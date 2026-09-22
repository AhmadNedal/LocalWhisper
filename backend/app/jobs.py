"""Background transcription jobs.

Each job runs in a worker thread so the HTTP server (and therefore the UI)
stays responsive. The UI polls ``GET /jobs/{id}?since=N`` a few times per
second and receives the current stage, progress, ETA and any new transcript
segments since index ``N`` — cheap, robust, real-time enough.

Pipeline: probe → extract audio (FFmpeg) → ensure model (download once) →
load model (CTranslate2) → transcribe (faster-whisper) → finalize.
"""

from __future__ import annotations

import logging
import shutil
import tempfile
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .config import Settings
from .errors import AppError, Cancelled, ErrorCode, classify_exception
from .media import PcmAudio, extract_audio, probe
from .model_store import ModelStore
from .system_info import gpu_fits, resolve_device
from .transcriber import Engine, TranscriptSegment

log = logging.getLogger(__name__)

# Share of the overall progress bar each stage represents.
_EXTRACT_SPAN = (0.0, 0.08)
_PREPARE_SPAN = (0.08, 0.12)
_TRANSCRIBE_SPAN = (0.12, 0.99)


@dataclass
class JobRequest:
    path: str
    model: str
    language: str | None  # None → auto-detect
    device: str  # auto | cpu | cuda
    preset: str  # fast | balanced | accurate
    arabic_punctuation: bool = True


@dataclass
class Job:
    id: str
    request: JobRequest
    status: str = "running"  # running | completed | error | cancelled
    stage: str = "queued"
    stage_progress: float = 0.0
    progress: float = 0.0
    eta_seconds: float | None = None
    media: dict[str, Any] | None = None
    device: str | None = None
    compute_type: str | None = None
    language: str | None = None
    language_probability: float | None = None
    download: dict[str, int] | None = None
    warnings: list[str] = field(default_factory=list)
    error: dict[str, str] | None = None
    segments: list[TranscriptSegment] = field(default_factory=list)
    started_at: float = field(default_factory=time.time)
    finished_at: float | None = None
    cancel_event: threading.Event = field(default_factory=threading.Event)
    lock: threading.Lock = field(default_factory=threading.Lock)

    def snapshot(self, since: int = 0) -> dict[str, Any]:
        with self.lock:
            return {
                "id": self.id,
                "status": self.status,
                "stage": self.stage,
                "stageProgress": round(self.stage_progress, 4),
                "progress": round(self.progress, 4),
                "etaSeconds": None if self.eta_seconds is None else round(self.eta_seconds),
                "media": self.media,
                "device": self.device,
                "computeType": self.compute_type,
                "model": self.request.model,
                "language": self.language,
                "languageProbability": self.language_probability,
                "download": self.download,
                "warnings": list(self.warnings),
                "error": self.error,
                "segmentCount": len(self.segments),
                "segments": [s.to_dict() for s in self.segments[since:]],
                "elapsedSeconds": round((self.finished_at or time.time()) - self.started_at, 1),
            }


class JobManager:
    def __init__(self, settings: Settings, store: ModelStore, engine: Engine) -> None:
        self.settings = settings
        self.store = store
        self.engine = engine
        self._jobs: dict[str, Job] = {}
        self._lock = threading.Lock()

    def get(self, job_id: str) -> Job:
        job = self._jobs.get(job_id)
        if job is None:
            raise AppError(ErrorCode.INVALID_REQUEST, "Unknown job")
        return job

    def start(self, request: JobRequest) -> Job:
        with self._lock:
            if any(j.status == "running" for j in self._jobs.values()):
                raise AppError(ErrorCode.BUSY, "A transcription is already running")
            self.store.spec(request.model)  # validate early
            # Keep memory bounded: forget finished jobs (the UI holds the result).
            self._jobs = {k: v for k, v in self._jobs.items() if v.status == "running"}
            job = Job(id=uuid.uuid4().hex, request=request)
            self._jobs[job.id] = job
        threading.Thread(target=self._run, args=(job,), daemon=True, name=f"job-{job.id[:8]}").start()
        return job

    def cancel(self, job_id: str) -> None:
        self.get(job_id).cancel_event.set()

    # ------------------------------------------------------------------ worker
    def _set(self, job: Job, **changes: Any) -> None:
        with job.lock:
            for key, value in changes.items():
                setattr(job, key, value)

    def _run(self, job: Job) -> None:
        req = job.request
        tmp_dir = Path(tempfile.mkdtemp(prefix="local-transcriber-"))
        audio: PcmAudio | None = None
        try:
            # 1. Probe (headers only)
            self._set(job, stage="probing")
            info = probe(req.path)
            self._set(job, media=info.to_dict())

            # 2. Extract audio once, directly at 16 kHz mono
            self._set(job, stage="extracting_audio", stage_progress=0.0)
            pcm_path = tmp_dir / "audio.s16le"

            def on_extract(p: float) -> None:
                self._set(job, stage_progress=p, progress=_span(_EXTRACT_SPAN, p))

            extract_audio(self.settings.ffmpeg_path, req.path, pcm_path, info.duration, on_extract, job.cancel_event)
            audio = PcmAudio(pcm_path)
            if job.media is not None and not job.media.get("duration"):
                with job.lock:
                    job.media["duration"] = audio.duration

            # 3. Model: download once, then always from disk
            device, compute_type = resolve_device(req.device)
            spec = self.store.spec(req.model)
            if device == "cuda" and not gpu_fits(spec.vram_gpu_mb, compute_type):
                if req.device == "auto":
                    device, compute_type = "cpu", "int8"
                    self._warn(job, "gpu_too_small")
                else:
                    raise AppError(
                        ErrorCode.INSUFFICIENT_MEMORY,
                        f"Model '{spec.id}' needs about {spec.vram_gpu_mb / 1024:.1f} GB of GPU memory "
                        f"({compute_type}); choose a smaller model or the CPU",
                    )
            self._set(job, device=device, compute_type=compute_type)
            if not self.store.is_downloaded(req.model):
                self._set(job, stage="downloading_model", stage_progress=0.0)

                def on_download(done: int, total: int) -> None:
                    self._set(
                        job,
                        download={"done": done, "total": total},
                        stage_progress=(done / total) if total else 0.0,
                    )

                self.store.wait_for_download(req.model, on_download, job.cancel_event.is_set)

            if job.cancel_event.is_set():
                raise Cancelled()

            # 4. Load model (cached across jobs); fall back to CPU if the GPU fails
            self._set(job, stage="loading_model", stage_progress=0.0, progress=_PREPARE_SPAN[0])
            try:
                model = self.engine.load(spec, self.store.path_for(req.model), device, compute_type)
            except AppError as err:
                if device == "cuda" and req.device == "auto" and err.code in (
                    ErrorCode.CUDA_UNAVAILABLE,
                    ErrorCode.INSUFFICIENT_MEMORY,
                    ErrorCode.MODEL_LOAD_FAILED,
                ):
                    device, compute_type = "cpu", "int8"
                    self._warn(job, f"gpu_fallback:{err.detail}")
                    self._set(job, device=device, compute_type=compute_type)
                    model = self.engine.load(spec, self.store.path_for(req.model), device, compute_type)
                else:
                    raise

            # 5. Transcribe
            segments = self._transcribe(job, model, audio, device)

            # 6. Finalize
            self._set(job, stage="finalizing", stage_progress=1.0, progress=0.995, eta_seconds=0)
            with job.lock:
                job.segments = segments
                job.status = "completed"
                job.stage = "completed"
                job.progress = 1.0
                job.finished_at = time.time()
        except BaseException as exc:  # noqa: BLE001 - every failure must reach the UI
            err = classify_exception(exc)
            if isinstance(exc, Cancelled) or job.cancel_event.is_set():
                err = Cancelled()
            if err.code != ErrorCode.CANCELLED:
                log.exception("Job %s failed", job.id)
            with job.lock:
                job.status = "cancelled" if err.code == ErrorCode.CANCELLED else "error"
                job.stage = job.status
                job.error = err.to_dict()
                job.eta_seconds = None
                job.finished_at = time.time()
        finally:
            if audio is not None:
                audio.close()
            shutil.rmtree(tmp_dir, ignore_errors=True)

    def _transcribe(self, job: Job, model, audio: PcmAudio, device: str) -> list[TranscriptSegment]:  # noqa: ANN001
        req = job.request
        self._set(job, stage="transcribing", stage_progress=0.0, progress=_TRANSCRIBE_SPAN[0])
        started = time.time()

        def on_language(code: str, prob: float) -> None:
            self._set(job, language=code, language_probability=round(prob, 3))

        def on_segment(seg: TranscriptSegment, p: float) -> None:
            elapsed = time.time() - started
            eta = (elapsed / p) * (1 - p) if p > 0.02 else None
            with job.lock:
                job.segments.append(seg)
                job.stage_progress = p
                job.progress = _span(_TRANSCRIBE_SPAN, p)
                job.eta_seconds = eta

        try:
            return self.engine.transcribe(
                model,
                audio,
                device=device,
                language=req.language,
                preset_name=req.preset,
                arabic_punctuation=req.arabic_punctuation,
                cancel=job.cancel_event,
                on_language=on_language,
                on_segment=on_segment,
            )
        except (AppError, Cancelled):
            raise
        except Exception as exc:  # noqa: BLE001
            err = classify_exception(exc)
            # GPU failed mid-run (driver/cuDNN/VRAM): retry once on CPU when "Auto".
            if device == "cuda" and req.device == "auto" and err.code in (
                ErrorCode.CUDA_UNAVAILABLE,
                ErrorCode.INSUFFICIENT_MEMORY,
            ):
                self._warn(job, f"gpu_fallback:{err.detail}")
                spec = self.store.spec(req.model)
                self.engine.unload()
                model = self.engine.load(spec, self.store.path_for(req.model), "cpu", "int8")
                with job.lock:
                    job.device, job.compute_type, job.segments = "cpu", "int8", []
                return self._transcribe(job, model, audio, "cpu")
            raise err from exc

    def _warn(self, job: Job, message: str) -> None:
        with job.lock:
            job.warnings.append(message)


def _span(span: tuple[float, float], fraction: float) -> float:
    lo, hi = span
    return lo + (hi - lo) * max(0.0, min(1.0, fraction))
