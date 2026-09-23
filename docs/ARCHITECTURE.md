# Architecture

[← Back to README](../README.md) · [العربية](../README.ar.md)

This document explains how Local Transcriber works internally. For installation and usage, see the [README](../README.md).

## Overview

```
┌──────────────────────── Electron (Windows desktop shell) ────────────────────────┐
│                                                                                   │
│  Renderer: Next.js + React + TypeScript (static export, served via app://)        │
│    • drag & drop / file dialog → sends the *file path* only                       │
│    • polls job progress, shows the live transcript, edits, exports                │
│                         │  HTTP on 127.0.0.1:<random port> + per-launch token     │
│                         ▼                                                         │
│  Python backend (FastAPI) — started & supervised by Electron                      │
│    FFmpeg ──► 16 kHz mono PCM (audio stream only, temp file, memory-mapped)       │
│    faster-whisper / CTranslate2 ──► CUDA float16 or CPU int8, Silero VAD, batched │
│    Model store ──► models/<name>/ (downloaded once from Hugging Face, then offline)│
│    fpdf2 + HarfBuzz + Amiri font ──► Arabic-shaped RTL PDF                         │
└───────────────────────────────────────────────────────────────────────────────────┘
```

### Why this design

- **Electron** turns the Next.js UI into a real Windows application (installer, Start-menu shortcut, native file dialogs, drag & drop with real file paths). It also owns the backend's lifecycle: it starts the backend, restarts it if it crashes, and stops it on exit.
- **Next.js is exported statically** (`output: "export"`). There is no Node server at runtime; Electron serves the files through a private `app://` protocol with a strict Content-Security-Policy (`connect-src` only allows `127.0.0.1`).
- **Python is the natural home for faster-whisper / CTranslate2.** It runs as a separate process, so heavy inference never blocks the UI. Each transcription runs in a worker thread and the UI polls progress a few times per second.
- **Packaging:** the backend is frozen with PyInstaller and shipped inside the Electron installer (electron-builder, NSIS), together with a static FFmpeg build. End users don't install Python, FFmpeg or Node.

## Security model

- The backend binds **`127.0.0.1` only**, on a random free port. It is unreachable from the network.
- Electron generates a **random token on every launch** and passes it to both processes. Every request must carry it in the `X-Auth-Token` header, so other programs or web pages on the same PC cannot use the backend.
- The UI sends **file paths, not file bytes**. Media never passes through the UI and is never uploaded.
- The renderer runs with `contextIsolation`, `sandbox` and no Node integration. The only native features it can use are the ones exposed by `electron/preload.js` (`window.desktop`).
- Hugging Face and Next.js telemetry are disabled. The only network request is the one-time model download.

## Transcription pipeline

`backend/app/jobs.py` runs each job in a background thread:

1. **Probe:** read container headers with PyAV (no decoding) to get the duration and check that an audio stream exists.
2. **Extract audio:** FFmpeg decodes **only the audio stream** (`-vn -sn -dn`) and resamples once to 16 kHz mono 16-bit PCM, written to a temp file. Progress comes from `-progress pipe:1`.
3. **Ensure model:** if the model isn't cached, download it (resumable; a `.complete` marker is written only when every file has arrived).
4. **Load model:** CTranslate2 with `float16` on capable NVIDIA GPUs, `int8` on CPU. The loaded model stays in memory between jobs.
5. **Transcribe:** faster-whisper, in ~20-minute windows cut at the quietest moment. Segments are streamed to the UI as they are produced.
6. **Finalize:** results are kept in memory. The UI holds the (editable) transcript and sends it back for PDF export.

Cancellation is cooperative (checked between segments) and kills FFmpeg immediately during extraction.

## Performance notes

- **No video transcoding.** Video frames are never decoded. A 2 GB MP4 costs about as much as its soundtrack.
- **Flat memory use.** PCM is memory-mapped (~115 MB per hour of audio on disk). Only the current window is converted to float32, so a 3-hour video uses about as much RAM as a 20-minute one.
- **Quantization:** `float16` on GPU, `int8` on CPU (about 3–4× faster than float32 with minimal accuracy loss). CPU threads = physical cores.
- **Batched inference + VAD:** Silero VAD removes silence, and speech chunks are decoded in batches (16 on GPU / 8 on CPU, halved for large models).
- **Language is detected once** on up to 5 minutes of speech, then fixed for the whole file, so long recordings don't flip languages.
- **Hallucination guard:** drops well-known Whisper artefacts produced on silence (e.g. subtitle credits such as “ترجمة نانسي قنقر”) and breaks repetition loops.

### Presets

| Preset | Decoder | Use for |
|---|---|---|
| Fastest | batched, greedy (beam 1) | Drafts, very long recordings |
| Balanced | batched, beam 5, VAD silence skipping | Default |
| Most accurate | sequential, beam 5, conditioned on previous text | Best punctuation/coherence |

"Improve Arabic punctuation" gives Whisper a short, well-punctuated Arabic prompt so it emits `،` `؟` `.` instead of long unpunctuated runs.

## Device selection

`backend/app/system_info.py`:

- Checks CUDA with CTranslate2 and verifies that the cuBLAS 12 / cuDNN 9 DLLs can actually be loaded. When cuDNN is missing, CTranslate2 can abort the whole process instead of raising an error, so this is checked up front.
- Reads GPU name, VRAM and compute capability via `nvidia-smi`.
- **Auto** uses the GPU only if it has ≥ 3.5 GB of VRAM and compute capability ≥ 6.0 (Pascal or newer). Weaker cards (e.g. MX130, 2 GB) fall back to the CPU.
- If the selected model doesn't fit in VRAM, Auto switches to the CPU. If the GPU fails while loading or transcribing, the job is retried on the CPU.
- The NVIDIA runtime comes from the `nvidia-cublas-cu12` / `nvidia-cudnn-cu12` pip wheels, so no CUDA Toolkit is needed.

## Arabic PDF rendering

`backend/app/pdf_export.py` uses **fpdf2 with HarfBuzz** (`uharfbuzz`) text shaping, the same engine browsers use:

- **Shaping:** letters take their correct initial/medial/final forms, and ligatures such as لا are formed.
- **Bidi:** the direction of each paragraph comes from its first strong character (Unicode rule P2). Mixed Arabic/English/numbers are ordered correctly.
- **Font:** Amiri (covers Arabic and Latin) is embedded, so there are no empty boxes.
- **Layout:** two-pass layout so the footer can show "page X of Y" in Arabic. The file is written atomically (`.part` then rename).

## Database insert

`backend/app/db_export.py` lets the user run their own SQL against SQL Server (`pyodbc` when an ODBC Driver 17/18 is installed, else `pymssql`), Oracle (`oracledb` thin), MySQL/MariaDB (`PyMySQL`) and PostgreSQL (`psycopg` 3).

- A small tokenizer rewrites `@name` / `:name` variables into the driver's placeholder style (`%(p_name)s`, `:p_name` or `?`), skipping string literals, quoted identifiers and comments. `@@IDENTITY`, `::casts` and user-declared variables are left alone.
- Values are always **bound parameters**. Nothing is interpolated into SQL text.
- The optional "before" statement and all inserts run in **one transaction**, rolled back on any error.
- Saved profiles live in `%APPDATA%\Local Transcriber\db-profiles.json`; connection strings are encrypted with Electron `safeStorage` (Windows DPAPI).

## Local API

All endpoints require the `X-Auth-Token` header.

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness |
| GET | `/system` | Devices, defaults, paths |
| GET | `/models` | Model catalog + download state |
| POST | `/models/{id}/download` | Start a download |
| DELETE | `/models/{id}` | Delete a cached model |
| POST | `/probe` | Media info for a path |
| POST | `/jobs` | Start a transcription |
| GET | `/jobs/{id}?since=N` | Progress + new segments since index N |
| POST | `/jobs/{id}/cancel` | Cancel |
| POST | `/export/pdf` | Generate a PDF from (edited) segments |
| POST | `/db/test` | Test a database connection string |
| POST | `/db/preview` | Convert the user's SQL and show the first parameter rows |
| POST | `/db/execute` | Run the optional "before" statement + inserts in one transaction |

Errors are returned as `{"error": {"code": "...", "detail": "..."}}`. The UI maps each `code` to a friendly Arabic/English message (`frontend/lib/i18n.ts`).

## Source layout

```
electron/
  main.js          window, app:// protocol + CSP, IPC (dialogs, shell)
  backend.js       spawns & supervises the Python backend (token, port, restarts, logs)
  preload.js       minimal bridge exposed as window.desktop
frontend/
  app/             layout, page, globals.css (Fluent-style, RTL-first)
  components/      MediaPicker, SettingsPanel, ProgressPanel, TranscriptView, ExportPanel
  lib/             API client, i18n (ar/en), languages, formatting, hooks
  public/fonts/    Noto Sans / Naskh Arabic (bundled, offline)
backend/
  app/__main__.py  entry: binds 127.0.0.1, prints READY <port>
  app/server.py    FastAPI routes + token auth
  app/jobs.py      job pipeline, progress, cancellation, GPU→CPU fallback
  app/transcriber.py  faster-whisper engine, presets, windowing, hallucination filter
  app/media.py     FFmpeg probe/extract, memory-mapped PCM
  app/model_store.py  download-once model cache
  app/system_info.py  CUDA detection, device & compute-type selection
  app/pdf_export.py   Arabic-shaped RTL PDF
  app/errors.py    user-facing error codes
  app/config.py    paths from environment (no hard-coded machine paths)
  transcriber-backend.spec  PyInstaller build
scripts/
  setup-python.mjs venv + pip (runs on npm install)
  dev.mjs          next dev + electron
  build-backend.mjs PyInstaller build
  doctor.mjs       diagnostics
```
