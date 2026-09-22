"""Local Whisper model cache.

Models are CTranslate2 conversions of OpenAI Whisper published on the Hugging
Face Hub (no account or API key needed). Each model is downloaded exactly once
into ``<models_dir>/<model-id>/`` and afterwards loaded straight from disk, so
transcription works fully offline.

A ``.complete`` marker is written only after every file has arrived; a
half-finished download (closed app, lost connection) is resumed next time
instead of being treated as a valid model.
"""

from __future__ import annotations

import json
import logging
import shutil
import threading
import time
from dataclasses import asdict, dataclass
from pathlib import Path

from .errors import AppError, ErrorCode

log = logging.getLogger(__name__)

_MODEL_FILES = ["config.json", "preprocessor_config.json", "model.bin", "tokenizer.json", "vocabulary.*"]
_MARKER = ".complete"


@dataclass(frozen=True)
class ModelSpec:
    id: str
    repo: str
    download_mb: int  # approximate download size
    ram_cpu_mb: int  # approximate RAM when running int8 on CPU
    vram_gpu_mb: int  # approximate VRAM when running float16 on GPU (batched)
    speed: int  # 1 (slowest) … 5 (fastest)
    arabic_accuracy: int  # 1 (weak) … 5 (best)


CATALOG: dict[str, ModelSpec] = {
    spec.id: spec
    for spec in (
        ModelSpec("tiny", "Systran/faster-whisper-tiny", 75, 500, 1000, 5, 1),
        ModelSpec("base", "Systran/faster-whisper-base", 145, 700, 1200, 5, 2),
        ModelSpec("small", "Systran/faster-whisper-small", 485, 1300, 2000, 4, 3),
        ModelSpec("medium", "Systran/faster-whisper-medium", 1530, 2600, 3500, 2, 4),
        ModelSpec("large-v3-turbo", "mobiuslabsgmbh/faster-whisper-large-v3-turbo", 1620, 3000, 3500, 4, 4),
        ModelSpec("large-v3", "Systran/faster-whisper-large-v3", 3090, 4500, 5500, 1, 5),
    )
}

# Defaults chosen for Arabic: on a GPU large-v3 is fast enough and is the most
# accurate Whisper for Arabic; on a CPU large-v3-turbo keeps near-large-v3
# accuracy with a 4-layer decoder, making it several times faster.
DEFAULT_MODEL_GPU = "large-v3"
DEFAULT_MODEL_CPU = "large-v3-turbo"


@dataclass
class DownloadState:
    model: str
    status: str = "idle"  # idle | downloading | done | error
    downloaded_bytes: int = 0
    total_bytes: int = 0
    error: dict[str, str] | None = None

    def to_dict(self) -> dict[str, object]:
        return asdict(self)


def _dir_size(path: Path) -> int:
    total = 0
    if not path.exists():
        return 0
    for p in path.rglob("*"):
        try:
            if p.is_file():
                total += p.stat().st_size
        except OSError:
            continue
    return total


class ModelStore:
    def __init__(self, models_dir: Path) -> None:
        self.models_dir = models_dir
        self._lock = threading.Lock()
        self._downloads: dict[str, DownloadState] = {}
        self._threads: dict[str, threading.Thread] = {}

    # ---------------------------------------------------------------- queries
    def spec(self, model_id: str) -> ModelSpec:
        spec = CATALOG.get(model_id)
        if spec is None:
            raise AppError(ErrorCode.INVALID_REQUEST, f"Unknown model '{model_id}'")
        return spec

    def path_for(self, model_id: str) -> Path:
        return self.models_dir / model_id

    def is_downloaded(self, model_id: str) -> bool:
        path = self.path_for(model_id)
        return (path / _MARKER).is_file() and (path / "model.bin").is_file()

    def list_models(self) -> list[dict[str, object]]:
        items = []
        for spec in CATALOG.values():
            state = self._downloads.get(spec.id)
            items.append(
                {
                    **asdict(spec),
                    "downloaded": self.is_downloaded(spec.id),
                    "download": state.to_dict() if state else None,
                }
            )
        return items

    def download_state(self, model_id: str) -> DownloadState:
        with self._lock:
            return self._downloads.get(model_id) or DownloadState(
                model=model_id, status="done" if self.is_downloaded(model_id) else "idle"
            )

    # -------------------------------------------------------------- downloads
    def start_download(self, model_id: str) -> DownloadState:
        """Start (or join) a background download. Idempotent."""
        spec = self.spec(model_id)
        with self._lock:
            if self.is_downloaded(model_id):
                state = DownloadState(model_id, "done")
                self._downloads[model_id] = state
                return state
            thread = self._threads.get(model_id)
            if thread and thread.is_alive():
                return self._downloads[model_id]
            state = DownloadState(model_id, "downloading", total_bytes=spec.download_mb * 1024 * 1024)
            self._downloads[model_id] = state
            thread = threading.Thread(target=self._download, args=(spec, state), daemon=True, name=f"dl-{model_id}")
            self._threads[model_id] = thread
            thread.start()
            return state

    def wait_for_download(self, model_id: str, on_progress, is_cancelled) -> None:
        """Block until the model is available, reporting progress; raises on failure."""
        state = self.start_download(model_id)
        while True:
            with self._lock:
                status = state.status
                done, total = state.downloaded_bytes, state.total_bytes
                error = state.error
            if status == "done":
                return
            if status == "error":
                code = ErrorCode(error["code"]) if error else ErrorCode.MODEL_DOWNLOAD_FAILED
                raise AppError(code, (error or {}).get("detail", ""))
            if is_cancelled():
                # The download keeps running in the background so the work
                # isn't wasted; only the transcription job stops.
                from .errors import Cancelled

                raise Cancelled()
            on_progress(done, total)
            time.sleep(0.4)

    def _download(self, spec: ModelSpec, state: DownloadState) -> None:
        from faster_whisper.utils import disabled_tqdm
        from huggingface_hub import HfApi, snapshot_download

        target = self.path_for(spec.id)
        target.mkdir(parents=True, exist_ok=True)

        # Exact size (for an accurate progress bar) when the Hub is reachable.
        try:
            info = HfApi().model_info(spec.repo, files_metadata=True)
            exact = sum(
                (s.size or 0)
                for s in (info.siblings or [])
                if any(Path(s.rfilename).match(p) for p in _MODEL_FILES)
            )
            if exact > 0:
                state.total_bytes = exact
        except Exception as exc:  # noqa: BLE001 - offline / proxy: keep estimate
            log.info("Could not fetch model metadata for %s: %s", spec.id, exc)

        stop_polling = threading.Event()

        def poll() -> None:
            while not stop_polling.wait(0.5):
                size = _dir_size(target)
                with self._lock:
                    state.downloaded_bytes = min(size, state.total_bytes or size)

        poller = threading.Thread(target=poll, daemon=True)
        poller.start()
        try:
            snapshot_download(
                spec.repo,
                local_dir=str(target),
                allow_patterns=_MODEL_FILES,
                tqdm_class=disabled_tqdm,  # progress comes from the poller above
            )
            if not (target / "model.bin").is_file():
                raise RuntimeError("model.bin missing after download")
            (target / _MARKER).write_text(
                json.dumps({"repo": spec.repo, "downloaded_at": time.time()}), encoding="utf-8"
            )
            # Remove Hugging Face's bookkeeping folder; the model itself is all we need.
            shutil.rmtree(target / ".cache", ignore_errors=True)
            with self._lock:
                state.status = "done"
                state.downloaded_bytes = state.total_bytes
        except Exception as exc:  # noqa: BLE001
            log.exception("Model download failed: %s", spec.id)
            with self._lock:
                state.status = "error"
                state.error = AppError(
                    ErrorCode.MODEL_DOWNLOAD_FAILED, f"{exc.__class__.__name__}: {exc}"[:300]
                ).to_dict()
        finally:
            stop_polling.set()

    def delete(self, model_id: str) -> None:
        self.spec(model_id)
        with self._lock:
            thread = self._threads.get(model_id)
            if thread and thread.is_alive():
                raise AppError(ErrorCode.BUSY, "Model is currently downloading")
            shutil.rmtree(self.path_for(model_id), ignore_errors=True)
            self._downloads.pop(model_id, None)
