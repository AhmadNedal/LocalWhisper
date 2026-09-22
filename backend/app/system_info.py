"""Hardware detection: CUDA/GPU availability, RAM and CPU information.

CTranslate2 (the engine behind faster-whisper) needs the CUDA 12 cuBLAS and
cuDNN 9 runtime libraries to run on an NVIDIA GPU. They can come from:

* the ``nvidia-cublas-cu12`` / ``nvidia-cudnn-cu12`` pip packages that the
  setup script installs automatically when an NVIDIA driver is detected, or
* a system-wide CUDA Toolkit / cuDNN installation on ``PATH``.

``prepare_cuda_libraries()`` makes the pip-provided DLLs discoverable, and
``detect_devices()`` verifies they can actually be loaded. Checking up front
matters: when cuDNN is missing CTranslate2 may abort the whole process at the
first GPU call instead of raising a Python exception.
"""

from __future__ import annotations

import ctypes
import logging
import os
import shutil
import subprocess
import sys
from dataclasses import asdict, dataclass, field
from functools import lru_cache
from pathlib import Path

import psutil

log = logging.getLogger(__name__)

# Libraries CTranslate2 >= 4.5 loads for CUDA inference.
_WINDOWS_CUDA_LIBS = ("cublas64_12.dll", "cublasLt64_12.dll", "cudnn64_9.dll", "cudnn_ops64_9.dll")
_LINUX_CUDA_LIBS = ("libcublas.so.12", "libcublasLt.so.12", "libcudnn.so.9", "libcudnn_ops.so.9")

# A GPU is only *used automatically* when it is clearly faster than the CPU:
# enough VRAM for a mid-size model and a Pascal-or-newer architecture (older
# cards have no fast FP16/INT8 path in CTranslate2). Weaker cards (e.g. GeForce
# MX110/MX130, GT 7xx/9xx with 2 GB) can still be chosen manually.
MIN_AUTO_GPU_VRAM_MB = 3500
MIN_AUTO_GPU_COMPUTE = 6.0


def _nvidia_package_dirs() -> list[Path]:
    """Return ``bin``/``lib`` folders of the pip-installed NVIDIA runtime packages."""
    roots: list[Path] = []
    meipass = getattr(sys, "_MEIPASS", None)
    if meipass:
        roots.append(Path(meipass) / "nvidia")
    try:
        import nvidia  # type: ignore[import-not-found]  # namespace package

        roots.extend(Path(p) for p in nvidia.__path__)
    except ImportError:
        pass

    found: list[Path] = []
    for root in roots:
        for package in ("cublas", "cudnn", "cuda_runtime", "cuda_nvrtc"):
            for sub in ("bin", "lib"):
                candidate = root / package / sub
                if candidate.is_dir() and candidate not in found:
                    found.append(candidate)
    return found


@lru_cache(maxsize=1)
def prepare_cuda_libraries() -> list[str]:
    """Make pip-provided CUDA libraries loadable. Returns the directories used."""
    dirs = _nvidia_package_dirs()
    if not dirs:
        return []

    if sys.platform == "win32":
        path_parts = [str(d) for d in dirs]
        os.environ["PATH"] = os.pathsep.join(path_parts + [os.environ.get("PATH", "")])
        for d in dirs:
            try:
                os.add_dll_directory(str(d))  # type: ignore[attr-defined]
            except (OSError, AttributeError):
                pass
        # Pre-load by absolute path. Once a DLL is in the process, CTranslate2's
        # later LoadLibrary("cublas64_12.dll") resolves to the loaded module.
        for d in dirs:
            for dll in sorted(d.glob("*.dll")):
                if dll.name.startswith(("cublas", "cudnn64", "cudnn_ops", "cudnn_cnn", "cudnn_graph")):
                    try:
                        ctypes.WinDLL(str(dll))
                    except OSError:
                        pass
    else:
        for d in dirs:
            for lib in sorted(d.glob("*.so*")):
                try:
                    ctypes.CDLL(str(lib), mode=ctypes.RTLD_GLOBAL)
                except OSError:
                    pass
    return [str(d) for d in dirs]


def _can_load(name: str) -> bool:
    try:
        if sys.platform == "win32":
            # winmode=0 → classic search order, which includes PATH.
            ctypes.WinDLL(name, winmode=0)  # type: ignore[call-arg]
        else:
            ctypes.CDLL(name)
        return True
    except OSError:
        return False


@dataclass
class DeviceReport:
    cuda_available: bool
    cuda_device_count: int
    cuda_reason: str
    cuda_compute_types: list[str] = field(default_factory=list)
    cpu_cores_logical: int = 1
    cpu_cores_physical: int = 1
    ram_total_gb: float = 0.0
    ram_available_gb: float = 0.0
    gpu_name: str | None = None
    gpu_vram_mb: int | None = None
    gpu_compute_capability: float | None = None
    gpu_recommended: bool = False  # used automatically in "Auto" mode
    gpu_note: str = ""

    def to_dict(self) -> dict[str, object]:
        return asdict(self)


@lru_cache(maxsize=1)
def _cuda_status() -> tuple[bool, int, str, tuple[str, ...]]:
    import ctranslate2

    prepare_cuda_libraries()
    try:
        count = ctranslate2.get_cuda_device_count()
    except Exception as exc:  # noqa: BLE001 - defensive: driver issues surface here
        return False, 0, f"CUDA driver check failed: {exc}", ()

    if count <= 0:
        return False, 0, "No NVIDIA GPU with a working CUDA driver was found.", ()

    required = _WINDOWS_CUDA_LIBS if sys.platform == "win32" else _LINUX_CUDA_LIBS
    missing = [lib for lib in required if not _can_load(lib)]
    if missing:
        return (
            False,
            count,
            "GPU found but CUDA 12 runtime libraries are missing: "
            + ", ".join(missing)
            + ". Run `npm run setup:gpu` (see README → GPU troubleshooting).",
            (),
        )

    try:
        types = tuple(sorted(ctranslate2.get_supported_compute_types("cuda")))
    except Exception:  # noqa: BLE001
        types = ()
    return True, count, "CUDA ready", types


@lru_cache(maxsize=1)
def _gpu_properties() -> tuple[str | None, int | None, float | None]:
    """Name, VRAM (MB) and compute capability of GPU 0 via nvidia-smi (ships with the driver)."""
    exe = shutil.which("nvidia-smi")
    if not exe and sys.platform == "win32":
        candidate = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32", "nvidia-smi.exe")
        exe = candidate if os.path.isfile(candidate) else None
    if not exe:
        return None, None, None

    def query(fields: str) -> list[str] | None:
        try:
            out = subprocess.run(
                [exe, f"--query-gpu={fields}", "--format=csv,noheader,nounits"],
                capture_output=True,
                text=True,
                timeout=10,
                creationflags=0x08000000 if sys.platform == "win32" else 0,  # no console window
            )
        except (OSError, subprocess.SubprocessError):
            return None
        if out.returncode != 0 or not out.stdout.strip():
            return None
        return [p.strip() for p in out.stdout.strip().splitlines()[0].split(",")]

    parts = query("name,memory.total,compute_cap") or query("name,memory.total")
    if not parts:
        return None, None, None
    name = parts[0] or None
    try:
        vram = int(float(parts[1]))
    except (IndexError, ValueError):
        vram = None
    try:
        cc = float(parts[2]) if len(parts) > 2 else None
    except ValueError:
        cc = None
    return name, vram, cc


def detect_devices() -> DeviceReport:
    available, count, reason, types = _cuda_status()
    name, vram, cc = _gpu_properties() if count > 0 else (None, None, None)
    recommended = available
    note = ""
    if available and vram is not None and vram < MIN_AUTO_GPU_VRAM_MB:
        recommended = False
        note = f"{name or 'GPU'} has only {vram / 1024:.1f} GB of VRAM; Auto mode uses the CPU."
    elif available and cc is not None and cc < MIN_AUTO_GPU_COMPUTE:
        recommended = False
        note = f"{name or 'GPU'} (compute {cc}) is too old for fast inference; Auto mode uses the CPU."
    vm = psutil.virtual_memory()
    return DeviceReport(
        cuda_available=available,
        cuda_device_count=count,
        cuda_reason=reason,
        cuda_compute_types=list(types),
        cpu_cores_logical=psutil.cpu_count(logical=True) or 1,
        cpu_cores_physical=psutil.cpu_count(logical=False) or psutil.cpu_count() or 1,
        ram_total_gb=round(vm.total / 1024**3, 1),
        ram_available_gb=round(vm.available / 1024**3, 1),
        gpu_name=name,
        gpu_vram_mb=vram,
        gpu_compute_capability=cc,
        gpu_recommended=recommended,
        gpu_note=note,
    )


def resolve_device(requested: str) -> tuple[str, str]:
    """Map the UI choice (auto/cpu/cuda) to a concrete (device, compute_type).

    * GPU: ``float16`` — fastest on modern NVIDIA cards with negligible accuracy
      loss; falls back to ``int8_float16``/``float32`` on cards without FP16.
    * CPU: ``int8`` — ~2-4x faster than float32 with very small accuracy loss
      and a quarter of the memory.
    """
    status = detect_devices()
    if requested == "cuda" and not status.cuda_available:
        from .errors import AppError, ErrorCode

        raise AppError(ErrorCode.CUDA_UNAVAILABLE, status.cuda_reason)

    use_gpu = (requested == "cuda" and status.cuda_available) or (requested == "auto" and status.gpu_recommended)
    if use_gpu:
        types = set(status.cuda_compute_types)
        for candidate in ("float16", "int8_float16", "float32"):
            if not types or candidate in types:
                return "cuda", candidate
        return "cuda", "float32"
    return "cpu", "int8"


def gpu_fits(vram_needed_mb: int, compute_type: str) -> bool:
    """Whether a model is expected to fit in the GPU's memory (True if unknown)."""
    vram = detect_devices().gpu_vram_mb
    if vram is None:
        return True
    factor = 2.0 if compute_type == "float32" else 1.0  # catalog figures are for float16
    return vram_needed_mb * factor <= vram * 0.95


def available_ram_bytes() -> int:
    return int(psutil.virtual_memory().available)
