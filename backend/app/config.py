"""Runtime configuration and filesystem locations.

Every path is derived at runtime from environment variables (set by the
Electron main process) or from the location of this file, so nothing here is
tied to a particular machine or user name.
"""

from __future__ import annotations

import os
import shutil
import sys
from dataclasses import dataclass
from pathlib import Path

APP_NAME = "Local Transcriber"


def _is_frozen() -> bool:
    """True when running from a PyInstaller bundle (the packaged Windows app)."""
    return bool(getattr(sys, "frozen", False))


def backend_root() -> Path:
    """Directory that contains the backend's bundled resources (``assets/``)."""
    if _is_frozen():
        # PyInstaller extracts/places data files under sys._MEIPASS.
        return Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
    return Path(__file__).resolve().parent.parent


def project_root() -> Path:
    """Repository root in development (one level above ``backend/``)."""
    return Path(__file__).resolve().parent.parent.parent


def _default_models_dir() -> Path:
    if _is_frozen():
        # Packaged app: never write next to the executable (Program Files is
        # read-only). Use the per-user application data folder instead.
        base = os.environ.get("LOCALAPPDATA") or str(Path.home() / ".local" / "share")
        return Path(base) / APP_NAME / "models"
    return project_root() / "models"


def _default_output_dir() -> Path:
    documents = Path.home() / "Documents"
    base = documents if documents.exists() else Path.home()
    return base / APP_NAME


@dataclass(frozen=True)
class Settings:
    models_dir: Path
    output_dir: Path
    data_dir: Path  # archive database etc. (Electron passes its userData folder)
    fonts_dir: Path
    ffmpeg_path: str | None
    auth_token: str
    parent_pid: int | None


def _resolve_ffmpeg() -> str | None:
    """Find an FFmpeg executable.

    Order: explicit ``FFMPEG_PATH`` (Electron passes the binary shipped by the
    ``ffmpeg-static`` npm package) → FFmpeg on the system ``PATH``.
    """
    explicit = os.environ.get("FFMPEG_PATH")
    if explicit and Path(explicit).is_file():
        return explicit
    return shutil.which("ffmpeg")


def load_settings() -> Settings:
    models_dir = Path(os.environ.get("TRANSCRIBER_MODELS_DIR") or _default_models_dir())
    data_dir = Path(os.environ.get("TRANSCRIBER_DATA_DIR") or (models_dir.parent / "data"))
    output_dir = Path(os.environ.get("TRANSCRIBER_OUTPUT_DIR") or _default_output_dir())
    models_dir.mkdir(parents=True, exist_ok=True)

    parent_pid_raw = os.environ.get("TRANSCRIBER_PARENT_PID")
    return Settings(
        models_dir=models_dir,
        output_dir=output_dir,
        data_dir=data_dir,
        fonts_dir=backend_root() / "assets" / "fonts",
        ffmpeg_path=_resolve_ffmpeg(),
        auth_token=os.environ.get("TRANSCRIBER_TOKEN", ""),
        parent_pid=int(parent_pid_raw) if parent_pid_raw and parent_pid_raw.isdigit() else None,
    )


# Privacy: make sure no library phones home. Hugging Face is only contacted
# when the user explicitly downloads a model; telemetry is always disabled.
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("HF_HUB_DISABLE_IMPLICIT_TOKEN", "1")
os.environ.setdefault("DO_NOT_TRACK", "1")
