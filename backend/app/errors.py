"""User-facing error model.

The backend never sends raw stack traces to the UI. Every failure is mapped to
a stable ``code`` that the frontend translates into a friendly Arabic/English
message; ``detail`` carries a short technical hint for the "details" toggle.
"""

from __future__ import annotations

from enum import Enum


class ErrorCode(str, Enum):
    FFMPEG_MISSING = "ffmpeg_missing"
    FILE_NOT_FOUND = "file_not_found"
    UNSUPPORTED_MEDIA = "unsupported_media"
    NO_AUDIO_STREAM = "no_audio_stream"
    CORRUPTED_MEDIA = "corrupted_media"
    MODEL_DOWNLOAD_FAILED = "model_download_failed"
    MODEL_NOT_DOWNLOADED_OFFLINE = "model_not_downloaded_offline"
    MODEL_LOAD_FAILED = "model_load_failed"
    LIVE_MODEL_MISSING = "live_model_missing"  # live mode needs the model downloaded first
    FREE_LIMIT = "free_limit"  # the free AI allowance of the day is used up
    FREE_AI_UNAVAILABLE = "free_ai_unavailable"  # the free AI relay refused (session, disabled)
    INSUFFICIENT_MEMORY = "insufficient_memory"
    CUDA_UNAVAILABLE = "cuda_unavailable"
    NO_SPEECH = "no_speech"
    TRANSCRIPTION_FAILED = "transcription_failed"
    PDF_FAILED = "pdf_failed"
    EXPORT_FAILED = "export_failed"
    BACKUP_INVALID = "backup_invalid"
    DB_DRIVER_MISSING = "db_driver_missing"
    DB_CONNECT_FAILED = "db_connect_failed"
    DB_QUERY_FAILED = "db_query_failed"
    YOUTUBE_INVALID_URL = "youtube_invalid_url"
    YOUTUBE_UNAVAILABLE = "youtube_unavailable"
    YOUTUBE_BOT_CHECK = "youtube_bot_check"
    YOUTUBE_NETWORK = "youtube_network"
    YOUTUBE_NO_CAPTIONS = "youtube_no_captions"
    YOUTUBE_FAILED = "youtube_failed"
    CLOUD_AUTH = "cloud_auth"
    CLOUD_QUOTA = "cloud_quota"
    CLOUD_RATE_LIMIT = "cloud_rate_limit"
    CLOUD_NETWORK = "cloud_network"
    CLOUD_FAILED = "cloud_failed"
    CLOUD_LANGUAGE_REQUIRED = "cloud_language_required"
    CLOUD_LANGUAGE_UNSUPPORTED = "cloud_language_unsupported"
    SUMMARY_FAILED = "summary_failed"
    SUMMARY_MODEL = "summary_model"
    SUMMARY_TOO_LONG = "summary_too_long"
    TRANSLATE_FAILED = "translate_failed"
    TRANSLATE_UNSUPPORTED = "translate_unsupported"
    TRANSLATE_SAME_LANGUAGE = "translate_same_language"
    CANCELLED = "cancelled"
    BUSY = "busy"
    INVALID_REQUEST = "invalid_request"
    INTERNAL = "internal"


class AppError(Exception):
    """An expected, explainable failure."""

    def __init__(self, code: ErrorCode, detail: str = "") -> None:
        super().__init__(f"{code.value}: {detail}")
        self.code = code
        self.detail = detail

    def to_dict(self) -> dict[str, str]:
        return {"code": self.code.value, "detail": self.detail}


class Cancelled(AppError):
    def __init__(self) -> None:
        super().__init__(ErrorCode.CANCELLED, "Cancelled by user")


def classify_exception(exc: BaseException) -> AppError:
    """Map an unexpected exception to the closest user-facing error."""
    if isinstance(exc, AppError):
        return exc
    if isinstance(exc, MemoryError):
        return AppError(ErrorCode.INSUFFICIENT_MEMORY, "Not enough RAM")

    text = str(exc)
    lowered = text.lower()
    if any(
        k in lowered
        for k in (
            "out of memory",
            "cudaerrormemoryallocation",
            "bad_alloc",
            "failed to allocate",  # e.g. Intel MKL: "mkl_malloc: failed to allocate memory"
            "cannot allocate memory",
            "allocation failed",
            "not enough memory",
        )
    ):
        return AppError(ErrorCode.INSUFFICIENT_MEMORY, _short(text))
    if any(k in lowered for k in ("cudnn", "cublas", "cuda driver", "cuda failed", "no cuda", "cuda error")):
        return AppError(ErrorCode.CUDA_UNAVAILABLE, _short(text))
    return AppError(ErrorCode.TRANSCRIPTION_FAILED, _short(text) or exc.__class__.__name__)


def _short(text: str, limit: int = 300) -> str:
    text = " ".join(text.split())
    return text if len(text) <= limit else text[: limit - 1] + "…"
