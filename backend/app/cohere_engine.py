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


class CohereEngine:
    """Runs Cohere Transcribe Arabic in a worker process, one transcription at a time."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._proc: subprocess.Popen | None = None

    def load(self, model_path: Path, language: str) -> Path:
        """Checks the files and installs the repaired graphs; the model is loaded inside the worker."""
        if not is_complete(model_path):
            raise AppError(ErrorCode.MODEL_LOAD_FAILED, "Model files are missing; download the model again")
        ensure_patched(model_path)
        return model_path

    def unload(self) -> None:
        with self._lock:
            proc, self._proc = self._proc, None
        if proc is not None and proc.poll() is None:
            proc.kill()

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

        # 2. Transcribe the chunks in the worker process
        cmd, cwd = _worker_command()
        threads = psutil.cpu_count(logical=False) or psutil.cpu_count() or 4
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if sys.platform == "win32" else 0
        proc = subprocess.Popen(
            cmd,
            cwd=cwd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            encoding="utf-8",
            errors="replace",
            creationflags=flags,
        )
        with self._lock:
            self._proc = proc
        stderr_tail: list[str] = []

        def pump_stderr() -> None:
            assert proc.stderr is not None
            for line in proc.stderr:
                line = line.rstrip()
                if line:
                    stderr_tail.append(line)
                    del stderr_tail[:-20]
                    log.warning("Cohere worker: %s", line)

        threading.Thread(target=pump_stderr, daemon=True, name="cohere-stderr").start()
        stop_watch = threading.Event()

        def watch_cancel() -> None:
            while not stop_watch.wait(0.3):
                if cancel.is_set() and proc.poll() is None:
                    proc.kill()
                    return

        threading.Thread(target=watch_cancel, daemon=True, name="cohere-cancel").start()

        segments: list[TranscriptSegment] = []
        recent: list[str] = []
        try:
            assert proc.stdin is not None and proc.stdout is not None
            proc.stdin.write(
                json.dumps(
                    {
                        "model_dir": str(model_path),
                        "pcm": str(audio.path),
                        "language": language,
                        "threads": threads,
                        "chunks": [[c.start, c.end] for c in chunks],
                    }
                )
                + "\n"
            )
            proc.stdin.flush()
            finished = False
            for line in proc.stdout:
                try:
                    msg = json.loads(line)
                except ValueError:
                    continue
                event = msg.get("event")
                if event == "ready":
                    log.info("Cohere worker: model loaded (%d threads)", threads)
                elif event == "chunk":
                    chunk = chunks[int(msg["i"])]
                    text = clean_text(str(msg.get("text") or ""))
                    # Skip empty chunks and repetition loops (the same line 3+ times in a row).
                    if not text or (len(recent) >= 2 and recent[-1] == text and recent[-2] == text):
                        continue
                    recent = (recent + [text])[-2:]
                    item = TranscriptSegment(
                        id=len(segments),
                        start=round(chunk.start / SAMPLE_RATE, 2),
                        end=round(chunk.end / SAMPLE_RATE, 2),
                        text=text,
                    )
                    segments.append(item)
                    on_segment(item, min(1.0, chunk.end / total))
                elif event == "error":
                    from .errors import classify_exception

                    err = classify_exception(RuntimeError(str(msg.get("detail") or "")))
                    if err.code == ErrorCode.TRANSCRIPTION_FAILED:
                        err = AppError(ErrorCode.MODEL_LOAD_FAILED, err.detail)
                    raise err
                elif event == "done":
                    finished = True
                    break
            if cancel.is_set():
                raise Cancelled()
            if not finished:
                code = proc.wait(timeout=10)
                detail = " | ".join(stderr_tail[-3:]) or f"exit code {code}"
                from .errors import classify_exception

                raise classify_exception(RuntimeError(f"Cohere worker stopped: {detail}"))
        finally:
            stop_watch.set()
            if proc.poll() is None:
                try:
                    proc.stdin.close()  # type: ignore[union-attr]
                    proc.wait(timeout=5)
                except Exception:  # noqa: BLE001
                    proc.kill()
            with self._lock:
                if self._proc is proc:
                    self._proc = None

        if not segments:
            raise AppError(ErrorCode.NO_SPEECH, "No speech was detected in the audio")
        log.info("Cohere: %d segments", len(segments))
        return segments
