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
import time
import logging
import re
from datetime import datetime
from pathlib import Path
from typing import Literal

from starlette.concurrency import run_in_threadpool
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field

from . import __version__
from .config import Settings
from .errors import AppError, ErrorCode
from .jobs import JobManager, JobRequest
from .media import SUPPORTED_EXTENSIONS, probe
from .model_store import CATALOG, DEFAULT_MODEL_CPU, DEFAULT_MODEL_GPU, ModelStore
from . import db_export
from .pdf_export import ExportRequest, ExportSegment, generate_pdf
from .system_info import detect_devices
from .transcriber import Engine

log = logging.getLogger(__name__)

_STATUS_FOR_CODE = {
    ErrorCode.INVALID_REQUEST: 400,
    ErrorCode.FILE_NOT_FOUND: 404,
    ErrorCode.BUSY: 409,
    ErrorCode.FREE_LIMIT: 429,
}


class ProbeBody(BaseModel):
    path: str


class JobBody(BaseModel):
    path: str = ""
    youtube_url: str | None = None
    model: str
    language: str | None = None
    device: Literal["auto", "cpu", "cuda"] = "auto"
    preset: Literal["fast", "balanced", "accurate"] = "balanced"
    arabic_punctuation: bool = True
    engine: Literal["local", "cloud"] = "local"
    cloud_provider: str | None = None
    cloud_model: str | None = None
    api_key: str = Field(default="", max_length=500, repr=False)
    vocabulary: str = Field(default="", max_length=1000)


class LiveBody(BaseModel):
    model: str
    language: str | None = None
    device: Literal["auto", "cpu", "cuda"] = "auto"
    preset: Literal["fast", "balanced", "accurate"] = "balanced"
    arabic_punctuation: bool = True
    vocabulary: str = Field(default="", max_length=1000)
    title: str = Field(default="", max_length=300)
    course: str | None = Field(default=None, max_length=200)
    source: Literal["mic", "system", "both"] = "mic"
    save_recording: bool = True
    save_to_archive: bool = True


class SegmentBody(BaseModel):
    start: float
    end: float
    text: str


class ArchiveBody(BaseModel):
    id: str | None = None
    title: str = Field(default="", max_length=500)
    source_type: Literal["file", "youtube"] = "file"
    source: str = Field(default="", max_length=4000)
    duration: float | None = None
    language: str | None = None
    engine: str | None = None
    model: str | None = None
    segments: list[dict[str, object]] = Field(default_factory=list)
    summary: dict[str, object] | None = None
    translation: dict[str, object] | None = None
    course: str | None = Field(default=None, max_length=200)


class SummaryBody(BaseModel):
    provider: str
    model: str = Field(max_length=200)
    api_key: str = Field(max_length=500, repr=False)
    language: Literal["auto", "ar", "en"] = "auto"
    title: str = Field(default="", max_length=500)
    duration: float | None = None
    transcript_language: str | None = None
    archive_id: str | None = None  # save the result on this archive entry
    segments: list[SegmentBody] = Field(default_factory=list)


class ArchiveSummaryBody(BaseModel):
    summary: dict[str, object] | None = None


class ArchiveTranslationBody(BaseModel):
    translation: dict[str, object] | None = None


class TranslateOptionsBody(BaseModel):
    engine: Literal["local", "llm", "deepl", "azure"] = "local"
    target: Literal["en", "ar"] = "en"
    provider: str = ""
    model: str = Field(default="", max_length=200)
    api_key: str = Field(default="", max_length=500, repr=False)
    region: str = Field(default="", max_length=60)


class TranslateBody(TranslateOptionsBody):
    source: str | None = None
    title: str = Field(default="", max_length=500)
    archive_id: str | None = None
    segments: list[SegmentBody] = Field(default_factory=list)


class TranslateTestBody(BaseModel):
    engine: Literal["llm", "deepl", "azure"]
    provider: str = ""
    api_key: str = Field(max_length=500, repr=False)
    region: str = Field(default="", max_length=60)


class SubtitleBody(BaseModel):
    output_path: str | None = None
    media_name: str = ""
    format: Literal["srt", "vtt"] = "srt"
    language: str = Field(default="", max_length=10)  # used in the default file name (e.g. "lecture.en.srt")
    segments: list[SegmentBody] = Field(default_factory=list)


class AskBody(BaseModel):
    course: str | None = None
    question: str = Field(min_length=1, max_length=2000)
    provider: str
    model: str = Field(max_length=200)
    api_key: str = Field(max_length=500, repr=False)


class BurnBody(BaseModel):
    source: str = Field(min_length=1, max_length=2000)
    output_path: str | None = None
    media_name: str = ""
    segments: list[SegmentBody] = Field(default_factory=list)
    translation: list[SegmentBody] | None = None
    content: Literal["original", "translation", "both"] = "original"
    size: Literal["small", "medium", "large"] = "medium"
    style: Literal["box", "outline"] = "box"
    duration: float | None = None


class WatchAddBody(BaseModel):
    path: str = Field(min_length=1, max_length=1000)
    include_existing: bool = False
    recursive: bool = True


class WatchUpdateBody(BaseModel):
    enabled: bool | None = None
    recursive: bool | None = None


class BatchAddBody(BaseModel):
    paths: list[str] = Field(default_factory=list, max_length=5000)
    skip_archived: bool = True
    course: str | None = Field(default=None, max_length=200)


class BatchYoutubeBody(BaseModel):
    url: str = Field(max_length=2000)
    skip_archived: bool = True
    course: str | None = Field(default=None, max_length=200)


class CourseBody(BaseModel):
    course: str | None = Field(default=None, max_length=200)


class ArchiveBackupBody(BaseModel):
    path: str | None = Field(default=None, max_length=2000)  # None → the output folder


class ArchiveFileBody(BaseModel):
    path: str = Field(min_length=1, max_length=2000)


class ReplaceBody(BaseModel):
    find: str
    replace: str = ""
    course: str | None = None  # None: the whole archive, "": entries without a course
    exact: bool = False
    whole_word: bool = False
    include_summary: bool = True
    ids: list[str] | None = None  # apply: only these entries


class CourseRenameBody(BaseModel):
    old: str = Field(max_length=200)
    new: str | None = Field(default=None, max_length=200)


class BatchSummaryBody(BaseModel):
    provider: str
    model: str = Field(max_length=200)
    language: Literal["auto", "ar", "en"] = "auto"
    api_key: str = Field(max_length=500, repr=False)


class BatchStartBody(BaseModel):
    model: str = ""
    language: str | None = None
    device: Literal["auto", "cpu", "cuda"] = "auto"
    preset: Literal["fast", "balanced", "accurate"] = "balanced"
    arabic_punctuation: bool = True
    engine: Literal["local", "cloud"] = "local"
    cloud_provider: str | None = None
    cloud_model: str | None = None
    api_key: str = Field(default="", max_length=500, repr=False)
    summary: BatchSummaryBody | None = None
    translation: TranslateOptionsBody | None = None
    youtube_captions: bool = True
    db: "DbSettingsBody | None" = None
    vocabulary: str = Field(default="", max_length=1000)


class DbSettingsBody(BaseModel):
    """A saved database profile (connection + SQL) used for many lessons."""

    db_type: Literal["sqlserver", "oracle", "mysql", "postgresql"]
    connection_string: str = Field(default="", max_length=4000)
    sql: str = Field(max_length=100_000)
    pre_sql: str = Field(default="", max_length=100_000)
    mode: Literal["chunks", "segments", "full"] = "chunks"
    chunk_seconds: int = Field(default=10, ge=1, le=3600)
    variables: dict[str, str] = Field(default_factory=dict)

    def to_request(self) -> db_export.DbRequest:
        return db_export.DbRequest(
            db_type=self.db_type,
            connection_string=self.connection_string,
            sql=self.sql,
            pre_sql=self.pre_sql,
            mode=self.mode,
            chunk_seconds=self.chunk_seconds,
            variables={k.strip(): v for k, v in self.variables.items() if k.strip()},
        )


class CourseDbBody(BaseModel):
    course: str | None = None
    ids: list[str] | None = None
    db: DbSettingsBody


class CourseExportBody(BaseModel):
    course: str | None = None
    ids: list[str] | None = None
    dest_dir: str | None = Field(default=None, max_length=1000)
    pdf: bool = True
    pdf_timestamps: bool = False
    pdf_content: Literal["original", "both", "translation"] = "original"
    include_summary: bool = True
    subtitles: bool = True
    subtitles_translation: bool = True
    subtitle_format: Literal["srt", "vtt"] = "srt"
    ui_language: Literal["ar", "en"] = "ar"
    documents: list[Literal["docx", "txt", "json"]] = Field(default_factory=list)  # extra formats per lesson
    website: bool = False


class BatchStopBody(BaseModel):
    cancel_current: bool = False


class CloudKeyBody(BaseModel):
    provider: str
    api_key: str = Field(max_length=500, repr=False)


class YoutubeBody(BaseModel):
    url: str = Field(max_length=2000)


class YoutubeCaptionBody(YoutubeBody):
    lang: str = Field(max_length=40)
    kind: Literal["manual", "auto"] = "manual"


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
    summary: dict[str, object] | None = None
    translation: list[SegmentBody] | None = None
    translation_language_name: str = ""
    content: Literal["original", "translation", "both"] = "original"
    source: str = Field(default="", max_length=2000)
    engine: Literal["local", "cloud", "youtube"] = "local"


class DocumentBody(PdfBody):
    format: Literal["docx", "txt", "json"] = "docx"


class DbConnectionBody(BaseModel):
    db_type: Literal["sqlserver", "oracle", "mysql", "postgresql"]
    connection_string: str = Field(default="", max_length=4000)


class DbInsertBody(DbConnectionBody):
    sql: str = Field(max_length=100_000)
    pre_sql: str = Field(default="", max_length=100_000)
    mode: Literal["chunks", "segments", "full"] = "chunks"
    chunk_seconds: int = Field(default=10, ge=1, le=3600)
    variables: dict[str, str] = Field(default_factory=dict)
    file_name: str = ""
    file_path: str = ""
    language: str = ""
    model: str = ""
    duration: float | None = None
    segments: list[SegmentBody] = Field(default_factory=list)
    translation: list[SegmentBody] | None = None
    translation_language: str = ""
    summary: dict[str, object] | None = None
    course: str = ""

    def to_request(self) -> tuple[db_export.DbRequest, db_export.TranscriptPayload]:
        return (
            db_export.DbRequest(
                db_type=self.db_type,
                connection_string=self.connection_string,
                sql=self.sql,
                pre_sql=self.pre_sql,
                mode=self.mode,
                chunk_seconds=self.chunk_seconds,
                variables={k.strip(): v for k, v in self.variables.items() if k.strip()},
            ),
            db_export.TranscriptPayload(
                segments=[ExportSegment(s.start, s.end, s.text) for s in self.segments],
                file_name=self.file_name,
                file_path=self.file_path,
                language=self.language,
                model=self.model,
                duration=self.duration,
                translation=[ExportSegment(t.start, t.end, t.text) for t in self.translation] if self.translation else None,
                translation_language=self.translation_language,
                summary=self.summary,
                course=self.course,
            ),
        )


def _clean_vocabulary(text: str) -> str:
    """"SQL Server، إرساء\nد. أحمد" → "SQL Server, إرساء, د. أحمد" (limited so it stays a hint)."""
    words = [w.strip() for w in re.split(r"[,،;\n]+", text or "") if w.strip()]
    out, size = [], 0
    for w in dict.fromkeys(words):
        if size + len(w) > 400:
            break
        out.append(w)
        size += len(w) + 2
    return ", ".join(out)


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
    from . import find_replace
    from .archive import Archive

    archive = Archive(settings.data_dir / "archive.db")
    from .batch import BatchManager, BatchOptions, BatchSummaryOptions
    from .summarize import SummaryManager, SummaryRequest

    batch = BatchManager(jobs, archive, settings.data_dir / "batch-queue.json")
    from .watch import WatchManager

    watcher = WatchManager(batch, settings.data_dir / "watch-folders.json")
    summaries = SummaryManager(on_done=archive.set_summary)
    from .translate import TranslateRequest, TranslationManager

    translations = TranslationManager(store, on_done=archive.set_translation)
    from .course_tools import CourseTools, ExportOptions, course_lessons, payload_for

    course_tools = CourseTools(archive, settings.fonts_dir, settings.output_dir)
    from .burn import BurnManager, BurnRequest

    burner = BurnManager(settings.ffmpeg_path, settings.fonts_dir)
    from .assistant import AskRequest, AssistantManager

    assistant = AssistantManager(archive)
    from .live import LiveManager, LiveRequest

    live = LiveManager(jobs, archive, settings)
    jobs.live = live

    app = FastAPI(title="Local Transcriber backend", version=__version__, docs_url=None, redoc_url=None)

    # Requests the UI polls every second or two: logged only when they fail or are slow.
    quiet_gets = ("/batch", "/watch", "/jobs/", "/health", "/media/stream", "/models", "/system", "/summaries/",
                  "/translations/", "/burn/", "/assistant/", "/logs", "/live")

    @app.middleware("http")
    async def log_requests(request: Request, call_next):  # noqa: ANN001, ANN202
        started = time.perf_counter()
        try:
            response = await call_next(request)
        except Exception:
            log.exception("%s %s crashed", request.method, request.url.path)
            raise
        ms = (time.perf_counter() - started) * 1000
        path = request.url.path
        quiet = (request.method in ("GET", "OPTIONS") and path.startswith(quiet_gets)) or (
            request.method == "POST" and path.startswith("/live/") and path.endswith("/audio")  # ~1 per second
        )
        if response.status_code >= 500:
            log.error("%s %s -> %d (%.0f ms)", request.method, path, response.status_code, ms)
        elif response.status_code >= 400:
            log.warning("%s %s -> %d (%.0f ms)", request.method, path, response.status_code, ms)
        elif not quiet or ms > 5000:
            log.info("%s %s -> %d (%.0f ms)", request.method, path, response.status_code, ms)
        return response

    @app.middleware("http")
    async def require_token(request: Request, call_next):  # noqa: ANN001, ANN202
        if request.method != "OPTIONS" and settings.auth_token:
            supplied = request.headers.get("x-auth-token", "")
            if not supplied and request.method == "GET" and request.url.path == "/media/stream":
                # <video> cannot send headers, so the player passes the token in the URL.
                supplied = request.query_params.get("token", "")
            if not hmac.compare_digest(supplied, settings.auth_token):
                return JSONResponse({"error": {"code": "unauthorized", "detail": ""}}, status_code=401)
        return await call_next(request)

    # The UI is served from app:// (packaged) or http://localhost (dev). Added after the
    # token middleware so CORS is the outermost layer: even a 401 carries CORS headers.
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=r"^(app://.*|http://(localhost|127\.0\.0\.1)(:\d+)?|null)$",
        allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
        allow_headers=["X-Auth-Token", "Content-Type"],
    )

    @app.exception_handler(AppError)
    async def app_error_handler(request: Request, exc: AppError) -> JSONResponse:
        log.warning("%s %s failed: %s — %s", request.method, request.url.path, exc.code.value, exc.detail)
        return JSONResponse({"error": exc.to_dict()}, status_code=_STATUS_FOR_CODE.get(exc.code, 422))

    @app.exception_handler(Exception)
    async def unexpected_handler(request: Request, exc: Exception) -> JSONResponse:
        log.error("Unhandled error in %s %s", request.method, request.url.path, exc_info=exc)
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
        if model_id in CATALOG and CATALOG[model_id].engine == "cohere":
            jobs.cohere.unload()
        store.delete(model_id)
        return {"ok": True}

    @app.post("/probe")
    def probe_media(body: ProbeBody) -> dict[str, object]:
        return probe(body.path).to_dict()

    # ---- Live transcription (microphone / computer audio) ----
    @app.post("/live")
    def live_start(body: LiveBody) -> dict[str, object]:
        return live.start(LiveRequest(**body.model_dump())).snapshot()

    @app.get("/live/current")
    def live_current() -> dict[str, object]:
        s = live.active()
        return {"session": s.snapshot() if s else None}

    @app.post("/live/{session_id}/audio")
    async def live_audio(session_id: str, request: Request) -> dict[str, object]:
        data = await request.body()  # 16 kHz mono 16-bit PCM, little-endian
        return await run_in_threadpool(live.feed, session_id, data)

    @app.get("/live/{session_id}")
    def live_state(session_id: str, since: int = 0) -> dict[str, object]:
        return live.get(session_id).snapshot(since)

    @app.post("/live/{session_id}/stop")
    def live_stop(session_id: str) -> dict[str, object]:
        return live.stop(session_id).snapshot()

    @app.post("/live/{session_id}/cancel")
    def live_cancel(session_id: str) -> dict[str, bool]:
        live.cancel(session_id)
        return {"ok": True}

    @app.post("/jobs")
    def start_job(body: JobBody) -> dict[str, object]:
        youtube_url = None
        if body.youtube_url:
            from .youtube import normalize_url

            youtube_url = normalize_url(body.youtube_url)
        elif not body.path:
            raise AppError(ErrorCode.INVALID_REQUEST, "No file or link given")
        job = jobs.start(
            JobRequest(
                youtube_url=youtube_url,
                path=youtube_url or body.path,
                model=body.model,
                language=(body.language or None) if body.language != "auto" else None,
                device=body.device,
                preset=body.preset,
                arabic_punctuation=body.arabic_punctuation,
                engine=body.engine,
                cloud_provider=body.cloud_provider,
                cloud_model=body.cloud_model,
                api_key=body.api_key.strip(),
                vocabulary=_clean_vocabulary(body.vocabulary),
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

    # ---- Archive -------------------------------------------------------------------
    @app.get("/archive")
    def archive_list(q: str = "", limit: int = 50, offset: int = 0, course: str | None = None) -> dict[str, object]:
        return archive.list(q, limit, offset, course)

    @app.get("/archive/courses")
    def archive_courses() -> dict[str, object]:
        return archive.courses()

    @app.post("/archive/courses/rename")
    def archive_course_rename(body: CourseRenameBody) -> dict[str, object]:
        return {"changed": archive.rename_course(body.old, body.new)}

    @app.put("/archive/{item_id}/course")
    def archive_set_course(item_id: str, body: CourseBody) -> dict[str, bool]:
        archive.set_course(item_id, body.course)
        return {"ok": True}

    # ---- Ask the course (user's own AI key) ----------------------------------
    @app.post("/assist/ask")
    def assist_ask(body: AskBody) -> dict[str, object]:
        return assistant.start_ask(
            AskRequest(course=body.course, question=body.question, provider=body.provider, model=body.model, api_key=body.api_key)
        ).snapshot()

    @app.get("/assist/{task_id}")
    def assist_status(task_id: str) -> dict[str, object]:
        return assistant.get(task_id).snapshot()

    @app.post("/assist/{task_id}/cancel")
    def assist_cancel(task_id: str) -> dict[str, bool]:
        assistant.cancel(task_id)
        return {"ok": True}

    @app.post("/export/burn")
    def export_burn(body: BurnBody) -> dict[str, object]:
        """Start writing a copy of the video with the subtitles drawn on it."""
        if not body.segments:
            raise AppError(ErrorCode.INVALID_REQUEST, "Transcript is empty")
        if body.output_path:
            target = Path(body.output_path).with_suffix(".mp4")
        else:
            label = {"original": "subtitled", "translation": "translated", "both": "bilingual"}[body.content]
            target = _unique(settings.output_dir / f"{_safe_stem(body.media_name or Path(body.source).name)} ({label}).mp4")
        if target.resolve() == Path(body.source).resolve():
            raise AppError(ErrorCode.INVALID_REQUEST, "The output would overwrite the original video")
        req = BurnRequest(
            source=body.source,
            output=target,
            segments=[s.model_dump() for s in body.segments],
            translation=[s.model_dump() for s in body.translation] if body.translation else None,
            content=body.content,
            size=body.size,
            style=body.style,
            duration=body.duration,
        )
        return burner.start(req).snapshot()

    @app.get("/export/burn/{task_id}")
    def export_burn_status(task_id: str) -> dict[str, object]:
        return burner.get(task_id).snapshot()

    @app.post("/export/burn/{task_id}/cancel")
    def export_burn_cancel(task_id: str) -> dict[str, bool]:
        burner.cancel(task_id)
        return {"ok": True}

    @app.get("/media/stream")
    def media_stream(path: str) -> FileResponse:
        """The local media file for the built-in player (with Range support so it can seek)."""
        import mimetypes

        from .media import SUPPORTED_EXTENSIONS

        target = Path(path)
        if target.suffix.lower() not in SUPPORTED_EXTENSIONS:
            raise AppError(ErrorCode.UNSUPPORTED_MEDIA, target.suffix)
        if not target.is_file():
            raise AppError(ErrorCode.FILE_NOT_FOUND, str(target))
        overrides = {".mkv": "video/x-matroska", ".m4a": "audio/mp4", ".opus": "audio/ogg", ".oga": "audio/ogg", ".m4v": "video/mp4"}
        mime = overrides.get(target.suffix.lower()) or mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        return FileResponse(target, media_type=mime, headers={"Cache-Control": "no-store"})

    @app.post("/archive/replace/preview")
    def archive_replace_preview(body: ReplaceBody) -> dict[str, object]:
        res = find_replace.preview(
            archive, body.find, body.replace, body.course, body.exact, body.whole_word, body.include_summary
        )
        res["undo"] = find_replace.undo_state(archive)
        return res

    @app.post("/archive/replace/apply")
    def archive_replace_apply(body: ReplaceBody) -> dict[str, object]:
        if body.ids is None:
            raise AppError(ErrorCode.INVALID_REQUEST, "Choose the entries to change")
        res = find_replace.apply(
            archive, body.find, body.replace, body.ids, body.course, body.exact, body.whole_word, body.include_summary
        )
        log.info("Find & replace: %s replacement(s) in %s entr(ies)", res["replacements"], res["changed_items"])
        return res

    @app.get("/archive/replace/undo")
    def archive_replace_undo_state() -> dict[str, object]:
        return {"undo": find_replace.undo_state(archive)}

    @app.post("/archive/replace/undo")
    def archive_replace_undo() -> dict[str, object]:
        res = find_replace.undo(archive)
        log.info("Find & replace undone: %s entr(ies) restored", res["restored_items"])
        return res

    @app.get("/archive/stats")
    def archive_stats(months: int = 12) -> dict[str, object]:
        return archive.stats(months)

    @app.post("/archive/backup")
    def archive_backup(body: ArchiveBackupBody) -> dict[str, object]:
        from datetime import date

        dest = Path(body.path) if body.path else settings.output_dir / f"archive-backup-{date.today().isoformat()}.ltbackup"
        return archive.backup(dest)

    @app.post("/archive/restore")
    def archive_restore(body: ArchiveFileBody) -> dict[str, object]:
        return archive.restore(Path(body.path))

    @app.get("/archive/{item_id}")
    def archive_get(item_id: str) -> dict[str, object]:
        return archive.get(item_id)

    @app.post("/archive")
    def archive_save(body: ArchiveBody) -> dict[str, object]:
        return archive.save(body.model_dump())

    @app.put("/archive/{item_id}/summary")
    def archive_set_summary(item_id: str, body: ArchiveSummaryBody) -> dict[str, bool]:
        archive.set_summary(item_id, body.summary)
        return {"ok": True}

    @app.put("/archive/{item_id}/translation")
    def archive_set_translation(item_id: str, body: ArchiveTranslationBody) -> dict[str, bool]:
        archive.set_translation(item_id, body.translation)
        return {"ok": True}

    @app.delete("/archive/{item_id}")
    def archive_delete(item_id: str) -> dict[str, bool]:
        archive.delete(item_id)
        return {"ok": True}

    # ---- Paid cloud providers ---------------------------------------------------
    @app.get("/cloud/providers")
    def cloud_providers() -> dict[str, object]:
        from .cloud import list_providers

        return {"providers": list_providers()}

    @app.post("/cloud/test")
    def cloud_test(body: CloudKeyBody) -> dict[str, object]:
        from .cloud import test_key

        return test_key(body.provider, body.api_key)

    # ---- AI summaries (text only, user's own key) ---------------------------------
    @app.get("/summary/providers")
    def summary_providers() -> dict[str, object]:
        from .summarize import list_providers

        return {"providers": list_providers()}

    @app.post("/summary/test")
    def summary_test(body: CloudKeyBody) -> dict[str, object]:
        from .summarize import test_key

        return test_key(body.provider, body.api_key)

    @app.post("/summary")
    def summary_start(body: SummaryBody) -> dict[str, object]:
        if not body.segments:
            raise AppError(ErrorCode.INVALID_REQUEST, "Transcript is empty")
        task = summaries.start(
            SummaryRequest(
                segments=[s.model_dump() for s in body.segments],
                provider=body.provider,
                model=body.model,
                api_key=body.api_key,
                language=body.language,
                title=body.title,
                duration=body.duration,
                transcript_language=body.transcript_language,
            ),
            archive_id=body.archive_id,
        )
        return task.snapshot()

    @app.get("/summary/{task_id}")
    def summary_status(task_id: str) -> dict[str, object]:
        return summaries.get(task_id).snapshot()

    @app.post("/summary/{task_id}/cancel")
    def summary_cancel(task_id: str) -> dict[str, bool]:
        summaries.cancel(task_id)
        return {"ok": True}

    # ---- Whole-course actions -------------------------------------------------------
    @app.get("/courses/lessons")
    def courses_lessons(course: str | None = None) -> dict[str, object]:
        lessons = course_lessons(archive, course)
        return {
            "lessons": [
                {
                    "id": l["id"],
                    "index": l["lesson_index"],
                    "title": l["title"],
                    "duration": l["duration"],
                    "has_translation": bool(l.get("has_translation")),
                    "has_summary": bool(l.get("has_summary")),
                }
                for l in lessons
            ]
        }

    @app.post("/courses/db/preview")
    def courses_db_preview(body: CourseDbBody) -> dict[str, object]:
        lessons = course_lessons(archive, body.course)
        wanted = set(body.ids) if body.ids else None
        first = next((l for l in lessons if wanted is None or l["id"] in wanted), None)
        if first is None:
            raise AppError(ErrorCode.INVALID_REQUEST, "No lessons selected")
        result = db_export.preview(body.db.to_request(), payload_for(archive.get(first["id"]), first["lesson_index"]))
        return {**result, "lessonTitle": first["title"], "lessonIndex": first["lesson_index"]}

    @app.post("/courses/db")
    def courses_db(body: CourseDbBody) -> dict[str, object]:
        return course_tools.start_db(body.db.to_request(), body.course, body.ids).snapshot()

    @app.post("/courses/export")
    def courses_export(body: CourseExportBody) -> dict[str, object]:
        options = ExportOptions(**body.model_dump(exclude={"course", "ids"}))
        return course_tools.start_export(body.course, body.ids, options).snapshot()

    @app.get("/courses/tasks/{task_id}")
    def courses_task(task_id: str) -> dict[str, object]:
        return course_tools.get(task_id).snapshot()

    @app.post("/courses/tasks/{task_id}/cancel")
    def courses_task_cancel(task_id: str) -> dict[str, bool]:
        course_tools.cancel(task_id)
        return {"ok": True}

    # ---- Translation -----------------------------------------------------------------
    @app.get("/translate/catalog")
    def translate_catalog() -> dict[str, object]:
        from .translate import catalog

        return catalog(store)

    @app.post("/translate/models/{key}/download")
    def translate_model_download(key: str) -> dict[str, object]:
        from .translate import LOCAL_MODELS

        model = next((m for m in LOCAL_MODELS.values() if m.key == key), None)
        if model is None:
            raise AppError(ErrorCode.INVALID_REQUEST, "Unknown translation model")
        return store.start_extra_download(model.key, model.repo, list(model.patterns), model.size_mb).to_dict()

    @app.delete("/translate/models/{key}")
    def translate_model_delete(key: str) -> dict[str, bool]:
        from .translate import LOCAL_MODELS, _local_cache

        if not any(m.key == key for m in LOCAL_MODELS.values()):
            raise AppError(ErrorCode.INVALID_REQUEST, "Unknown translation model")
        _local_cache.pop(key, None)
        store.delete_extra(key)
        return {"ok": True}

    @app.post("/translate/test")
    def translate_test(body: TranslateTestBody) -> dict[str, object]:
        from .translate import test_key

        return test_key(body.engine, body.api_key, body.region, body.provider)

    @app.post("/translate")
    def translate_start(body: TranslateBody) -> dict[str, object]:
        if not body.segments:
            raise AppError(ErrorCode.INVALID_REQUEST, "Transcript is empty")
        task = translations.start(
            TranslateRequest(
                segments=[s.model_dump() for s in body.segments],
                engine=body.engine,
                target=body.target,
                source=body.source,
                provider=body.provider,
                model=body.model,
                api_key=body.api_key,
                region=body.region,
                title=body.title,
            ),
            archive_id=body.archive_id,
        )
        return task.snapshot()

    @app.get("/translate/{task_id}")
    def translate_status(task_id: str) -> dict[str, object]:
        return translations.get(task_id).snapshot()

    @app.post("/translate/{task_id}/cancel")
    def translate_cancel(task_id: str) -> dict[str, bool]:
        translations.cancel(task_id)
        return {"ok": True}

    @app.post("/export/subtitles")
    def export_subtitles(body: SubtitleBody) -> dict[str, str]:
        from .subtitles import write_subtitles

        if not body.segments:
            raise AppError(ErrorCode.INVALID_REQUEST, "Transcript is empty")
        if body.output_path:
            target = Path(body.output_path)
            if target.suffix.lower() != f".{body.format}":
                target = target.with_suffix(f".{body.format}")
        else:
            lang = re.sub(r"[^A-Za-z-]", "", body.language)[:10]
            name = f"{_safe_stem(body.media_name)}{'.' + lang if lang else ''}.{body.format}"
            target = _unique(settings.output_dir / name)
        path = write_subtitles([s.model_dump() for s in body.segments], body.format, target)
        return {"path": str(path)}

    # ---- Batch queue --------------------------------------------------------------
    @app.get("/batch")
    def batch_state() -> dict[str, object]:
        return batch.snapshot()

    @app.post("/batch/dismiss_restored")
    def batch_dismiss_restored() -> dict[str, bool]:
        batch.restored = None
        return {"ok": True}

    @app.post("/batch/add")
    def batch_add(body: BatchAddBody) -> dict[str, object]:
        return batch.add(body.paths, body.skip_archived, body.course)

    @app.post("/batch/add_youtube")
    def batch_add_youtube(body: BatchYoutubeBody) -> dict[str, object]:
        return batch.add_youtube(body.url, body.skip_archived, body.course)

    @app.post("/batch/start")
    def batch_start(body: BatchStartBody) -> dict[str, object]:
        return batch.start(
            BatchOptions(
                model=body.model,
                language=(body.language or None) if body.language != "auto" else None,
                device=body.device,
                preset=body.preset,
                arabic_punctuation=body.arabic_punctuation,
                engine=body.engine,
                cloud_provider=body.cloud_provider,
                cloud_model=body.cloud_model,
                api_key=body.api_key.strip(),
                youtube_captions=body.youtube_captions,
                vocabulary=_clean_vocabulary(body.vocabulary),
                db=body.db.to_request() if body.db else None,
                translation=TranslateRequest(
                    segments=[],
                    engine=body.translation.engine,
                    target=body.translation.target,
                    provider=body.translation.provider,
                    model=body.translation.model,
                    api_key=body.translation.api_key.strip(),
                    region=body.translation.region,
                )
                if body.translation
                else None,
                summary=BatchSummaryOptions(
                    provider=body.summary.provider,
                    model=body.summary.model,
                    language=body.summary.language,
                    api_key=body.summary.api_key.strip(),
                )
                if body.summary
                else None,
            )
        )

    @app.post("/batch/stop")
    def batch_stop(body: BatchStopBody) -> dict[str, object]:
        return batch.stop(body.cancel_current)

    @app.post("/batch/items/{item_id}/retry")
    def batch_retry(item_id: str) -> dict[str, object]:
        batch.retry(item_id)
        return batch.snapshot()

    @app.post("/batch/items/{item_id}/move")
    def batch_move(item_id: str, delta: int = 1) -> dict[str, object]:
        batch.move(item_id, delta)
        return batch.snapshot()

    @app.delete("/batch/items/{item_id}")
    def batch_remove(item_id: str) -> dict[str, object]:
        batch.remove(item_id)
        return batch.snapshot()

    @app.post("/batch/clear")
    def batch_clear(which: Literal["finished", "all"] = "finished") -> dict[str, object]:
        batch.clear(which)
        return batch.snapshot()

    # ---- Watched folders (new videos are queued automatically) ----------------
    @app.get("/watch")
    def watch_state() -> dict[str, object]:
        return watcher.snapshot()

    @app.post("/watch/folders")
    def watch_add(body: WatchAddBody) -> dict[str, object]:
        return watcher.add(body.path, body.include_existing, body.recursive)

    @app.patch("/watch/folders/{folder_id}")
    def watch_update(folder_id: str, body: WatchUpdateBody) -> dict[str, object]:
        return watcher.update(folder_id, body.enabled, body.recursive)

    @app.delete("/watch/folders/{folder_id}")
    def watch_remove(folder_id: str) -> dict[str, object]:
        return watcher.remove(folder_id)

    @app.post("/watch/scan")
    def watch_scan() -> dict[str, object]:
        return watcher.scan_now()

    # ---- YouTube ---------------------------------------------------------------
    @app.post("/youtube/inspect")
    def youtube_inspect(body: YoutubeBody) -> dict[str, object]:
        from .youtube import inspect

        return inspect(body.url).to_dict()

    @app.post("/youtube/subtitles")
    def youtube_subtitles(body: YoutubeCaptionBody) -> dict[str, object]:
        from .youtube import fetch_subtitles

        return fetch_subtitles(body.url, body.lang, body.kind)

    # ---- Insert into the user's own database --------------------------------
    @app.post("/db/test")
    def db_test(body: DbConnectionBody) -> dict[str, object]:
        return db_export.test_connection(body.db_type, body.connection_string)

    @app.post("/db/preview")
    def db_preview(body: DbInsertBody) -> dict[str, object]:
        return db_export.preview(*body.to_request())

    @app.post("/db/execute")
    def db_execute(body: DbInsertBody) -> dict[str, object]:
        return db_export.execute(*body.to_request())

    def _export_request(body: PdfBody, target: Path) -> ExportRequest:
        return ExportRequest(
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
            source=body.source,
            engine=body.engine,
            summary=body.summary,
            translation=[ExportSegment(t.start, t.end, t.text) for t in body.translation] if body.translation else None,
            translation_language_name=body.translation_language_name,
            content=body.content,
        )

    def _target(output_path: str | None, media_name: str, suffix: str) -> Path:
        if output_path:
            target = Path(output_path)
            return target if target.suffix.lower() == suffix else target.with_suffix(suffix)
        return _unique(settings.output_dir / f"{_safe_stem(media_name)} - transcript{suffix}")

    @app.post("/export/pdf")
    def export_pdf(body: PdfBody) -> dict[str, str]:
        if not body.segments:
            raise AppError(ErrorCode.INVALID_REQUEST, "Transcript is empty")
        path = generate_pdf(_export_request(body, _target(body.output_path, body.media_name, ".pdf")), settings.fonts_dir)
        return {"path": str(path)}

    @app.post("/export/document")
    def export_document(body: DocumentBody) -> dict[str, str]:
        """Word (.docx), plain text (.txt) or JSON — same options as the PDF."""
        from .documents import write_document

        if not body.segments:
            raise AppError(ErrorCode.INVALID_REQUEST, "Transcript is empty")
        target = _target(body.output_path, body.media_name, f".{body.format}")
        return {"path": str(write_document(_export_request(body, target), body.format))}

    return app
