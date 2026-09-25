"""Local model cache.

Models are CTranslate2 conversions of OpenAI Whisper published on the Hugging
Face Hub (no account or API key needed), plus the ONNX export of Cohere
Transcribe Arabic (run with sherpa-onnx, see cohere_engine.py). Each model is downloaded exactly once
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
    ram_cpu_mb: int  # approximate working set when running int8 on CPU (measured, not peak virtual)
    vram_gpu_mb: int  # approximate VRAM when running float16 on GPU (batched)
    speed: int  # 1 (slowest) … 5 (fastest)
    arabic_accuracy: int  # 1 (weak) … 5 (best)
    engine: str = "whisper"  # whisper (faster-whisper) | cohere (sherpa-onnx)
    files: tuple[str, ...] = ()  # files to download (default: the Whisper set)
    languages: tuple[str, ...] = ()  # supported languages; empty = all Whisper languages
    gpu: bool = True  # False: always runs on the CPU
    experimental: bool = False
    # Fallback sources when the Hugging Face repo fails (deleted, blocked, offline):
    # base URLs that serve each file by its name, e.g. a GitHub Release.
    mirrors: tuple[str, ...] = ()

    @property
    def patterns(self) -> list[str]:
        return list(self.files) if self.files else _MODEL_FILES

    @property
    def required(self) -> str:
        """The file whose presence proves the download finished."""
        return self.files[1] if self.files else "model.bin"


CATALOG: dict[str, ModelSpec] = {
    spec.id: spec
    for spec in (
        ModelSpec("tiny", "Systran/faster-whisper-tiny", 75, 350, 1000, 5, 1),
        ModelSpec("base", "Systran/faster-whisper-base", 145, 450, 1200, 5, 2),
        ModelSpec("small", "Systran/faster-whisper-small", 485, 900, 2000, 4, 3),
        ModelSpec("medium", "Systran/faster-whisper-medium", 1530, 1700, 3500, 2, 4),
        ModelSpec("large-v3-turbo", "mobiuslabsgmbh/faster-whisper-large-v3-turbo", 1620, 2000, 3500, 4, 4),
        ModelSpec("large-v3", "Systran/faster-whisper-large-v3", 3090, 3300, 5500, 1, 5),
        # Cohere Transcribe Arabic (07-2026), 4-bit ONNX export: Arabic-specialized
        # (MSA + dialects), Arabic/English only, CPU only, segment times from the VAD.
        ModelSpec(
            "cohere-arabic",
            "abdelmoez98/cohere-transcribe-arabic-07-2026-ONNX",
            1540,
            2400,
            0,
            4,
            5,
            engine="cohere",
            files=(
                "onnx/encoder.q4f16.onnx",
                "onnx/encoder.q4f16.onnx_data",
                "onnx/decoder.q4f16.onnx",
                "onnx/decoder.q4f16.onnx_data",
                "onnx/tokens.txt",
            ),
            languages=("ar", "en"),
            gpu=False,
            experimental=True,
            # The project's own copy (a GitHub Release with the same 5 files), so the
            # model keeps downloading even if the Hugging Face repo above disappears.
            mirrors=("https://github.com/AhmadNedal/LocalWhisper/releases/download/cohere-arabic-model/",),
        ),
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
        spec = CATALOG.get(model_id)
        required = spec.required if spec else "model.bin"
        return (path / _MARKER).is_file() and (path / required).is_file()

    def list_models(self) -> list[dict[str, object]]:
        items = []
        for spec in CATALOG.values():
            state = self._downloads.get(spec.id)
            items.append(
                {
                    **asdict(spec),
                    "files": None,
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
            thread = threading.Thread(
                target=self._download,
                args=(spec.repo, self.path_for(spec.id), spec.patterns, state, spec.required, spec.mirrors),
                daemon=True,
                name=f"dl-{model_id}",
            )
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

    # ------------------------------------------------ extra (non-Whisper) models
    def extra_path(self, key: str) -> Path:
        return self.models_dir / "extra" / key

    def extra_downloaded(self, key: str) -> bool:
        path = self.extra_path(key)
        return (path / _MARKER).is_file() and (path / "model.bin").is_file()

    def extra_state(self, key: str) -> DownloadState:
        with self._lock:
            return self._downloads.get(f"extra:{key}") or DownloadState(
                model=key, status="done" if self.extra_downloaded(key) else "idle"
            )

    def start_extra_download(self, key: str, repo: str, patterns: list[str], size_mb: int) -> DownloadState:
        """Download another CTranslate2 model (e.g. the offline translator) the same way."""
        dl_key = f"extra:{key}"
        with self._lock:
            if self.extra_downloaded(key):
                state = DownloadState(key, "done")
                self._downloads[dl_key] = state
                return state
            thread = self._threads.get(dl_key)
            if thread and thread.is_alive():
                return self._downloads[dl_key]
            state = DownloadState(key, "downloading", total_bytes=size_mb * 1024 * 1024)
            self._downloads[dl_key] = state
            thread = threading.Thread(
                target=self._download, args=(repo, self.extra_path(key), patterns, state), daemon=True, name=f"dl-{key}"
            )
            self._threads[dl_key] = thread
            thread.start()
            return state

    def delete_extra(self, key: str) -> None:
        with self._lock:
            thread = self._threads.get(f"extra:{key}")
            if thread and thread.is_alive():
                raise AppError(ErrorCode.BUSY, "Model is currently downloading")
            shutil.rmtree(self.extra_path(key), ignore_errors=True)
            self._downloads.pop(f"extra:{key}", None)

    def _download(
        self,
        repo: str,
        target: Path,
        patterns: list[str],
        state: DownloadState,
        required: str = "model.bin",
        mirrors: tuple[str, ...] = (),
    ) -> None:
        from faster_whisper.utils import disabled_tqdm
        from huggingface_hub import HfApi, snapshot_download

        target.mkdir(parents=True, exist_ok=True)

        # Exact size (for an accurate progress bar) when the Hub is reachable.
        try:
            info = HfApi().model_info(repo, files_metadata=True)
            exact = sum(
                (s.size or 0)
                for s in (info.siblings or [])
                if any(Path(s.rfilename).match(p) for p in patterns)
            )
            if exact > 0:
                state.total_bytes = exact
        except Exception as exc:  # noqa: BLE001 - offline / proxy: keep estimate
            log.info("Could not fetch model metadata for %s: %s", repo, exc)

        stop_polling = threading.Event()

        def poll() -> None:
            while not stop_polling.wait(0.5):
                size = _dir_size(target)
                with self._lock:
                    state.downloaded_bytes = min(size, state.total_bytes or size)

        poller = threading.Thread(target=poll, daemon=True)
        poller.start()
        try:
            try:
                snapshot_download(
                    repo,
                    local_dir=str(target),
                    allow_patterns=patterns,
                    tqdm_class=disabled_tqdm,  # progress comes from the poller above
                )
                if not (target / required).is_file():
                    raise RuntimeError(f"{required} missing after download")
            except Exception as hub_error:  # noqa: BLE001
                if not mirrors:
                    raise
                log.warning("Hugging Face download of %s failed (%s); trying the mirrors", repo, hub_error)
                self._download_from_mirrors(mirrors, target, patterns, hub_error)
            if not (target / required).is_file():
                raise RuntimeError(f"{required} missing after download")
            (target / _MARKER).write_text(
                json.dumps({"repo": repo, "downloaded_at": time.time()}), encoding="utf-8"
            )
            # Remove Hugging Face's bookkeeping folder; the model itself is all we need.
            shutil.rmtree(target / ".cache", ignore_errors=True)
            with self._lock:
                state.status = "done"
                state.downloaded_bytes = state.total_bytes
        except Exception as exc:  # noqa: BLE001
            log.exception("Model download failed: %s", repo)
            with self._lock:
                state.status = "error"
                state.error = AppError(
                    ErrorCode.MODEL_DOWNLOAD_FAILED, f"{exc.__class__.__name__}: {exc}"[:300]
                ).to_dict()
        finally:
            stop_polling.set()

    @staticmethod
    def _download_from_mirrors(mirrors: tuple[str, ...], target: Path, files: list[str], first_error: Exception) -> None:
        """Fetch every file from the first mirror that has them all (``<base><file name>``)."""
        import urllib.request

        errors = [f"Hugging Face: {first_error}"]
        for base in mirrors:
            try:
                for rel in files:
                    dest = target / rel
                    url = base + Path(rel).name
                    req = urllib.request.Request(url, headers={"User-Agent": "LocalTranscriber"})
                    with urllib.request.urlopen(req, timeout=60) as resp:
                        size = int(resp.headers.get("Content-Length") or 0)
                        if dest.is_file() and size and dest.stat().st_size == size:
                            continue  # already here from an earlier attempt
                        dest.parent.mkdir(parents=True, exist_ok=True)
                        part = dest.with_name(dest.name + ".part")
                        with open(part, "wb") as out:
                            while True:
                                block = resp.read(1 << 20)
                                if not block:
                                    break
                                out.write(block)
                        if size and part.stat().st_size != size:
                            raise RuntimeError(f"{rel}: incomplete ({part.stat().st_size} of {size} bytes)")
                        part.replace(dest)
                log.info("Model downloaded from mirror %s", base)
                return
            except Exception as exc:  # noqa: BLE001 - try the next mirror
                log.warning("Mirror %s failed: %s", base, exc)
                errors.append(f"{base}: {exc}")
        raise RuntimeError(" | ".join(errors)[:280])

    def delete(self, model_id: str) -> None:
        self.spec(model_id)
        with self._lock:
            thread = self._threads.get(model_id)
            if thread and thread.is_alive():
                raise AppError(ErrorCode.BUSY, "Model is currently downloading")
            shutil.rmtree(self.path_for(model_id), ignore_errors=True)
            self._downloads.pop(model_id, None)
