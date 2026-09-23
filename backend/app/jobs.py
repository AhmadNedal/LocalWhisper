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

import psutil
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
_DOWNLOAD_SPAN = (0.0, 0.10)  # YouTube audio download (only for YouTube jobs)
_EXTRACT_SPAN = (0.0, 0.08)
_PREPARE_SPAN = (0.08, 0.12)
_TRANSCRIBE_SPAN = (0.12, 0.99)


@dataclass
class PreparedMedia:
    """Audio already extracted ahead of time (the batch queue prepares the next file)."""

    pcm_path: Path
    media: dict[str, Any]
    tmp_dir: Path  # owned by the job from now on: deleted when it ends


def prepare_media(
    settings: Settings,
    path: str,
    youtube_url: str | None,
    tmp_dir: Path,
    cancel: threading.Event,
    on_download: Any = None,
    on_extract: Any = None,
    on_probed: Any = None,
) -> tuple[Path, dict[str, Any]]:
    """Download (YouTube) → probe → extract 16 kHz mono PCM. Returns (pcm path, media info)."""
    source_path = path
    yt_title = None
    if youtube_url:
        from .youtube import download_audio

        media_file, yt_info = download_audio(youtube_url, tmp_dir, on_download or (lambda *a: None), cancel)
        source_path = str(media_file)
        yt_title = yt_info.get("title")
    info = probe(source_path)
    media = info.to_dict()
    if youtube_url:
        media.update({"path": youtube_url, "name": yt_title or info.name, "has_video": True})
    if on_probed:
        on_probed(media)
    pcm_path = tmp_dir / "audio.s16le"
    extract_audio(settings.ffmpeg_path, source_path, pcm_path, info.duration, on_extract or (lambda p: None), cancel)
    return pcm_path, media


@dataclass
class JobRequest:
    path: str  # local file, or the YouTube URL when youtube_url is set
    model: str
    language: str | None  # None → auto-detect
    device: str  # auto | cpu | cuda
    preset: str  # fast | balanced | accurate
    arabic_punctuation: bool = True
    youtube_url: str | None = None
    engine: str = "local"  # local | cloud
    cloud_provider: str | None = None
    cloud_model: str | None = None
    api_key: str = field(default="", repr=False)  # never logged, never returned
    prepared: PreparedMedia | None = field(default=None, repr=False)
    vocabulary: str = ""  # comma-separated names / terms (custom vocabulary)


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
    cloud_chunks: int | None = None
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
                "model": self.request.cloud_model if self.request.engine == "cloud" else self.request.model,
                "engine": self.request.engine,
                "cloudProvider": self.request.cloud_provider,
                "cloudChunks": self.cloud_chunks,
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
            if request.engine == "cloud":
                from .cloud import validate_request

                validate_request(request.cloud_provider or "", request.cloud_model or "", request.language, request.api_key)
            else:
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

    def _resolve_device(self, job: Job) -> tuple[str, str]:
        req = job.request
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
        return device, compute_type

    def _warm_up(self, job: Job, device: str, compute_type: str) -> threading.Thread | None:
        """Load the model in the background while the audio is being prepared.

        Loading a large model from disk takes 10–60 s on a laptop; doing it in
        parallel with the download / FFmpeg step removes that wait. Any error is
        ignored here — the real load below reports it properly.
        """
        req = job.request
        if not self.store.is_downloaded(req.model):
            self.store.start_download(req.model)  # start the one-time download right away too
            return None
        spec = self.store.spec(req.model)

        def load() -> None:
            try:
                self.engine.load(spec, self.store.path_for(req.model), device, compute_type)
            except BaseException:  # noqa: BLE001
                log.info("Model warm-up failed; it will be retried", exc_info=True)

        thread = threading.Thread(target=load, daemon=True, name=f"warm-{job.id[:8]}")
        thread.start()
        return thread

    def _run(self, job: Job) -> None:
        req = job.request
        tmp_dir = Path(tempfile.mkdtemp(prefix="local-transcriber-"))
        audio: PcmAudio | None = None
        warm: threading.Thread | None = None
        try:
            device = compute_type = ""
            if req.engine != "cloud":
                device, compute_type = self._resolve_device(job)
                self._set(job, device=device, compute_type=compute_type)
                warm = self._warm_up(job, device, compute_type)

            if req.prepared is not None:
                # 0-2. Prepared ahead of time by the batch queue
                shutil.rmtree(tmp_dir, ignore_errors=True)
                tmp_dir = req.prepared.tmp_dir
                pcm_path = req.prepared.pcm_path
                self._set(job, media=dict(req.prepared.media), stage="extracting_audio", stage_progress=1.0,
                          progress=_EXTRACT_SPAN[1])
            else:
                extract_span = (_DOWNLOAD_SPAN[1], _DOWNLOAD_SPAN[1] + 0.04) if req.youtube_url else _EXTRACT_SPAN
                self._set(job, stage="downloading_media" if req.youtube_url else "probing", stage_progress=0.0)

                def on_download_media(p: float, done: int, total: int) -> None:
                    self._set(
                        job,
                        stage_progress=p,
                        progress=_span(_DOWNLOAD_SPAN, p),
                        download={"done": done, "total": total},
                    )

                def on_probed(media: dict[str, Any]) -> None:
                    self._set(job, media=media, download=None, stage="extracting_audio", stage_progress=0.0)

                def on_extract(p: float) -> None:
                    self._set(job, stage_progress=p, progress=_span(extract_span, p))

                # 0-2. (YouTube: download the audio only) → probe → extract 16 kHz mono once
                pcm_path, _media = prepare_media(
                    self.settings,
                    req.path,
                    req.youtube_url,
                    tmp_dir,
                    job.cancel_event,
                    on_download_media,
                    on_extract,
                    on_probed,
                )
            audio = PcmAudio(pcm_path)
            if job.media is not None and not job.media.get("duration"):
                with job.lock:
                    job.media["duration"] = audio.duration

            if req.engine == "cloud":
                # 3-5. Paid cloud provider: upload speech chunks, no local model
                segments = self._transcribe_cloud(job, audio)
            else:
                # 3. Model: download once, then always from disk
                spec = self.store.spec(req.model)
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

                # 4. Load model (usually already warm; cached across jobs); CPU fallback if the GPU fails
                self._set(job, stage="loading_model", stage_progress=0.0, progress=_PREPARE_SPAN[0])
                if warm is not None:
                    while warm.is_alive():
                        if job.cancel_event.is_set():
                            raise Cancelled()
                        warm.join(0.2)
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
            job.request.api_key = ""  # don't keep the user's key in memory
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

        spec = self.store.spec(req.model)
        low_memory = device == "cpu" and psutil.virtual_memory().available < spec.ram_cpu_mb * 1024 * 1024 * 1.5
        if low_memory:
            self._warn(job, "low_memory")
        try:
            return self.engine.transcribe(
                model,
                audio,
                low_memory=low_memory,
                vocabulary=req.vocabulary,
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

    def _transcribe_cloud(self, job: Job, audio: PcmAudio) -> list[TranscriptSegment]:
        from .cloud import provider, transcribe

        req = job.request
        prov = provider(req.cloud_provider or "")
        self._warn(job, "cloud_upload")
        self._set(
            job,
            device="cloud",
            compute_type=prov.name,
            language=req.language,
            language_probability=1.0 if req.language else None,
            stage="transcribing",
            stage_progress=0.0,
            progress=_TRANSCRIBE_SPAN[0],
        )
        started = time.time()

        def on_segment(seg: TranscriptSegment, p: float) -> None:
            elapsed = time.time() - started
            eta = (elapsed / p) * (1 - p) if p > 0.02 else None
            with job.lock:
                job.segments.append(seg)
                job.stage_progress = p
                job.progress = _span(_TRANSCRIBE_SPAN, p)
                job.eta_seconds = eta

        return transcribe(
            audio,
            provider_id=prov.id,
            model=req.cloud_model or "",
            api_key=req.api_key,
            language=req.language,
            cancel=job.cancel_event,
            on_segment=on_segment,
            on_planned=lambda n: self._set(job, cloud_chunks=n),
            vocabulary=req.vocabulary,
        )

    def _warn(self, job: Job, message: str) -> None:
        with job.lock:
            job.warnings.append(message)


def _span(span: tuple[float, float], fraction: float) -> float:
    lo, hi = span
    return lo + (hi - lo) * max(0.0, min(1.0, fraction))
