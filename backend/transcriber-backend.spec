# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for the packaged backend (used by `npm run build:backend`).
#
# Produces a one-folder build (faster start-up than one-file, and antivirus
# friendlier) at backend/dist/transcriber-backend/.
from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files, collect_dynamic_libs, collect_submodules

block_cipher = None
here = Path(SPECPATH)  # noqa: F821 - provided by PyInstaller

datas = [(str(here / "assets"), "assets")]
datas += collect_data_files("faster_whisper")  # Silero VAD ONNX model
datas += collect_data_files("fpdf")

binaries = []
binaries += collect_dynamic_libs("ctranslate2")  # ctranslate2.dll, libiomp5md.dll, …
binaries += collect_dynamic_libs("onnxruntime")

# Optional NVIDIA runtime (present only if requirements-gpu.txt was installed).
# Bundling them makes GPU transcription work on user machines with only the
# NVIDIA driver installed. Adds ~800 MB; build with `npm run setup:cpu` first
# for a small CPU-only installer.
try:
    import nvidia  # type: ignore  # noqa: F401

    for root in nvidia.__path__:
        for pkg in ("cublas", "cudnn"):
            for sub in ("bin", "lib"):
                folder = Path(root) / pkg / sub
                if folder.is_dir():
                    for lib in folder.iterdir():
                        if lib.suffix in (".dll", ".so") or ".so." in lib.name:
                            binaries.append((str(lib), f"nvidia/{pkg}/{sub}"))
except ImportError:
    pass

hiddenimports = []
hiddenimports += collect_submodules("uvicorn")
hiddenimports += ["app", "app.server", "app.jobs", "app.transcriber", "app.pdf_export", "app.db_export", "uharfbuzz"]
# Database drivers are imported lazily, so PyInstaller can't see them on its own.
# (pyodbc is a single extension module; it links to odbc32.dll, which ships with Windows.)
hiddenimports += ["pyodbc"]
for pkg in ("pymssql", "oracledb", "cryptography", "pymysql", "psycopg", "psycopg_binary"):
    try:
        hiddenimports += collect_submodules(pkg)
        binaries += collect_dynamic_libs(pkg)
    except Exception:  # noqa: BLE001 - optional driver not installed
        pass

# YouTube: yt-dlp is imported lazily; its JavaScript solver (yt-dlp-ejs) is data,
# and the Deno runtime binary from the `deno` pip package goes into _internal/deno/.
hiddenimports += ["app.youtube", "app.cloud", "app.archive", "app.batch", "app.summarize", "app.translate", "app.subtitles", "app.course_tools"]
hiddenimports += ["sentencepiece"]
hiddenimports += ["app.documents", "app.course_site", "app.burn", "app.assistant"]
binaries += collect_dynamic_libs("sentencepiece")
try:
    hiddenimports += collect_submodules("yt_dlp")
    datas += collect_data_files("yt_dlp_ejs")
    hiddenimports += collect_submodules("yt_dlp_ejs")
except Exception:  # noqa: BLE001
    pass
try:
    import deno as _deno  # type: ignore

    _deno_bin = _deno.find_deno_bin()
    if _deno_bin and Path(_deno_bin).is_file():
        binaries.append((str(_deno_bin), "deno"))
except Exception:  # noqa: BLE001
    pass

a = Analysis(  # noqa: F821
    [str(here / "run_backend.py")],
    pathex=[str(here)],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    excludes=["tkinter", "matplotlib", "IPython", "pytest", "torch"],
    noarchive=False,
    cipher=block_cipher,
)
pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)  # noqa: F821

exe = EXE(  # noqa: F821
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="transcriber-backend",
    debug=False,
    strip=False,
    upx=False,
    console=True,  # stdout carries the READY handshake; Electron hides the window
)

coll = COLLECT(  # noqa: F821
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="transcriber-backend",
)
