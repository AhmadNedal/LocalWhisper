"""Live transcription: microphone / computer audio → text while it is spoken.

The desktop app captures the sound, converts it to 16 kHz mono 16-bit PCM and
posts it here about once a second. A worker thread per session then:

1. appends the audio to a temporary PCM file (the recording);
2. finds speech with Silero VAD in the part not yet transcribed;
3. cuts an *utterance* as soon as the speaker pauses (~0.8 s of silence), or
   after ~14 s of continuous speech (at the best pause inside it);
4. transcribes each utterance with the model chosen in the settings — Whisper
   (the loaded faster-whisper model, kept loaded) or Cohere Transcribe Arabic
   (its persistent worker process) — and publishes the text.

So text appears 1–3 seconds after each sentence on a GPU, a little later on a
CPU; when the computer can't keep up, utterances queue and are caught up
(the UI shows the backlog). Nothing is sent anywhere.

When the session stops, the remaining speech is transcribed, the recording is
kept (compressed with FFmpeg when available) and the transcript is saved in
the archive, pointing at that recording, so it opens like any other file.
"""

from __future__ import annotations

import datetime as dt
import logging
import re
import subprocess
import sys
import tempfile
import threading
import time
import uuid
import wave
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

from .errors import AppError, Cancelled, ErrorCode, classify_exception
from .media import SAMPLE_RATE
from .transcriber import ARABIC_PUNCTUATION_PROMPT, TEMPERATURES_FAST, clean_text, _is_hallucination

log = logging.getLogger(__name__)

END_SILENCE_S = 0.8  # a pause this long ends an utterance
MERGE_GAP_S = 0.5  # speech spans closer than this belong to the same utterance
MAX_UTTERANCE_S = 14.0
MIN_UTTERANCE_S = 0.35
KEEP_SILENCE_S = 1.0  # while nothing is said, keep only the last second pending
PAD_S = 0.15
NO_AUDIO_TIMEOUT_S = 90.0  # the app stopped sending (closed / crashed): end the session
MAX_POST_BYTES = 10 * SAMPLE_RATE * 2  # one request carries at most 10 s
_NO_WINDOW = 0x08000000 if sys.platform == "win32" else 0


@dataclass
class LiveRequest:
    model: str
    language: str | None = None
    device: str = "auto"
    preset: str = "balanced"
    arabic_punctuation: bool = True
    vocabulary: str = ""
    title: str = ""
    course: str | None = None
    source: str = "mic"  # mic | system | both (for the record only)
    save_recording: bool = True
    save_to_archive: bool = True


@dataclass
class LiveSession:
    id: str
    request: LiveRequest
    pcm_path: Path
    started_at: float = field(default_factory=time.time)
    status: str = "loading"  # loading | listening | finishing | done | error | cancelled
    error: dict[str, str] | None = None
    device: str | None = None
    language: str | None = None
    total: int = 0  # samples received
    cut: int = 0  # samples already turned into utterances
    segments: list[dict[str, Any]] = field(default_factory=list)
    recording_path: str | None = None
    archive_id: str | None = None
    last_audio_at: float = field(default_factory=time.time)
    stop_requested: bool = False
    cancel_event: threading.Event = field(default_factory=threading.Event)
    cond: threading.Condition = field(default_factory=threading.Condition)
    lock: threading.Lock = field(default_factory=threading.Lock)

    def snapshot(self, since: int = 0) -> dict[str, Any]:
        with self.lock:
            return {
                "id": self.id,
                "status": self.status,
                "error": self.error,
                "device": self.device,
                "model": self.request.model,
                "language": self.language or self.request.language,
                "title": self.request.title,
                "course": self.request.course,
                "started_at": self.started_at,
                "duration": round(self.total / SAMPLE_RATE, 2),
                "backlog": round(max(0, self.total - self.cut) / SAMPLE_RATE, 2),
                "segment_count": len(self.segments),
                "segments": self.segments[since:],
                "recording_path": self.recording_path,
                "archive_id": self.archive_id,
            }


class LiveManager:
    def __init__(self, jobs, archive, settings) -> None:  # noqa: ANN001 - JobManager, Archive, Settings
        self.jobs = jobs
        self.archive = archive
        self.settings = settings
        self._sessions: dict[str, LiveSession] = {}
        self._lock = threading.Lock()
        self._tmp = Path(tempfile.gettempdir()) / "local-transcriber-live"

    # ------------------------------------------------------------------ API
    def active(self) -> LiveSession | None:
        with self._lock:
            for s in self._sessions.values():
                if s.status in ("loading", "listening", "finishing"):
                    return s
        return None

    def get(self, session_id: str) -> LiveSession:
        s = self._sessions.get(session_id)
        if s is None:
            raise AppError(ErrorCode.INVALID_REQUEST, "Unknown live session")
        return s

    def start(self, request: LiveRequest) -> LiveSession:
        spec = self.jobs.store.spec(request.model)  # validates the id
        if spec.languages and request.language and request.language not in spec.languages:
            raise AppError(ErrorCode.INVALID_REQUEST, f"model_language: {spec.id} supports {', '.join(spec.languages)} only")
        if not self.jobs.store.is_downloaded(request.model):
            raise AppError(ErrorCode.LIVE_MODEL_MISSING, f"Download the model '{request.model}' first")
        with self._lock:
            if any(s.status in ("loading", "listening", "finishing") for s in self._sessions.values()):
                raise AppError(ErrorCode.BUSY, "A live session is already running")
            if self.jobs.running():
                raise AppError(ErrorCode.BUSY, "A transcription is running; wait for it or stop it first")
            # Forget old sessions (the UI and the archive hold their results).
            self._sessions = {k: v for k, v in self._sessions.items() if v.status in ("loading", "listening", "finishing")}
            self._tmp.mkdir(parents=True, exist_ok=True)
            sid = uuid.uuid4().hex
            session = LiveSession(id=sid, request=request, pcm_path=self._tmp / f"{sid}.pcm")
            session.pcm_path.write_bytes(b"")
            self._sessions[sid] = session
        log.info(
            "Live session %s started: model=%s language=%s device=%s source=%s",
            sid[:8], request.model, request.language or "auto", request.device, request.source,
        )
        threading.Thread(target=self._run, args=(session,), daemon=True, name=f"live-{sid[:8]}").start()
        return session

    def feed(self, session_id: str, data: bytes) -> dict[str, Any]:
        s = self.get(session_id)
        if s.status not in ("loading", "listening"):
            raise AppError(ErrorCode.INVALID_REQUEST, "The live session has ended")
        if len(data) > MAX_POST_BYTES:
            raise AppError(ErrorCode.INVALID_REQUEST, "Audio chunk too large")
        if len(data) % 2:
            data = data[:-1]
        if data:
            with open(s.pcm_path, "ab") as f:
                f.write(data)
            with s.cond:
                with s.lock:
                    s.total += len(data) // 2
                    s.last_audio_at = time.time()
                s.cond.notify_all()
        return {"ok": True, "backlog": round(max(0, s.total - s.cut) / SAMPLE_RATE, 2), "status": s.status}

    def stop(self, session_id: str) -> LiveSession:
        s = self.get(session_id)
        with s.cond:
            s.stop_requested = True
            s.cond.notify_all()
        return s

    def cancel(self, session_id: str) -> None:
        s = self.get(session_id)
        with s.cond:
            s.stop_requested = True
            s.cancel_event.set()
            s.cond.notify_all()

    # ------------------------------------------------------------------ worker
    def _set(self, s: LiveSession, **changes: Any) -> None:
        with s.lock:
            for k, v in changes.items():
                setattr(s, k, v)

    def _run(self, s: LiveSession) -> None:
        try:
            runner = self._load(s)
            self._set(s, status="listening")
            log.info("Live session %s: listening on %s", s.id[:8], s.device)
            checked = 0
            while True:
                with s.cond:
                    while not s.stop_requested and s.total - checked < SAMPLE_RATE // 4:
                        s.cond.wait(timeout=1.0)
                        if time.time() - s.last_audio_at > NO_AUDIO_TIMEOUT_S:
                            log.warning("Live session %s: no audio for %ds; ending it", s.id[:8], NO_AUDIO_TIMEOUT_S)
                            s.stop_requested = True
                    final = s.stop_requested
                if s.cancel_event.is_set():
                    raise Cancelled()
                total = s.total
                checked = total
                self._step(s, runner, total, final)
                if final:
                    break
            self._finish(s)
        except Cancelled:
            self._set(s, status="cancelled")
            log.info("Live session %s cancelled", s.id[:8])
            s.pcm_path.unlink(missing_ok=True)
        except Exception as exc:  # noqa: BLE001
            err = exc if isinstance(exc, AppError) else classify_exception(exc)
            log.error("Live session %s failed: %s: %s", s.id[:8], err.code.value, err.detail, exc_info=not isinstance(exc, AppError))
            self._set(s, error=err.to_dict())
            # Keep what was already transcribed.
            try:
                self._finish(s, failed=True)
            except Exception:  # noqa: BLE001
                log.exception("Live session %s: could not save after the failure", s.id[:8])
            self._set(s, status="error")

    def _load(self, s: LiveSession):  # noqa: ANN202 - returns a callable (start, end, samples) -> segments
        req = s.request
        spec = self.jobs.store.spec(req.model)
        device, compute_type = self.jobs.device_for(spec, req.device)
        self._set(s, device=device)
        model = self.jobs.load_model(spec, device, compute_type, req.language)
        if spec.engine == "cohere":
            language = req.language or "ar"
            self._set(s, language=language)
            return lambda start, end, samples: self._cohere(s, model, language, start, end, samples)
        return lambda start, end, samples: self._whisper(s, model, device, start, end, samples)

    def _read(self, s: LiveSession, lo: int, hi: int) -> np.ndarray:
        with open(s.pcm_path, "rb") as f:
            f.seek(lo * 2)
            raw = f.read((hi - lo) * 2)
        return np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0

    def _step(self, s: LiveSession, runner, total: int, final: bool) -> None:  # noqa: ANN001
        lo = s.cut
        if total - lo < int(MIN_UTTERANCE_S * SAMPLE_RATE):
            if final:
                self._set(s, cut=total)
            return
        audio = self._read(s, lo, total)
        utterances, new_cut = find_utterances(audio, final)
        for a, b in utterances:
            if s.cancel_event.is_set():
                raise Cancelled()
            runner(lo + a, lo + b, audio[a:b])
            # Everything up to the end of this utterance is done.
            self._set(s, cut=max(s.cut, lo + b))
        self._set(s, cut=max(s.cut, lo + new_cut))

    def _publish(self, s: LiveSession, start: float, end: float, text: str) -> None:
        text = clean_text(text)
        if not text:
            return
        with s.lock:
            if s.segments and s.segments[-1]["text"] == text and start - s.segments[-1]["end"] < 3:
                return  # the same line twice in a row
            s.segments.append({"id": len(s.segments), "start": round(start, 2), "end": round(end, 2), "text": text})

    def _whisper(self, s: LiveSession, model, device: str, start: int, end: int, samples: np.ndarray) -> None:  # noqa: ANN001
        req = s.request
        language = s.language or req.language
        prompt_parts = []
        if req.arabic_punctuation and (language or "ar") == "ar":
            prompt_parts.append(ARABIC_PUNCTUATION_PROMPT)
        with s.lock:
            previous = " ".join(x["text"] for x in s.segments[-3:])
        if previous:
            prompt_parts.append(previous[-200:])  # continuity: names and style of what came just before
        beam = 1 if req.preset == "fast" else (2 if device == "cpu" else 5)
        seg_iter, info = model.transcribe(
            samples,
            language=language,
            task="transcribe",
            beam_size=beam,
            temperature=list(TEMPERATURES_FAST),
            condition_on_previous_text=False,
            initial_prompt=" ".join(prompt_parts) or None,
            hotwords=req.vocabulary or None,
            vad_filter=False,  # already cut on speech
            without_timestamps=False,
        )
        if language is None and getattr(info, "language", None) and (info.language_probability or 0) >= 0.5:
            self._set(s, language=info.language)
            log.info("Live session %s: language %s (%.0f%%)", s.id[:8], info.language, info.language_probability * 100)
        offset = start / SAMPLE_RATE
        for seg in seg_iter:
            if s.cancel_event.is_set():
                raise Cancelled()
            text = clean_text(seg.text)
            if not text or _is_hallucination(text, seg.no_speech_prob, seg.avg_logprob):
                continue
            self._publish(s, offset + seg.start, min(end / SAMPLE_RATE, offset + seg.end), text)

    def _cohere(self, s: LiveSession, model_path: Path, language: str, start: int, end: int, samples: np.ndarray) -> None:
        tmp = s.pcm_path.with_suffix(".utt.pcm")
        tmp.write_bytes((np.clip(samples, -1.0, 1.0) * 32767).astype(np.int16).tobytes())
        texts: list[str] = []
        try:
            self.jobs.cohere.run_chunks(
                model_path, tmp, language, [[0, len(samples)]], lambda _i, text: texts.append(text), s.cancel_event
            )
        finally:
            tmp.unlink(missing_ok=True)
        text = " ".join(t for t in texts if t.strip())
        if text:
            self._publish(s, start / SAMPLE_RATE, end / SAMPLE_RATE, text)

    # ------------------------------------------------------------------ end
    def _finish(self, s: LiveSession, failed: bool = False) -> None:
        req = s.request
        self._set(s, status="finishing")
        duration = s.total / SAMPLE_RATE
        log.info("Live session %s: %.0f s recorded, %d segment(s)", s.id[:8], duration, len(s.segments))
        recording: Path | None = None
        if req.save_recording and s.total > SAMPLE_RATE and s.segments:  # nothing said: no file to keep
            try:
                recording = self._save_recording(s)
                self._set(s, recording_path=str(recording))
            except Exception:  # noqa: BLE001
                log.exception("Live session %s: could not save the recording", s.id[:8])
        s.pcm_path.unlink(missing_ok=True)
        if req.save_to_archive and s.segments:
            item = self.archive.save(
                {
                    "title": req.title or default_title(s.started_at),
                    "source_type": "file",
                    "source": str(recording) if recording else "",
                    "duration": duration,
                    "language": s.language or req.language,
                    "engine": "local",
                    "model": req.model,
                    "course": req.course,
                    "segments": s.segments,
                }
            )
            self._set(s, archive_id=item["id"])
            log.info("Live session %s saved to the archive (%s)", s.id[:8], item["id"][:8])
        if not failed:
            self._set(s, status="done")

    def _save_recording(self, s: LiveSession) -> Path:
        out_dir = self.settings.output_dir / "Live recordings"
        out_dir.mkdir(parents=True, exist_ok=True)
        stem = safe_name(s.request.title or default_title(s.started_at))
        ffmpeg = self.settings.ffmpeg_path
        if ffmpeg:
            dest = unique(out_dir / f"{stem}.m4a")
            cmd = [
                ffmpeg, "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
                "-f", "s16le", "-ar", str(SAMPLE_RATE), "-ac", "1", "-i", str(s.pcm_path),
                "-c:a", "aac", "-b:a", "48k", str(dest),
            ]
            proc = subprocess.run(cmd, capture_output=True, timeout=600, creationflags=_NO_WINDOW, check=False)  # noqa: S603
            if proc.returncode == 0 and dest.exists():
                return dest
            log.warning("ffmpeg could not compress the recording (%s); keeping WAV", proc.stderr[-300:])
            dest.unlink(missing_ok=True)
        dest = unique(out_dir / f"{stem}.wav")
        with wave.open(str(dest), "wb") as w, open(s.pcm_path, "rb") as src:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(SAMPLE_RATE)
            while chunk := src.read(1 << 20):
                w.writeframesraw(chunk)
        return dest


# ---------------------------------------------------------------------- helpers
def find_utterances(audio: np.ndarray, final: bool) -> tuple[list[tuple[int, int]], int]:
    """Complete utterances in ``audio`` (sample ranges) and where the next search starts."""
    from faster_whisper.vad import VadOptions, get_speech_timestamps

    n = len(audio)
    spans = get_speech_timestamps(
        audio,
        VadOptions(
            threshold=0.5,
            min_speech_duration_ms=200,
            max_speech_duration_s=MAX_UTTERANCE_S,
            min_silence_duration_ms=300,
            speech_pad_ms=int(PAD_S * 1000),
        ),
    )
    if not spans:
        return [], (n if final else max(0, n - int(KEEP_SILENCE_S * SAMPLE_RATE)))
    groups: list[list[int]] = []
    gap = int(MERGE_GAP_S * SAMPLE_RATE)
    max_len = int(MAX_UTTERANCE_S * SAMPLE_RATE)
    for sp in spans:
        a, b = int(sp["start"]), int(sp["end"])
        if groups and a - groups[-1][1] <= gap and b - groups[-1][0] <= max_len:
            groups[-1][1] = b
        else:
            groups.append([a, b])
    last = groups[-1]
    done = final or n - last[1] >= int(END_SILENCE_S * SAMPLE_RATE) or last[1] - last[0] >= max_len - SAMPLE_RATE // 2
    complete = groups if done else groups[:-1]
    min_len = int(MIN_UTTERANCE_S * SAMPLE_RATE)
    utterances = [(a, b) for a, b in complete if b - a >= min_len]
    if done:
        next_cut = n if final else min(n, last[1])
    else:
        next_cut = max(complete[-1][1] if complete else 0, last[0] - int(PAD_S * SAMPLE_RATE), 0)
    return utterances, next_cut


def default_title(started: float) -> str:
    return "تفريغ مباشر " + dt.datetime.fromtimestamp(started).strftime("%Y-%m-%d %H-%M")


def safe_name(name: str) -> str:
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', " ", name)
    return " ".join(name.split())[:120].strip(" .") or "live"


def unique(path: Path) -> Path:
    if not path.exists():
        return path
    for i in range(2, 1000):
        candidate = path.with_name(f"{path.stem} ({i}){path.suffix}")
        if not candidate.exists():
            return candidate
    return path.with_name(f"{path.stem} {uuid.uuid4().hex[:6]}{path.suffix}")
