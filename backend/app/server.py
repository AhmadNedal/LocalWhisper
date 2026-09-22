"""Local HTTP API used by the desktop UI.

Security model
--------------
* Bound to ``127.0.0.1`` only (see ``__main__``) — unreachable from the network.
* Every request must carry the random per-launch token that Electron generates
  and hands to both processes (``X-Auth-Token`` header). Other programs or web
  pages on the same machine therefore cannot drive the backend.
* Media never leaves the machine: the UI sends a *file path*, not file bytes.
"""

from __future__ import annotations

import hmac
import logging
import re
from datetime import datetime
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from . import __version__
from .config import Settings
from .errors import AppError, ErrorCode
from .jobs import JobManager, JobRequest
from .media import SUPPORTED_EXTENSIONS, probe
from .model_store import CATALOG, DEFAULT_MODEL_CPU, DEFAULT_MODEL_GPU, ModelStore
from .pdf_export import ExportRequest, ExportSegment, generate_pdf
from .system_info import detect_devices
from .transcriber import Engine

log = logging.getLogger(__name__)

_STATUS_FOR_CODE = {
    ErrorCode.INVALID_REQUEST: 400,
    ErrorCode.FILE_NOT_FOUND: 404,
    ErrorCode.BUSY: 409,
}


class ProbeBody(BaseModel):
    path: str


class JobBody(BaseModel):
    path: str
    model: str
    language: str | None = None
    device: Literal["auto", "cpu", "cuda"] = "auto"
    preset: Literal["fast", "balanced", "accurate"] = "balanced"
    arabic_punctuation: bool = True


class SegmentBody(BaseModel):
    start: float
    end: float
    text: str


class PdfBody(BaseModel):
    output_path: str | None = None
    media_name: str
    language_code: str = ""
    language_name: str = ""
    model_name: str | None = None
    duration: float | None = None
    include_timestamps: bool = True
    ui_language: Literal["ar", "en"] = "ar"
    segments: list[SegmentBody] = Field(default_factory=list)


def _safe_stem(name: str) -> str:
    stem = Path(name).stem or "transcript"
    stem = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", stem).strip(" .")
    return stem[:120] or "transcript"


def _unique(path: Path) -> Path:
    if not path.exists():
        return path
    for i in range(2, 1000):
        candidate = path.with_name(f"{path.stem} ({i}){path.suffix}")
        if not candidate.exists():
            return candidate
    return path


def create_app(settings: Settings) -> FastAPI:
    store = ModelStore(settings.models_dir)
    engine = Engine()
    jobs = JobManager(settings, store, engine)

    app = FastAPI(title="Local Transcriber backend", version=__version__, docs_url=None, redoc_url=None)

    # The UI is served from app:// (packaged) or http://localhost (dev).
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=r"^(app://.*|http://(localhost|127\.0\.0\.1)(:\d+)?|null)$",
        allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
        allow_headers=["X-Auth-Token", "Content-Type"],
    )

    @app.middleware("http")
    async def require_token(request: Request, call_next):  # noqa: ANN001, ANN202
        if request.method != "OPTIONS" and settings.auth_token:
            supplied = request.headers.get("x-auth-token", "")
            if not hmac.compare_digest(supplied, settings.auth_token):
                return JSONResponse({"error": {"code": "unauthorized", "detail": ""}}, status_code=401)
        return await call_next(request)

    @app.exception_handler(AppError)
    async def app_error_handler(_request: Request, exc: AppError) -> JSONResponse:
        return JSONResponse({"error": exc.to_dict()}, status_code=_STATUS_FOR_CODE.get(exc.code, 422))

    @app.exception_handler(Exception)
    async def unexpected_handler(_request: Request, exc: Exception) -> JSONResponse:
        log.exception("Unhandled error")
        return JSONResponse(
            {"error": {"code": ErrorCode.INTERNAL.value, "detail": exc.__class__.__name__}}, status_code=500
        )

    # ------------------------------------------------------------ endpoints
    @app.get("/health")
    def health() -> dict[str, object]:
        return {"ok": True, "version": __version__}

    @app.get("/system")
    def system() -> dict[str, object]:
        devices = detect_devices()
        # large-v3 needs ~5.5 GB of VRAM; smaller GPUs get large-v3-turbo (~3.5 GB).
        gpu_default = (
            DEFAULT_MODEL_GPU
            if devices.gpu_vram_mb is None or devices.gpu_vram_mb >= 6000
            else DEFAULT_MODEL_CPU
        )
        return {
            "version": __version__,
            "devices": devices.to_dict(),
            "ffmpegAvailable": bool(settings.ffmpeg_path),
            "defaultModel": gpu_default if devices.gpu_recommended else DEFAULT_MODEL_CPU,
            "defaultModelGpu": gpu_default,
            "defaultModelCpu": DEFAULT_MODEL_CPU,
            "modelsDir": str(settings.models_dir),
            "outputDir": str(settings.output_dir),
            "supportedExtensions": sorted(SUPPORTED_EXTENSIONS),
            "loadedModel": engine.loaded_key(),
        }

    @app.get("/models")
    def list_models() -> dict[str, object]:
        return {"models": store.list_models()}

    @app.post("/models/{model_id}/download")
    def download_model(model_id: str) -> dict[str, object]:
        return store.start_download(model_id).to_dict()

    @app.get("/models/{model_id}/download")
    def download_status(model_id: str) -> dict[str, object]:
        if model_id not in CATALOG:
            raise AppError(ErrorCode.INVALID_REQUEST, "Unknown model")
        return store.download_state(model_id).to_dict()

    @app.delete("/models/{model_id}")
    def delete_model(model_id: str) -> dict[str, bool]:
        if engine.loaded_key() and engine.loaded_key()[0] == model_id:  # type: ignore[index]
            engine.unload()
        store.delete(model_id)
        return {"ok": True}

    @app.post("/probe")
    def probe_media(body: ProbeBody) -> dict[str, object]:
        return probe(body.path).to_dict()

    @app.post("/jobs")
    def start_job(body: JobBody) -> dict[str, object]:
        job = jobs.start(
            JobRequest(
                path=body.path,
                model=body.model,
                language=(body.language or None) if body.language != "auto" else None,
                device=body.device,
                preset=body.preset,
                arabic_punctuation=body.arabic_punctuation,
            )
        )
        return job.snapshot()

    @app.get("/jobs/{job_id}")
    def job_status(job_id: str, since: int = 0) -> dict[str, object]:
        return jobs.get(job_id).snapshot(max(0, since))

    @app.post("/jobs/{job_id}/cancel")
    def cancel_job(job_id: str) -> dict[str, bool]:
        jobs.cancel(job_id)
        return {"ok": True}

    @app.post("/export/pdf")
    def export_pdf(body: PdfBody) -> dict[str, str]:
        if not body.segments:
            raise AppError(ErrorCode.INVALID_REQUEST, "Transcript is empty")
        if body.output_path:
            target = Path(body.output_path)
            if target.suffix.lower() != ".pdf":
                target = target.with_suffix(".pdf")
        else:
            target = _unique(settings.output_dir / f"{_safe_stem(body.media_name)} - transcript.pdf")
        path = generate_pdf(
            ExportRequest(
                output_path=target,
                media_name=body.media_name,
                language_code=body.language_code,
                language_name=body.language_name,
                model_name=body.model_name,
                duration=body.duration,
                include_timestamps=body.include_timestamps,
                ui_language=body.ui_language,
                segments=[ExportSegment(s.start, s.end, s.text) for s in body.segments],
                transcribed_at=datetime.now(),
            ),
            settings.fonts_dir,
        )
        return {"path": str(path)}

    return app
