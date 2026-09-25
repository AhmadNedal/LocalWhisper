"""Cohere Transcribe Arabic, run locally with ONNX Runtime (CPU).

A 2B-parameter Conformer encoder-decoder trained for Arabic (Modern Standard
Arabic, Egyptian, Gulf, Levantine and Maghrebi dialects, and Arabic-English
code-switching). The 4-bit ONNX export (~1.5 GB download, ~2.4 GB of RAM) is
used; on a CPU it measured ~6x faster than Whisper large-v3-turbo with the same
transcript on real speech.

The published export can't be loaded as is (mixed 16/32-bit types, wrongly
named weight files, clashing dimension names), so the two small graph files
are replaced by repaired copies shipped in ``assets/cohere`` (made with
scripts/tools/repair_cohere_onnx.py); the downloaded weights are used as they are.

The model gives no timestamps, so the timing comes from the audio itself: the
Silero voice-activity detector (already shipped with faster-whisper) finds the
speech, nearby speech spans are merged into short chunks (a few seconds up to
~20 s, split at pauses), and every chunk becomes one transcript segment with the
chunk's start and end time. That is also how Cohere recommends running it
(the model transcribes non-speech sounds eagerly without a VAD in front).

The model itself runs in a separate worker process (cohere_worker.py), which
gives its memory back as soon as a transcription ends.
"""

from __future__ import annotations

import json
import logging
import subprocess
import sys
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import psutil

from .errors import AppError, Cancelled, ErrorCode
from .media import SAMPLE_RATE, PcmAudio
from .transcriber import TranscriptSegment, clean_text

log = logging.getLogger(__name__)

ENCODER = "onnx/encoder.q4f16.onnx"
DECODER = "onnx/decoder.q4f16.onnx"
TOKENS = "onnx/tokens.txt"
# Files to download (the .onnx_data sidecars hold the weights).
FILES = (
    "onnx/encoder.q4f16.onnx",
    "onnx/encoder.q4f16.onnx_data",
    "onnx/decoder.q4f16.onnx",
    "onnx/decoder.q4f16.onnx_data",
    "onnx/tokens.txt",
)
LANGUAGES = ("ar", "en")

WINDOW_SECONDS = 10 * 60  # audio read (and VAD-scanned) this much at a time
MAX_CHUNK_S = 20.0  # longest piece sent to the model (and longest segment)
MERGE_GAP_S = 0.6  # speech spans closer than this are joined into one chunk


def is_complete(model_path: Path) -> bool:
    return all((model_path / f).is_file() for f in FILES)


def _patch_dir() -> Path:
    from .config import backend_root

    return backend_root() / "assets" / "cohere"


def ensure_patched(model_path: Path) -> None:
    """Put the repaired graph files next to the downloaded weights (once)."""
    import filecmp
    import shutil

    for name in ("encoder.q4f16.onnx", "decoder.q4f16.onnx"):
        fixed = _patch_dir() / name
        target = model_path / "onnx" / name
        if not fixed.is_file():
            raise AppError(ErrorCode.MODEL_LOAD_FAILED, f"Repaired graph missing from the app: {fixed}")
        if not target.is_file() or not filecmp.cmp(fixed, target, shallow=False):
            shutil.copyfile(fixed, target)
            log.info("Cohere: installed the repaired %s", name)


@dataclass
class _Chunk:
    start: int  # sample index in the whole recording
    end: int


def _speech_chunks(audio: PcmAudio, lo: int, hi: int) -> list[_Chunk]:
    """Speech spans of [lo, hi), merged into chunks of at most MAX_CHUNK_S."""
    from faster_whisper.vad import VadOptions, get_speech_timestamps

    window = audio.window(lo, hi)
    spans = get_speech_timestamps(
        window,
        VadOptions(
            threshold=0.5,
            min_speech_duration_ms=250,
            max_speech_duration_s=MAX_CHUNK_S,
            min_silence_duration_ms=400,
            speech_pad_ms=200,
        ),
    )
    del window
    chunks: list[_Chunk] = []
    max_len = int(MAX_CHUNK_S * SAMPLE_RATE)
    gap = int(MERGE_GAP_S * SAMPLE_RATE)
    for span in spans:
        s, e = lo + int(span["start"]), lo + int(span["end"])
        if chunks and s - chunks[-1].end <= gap and e - chunks[-1].start <= max_len:
            chunks[-1].end = e
        else:
            chunks.append(_Chunk(s, e))
    return chunks


def _worker_command() -> tuple[list[str], str | None]:
    """How to start the worker: the packaged exe in worker mode, or ``python -m``."""
    if getattr(sys, "frozen", False):
        return [sys.executable, "--cohere-worker"], None
    return [sys.executable, "-m", "app.cohere_worker"], str(Path(__file__).resolve().parent.parent)


IDLE_SECONDS = 10 * 60  # a worker with nothing to do is stopped (frees ~2.4 GB)


class _Worker:
    """One running worker process with the model loaded."""

    def __init__(self, model_path: Path) -> None:
        self.model_path = model_path
        cmd, cwd = _worker_command()
        self.threads = psutil.cpu_count(logical=False) or psutil.cpu_count() or 4
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if sys.platform == "win32" else 0
        self.proc = subprocess.Popen(
            cmd,
            cwd=cwd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            encoding="utf-8",
            errors="replace",
            creationflags=flags,
        )
        self.stderr_tail: list[str] = []
        threading.Thread(target=self._pump_stderr, daemon=True, name="cohere-stderr").start()
        self._send({"model_dir": str(model_path), "threads": self.threads})
        msg = self._read()
        if msg.get("event") != "ready":
            self.kill()
            raise self._error(msg)
        log.info("Cohere worker: model loaded (%d threads)", self.threads)

    def _pump_stderr(self) -> None:
        assert self.proc.stderr is not None
        for line in self.proc.stderr:
            line = line.rstrip()
            if line:
                self.stderr_tail.append(line)
                del self.stderr_tail[:-20]
                log.warning("Cohere worker: %s", line)

    def alive(self) -> bool:
        return self.proc.poll() is None

    def _send(self, obj: dict) -> None:
        assert self.proc.stdin is not None
        self.proc.stdin.write(json.dumps(obj) + "\n")
        self.proc.stdin.flush()

    def _read(self) -> dict:
        assert self.proc.stdout is not None
        while True:
            line = self.proc.stdout.readline()
            if not line:  # the process ended
                detail = " | ".join(self.stderr_tail[-3:]) or f"exit code {self.proc.poll()}"
                return {"event": "error", "detail": f"Cohere worker stopped: {detail}"}
            try:
                return json.loads(line)
            except ValueError:
                continue

    @staticmethod
    def _error(msg: dict) -> AppError:
        from .errors import classify_exception

        err = classify_exception(RuntimeError(str(msg.get("detail") or "Cohere worker failed")))
        if err.code == ErrorCode.TRANSCRIPTION_FAILED:
            err = AppError(ErrorCode.MODEL_LOAD_FAILED, err.detail)
        return err

    def run(self, pcm: Path, language: str, chunks: list[list[int]], on_chunk: Callable[[int, str], None]) -> None:
        self._send({"cmd": "transcribe", "pcm": str(pcm), "language": language, "chunks": chunks})
        while True:
            msg = self._read()
            event = msg.get("event")
            if event == "chunk":
                on_chunk(int(msg["i"]), str(msg.get("text") or ""))
            elif event == "done":
                return
            elif event == "error":
                raise self._error(msg)

    def kill(self) -> None:
        if self.proc.poll() is None:
            try:
                self._send({"cmd": "quit"})
                self.proc.wait(timeout=3)
            except Exception:  # noqa: BLE001
                pass
        if self.proc.poll() is None:
            self.proc.kill()


class CohereEngine:
    """Runs Cohere Transcribe Arabic in a worker process that stays loaded between files.

    The first transcription starts the worker (loading the model takes ~10–40 s);
    the next files in a queue or from a watched folder reuse it. It is stopped
    after IDLE_SECONDS without work, when a Whisper model is loaded instead, or
    when a transcription is cancelled.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()  # one transcription at a time
        self._worker: _Worker | None = None
        self._idle: threading.Timer | None = None

    def load(self, model_path: Path, language: str) -> Path:
        """Checks the files and installs the repaired graphs; the model is loaded inside the worker."""
        if not is_complete(model_path):
            raise AppError(ErrorCode.MODEL_LOAD_FAILED, "Model files are missing; download the model again")
        ensure_patched(model_path)
        return model_path

    def loaded(self) -> bool:
        w = self._worker
        return w is not None and w.alive()

    def unload(self) -> None:
        self._cancel_idle()
        worker, self._worker = self._worker, None
        if worker is not None:
            log.info("Cohere worker stopped (memory freed)")
            worker.kill()

    def _cancel_idle(self) -> None:
        if self._idle is not None:
            self._idle.cancel()
            self._idle = None

    def _arm_idle(self) -> None:
        self._cancel_idle()
        self._idle = threading.Timer(IDLE_SECONDS, self._idle_stop)
        self._idle.daemon = True
        self._idle.start()

    def _idle_stop(self) -> None:
        if self._lock.acquire(blocking=False):
            try:
                if self._worker is not None:
                    log.info("Cohere worker idle for %d min", IDLE_SECONDS // 60)
                    self.unload()
            finally:
                self._lock.release()

    def _get_worker(self, model_path: Path) -> _Worker:
        w = self._worker
        if w is not None and w.alive() and w.model_path == model_path:
            return w
        self.unload()
        self._worker = _Worker(model_path)
        return self._worker

    def run_chunks(
        self,
        model_path: Path,
        pcm: Path,
        language: str,
        chunks: list[list[int]],
        on_chunk: Callable[[int, str], None],
        cancel: threading.Event | None = None,
    ) -> None:
        """Transcribe sample ranges of a 16 kHz int16 PCM file (used by files and live mode)."""
        with self._lock:
            self._cancel_idle()
            worker = self._get_worker(model_path)
            stop = threading.Event()

            def watch() -> None:
                while not stop.wait(0.3):
                    if cancel is not None and cancel.is_set():
                        worker.proc.kill()  # the only way to interrupt the model mid-chunk
                        return

            threading.Thread(target=watch, daemon=True, name="cohere-cancel").start()
            try:
                worker.run(pcm, language, chunks, on_chunk)
            except AppError:
                if cancel is not None and cancel.is_set():
                    raise Cancelled() from None
                if not worker.alive():
                    self._worker = None
                raise
            finally:
                stop.set()
                if cancel is not None and cancel.is_set():
                    self._worker = None
                    worker.kill()
                if self._worker is not None:
                    self._arm_idle()
            if cancel is not None and cancel.is_set():
                raise Cancelled()

    def transcribe(
        self,
        model_path: Path,
        audio: PcmAudio,
        *,
        language: str,
        cancel: threading.Event,
        on_segment: Callable[[TranscriptSegment, float], None],
    ) -> list[TranscriptSegment]:
        total = audio.num_samples
        if total < SAMPLE_RATE // 2:
            raise AppError(ErrorCode.NO_SPEECH, "Audio is shorter than half a second")

        # 1. Where is the speech? (Silero VAD, in this process)
        chunks: list[_Chunk] = []
        position = 0
        while position < total:
            if cancel.is_set():
                raise Cancelled()
            end = min(total, position + WINDOW_SECONDS * SAMPLE_RATE)
            if end < total:
                end = audio.quietest_point(end)
                if end <= position:
                    end = min(total, position + WINDOW_SECONDS * SAMPLE_RATE)
            chunks.extend(_speech_chunks(audio, position, end))
            position = end
        log.info("Cohere: %.0f s of audio → %d speech chunks", total / SAMPLE_RATE, len(chunks))
        if not chunks:
            raise AppError(ErrorCode.NO_SPEECH, "No speech was detected in the audio")

        # 2. Transcribe them in the (kept-loaded) worker
        segments: list[TranscriptSegment] = []
        recent: list[str] = []

        def on_chunk(i: int, text: str) -> None:
            nonlocal recent
            chunk = chunks[i]
            text = clean_text(text)
            # Skip empty chunks and repetition loops (the same line 3+ times in a row).
            if not text or (len(recent) >= 2 and recent[-1] == text and recent[-2] == text):
                return
            recent = (recent + [text])[-2:]
            item = TranscriptSegment(
                id=len(segments),
                start=round(chunk.start / SAMPLE_RATE, 2),
                end=round(chunk.end / SAMPLE_RATE, 2),
                text=text,
            )
            segments.append(item)
            on_segment(item, min(1.0, chunk.end / total))

        self.run_chunks(model_path, audio.path, language, [[c.start, c.end] for c in chunks], on_chunk, cancel)
        if not segments:
            raise AppError(ErrorCode.NO_SPEECH, "No speech was detected in the audio")
        log.info("Cohere: %d segments", len(segments))
        return segments
