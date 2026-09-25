# Local Transcriber — Complete Project Guide

> The whole system from A to Z: what every part is, which technology it uses and why, and exactly how every flow works, step by step.
>
> Arabic name: **المفرّغ المحلي**. Repository: <https://github.com/AhmadNedal/LocalWhisper>. Built with Claude (Anthropic's AI).

---

## Contents

1. [What the system is](#1-what-the-system-is)
2. [The three projects](#2-the-three-projects)
3. [Technology stack](#3-technology-stack)
4. [Folder structure (every file)](#4-folder-structure-every-file)
5. [Architecture: processes and how they talk](#5-architecture-processes-and-how-they-talk)
6. [Startup flow (from double-click to ready)](#6-startup-flow-from-double-click-to-ready)
7. [Security model](#7-security-model)
8. [Accounts: sign-in, sign-up with OTP, forgot password](#8-accounts-sign-in-sign-up-with-otp-forgot-password)
9. [Transcribing a file (the main flow)](#9-transcribing-a-file-the-main-flow)
10. [The engines: Whisper, Cohere Arabic, cloud providers](#10-the-engines-whisper-cohere-arabic-cloud-providers)
11. [Models: catalog, download, device selection](#11-models-catalog-download-device-selection)
12. [YouTube](#12-youtube)
13. [Batch queue, watched folders, tray mode](#13-batch-queue-watched-folders-tray-mode)
14. [Live transcription](#14-live-transcription)
15. [Archive, courses, search, find & replace, backup](#15-archive-courses-search-find--replace-backup)
16. [AI features and the free-AI proxy](#16-ai-features-and-the-free-ai-proxy)
17. [Exports: PDF, Word, subtitles, video, website, database](#17-exports-pdf-word-subtitles-video-website-database)
18. [Logging, errors and diagnostics](#18-logging-errors-and-diagnostics)
19. [Automatic updates](#19-automatic-updates)
20. [Building, packaging and releasing](#20-building-packaging-and-releasing)
21. [The account server (WindowsAppLoginBackend)](#21-the-account-server-windowsapploginbackend)
22. [The admin panel](#22-the-admin-panel)
23. [Reference: local API](#23-reference-local-api)
24. [Reference: Electron IPC bridge](#24-reference-electron-ipc-bridge)
25. [Reference: where data lives](#25-reference-where-data-lives)
26. [Reference: configuration and environment variables](#26-reference-configuration-and-environment-variables)
27. [Interface, languages and RTL](#27-interface-languages-and-rtl)
28. [Development workflow](#28-development-workflow)
29. [Known limits and design trade-offs](#29-known-limits-and-design-trade-offs)

---

## 1. What the system is

Local Transcriber is a **Windows desktop application** that turns video and audio (lectures, courses, meetings, YouTube videos, or live speech) into text, **on the user's own computer**, with Arabic as the first-class language.

Around that core it offers:

- **Transcription:**
  - Local AI models: OpenAI Whisper through faster-whisper, and Cohere Transcribe Arabic through ONNX Runtime.
  - Paid cloud providers, with the user's own key.
  - YouTube captions.
  - Live transcription of the microphone or the computer's audio.
- **Working with transcripts:**
  - Editing, a built-in player, and an archive organised by course.
  - Search, and find & replace across a whole course.
  - Statistics, and backup/restore.
- **AI features:**
  - Summaries with chapters, translation, and "Ask the course" (questions answered from all its lessons).
- **Exports:**
  - Arabic-correct PDF, Word, TXT, JSON, SRT/VTT, and video with burned-in subtitles.
  - A static course website, and inserting transcripts into the user's own database.
- **Automation:**
  - A batch queue, watched folders that transcribe new videos by themselves, a tray/background mode and start-with-Windows.
- **Accounts:**
  - Mandatory sign-in against a central server, with sign-up by e-mail code (OTP) and "forgot password".
  - A free AI allowance per user through that server.
  - An admin panel.
- **Maintenance:**
  - A full system log viewer, and automatic updates from GitHub Releases.

The guiding rule: **media never leaves the computer** unless the user explicitly picks a cloud option. The app sends *file paths* between its own processes, never file contents.

---

## 2. The three projects

| Project | Folder | What it is | Runs where |
|---|---|---|---|
| **Desktop app** | `windowsApplication/` | Electron shell + Next.js/React UI + Python/FastAPI engine | The user's Windows PC |
| **Account server** | `WindowsAppLoginBackend/` | ASP.NET Core 8 Web API + SQL Server (EF Core) | Hosted at `https://transcript.runasp.net` |
| **Admin panel** | `WindowsAppLoginBackend/admin-panel/` | React 18 + Vite single-page app | Hosted on Netlify: `https://transcriptadmin.netlify.app` |

```
            ┌──────────────────────────┐          ┌──────────────────────────┐
            │  Admin panel (React)     │  HTTPS   │  Account server (.NET 8) │
            │  Netlify                 ├─────────►│  runasp.net + SQL Server │
            └──────────────────────────┘          │  • accounts, JWT          │
                                                  │  • e-mail codes (SMTP)    │
┌─────────────────────────────────────────┐ HTTPS │  • free-AI proxy → Groq   │
│  Desktop app (Windows)                   ├──────►│                          │
│  Electron + Next.js + Python engine      │       └────────────┬─────────────┘
└─────────────────────────────────────────┘                    │ HTTPS
                                                               ▼
                                                     api.groq.com (LLM + Whisper)
```

---

## 3. Technology stack

### 3.1 Desktop app — shell (Electron)

| Technology | Version | Role | Why |
|---|---|---|---|
| **Electron** | 44.x | Native Windows window, tray, dialogs, notifications, secure storage, process supervision | Turns a web UI into a real installable Windows app with native file paths and drag & drop |
| **Node.js** | ≥ 22.12 | Runtime for Electron main process and build scripts | Required by Electron 44 and Next 16 |
| **safeStorage** (Electron) | — | Encrypts API keys, DB connection strings and the remembered session with **Windows DPAPI** | Secrets are readable only by the same Windows user |
| **electron-updater** | 6.x | Downloads and installs new versions from GitHub Releases | Standard, verifies sha512 of the installer |
| **electron-builder** | 26.x | Produces the NSIS installer (`.exe`), `latest.yml`, `.blockmap` | One command, per-user installer, no admin rights needed |
| **ffmpeg-static** | 5.x | A static FFmpeg binary shipped with the app | Users don't install FFmpeg |

### 3.2 Desktop app — interface

| Technology | Version | Role |
|---|---|---|
| **Next.js** | 16 | Framework; used as a **static export** (`output: "export"`), no server at runtime |
| **React** | 19 | UI components and state |
| **TypeScript** | 5.9 (strict) | Type safety for the whole UI and the API client |
| **Plain CSS** (`globals.css`) | — | Fluent-style design, light/dark, RTL-first; no CSS framework |
| **Web Audio API + AudioWorklet** | — | Live capture, resampling to 16 kHz, level meter |
| **getUserMedia / getDisplayMedia** | — | Microphone / Windows loopback (computer audio) |
| Bundled fonts | — | Noto Sans Arabic, Noto Naskh Arabic (offline) |

### 3.3 Desktop app — engine (Python backend)

| Technology | Role |
|---|---|
| **Python** | 3.10–3.13 (3.11 recommended). Runtime of the engine. |
| **FastAPI + Uvicorn** | Local HTTP API bound to `127.0.0.1` |
| **faster-whisper** | Whisper inference: batched pipeline, VAD, timestamps |
| **CTranslate2** | The inference engine under faster-whisper (float16 GPU / int8 CPU); also runs the offline translation model |
| **Silero VAD** (via faster-whisper, ONNX) | Finds speech and skips silence; used for cloud chunking, Cohere chunking and live endpointing |
| **ONNX Runtime** | Runs Cohere Transcribe Arabic (4-bit ONNX) |
| **kaldi-native-fbank** | 128-bin log-mel features for Cohere |
| **FFmpeg** (subprocess) | Extracts audio (16 kHz mono PCM), burns subtitles (libass), compresses live recordings |
| **PyAV** | Reads container headers (duration, streams) without decoding |
| **huggingface_hub** | One-time model downloads (resumable) |
| **fpdf2 + uharfbuzz (HarfBuzz)** | PDF with correct Arabic shaping + bidi |
| **sentencepiece** | Tokenizer of the offline Arabic→English translation model |
| **httpx** | Calls to cloud providers / LLMs / the account-server proxy |
| **yt-dlp (+ yt-dlp-ejs, deno)** | YouTube metadata, captions and audio download |
| **psutil, numpy** | RAM/CPU checks, parent-process watchdog, audio arrays |
| **SQLite** (stdlib `sqlite3`) | The local archive |
| **pyodbc, pymssql, oracledb, PyMySQL, psycopg** | "Insert into your database" (SQL Server, Oracle, MySQL, PostgreSQL) |
| **PyInstaller** | Freezes the engine into `transcriber-backend.exe` for the installer |
| **nvidia-cublas-cu12, nvidia-cudnn-cu12** | CUDA 12 + cuDNN 9 runtime from pip (only on NVIDIA machines) |

### 3.4 Account server

| Technology | Role |
|---|---|
| **ASP.NET Core 8** (controllers) | REST API |
| **Entity Framework Core 8 + SQL Server** | Users and AI-usage tables |
| **ASP.NET Identity `PasswordHasher`** | PBKDF2 password hashes |
| **Custom JWT (HS256)** | Access tokens with a *security stamp* claim for instant revocation |
| **Built-in rate limiter** | Per-IP limits on auth and e-mail endpoints |
| **System.Net.Mail `SmtpClient`** | Verification / reset e-mails (Gmail SMTP) |
| **IHttpClientFactory** | Relays free-AI requests to Groq |
| **Swashbuckle (Swagger)** | API explorer at the site root |

### 3.5 Admin panel

React 18, TypeScript, Vite 5, deployed to Netlify (`netlify.toml`).

### 3.6 Tooling and delivery

GitHub (source + Releases), GitHub Actions workflow (`.github/workflows/release.yml`, optional), NSIS installer, `npm` scripts as the single entry point for developers.

---

## 4. Folder structure (every file)

### 4.1 Desktop app (`windowsApplication/`)

```
windowsApplication/
├─ package.json                 npm scripts, Electron/Next deps, electron-builder config ("build"), publish URL
├─ package-lock.json
├─ auth-config.json             sign-in settings: enabled, apiBaseUrl (account server), rememberDays
├─ builtin-keys.json            (git-ignored, development only) a Groq key for `npm run dev`; never in the installer
├─ LICENSE · README.md · README.ar.md
├─ .github/workflows/release.yml   optional CI: build installer on windows-latest, publish on tags v*
│
├─ electron/                    ── the desktop shell (Node.js, main process) ──
│  ├─ main.js                   app lifecycle, window, app:// protocol + CSP, tray, IPC handlers, secrets, updates
│  ├─ preload.js                the ONLY bridge to the UI: exposes window.desktop (contextBridge)
│  ├─ backend.js                spawns/supervises the Python engine (token, env, READY port, restarts, stop/wait)
│  ├─ auth.js                   sign-in client: login, sign-up + OTP, reset password, remember-me session, /me check
│  ├─ logger.js                 app-wide log: ring buffer + daily files, secret redaction, Python line parsing
│  └─ updater.js                automatic updates (electron-updater, generic provider on GitHub Releases)
│
├─ frontend/                    ── the interface (Next.js static export) ──
│  ├─ next.config.ts            output: "export", trailingSlash, unoptimized images
│  ├─ tsconfig.json
│  ├─ app/
│  │  ├─ layout.tsx             <html> shell, fonts, metadata
│  │  ├─ page.tsx               renders <AuthGate> → <TranscriberApp>
│  │  └─ globals.css            the whole design system (~4.4k lines): tokens, light/dark, RTL, every component
│  ├─ components/
│  │  ├─ AuthGate.tsx           sign-in / sign-up (country + OTP) / forgot-password screens; gates the app
│  │  ├─ TranscriberApp.tsx     the main screen: state, title bar, all flows wired together
│  │  ├─ MediaPicker.tsx        drag & drop / choose file / folder / many files
│  │  ├─ YoutubePanel.tsx       paste a link, list captions, playlist → queue
│  │  ├─ SettingsPanel.tsx      model, language, device, preset, punctuation, vocabulary, engine (local/cloud)
│  │  ├─ CloudSettings.tsx      paid provider + model + key field + test
│  │  ├─ KeyField.tsx           masked API-key input with test/save
│  │  ├─ ProgressPanel.tsx      start/cancel, stage, progress, ETA, warnings
│  │  ├─ TranscriptView.tsx     editable segments, reading/timed views, search, translation side by side
│  │  ├─ MediaPlayer.tsx        local video/audio or YouTube embed, synced highlight
│  │  ├─ SummaryPanel.tsx       AI summary, key points, chapters
│  │  ├─ TranslatePanel.tsx     translation engines and running a translation
│  │  ├─ ExportPanel.tsx        PDF / Word / TXT / JSON / SRT / VTT / burned video options
│  │  ├─ BurnDialog.tsx         video-with-subtitles options and progress
│  │  ├─ DatabaseDialog.tsx     connection profiles, SQL editor, preview, insert
│  │  ├─ ArchiveDialog.tsx      archive browser: courses, search, open/delete, backup/restore, stats, tools
│  │  ├─ CourseToolsDialog.tsx  whole-course DB insert / export (+ website)
│  │  ├─ StatsDialog.tsx        hours per month / course, missing summaries/translations
│  │  ├─ AskDialog.tsx          "Ask the course"
│  │  ├─ ReplaceDialog.tsx      find & replace across a course (preview, choose lectures, undo)
│  │  ├─ BatchDialog.tsx        batch queue
│  │  ├─ WatchDialog.tsx        watched folders, background mode, start with Windows
│  │  ├─ LiveDialog.tsx         live transcription (source, mic, course, recording, live text)
│  │  ├─ LogsDialog.tsx         system log viewer (filters, search, copy, save)
│  │  ├─ UpdateButton.tsx       update check / download progress / "Restart to update"
│  │  ├─ FileName.tsx           bidi-safe file-name display
│  │  └─ Icons.tsx              inline SVG icon set
│  ├─ lib/
│  │  ├─ api.ts                 BackendClient: typed calls to every engine endpoint + all shared types
│  │  ├─ desktop.d.ts           TypeScript types of window.desktop (the preload bridge)
│  │  ├─ useBackend.ts          connects to the engine (status → BackendClient); usePersistentState (localStorage)
│  │  ├─ i18n.ts                all Arabic + English strings and error messages
│  │  ├─ languages.ts           language list + names
│  │  ├─ countries.ts           country list for sign-up (Arab countries first)
│  │  ├─ format.ts              time/size formatting, RTL detection
│  │  ├─ keys.ts                "your own key vs free key" state for settings fields
│  │  ├─ dbProfiles.ts          database profile types
│  │  ├─ playerClock.ts         lightweight time subscription for the player highlight
│  │  └─ liveCapture.ts         microphone / loopback capture → 16 kHz PCM blocks
│  └─ public/
│     ├─ fonts/                 Noto Sans/Naskh Arabic + licences
│     └─ live-worklet.js        AudioWorklet: mono mix, 100 ms blocks, loudness
│
├─ backend/                     ── the engine (Python) ──
│  ├─ requirements.txt          runtime deps · requirements-gpu.txt (CUDA libs) · requirements-build.txt (PyInstaller)
│  ├─ transcriber-backend.spec  PyInstaller recipe (what to bundle)
│  ├─ run_backend.py            PyInstaller entry
│  ├─ assets/
│  │  ├─ fonts/                 Amiri (PDF), Noto Sans Arabic (burned subtitles)
│  │  └─ cohere/                repaired ONNX graphs for Cohere (encoder/decoder .onnx)
│  └─ app/
│     ├─ __main__.py            entry: logging, CUDA prep, parent watchdog, bind 127.0.0.1:0, print READY <port>;
│     │                         `--cohere-worker` switches to the Cohere worker process
│     ├─ server.py              FastAPI app: token middleware, request logging, CORS, every route, error handler
│     ├─ config.py              paths and settings from environment variables
│     ├─ errors.py              ErrorCode enum, AppError, exception classifier
│     ├─ system_info.py         CUDA/GPU/RAM detection, device + compute-type choice
│     ├─ model_store.py         model catalog, one-time resumable downloads, GitHub mirror fallback
│     ├─ media.py               FFmpeg probe + audio extraction, memory-mapped PCM
│     ├─ jobs.py                job pipeline (threads), progress, cancel, GPU→CPU fallback, engine dispatch
│     ├─ transcriber.py         faster-whisper engine, presets, windowing, hallucination filter
│     ├─ cohere_engine.py       Cohere manager: VAD chunks, persistent worker, idle unload, patching
│     ├─ cohere_worker.py       separate process: ONNX Runtime encoder/decoder, features, greedy decoding
│     ├─ cloud.py               Cohere / OpenAI / Groq cloud transcription (speech chunks in parallel)
│     ├─ ai_proxy.py            routes Groq calls through the account server when using the free AI
│     ├─ live.py                live sessions: receive PCM, VAD endpointing, transcribe utterances, save
│     ├─ youtube.py             yt-dlp: inspect, captions → segments, audio download
│     ├─ batch.py               batch queue (+ prefetch, persistence, auto summary/DB insert)
│     ├─ watch.py               watched folders (polling, stable-file detection)
│     ├─ archive.py             SQLite archive, search, courses, stats, backup/restore
│     ├─ find_replace.py        find & replace across the archive, with undo
│     ├─ summarize.py           AI summaries (map → reduce), LLM providers, key tests
│     ├─ translate.py           translation: offline Opus-MT, LLM, DeepL, Azure
│     ├─ assistant.py           "Ask the course" (BM25 retrieval + LLM + citations)
│     ├─ pdf_export.py          Arabic PDF (HarfBuzz shaping + bidi), GitHub link at the end
│     ├─ documents.py           Word (.docx written by hand), TXT, JSON
│     ├─ subtitles.py           SRT / VTT cue splitting
│     ├─ burn.py                burned-in subtitles (ASS + FFmpeg libass)
│     ├─ course_tools.py        whole-course DB insert and export tasks
│     ├─ course_site.py         static course website generator
│     └─ db_export.py           user SQL → bound parameters, one transaction, 4 database engines
│
├─ scripts/                     ── developer entry points (called by npm) ──
│  ├─ setup-python.mjs          create backend/.venv, pip install (GPU libs if NVIDIA), incremental
│  ├─ dev.mjs                   setup → next dev (port 3123) → electron pointing at it
│  ├─ build-backend.mjs         PyInstaller build (runs setup first if needed)
│  ├─ ensure-deps.mjs           installs missing runtime npm deps before `npm run dist`
│  ├─ doctor.mjs                environment report (Node, Python, venv, FFmpeg, GPU, models)
│  ├─ update-youtube.mjs        upgrades yt-dlp
│  ├─ lib/python.mjs            find Python, venv paths, NVIDIA detection, run helpers
│  └─ tools/repair_cohere_onnx.py   one-off tool that produced backend/assets/cohere/*.onnx
│
├─ models/                      (development) downloaded models; installed app uses %LOCALAPPDATA%
├─ build/                       icon.ico / icon.png for the installer and window
└─ docs/                        ARCHITECTURE.md, this guide, screenshots
```

### 4.2 Account server (`WindowsAppLoginBackend/`)

```
WindowsAppLoginBackend/
├─ Program.cs                    DI, EF Core (SQL Server), auth scheme, rate limits, CORS, Swagger, error shape
├─ WindowsAppLoginBackend.csproj net8.0; packages: EF Core SqlServer, Swashbuckle
├─ appsettings.json              logging, CORS origins, connection string, JWT, Accounts, EmailVerification, Ai, Admin
├─ appsettings.Development.json
├─ appsettings.Secrets.json      (git-ignored, published) SMTP account + Ai:Groq:ApiKey
├─ appsettings.Secrets.example.json
├─ Auth/BearerAuthenticationHandler.cs   validates JWT + user still active + security stamp matches
├─ Data/ApplicationDbContext.cs  EF model: Users, AiUsage
├─ Models/
│  ├─ User.cs                    user entity + Roles
│  ├─ Dtos.cs                    request/response records + ErrorCodes
│  ├─ Countries.cs               ISO country validation
│  └─ AiUsage.cs                 daily usage row + usage DTO
├─ Services/
│  ├─ AccountService.cs          validation, register (+OTP), login + lockout, forgot/reset password, admin seed
│  ├─ UserStore.cs               EF-backed user reads/writes (schema touch-ups like the Country column)
│  ├─ TokenService.cs            JWT HS256 issue/validate (key from config or App_Data/jwt.key)
│  ├─ EmailSender.cs             SMTP (Gmail app password; 465 → 587 STARTTLS)
│  ├─ EmailVerificationService.cs  6-digit codes: salted hash, TTL, attempts, resend limits, purposes (register/reset)
│  ├─ AiProxyService.cs          Groq relay: model allow-list, quotas, token clamp, multipart rebuild
│  └─ AiUsageStore.cs            per-user per-day counters (creates the AiUsage table if missing)
├─ Endpoints/
│  ├─ AuthController.cs          /api/auth/*
│  ├─ AdminController.cs         /api/admin/users (Admin role)
│  ├─ AiController.cs            /api/ai/* (signed-in users)
│  ├─ StatusController.cs        / and /health
│  └─ AuthEndpoints.cs           (legacy minimal-API mapping kept for reference)
├─ requests.http                 ready-made requests for testing
└─ admin-panel/                  the React admin panel (separate npm project)
```

---

## 5. Architecture: processes and how they talk

When the app runs, these processes exist on the user's PC:

```
┌───────────────────────────── Electron main process (Node.js) ─────────────────────────────┐
│ main.js  auth.js  backend.js  logger.js  updater.js                                       │
│   • owns the window, tray, dialogs, safeStorage, sign-in session, updates                 │
│   • generates a random 32-byte token on every launch                                      │
│   • spawns the engine and reads its stdout/stderr line by line                            │
└───────▲───────────────────────────────┬──────────────────────────────────────────┬────────┘
        │ IPC (contextBridge,            │ spawn + env vars                         │ net.fetch (HTTPS)
        │ window.desktop.*)              ▼                                          ▼
┌───────┴───────────────────┐   ┌──────────────────────────────────┐     Account server
│ Renderer (Chromium)       │   │ Python engine (FastAPI/Uvicorn)   │     (sign-in, OTP, reset)
│ Next.js static UI         │   │ 127.0.0.1:<random port>          │
│ served from app://local   ├──►│ X-Auth-Token required            │───► api.groq.com (via account
│ fetch → http://127.0.0.1  │HTTP│ threads: jobs, batch, watch,    │      server proxy, or direct
└───────────────────────────┘   │ live, summaries, translations…    │      with the user's key)
                                └───┬──────────────┬───────────────┘
                                    │ subprocess   │ subprocess (persistent)
                                    ▼              ▼
                                  FFmpeg      Cohere worker (ONNX Runtime)
```

**Channels:**

| From → To | Channel | Carries |
|---|---|---|
| UI → Electron | IPC through `preload.js` (`window.desktop`) | dialogs, secrets, sign-in, logs, tray, updates, backend URL+token |
| UI → Engine | HTTP `fetch` to `http://127.0.0.1:<port>` with header `X-Auth-Token` | everything about media, jobs, archive, exports (paths, not bytes) |
| Engine → UI | Responses only; the UI **polls** (`GET /jobs/{id}?since=N`, `/batch`, `/live/{id}`, …) | progress + new segments since index N |
| Electron → Engine | environment variables at spawn; stdout `READY <port>` | token, folders, FFmpeg path, parent PID, proxy URL |
| Engine → Electron | stdout/stderr lines | the `READY` line, and every log line (parsed into the app log) |
| Engine → Cohere worker | stdin/stdout JSON lines | load model, transcribe chunks, events |
| Electron → Account server | HTTPS (`net.fetch`) | login, register, OTP, reset, `/me` |
| Engine → Account server | HTTPS (`httpx`) | free-AI calls (`/api/ai/...`) with the user's JWT |

Why polling instead of WebSockets: it is simpler, survives backend restarts, needs no extra auth path, and a few small requests per second on localhost cost nothing.

---

## 6. Startup flow (from double-click to ready)

### 6.1 Developer run: `npm run dev`

1. `scripts/dev.mjs` checks Node ≥ 22.12.
2. It runs `scripts/setup-python.mjs`, which is incremental: it hashes the requirement files and returns at once if nothing changed. Otherwise it:
   - finds Python 3.10–3.13 (or `PYTHON=`),
   - creates `backend/.venv`,
   - installs `requirements.txt`, plus `requirements-gpu.txt` when `nvidia-smi` finds an NVIDIA driver (or with `--gpu`).
3. It starts `next dev frontend --port 3123` and waits for the port.
4. It launches Electron with `ELECTRON_START_URL=http://localhost:3123`.
5. Electron then follows the same steps as the installed app (below). The only differences:
   - the UI comes from the dev server;
   - the engine runs as `.venv\Scripts\python.exe -m app`;
   - models live in `windowsApplication/models`.

### 6.2 Installed app (and the rest of the dev flow)

**Electron main process** (`electron/main.js`), at module load:

1. `app.requestSingleInstanceLock()`: a second copy just focuses the first window.
2. The **logger** is created (`%APPDATA%\Local Transcriber\logs\local-transcriber-YYYY-MM-DD.log`). It writes a start line with the version, Electron version, Windows version and dev/installed mode. Uncaught exceptions and rejections are logged.
3. `new BackendProcess()`: a random 32-byte hex **token** is generated. `new Updater()`.
4. `protocol.registerSchemesAsPrivileged` makes `app://` behave like a secure origin.

**When Electron is ready** (`app.whenReady()`):

5. The application menu is removed.
6. `registerAppProtocol()` serves `frontend/out` at `app://local/...`. Every response gets a strict **Content-Security-Policy** (see §7).
7. `new AuthGate()` loads `auth-config.json`. An installed copy always forces `enabled = true`. If "remember me" was used, it restores the encrypted `session.json`.
8. `backend.aiProxy` is set to the account-server URL (used for the free AI).
9. `registerIpc()` registers every `ipcMain.handle` channel (§24) and the loopback-audio handler for live mode.
10. `backend.start()` spawns the engine early, so it warms up while the user signs in:
    - command: `resources\backend\transcriber-backend\transcriber-backend.exe` (installed) or the venv Python;
    - environment: `TRANSCRIBER_TOKEN`, `TRANSCRIBER_PARENT_PID`, `TRANSCRIBER_MODELS_DIR`, `TRANSCRIBER_OUTPUT_DIR`, `TRANSCRIBER_DATA_DIR`, `FFMPEG_PATH`, `TRANSCRIBER_AI_PROXY`, `PYTHONUTF8=1`, …;
    - stdout and stderr are read line by line; each line goes to the logger and to `backend.log`.
11. `createWindow()` creates a 1280×860 window with `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false` and `backgroundThrottling: false`. It loads `app://local/` (or the dev URL).
    - If it was started with Windows (`--hidden`) and the session is valid, the window stays hidden in the tray.
12. `updater.start()` (installed app only) checks GitHub after 20 s, then every 6 h.

**Python engine** (`backend/app/__main__.py`):

1. Forces UTF-8 on stdout/stderr, so Arabic log lines never crash on cp1252.
2. Configures logging in the format `2026-09-25 20:02:19,423 INFO app.x: message`. Electron parses exactly this format.
3. `load_settings()` reads the folders from the environment.
4. `prepare_cuda_libraries()` makes the pip-installed CUDA DLLs discoverable.
5. Logs one startup summary: version, Python, OS, CPU, RAM, models/data/FFmpeg paths.
6. Starts a **parent watchdog** thread. If Electron's PID disappears, the engine exits, so no orphan processes are left.
7. Binds a socket to **`127.0.0.1:0`**, which picks a random free port.
8. Starts Uvicorn. As soon as it is serving, it prints **`READY <port>`**.
9. `create_app()` builds every manager once:
   - `ModelStore`, `Engine`, `JobManager` (with `CohereEngine`), `Archive`, `BatchManager`, `WatchManager`;
   - `SummaryManager`, `TranslationManager`, `CourseTools`, `BurnManager`, `AssistantManager`, `LiveManager`;
   - it then registers the routes.

**Back in Electron:**

- `backend.js` sees `READY 54773`. The status becomes `{state: "ready", url: "http://127.0.0.1:54773", token}` and is sent to the window as `backend:status`.
  - It is only sent once the user is signed in. Until then the UI receives `{state: "locked"}`.
- If the engine exits after it was ready, it is restarted automatically (up to a few times). If it never became ready, the error (`python_missing`, `backend_crashed`, timeout) is shown with the last stderr lines.

**Renderer:**

1. `page.tsx` renders `<AuthGate>`. It calls `desktop.authState()`, which re-verifies a remembered session once per launch through `/api/auth/me`.
2. Not signed in → `LoginScreen`. Signed in → `<TranscriberApp>`.
3. `useBackend()` asks `desktop.getBackend()` and subscribes to `onBackendStatus`. When the status is `ready`, it creates `new BackendClient(url, token)`, and every component uses this client.
4. `TranscriberApp` loads:
   - `/system`, `/models`, `/cloud/providers`, `/summary/providers` and `/translate/catalog`;
   - the batch and watch state;
   - the persisted settings from `localStorage` (`usePersistentState`).

---

## 7. Security model

| Threat | Protection |
|---|---|
| Other devices on the network calling the engine | Engine binds **127.0.0.1 only**; random port every launch |
| Other programs / web pages on the same PC calling the engine | Every request must carry the per-launch **`X-Auth-Token`** (32 random bytes). Only Electron and the UI know it. |
| Using the app without an account | The lock is in the **main process**: until sign-in, `backend:connection` returns `locked`, secrets and DB profiles return nothing, so the UI never learns the port/token. Hiding the login screen unlocks nothing. |
| Malicious content in the UI | `contextIsolation`, `sandbox`, no Node in the renderer; only the functions in `preload.js` exist. CSP: `default-src 'self'`, `connect-src http://127.0.0.1:*` (the UI cannot talk to the internet), `media-src http://127.0.0.1:* blob:`, `frame-src https://www.youtube-nocookie.com`. Navigation away from the app is blocked; external links open in the browser. |
| Stolen API keys / DB passwords | Stored with Electron `safeStorage` = **Windows DPAPI** (only that Windows user can decrypt). Passed to the engine per request, wiped from job memory when the job ends. Keys are masked in logs. |
| Leaking the free Groq key | The key lives **only on the account server** (`appsettings.Secrets.json`), never in the app or installer. |
| Media leaving the PC | The UI sends **file paths**; only the explicit cloud options upload audio (and only speech chunks). The built-in player streams local files from the engine (`/media/stream?token=` because `<video>` can't send headers; allowed extensions only). |
| SQL injection in "insert into database" | Variables are always **bound parameters**; SQL text is never built from values. |
| Brute force on accounts | Per-account lockout (5 wrong passwords → 15 min), per-IP rate limit (20/min on auth, 10 per 15 min on e-mail codes), OTP attempts limited. |
| Revoking sessions | JWT carries the user's **security stamp**; changing/resetting the password or disabling the user changes it, so every old token fails immediately. |
| Secrets in logs | `logger.js` masks `gsk_…`, `sk-…`, `AIza…`, JWTs, `Bearer …`, `password=`/`token=`/`api_key=` patterns before storing anything. |

---

## 8. Accounts: sign-in, sign-up with OTP, forgot password

All account traffic goes **from the Electron main process** (`electron/auth.js`, `net.fetch`) to the account server. It never goes from the web page, so no CORS rules are needed and the token never sits in page memory longer than necessary.

### 8.1 Sign-in

1. The user types an e-mail and password (`AuthGate.tsx`), then `desktop.authLogin(email, password, remember)`.
2. `auth.js` sends `POST {apiBaseUrl}/api/auth/login {email, password}`.
3. Server (`AccountService.LoginAsync`):
   - looks the user up by normalized e-mail. An unknown e-mail still runs a dummy hash, so timing reveals nothing;
   - checks the lock-out;
   - verifies the PBKDF2 hash. A wrong password increments `FailedAttempts`; the 5th locks the account for 15 min;
   - checks that the account is active (`pending_approval` / `account_disabled`);
   - resets the counters, sets `LastLoginAt`, and issues a **JWT** (claims: id, e-mail, name, role, *stamp*, exp = 7 days).
4. `auth.js` reads the token from the first matching path (`accessToken`, `token`, …). With "remember me", it stores `{email, name, token, expiresAt}` encrypted with DPAPI in `session.json`.
5. Main sends `backend:status` (now unlocked). The UI shows the app.

On each launch a remembered session is re-checked once with `GET /api/auth/me`. A revoked token (password changed, account disabled) signs the user out. **No internet** keeps the remembered session working, because transcription is local.

### 8.2 Sign-up with e-mail code (OTP)

1. Form: name, e-mail, **country** (Arab countries first, the default guessed from the Windows locale), password, and confirmation. Client-side checks: length, letters and digits, and matching confirmation.
2. `desktop.authSendCode(details)` sends `POST /api/auth/register/send-code` (the "otp" rate limit applies).
   - The server validates **everything first** (name, e-mail, country, password strength, e-mail not taken), so the user fixes mistakes before waiting for an e-mail.
   - `EmailVerificationService.SendAsync(purpose "register")`:
     - generates 6 random digits and stores only a **salted SHA-256** of them, with an expiry (10 min);
     - enforces "resend after 60 s" and "5 sends per hour";
     - e-mails an RTL/LTR HTML message through SMTP. In development without SMTP, the code is written to the console.
3. The UI switches to the code screen: countdowns for resend and expiry. Paste works, including Arabic-Indic digits; 6 digits submit automatically.
4. `desktop.authRegister({…details, code})` sends `POST /api/auth/register`. The server:
   - verifies the code in constant time (max 5 wrong tries), then deletes it;
   - creates the user (the first account ever becomes **Admin**);
   - returns a JWT, which signs the user in at once. It returns `202` instead when admin approval is required.

### 8.3 Forgot password

1. The **"Forgot password?"** link opens the reset card, where the user enters their e-mail.
2. `desktop.authSendResetCode` sends `POST /api/auth/password/send-code`.
   - The server answers **the same way whether or not the e-mail has an account**, so nobody can probe which e-mails exist.
   - If it exists, a 6-digit code with purpose **"reset"** is e-mailed. The key is `reset:<email>`, so a registration code can never reset a password.
3. The user enters the code, the new password and the confirmation. `desktop.authResetPassword` sends `POST /api/auth/password/reset`. The server:
   - verifies the code;
   - sets the new hash;
   - **changes the security stamp** (every other device is signed out);
   - clears the lock-out;
   - returns a JWT, which signs the user in.
4. The server advertises the feature in `GET /api/auth/options` (`passwordReset: true`). The link is hidden for an older server.

### 8.4 Sign-out

`desktop.authLogout()` deletes `session.json`, and the window reloads to drop everything the session had loaded.

---

## 9. Transcribing a file (the main flow)

### 9.1 In the UI

1. The user drops a file, or picks one with the native dialog (`dialog:openMedia`). Electron returns the **absolute path**.
2. `POST /probe {path}` returns duration, size, has video/audio, and codec. PyAV reads the headers only.
3. The user chooses settings in `SettingsPanel` (saved in `localStorage`):
   - model;
   - language (or auto);
   - device (Auto/GPU/CPU);
   - preset (Fast / Balanced / Most accurate);
   - Arabic punctuation;
   - custom vocabulary;
   - engine (local / paid provider).
4. **Start** calls `POST /jobs` with the path and those settings. For cloud it also sends the API key, read with `desktop.getSecret`.
5. The UI polls `GET /jobs/{id}?since=N` about every half second. It gets the stage, overall progress, ETA, detected language, device, warnings, and **new segments since index N**. It appends them, so text appears while the file is still being processed.
6. When the job completes, the transcript is **saved to the archive automatically** (`POST /archive`, debounced). Later edits update the same entry.

### 9.2 In the engine (`jobs.py`)

`JobManager.start()`:

- refuses if another job or a live session is running (`busy`);
- validates the model and language (Cohere accepts only Arabic/English);
- creates a `Job` and runs `_run()` in its own thread.

The pipeline stages (each change is logged and visible in the UI):

| Stage | What happens |
|---|---|
| `queued` | Job created |
| `downloading_media` | (YouTube without captions) yt-dlp downloads the audio stream only |
| `probing` | PyAV reads duration/streams |
| `extracting_audio` | FFmpeg: `-vn -sn -dn` (no video decoding), resample once to **16 kHz mono s16le** into a temp `.pcm` file; progress from `-progress pipe:1`; cancel kills FFmpeg immediately |
| `downloading_model` | First use of a model: resumable download (see §11) |
| `loading_model` | Load (or reuse) the model. A **warm-up thread** starts loading while FFmpeg is still extracting, so the two overlap |
| `transcribing` | The engine produces segments; each is appended to `job.segments` with progress and ETA |
| `finalizing` | Done; temp folder deleted; the API key is cleared from memory |

**Errors:**

- Any exception is mapped by `classify_exception` to a stable **error code** (§18.3); the UI translates it.
- Out-of-memory during model load is retried once after garbage collection.
- A GPU failure in "Auto" mode is retried on the CPU.

**Audio in memory:** `PcmAudio` memory-maps the PCM file, and only the current window is converted to float32. A 3-hour lecture uses about the same RAM as a 20-minute one.

---

## 10. The engines: Whisper, Cohere Arabic, cloud providers

### 10.1 Whisper (faster-whisper / CTranslate2) — `transcriber.py`

**Loading**

- **float16 on NVIDIA GPUs, int8 on the CPU.** CPU threads = physical cores.
- The loaded model is **cached between jobs**, keyed by (model, device, compute type).
- Before loading on the CPU, RAM + page file is checked against the model's needs.

**Language**

- Detected once on up to 5 minutes of speech (VAD-filtered), then fixed for the whole file.

**Windows**

- Long audio is processed in ~20-minute windows, cut at the **quietest point** near the boundary.

**Presets**

| Preset | Decoder | Beam | Notes |
|---|---|---|---|
| Fast | `BatchedInferencePipeline` | 1 | Batch 16/8, VAD skips silence |
| Balanced (default) | batched | 5 on GPU, **2 on CPU** | Best speed/quality trade-off |
| Most accurate | sequential | 5 | `condition_on_previous_text`, full temperature ladder |

- **Batch size:** 8 (large models) or 16 on a GPU. 4 or 8 on a CPU, and 2 when RAM is low.
- **Arabic punctuation:** a short, well-punctuated Arabic `initial_prompt` nudges Whisper to write `،` `؟` `.`.
- **Vocabulary:** user terms go to `hotwords`.

**Hallucination guard:**

- drops known phantom lines on silence (e.g. subtitle credits, "please subscribe" when uncertain) and the echoed prompt;
- breaks repetition loops (the same line 3 times).

### 10.2 Cohere Transcribe Arabic — `cohere_engine.py` + `cohere_worker.py`

**The model:**

- A 2-billion-parameter Conformer encoder-decoder for Arabic: MSA plus Egyptian, Gulf, Levantine and Maghrebi dialects, and Arabic-English code-switching.
- The app uses the **4-bit ONNX export** (`abdelmoez98/cohere-transcribe-arabic-07-2026-ONNX`): about 1.5 GB to download and about 2.4 GB of RAM. It runs on the CPU only.

**Why a repair was needed:** the published graphs couldn't be loaded by any ONNX Runtime. They had:

- mixed float16/float32 types;
- wrong external-weight file names;
- clashing dimension names that broke buffer reuse.

`scripts/tools/repair_cohere_onnx.py` produced fixed copies of the two small graph files. They ship in `backend/assets/cohere/`, and `ensure_patched()` copies them over the downloaded graphs. The 1.5 GB of weights are used as downloaded.

**Pipeline for one file:**

1. **Silero VAD** finds speech. Close spans are merged into chunks of at most 20 s (merge gap 0.6 s). This gives the **timestamps**, because the model outputs none.
2. The chunk list is sent to the **Cohere worker process**. It runs as a separate process so that its memory is separate and a native crash can't kill the engine.
3. The worker computes, for each chunk:
   - 128 log-mel features (kaldi-native-fbank: Hann window, librosa mel, pre-emphasis 0.97, no DC removal) with per-feature normalization;
   - the **encoder** gives cross-attention K/V;
   - **greedy decoding** runs from the task prompt `<|startofcontext|><|startoftranscript|><|emo:undefined|><|ar|><|ar|><|pnc|><|itn|><|notimestamp|><|nodiarize|>`, with a growing self-attention cache, until `<|endoftext|>`;
   - token IDs are turned into text (`▁` = space, `<0xHH>` byte fallback).
4. Chunks that are pure silence are skipped, so the decoder doesn't invent sentences.
5. Each chunk's text comes back as an event and becomes a segment with that chunk's start/end.

**Worker protocol** (JSON lines over stdin/stdout):

```
→ {"model_dir": "...", "threads": 4}                        ← {"event": "ready"}
→ {"cmd": "transcribe", "pcm": "file.pcm", "language": "ar", "chunks": [[s,e], …]}
                                                           ← {"event": "chunk", "i": 0, "text": "…"}  (per chunk)
                                                           ← {"event": "done"}  |  {"event": "error", "detail": "…"}
→ {"cmd": "quit"}
```

**Behaviour between files:**

- The worker is **persistent**: the model stays loaded between files and live utterances.
- It is stopped after **10 minutes idle** (to free the ~2.4 GB), when another engine is loaded, or on cancel. Cancel kills the process, because that is the only way to stop the model mid-chunk.
- It is started as `python -m app.cohere_worker` in development, or `transcriber-backend.exe --cohere-worker` when installed.

**Measured:** about 6× faster than large-v3-turbo on a CPU, with correct Arabic on real speech.

### 10.3 Paid cloud providers — `cloud.py`

- **Providers:**
  - Cohere Transcribe (Arabic or multilingual);
  - OpenAI (gpt-4o-transcribe, gpt-4o-mini-transcribe, whisper-1);
  - Groq (whisper-large-v3-turbo, whisper-large-v3).
- **Keys:** the user's own key (DPAPI), or for Groq the **free AI through the account server** (§16.4).
- **How audio is sent:** the PCM that FFmpeg already made is cut by Silero VAD into **speech chunks**, so silence is never uploaded or billed and the 25 MB API limits are never hit.
  - Providers that return timestamps (Groq, whisper-1) get ~9–10-minute chunks with `verbose_json`, which means far fewer requests.
  - The others get ~20–28 s chunks, and each chunk's position gives its timestamps.
- **Upload:** chunks are encoded as small WAVs and uploaded **4 in parallel**. Results are emitted **in order**.
- **Retries:** 429/5xx are retried with exponential backoff, honouring `Retry-After`. Auth, quota, language and free-limit errors fail fast.
- **Header warning:** the header shows "Cloud: audio is uploaded to …" whenever a cloud engine is selected.

---

## 11. Models: catalog, download, device selection

### 11.1 Catalog (`model_store.py`)

| ID | Source (Hugging Face) | Download | RAM (CPU) | VRAM (GPU) | Engine |
|---|---|---|---|---|---|
| tiny | Systran/faster-whisper-tiny | 75 MB | 350 MB | 1.0 GB | Whisper |
| base | Systran/faster-whisper-base | 145 MB | 450 MB | 1.2 GB | Whisper |
| small | Systran/faster-whisper-small | 485 MB | 900 MB | 2.0 GB | Whisper |
| medium | Systran/faster-whisper-medium | 1.5 GB | 1.7 GB | 3.5 GB | Whisper |
| large-v3-turbo | mobiuslabsgmbh/faster-whisper-large-v3-turbo | 1.6 GB | 2.0 GB | 3.5 GB | Whisper |
| large-v3 | Systran/faster-whisper-large-v3 | 3.1 GB | 3.3 GB | 5.5 GB | Whisper |
| cohere-arabic | abdelmoez98/cohere-transcribe-arabic-07-2026-ONNX (5 files under `onnx/`) | 1.5 GB | 2.4 GB | CPU only | ONNX (ar/en only, marked experimental) |

Plus the offline translation model **Opus-MT Arabic→English** (`gaudi/opus-mt-ar-en-ctranslate2`, ~150 MB) in `models/extra/`.

### 11.2 Download

1. `huggingface_hub.snapshot_download` fetches only the needed file patterns into `<models_dir>/<id>/`. No account is needed, and the download resumes if interrupted.
2. A **`.complete` marker** is written only after every required file has arrived. A half-finished folder is resumed, never trusted.
3. **Mirror fallback:** if Hugging Face fails, a model with `mirrors` (Cohere) is downloaded from the project's own GitHub Release. The URL is `https://github.com/AhmadNedal/LocalWhisper/releases/download/cohere-arabic-model/<file>`. Files are written to `.part`, then size-checked and renamed.
4. The UI shows download progress, and models can be deleted from the settings.

### 11.3 Device selection (`system_info.py`)

- **Detection:**
  - CTranslate2's CUDA device count;
  - a real load test of the cuBLAS 12 / cuDNN 9 DLLs (a missing cuDNN can otherwise abort the whole process at the first GPU call);
  - `nvidia-smi` for the name, VRAM and compute capability.
- **Auto:** uses the GPU only if it has ≥ 3.5 GB VRAM and compute capability ≥ 6.0. If the chosen model doesn't fit in VRAM, it uses the CPU (warning `gpu_too_small`).
- **Models that are CPU-only** (Cohere) always use the CPU. Asking for the GPU just shows a `cpu_only_model` warning.
- **Default model** on first run is chosen from the hardware (`/system`).

---

## 12. YouTube

`youtube.py` (yt-dlp; YouTube now requires a JavaScript runtime, which the bundled **deno** provides):

1. **Paste a link:** `POST /youtube/inspect` returns the title, duration and thumbnail, plus the caption tracks:
   - **manual** (uploaded by the channel);
   - **auto** (YouTube's own recognition, original language only; machine-translated tracks are skipped).
2. **Use captions:** `POST /youtube/subtitles` downloads the json3 track (millisecond timing). It clamps overlapping auto events and merges 1–3-word events into readable segments. No model is needed.
3. **Transcribe instead:** the job gets a `downloading_media` stage. Only the best **audio** stream is downloaded into the job's temp folder (deleted afterwards), then the normal pipeline runs.
4. **Playlist:** `POST /batch/add_youtube` lists the playlist with flat extraction (one request, nothing downloaded) and queues every video. It uses captions when a suitable track exists, otherwise transcription.
5. **Updating yt-dlp:** `npm run update:youtube` upgrades it, because YouTube changes often.
6. **The player:** for YouTube transcripts, the built-in player uses the privacy-enhanced embed (`youtube-nocookie.com`) through its `postMessage` API.

---

## 13. Batch queue, watched folders, tray mode

### 13.1 Batch queue (`batch.py`)

- **Adding:** `POST /batch/add` takes files and folders. Folders are expanded recursively and naturally sorted ("Lesson 2" before "Lesson 10"), and files already in the archive can be skipped. A folder becomes a **course** named after it.
- **Running:** one worker thread runs each file through the normal `JobManager`, so the model is loaded once and only one transcription runs at a time. It waits, then:
  - saves the result to the archive;
  - optionally summarizes it;
  - optionally inserts it into a database.
- **Prefetch:** while file N is transcribed, file N+1 is already probed and its audio extracted.
- **Errors:** an error that would repeat for every file (bad key, no credit, model download, FFmpeg missing, YouTube bot check) **pauses** the queue. Other errors only mark that file.
- **Surviving restarts:** the queue is saved to `batch-queue.json` every 2 s when it changed (never keys). After a restart, "Continue where it stopped" appears.
- **While running:** the UI asks Electron to keep Windows from sleeping (`powerSaveBlocker`).

### 13.2 Watched folders (`watch.py` + `WatchDialog.tsx`)

The user adds folders to "listen" to. Every new video dropped there is transcribed without anyone pressing anything.

- A background thread scans every **5 s** (polling works on OneDrive, network drives and USB, and needs no extra packages).
- A new media file must be **stable for 8 s** (same size and modification time), and partial-download extensions are ignored. Only then is it added to the batch queue.
- **Course name:**
  - a file in `Watched/React/01.mp4` goes to the course **React**;
  - a file directly in the watched folder goes to a course named after the watched folder.
- **Folder list:** folders and the files already seen are saved in `watch-folders.json`, so nothing is transcribed twice after a restart.
  - "Include existing files" can queue what is already there.
  - An unreachable folder (unplugged drive) is marked, and its known files are kept.
- **Starting:** the UI polls `/watch`. When new files appear and the queue is idle, it **starts the queue automatically** with the current settings (the "Start automatically" option). It then shows a Windows notification.

### 13.3 Tray and start with Windows

- **"Keep watching in the background":** closing the window hides it to the **system tray** instead of quitting. The tray icon's tooltip shows the status, and its menu has Open and Quit. A notification explains it the first time.
- **"Start with Windows"** (installed app only): `app.setLoginItemSettings({openAtLogin, args: ["--hidden"]})`. The app starts hidden in the tray and keeps watching.
- **Background throttling is off,** so polling stays at full speed while hidden.

---

## 14. Live transcription

Speech becomes text while it is spoken, from the microphone, the computer's audio (Zoom, Teams, YouTube…), or both.

### 14.1 Capture (renderer) — `lib/liveCapture.ts`, `public/live-worklet.js`

1. **Microphone:** `getUserMedia({audio: {deviceId, echoCancellation, noiseSuppression, autoGainControl}})`.
2. **Computer audio (Windows):**
   - the page first calls `desktop.liveSystemAudio()`, which lets Electron answer **one** `getDisplayMedia` request in the next 15 s;
   - `setDisplayMediaRequestHandler` answers it with the screen + **`audio: "loopback"`**;
   - the page keeps only the audio track and stops the video track at once.
3. **Both:** the two streams are connected to the same node. Web Audio sums them.
4. An `AudioContext({sampleRate: 16000})` makes Chromium resample everything to 16 kHz.
5. An **AudioWorklet** (`live-worklet.js`, served from the app's own origin, so the CSP is respected):
   - mixes the channels to mono;
   - posts **100 ms blocks** (1600 samples) with their loudness (RMS), which drives the level meter.
6. The page converts each block to 16-bit PCM and batches **1 s** (10 blocks) per request: `POST /live/{id}/audio` with a raw `application/octet-stream` body.
   - Requests are sent one at a time, in order.
   - If the engine is briefly unreachable, up to 60 s is kept and re-sent.
7. Windows is kept from sleeping during the session (`powerSaveBlocker`).

### 14.2 Engine — `live.py`

1. **Start:** `POST /live` with the local model and settings, plus the title, course and source.
   - It refuses if a job or live session is running, or if the model isn't downloaded (`live_model_missing`).
   - While live runs, `JobManager` refuses new jobs; the batch queue waits.
2. **Loading:** a worker thread loads the model (the same shared instance jobs use), then the status becomes `listening`.
3. **Receiving:** each audio POST is appended to a temporary PCM file, and `total` samples are counted.
4. **Endpointing** runs every ≥ 0.25 s of new audio (`find_utterances`), on the part not yet transcribed:
   - Silero VAD finds the speech spans; spans closer than 0.5 s are grouped;
   - an utterance is **complete** when there is ≥ **0.8 s of silence** after it, or it reached **14 s** of continuous speech (VAD splits long speech at the best pause), or the session is stopping;
   - blips shorter than 0.35 s are dropped;
   - during silence only the last second is kept pending, so a word starting at the edge isn't lost.
5. **Transcribing each utterance:**
   - **Whisper:** language auto-detected on the first utterance, then fixed. Beam 1 for Fast, 2 on CPU, 5 on GPU. The prompt is the Arabic punctuation prompt plus the **last ~200 characters said**, so names and style carry over. Vocabulary goes to hotwords. Hallucination filter.
   - **Cohere:** the utterance is written to a small PCM file and sent to the persistent worker (model already loaded).
6. **Publishing:** the segments get absolute times, and duplicate consecutive lines are dropped.
7. **UI updates:** the UI polls `GET /live/{id}?since=N` every 0.7 s. It shows new lines with timestamps, a clock, a level meter and the status: loading / listening / "the PC is N s behind — it will catch up" (the backlog between received and transcribed audio).
8. **Stop & save:**
   - the UI stops capturing, flushes the last audio, then calls `POST /live/{id}/stop`;
   - the engine transcribes what is left;
   - if anything was said, it compresses the recording with FFmpeg to **`.m4a`** (AAC 48 kb/s), or WAV if FFmpeg fails, in `Documents\Local Transcriber\Live recordings\`;
   - it saves the transcript to the **archive**, with the chosen course and `source` = the recording, so the player works;
   - the UI offers "Open transcript".
9. **Other endings:**
   - **Discard** (`/cancel`) deletes everything.
   - If no audio arrives for 90 s (window closed or crashed), the session ends and saves itself.
   - `GET /live/current` lets a reopened window finish or discard a session left running.

---

## 15. Archive, courses, search, find & replace, backup

### 15.1 Storage (`archive.py`)

SQLite file `%APPDATA%\Local Transcriber\archive.db` (WAL mode). Table `transcripts`:

| Column | Meaning |
|---|---|
| `id` | UUID hex |
| `title`, `source_type` (file/youtube), `source` (path or URL) | What it is |
| `created_at`, `updated_at` | Unix times |
| `duration`, `language`, `engine`, `model` | Metadata |
| `segment_count`, `word_count`, `full_text` | Derived |
| `segments_json` | `[{start, end, text}]` |
| `summary_json`, `translation_json` | AI results |
| `course` | Course name |
| `search_text` | Normalized copy for fast search |

New columns are added in place on older archives (`ALTER TABLE`). The removed quiz column is dropped.

### 15.2 Search

**Arabic-insensitive search:**

- tashkeel and tatweel are removed;
- أ/إ/آ become ا, ى becomes ي, and ة becomes ه;
- the text is lower-cased.

This normalized text is stored once at save time in `search_text`, so a search is a plain `LIKE` and also matches course names.

### 15.3 Courses and statistics

- Courses are a column; the side list shows each course and its count.
- Courses can be renamed or dissolved.
- Any entry can be moved into or out of a course.
- **Statistics** (`/archive/stats`) show hours per month and per course, plus lessons still missing a summary or translation.

### 15.4 Find & replace across a course (`find_replace.py` + `ReplaceDialog.tsx`)

**Matching:**

- **Smart mode** (default) builds a regex where:
  - each letter matches its variants (ا/أ/إ/آ, ي/ى, ه/ة);
  - diacritics and tatweel may appear between any letters;
  - case is ignored.
- **Exact** matches the text as typed. **Whole word** adds word-boundary look-arounds.

**Preview** (`/archive/replace/preview`, live while typing):

- every lecture with matches, with up to 4 examples in context (before / ~~match~~ / replacement / after) and the minute;
- matches that already read like the replacement don't count (e.g. "Django" when fixing "jango").

**Apply** (`/archive/replace/apply`) changes only the **ticked lectures**, and their summaries if chosen. It updates the full text, word count and search text. A replacement that would empty a lecture is refused.

**Undo:** the previous text of the last replacement is kept in the table `replace_undo`, and `/archive/replace/undo` restores it.

### 15.5 Backup and restore

**Backup** (`POST /archive/backup`):

- a zip file `.ltbackup` containing `manifest.json` and a consistent SQLite snapshot (SQLite backup API, vacuumed);
- written to `.part` first, then renamed.

**Restore** (`POST /archive/restore`) accepts that file or a raw `archive.db`, and **merges** in one transaction:

- new entries are added;
- an existing entry is replaced only when the backup's copy is newer;
- nothing is deleted.

**Keys and DB passwords are never in a backup**, because they are DPAPI-encrypted per computer.

---

## 16. AI features and the free-AI proxy

### 16.1 Summaries (`summarize.py`)

- **Providers:**
  - Anthropic (`/v1/messages`);
  - OpenAI and Groq (`/chat/completions`, JSON mode);
  - Cohere (`/v2/chat`, JSON mode).
- **Input:** the transcript is merged into ~40 s blocks prefixed with `[mm:ss]`.
- **Output:** the model returns JSON: `summary`, `key_points`, `chapters[{start, title, summary}]`, `keywords`.
- **Chapters:** chapter times are validated and snapped to real block starts.
- **Long lectures:** map → reduce. Each part is summarized, then the parts are merged.
- **Storage and printing:** results are stored on the archive entry and can be printed in the PDF. There, chapters become headings, bookmarks and clickable links.
- **Retries:** 429/5xx are retried with `Retry-After`.

### 16.2 Translation (`translate.py`)

Segment by segment, so every translated line keeps its timing and can become subtitles.

| Engine | How |
|---|---|
| **Offline** (free) | Opus-MT ar→en on CTranslate2 int8 + SentencePiece; long segments split at punctuation |
| **AI (LLM key or free AI)** | Numbered JSON batches (~4,500 chars, ≤ 60 items, previous 3 lines as context); missing items re-requested |
| **DeepL** | `/v2/translate` (free keys `:fx`), usage via `/v2/usage` |
| **Azure Translator** | `/translate?api-version=3.0` |

### 16.3 Ask the course (`assistant.py`)

1. Every lesson of the course is cut into ~45 s blocks, plus its summary.
2. The blocks are tokenized with Arabic normalization, prefix stripping (ال/وال/بال…) and stop-words.
3. If the whole course fits the model's budget, it is sent as is. Otherwise **BM25** picks the best blocks, with one neighbour on each side.
4. Excerpts are labelled `[L<lesson> mm:ss]`. The model must cite those labels.
5. Citations are validated against real lessons and snapped to real times. Clicking one opens the lesson at that minute.

### 16.4 Free AI through the account server (Groq proxy)

**Goal:**

- users without their own key get summaries, translation, "Ask the course" and Groq cloud transcription for free;
- **the Groq key stays on the server**;
- each user has a **daily allowance**.

**Flow**, when the user has no Groq key of their own:

1. The UI asks `desktop.getSecret("cloud:groq")`.
2. Electron has no stored key for the user, so it returns the pseudo-key **`lt-proxy:<the user's JWT>`**. This happens only while the user is signed in. In development, `builtin-keys.json` is used last.
3. The UI sends that "key" to the engine exactly like a real key.
4. `ai_proxy.bearer(url, key)` in `summarize.py` / `cloud.py` recognizes the prefix. It rewrites the request:
   - `https://api.groq.com/openai/v1/<path>` becomes **`<TRANSCRIBER_AI_PROXY>/api/ai/<path>`**;
   - it adds `Authorization: Bearer <JWT>`.
5. The account server (`AiController` → `AiProxyService`):
   - checks the JWT (the user must exist, be active, and have the same stamp);
   - checks the model against the allow-list (`openai/gpt-oss-120b`, `llama-3.3-70b-versatile`, `whisper-large-v3-turbo`, `whisper-large-v3`);
   - checks today's usage in table **`AiUsage` (UserId, Day, ChatRequests, AudioBytes)**: 100 chat requests and 200 MB of audio per day by default, while **administrators are unlimited**;
   - forces `stream=false` and clamps the output to 8000 tokens;
   - for audio, rebuilds the multipart form (≤ 30 MB per request);
   - forwards to Groq **with the server's key** and relays Groq's response and status unchanged.
6. The server returns errors as `{code, message}`:
   - `ai_daily_limit` (429);
   - `ai_model_not_allowed` (400);
   - `ai_disabled` (503, no key on the server);
   - `ai_upstream` (502).
7. The engine maps them to app errors: `free_limit` ("you've used today's free AI; it renews tomorrow or add your own key") and `free_ai_unavailable`. These are **not retried**.

The allowance resets at 00:00 UTC. A key the user saves is always used first and goes straight to Groq.

---

## 17. Exports: PDF, Word, subtitles, video, website, database

### 17.1 PDF (`pdf_export.py`)

- **fpdf2 + HarfBuzz** do the shaping (letters join correctly, لا ligature), and the Unicode bidi algorithm orders mixed Arabic/English/numbers.
- The embedded **Amiri** font covers Arabic and Latin.
- **Layouts:** reading (paragraphs) or timed (segments with times).
- **Content:** original, translation or both, plus the optional summary with key points and clickable chapters (bookmarks).
- **Pages:** "Page X of Y" in Arabic, using a two-pass layout.
- The file is written atomically.
- The last page ends with a clickable **GitHub mark** linking to the repository.

### 17.2 Word, TXT, JSON (`documents.py`)

- **Word:** the `.docx` is written **by hand** (content types, rels, document.xml, styles.xml). Paragraphs get `w:bidi` and runs get `w:rtl` by majority script, so Word lays Arabic out right-to-left. Chapters are Heading 2, so they appear in Word's navigation pane.
- **TXT:** written with a BOM and CRLF, so Notepad opens it correctly.
- **JSON:** the full structured data.

### 17.3 Subtitles (`subtitles.py`)

- SRT and VTT cues of at most 2 lines × 42 characters and at most 7 s.
- Cues are cut at punctuation, and each segment's time is shared in proportion to the text length.
- RLM marks go on right-to-left lines, and SRT gets a UTF-8 BOM.

### 17.4 Video with burned-in subtitles (`burn.py`)

- Writes an ASS file (Noto Sans Arabic; `Encoding -1` so libass picks each line's direction).
- Runs FFmpeg's `subtitles` filter from a temp folder with relative paths (avoids Windows drive-letter escaping).
- Encoding: libx264 CRF 20 `veryfast`. Audio is copied if AAC/MP3, otherwise converted to AAC.
- Both languages can be shown: original on top, translation smaller below.
- The original video is never modified.

### 17.5 Whole course: export and website (`course_tools.py`, `course_site.py`)

- **Export:** one folder with `01 - Lesson.pdf`, subtitles (and optional Word/TXT/JSON) for each lesson, plus `index.csv`.
- **Mini website:**
  - `website/index.html` lists the lessons, with search over the whole course, Arabic-insensitive and running in the browser from `search-index.js`;
  - one page per lesson with the summary, clickable chapters, the text and the translation;
  - it works offline from the folder, or uploaded to any host.

### 17.6 Insert into your database (`db_export.py`, `DatabaseDialog.tsx`)

- **Engines:** SQL Server (pyodbc, or pymssql as fallback), Oracle (oracledb thin), MySQL/MariaDB (PyMySQL), PostgreSQL (psycopg 3). All are pip-installed; no client software is needed.
- **Writing the SQL:** the user writes an `INSERT` using variables such as `@text`, `@start_seconds`, `@lesson_index`, `@course`.
  - A small tokenizer converts them to the driver's placeholders. It skips strings, identifiers and comments.
  - Values are always **bound parameters**.
- **Row modes:** fixed-length chunks, raw segments, or the whole transcript.
- **Transaction:** an optional "before" statement and all inserts run in **one transaction**, rolled back on any error.
- **Profiles:** connection profiles are saved in `db-profiles.json`, with the connection string DPAPI-encrypted.
- **Scope:** it works per lecture, per whole course, or automatically after each queued lecture.

---

## 18. Logging, errors and diagnostics

### 18.1 One log for the whole app (`electron/logger.js`)

- **Sources:** `app` (Electron), `backend` (every Python log line), and `ui` (renderer warnings and errors, uncaught exceptions, explicit messages).
- **Storage:**
  - in memory: a ring buffer of 5,000 entries, each with a revision number;
  - on disk: a **daily file** `local-transcriber-YYYY-MM-DD.log`, kept 14 days.
- **Python lines:** lines are parsed as `date time LEVEL logger: message`. Tracebacks and native messages are attached to the entry before them, and an exception line upgrades that entry to an error.
- **Redaction:** every entry has its secrets masked before it is stored.
- **What the engine logs:**
  - job start, stage changes, language detection, completion and failure, warnings;
  - queue and watch events;
  - every request (quiet polling paths only when slow or failing);
  - every `AppError`.

### 18.2 Log viewer (`LogsDialog.tsx`)

- **Title bar:** the **Log** button shows a red badge for new errors.
- **The viewer:**
  - the last error at the top, with "Copy error";
  - filters (All / Problems / Errors) and by source, plus text search;
  - expandable tracebacks, and live follow;
  - copy, "Save as…", and "Open log folder".
- **Error banners:** the error banner in the app has a "Show log" button.

### 18.3 Error model (`errors.py`)

The engine never sends stack traces to the UI. Every failure becomes `{"error": {"code", "detail"}}`. The UI shows a friendly Arabic/English message for the code, and `detail` sits behind a "details" toggle. The codes, by area:

- **Media and FFmpeg:** `ffmpeg_missing`, `file_not_found`, `unsupported_media`, `no_audio_stream`, `corrupted_media`.
- **Models:** `model_download_failed`, `model_not_downloaded_offline`, `model_load_failed`, `live_model_missing`.
- **Free AI:** `free_limit`, `free_ai_unavailable`.
- **Hardware and transcription:** `insufficient_memory`, `cuda_unavailable`, `no_speech`, `transcription_failed`.
- **Exports and backup:** `pdf_failed`, `export_failed`, `backup_invalid`.
- **Database insert:** `db_driver_missing`, `db_connect_failed`, `db_query_failed`.
- **YouTube:** `youtube_invalid_url`, `youtube_unavailable`, `youtube_bot_check`, `youtube_network`, `youtube_no_captions`, `youtube_failed`.
- **Cloud providers:** `cloud_auth`, `cloud_quota`, `cloud_rate_limit`, `cloud_network`, `cloud_failed`, `cloud_language_required`, `cloud_language_unsupported`.
- **Summaries and translation:** `summary_failed`, `summary_model`, `summary_too_long`, `translate_failed`, `translate_unsupported`, `translate_same_language`.
- **General:** `cancelled`, `busy`, `invalid_request`, `internal`.

**Memory errors:** "failed to allocate", "mkl_malloc", "not enough memory" and similar become `insufficient_memory`, with advice to pick a smaller model.

### 18.4 `npm run doctor`

Prints a report: the Node version, system Python, the venv, FFmpeg, whether an NVIDIA GPU and CUDA libraries are present, and the downloaded models. Nothing is sent anywhere.

---

## 19. Automatic updates

**Configuration:** `package.json` → `build.publish = [{provider: "generic", url: "https://github.com/AhmadNedal/LocalWhisper/releases/latest/download"}]`. The generic provider pointed at GitHub's `latest/download` links:

- needs no GitHub API calls and has no rate limit;
- ignores pre-releases and releases not marked as latest.

**Flow** (`electron/updater.js`, installed app only):

1. **Checking:**
   - 20 s after start, then every 6 h, or when the user clicks ↻ in the title bar;
   - `electron-updater` downloads `latest.yml` and compares its version with the app's.
2. **Downloading:**
   - if the version is newer, the installer downloads in the background;
   - the title bar shows "Downloading update 1.0.1 — 42%";
   - the file is verified with the **sha512** in `latest.yml`;
   - the full file is always downloaded (differential download is off, because only the newest release is reachable at `latest/download`).
3. **Ready:** the title bar shows **"Restart to update to 1.0.1"**. If a transcription is running, a second click is required.
4. **Installing:**
   - Electron first **stops the engine and waits for it** (`taskkill /T`, which also ends the Cohere worker), so no file is locked;
   - it then runs the installer **silently** and restarts the app;
   - if the user never clicks, the update installs silently the next time the app quits.
5. **Kept:** models, archive, settings, keys and the session. They are outside the install folder.

---

## 20. Building, packaging and releasing

### 20.1 npm scripts (the only commands a developer needs)

| Command | Does |
|---|---|
| `npm install` | JS packages, then `postinstall` → `setup-python.mjs` (venv + pip) |
| `npm run dev` | Setup (incremental) → Next dev server → Electron |
| `npm run setup` / `setup:gpu` / `setup:cpu` | (Re)create the Python environment, with or without NVIDIA libraries |
| `npm run build:ui` | `next build frontend` → `frontend/out/` (static files) |
| `npm run build:backend` | PyInstaller → `backend/dist/transcriber-backend/` |
| `npm run build` | Both |
| `npm run dist` | `ensure-deps` → build → `electron-builder --win --publish never` → `release/` |
| `npm run pack` | Same, unpacked app only (quick test) |
| `npm run doctor` | Environment report |
| `npm run update:youtube` | Upgrade yt-dlp |
| `npm run typecheck` | TypeScript check of the UI |

### 20.2 Freezing the engine (`transcriber-backend.spec`)

PyInstaller bundles:

- the `app` package (all submodules, including `live`, `find_replace`, `ai_proxy` and `cohere_worker`) and `assets/` (fonts, Cohere graphs);
- faster-whisper's Silero VAD model, and fpdf data;
- the DLLs of CTranslate2, ONNX Runtime and kaldi-native-fbank;
- the database drivers, SentencePiece, yt-dlp + yt-dlp-ejs, and the **deno** binary;
- the **CUDA 12 cuBLAS/cuDNN** DLLs when they are installed. This is why a build on an NVIDIA machine is about 1.3 GB and runs on users' GPUs.

The result is `transcriber-backend.exe`, plus `_internal/`. The same exe runs the Cohere worker with `--cohere-worker`.

### 20.3 The installer (electron-builder, NSIS)

- **App files** (inside `app.asar`): `electron/**`, `frontend/out/**`, `build/icon.png`, `package.json`, and production `node_modules` (only `electron-updater` and its dependencies).
- **Resources:**
  - `backend/transcriber-backend/` (the frozen engine);
  - `ffmpeg/ffmpeg.exe`;
  - `auth-config.json`;
  - `app-update.yml`, which is generated from `publish`.
- **The installer:**
  - per-user (no admin rights), directory selectable, desktop and Start-menu shortcuts;
  - named `LocalTranscriber-Setup-<version>.exe`;
  - **not code-signed**, so Windows SmartScreen may warn ("More info → Run anyway").
- **Outputs** in `release/`: the `.exe`, the `.exe.blockmap`, and `latest.yml`.

### 20.4 Publishing a release

1. Raise `version` in `package.json` and run `npm run dist`.
2. On GitHub, go to **Releases → Draft a new release**, with tag `vX.Y.Z`.
3. Upload **the three files** from `release/`, keep **"Set as the latest release"** ticked, and publish.
4. Installed copies see it within 6 hours (or at once with ↻).

**The model mirror:** a separate release with tag `cohere-arabic-model` holds the 5 Cohere files. It must **not** be marked "latest" (untick it, or mark it pre-release), otherwise the update check would read that release.

**Optional CI:** `.github/workflows/release.yml` builds on `windows-latest` when a `v*` tag is pushed (or manually), uploads the three files as an artifact, and publishes the release. No key is bundled.

---

## 21. The account server (WindowsAppLoginBackend)

### 21.1 Startup (`Program.cs`)

1. Loads `appsettings.json`, `appsettings.{Environment}.json`, then **`appsettings.Secrets.json`** (SMTP password, Groq key; git-ignored but published with the site).
2. Registers:
   - an **EF Core DbContext factory** for SQL Server (`DefaultConnection`, retry on failure);
   - singletons `UserStore`, `TokenService`, `AccountService`, `EmailSender`, `EmailVerificationService`, `SqlAiUsageStore`, `AiProxyService`;
   - the named HttpClient `"groq"` (5-minute timeout).
3. **Authentication:** a custom `Bearer` scheme (`BearerAuthenticationHandler`). It validates the JWT, loads the user, and requires `IsActive` and a matching security stamp.
4. **Rate limiting:**
   - `auth` policy: 20 requests/min per IP;
   - `otp` policy: 10 per 15 min per IP.
5. **Forwarded headers:** real client IPs behind IIS or the hosting proxy.
6. **CORS:** policy `admin-panel` for the Netlify origin (plus `http://localhost:5173` in dev). Tokens travel in a header, not cookies.
7. **Errors:** the exception handler and status-code pages always answer `{code, message}`, never a stack trace.
8. **Swagger UI** is at the site root.
9. `SeedAdminAsync` creates the configured administrator (`Admin:*`) when no account exists yet.

### 21.2 Data

- **`Users`:**
  - Id (Guid), Email, NormalizedEmail (unique), Name, Country (ISO-2);
  - PasswordHash (PBKDF2), Role (`Admin` / `User`), IsActive;
  - CreatedAt, LastLoginAt, FailedAttempts, LockedUntil, SecurityStamp.
- **`AiUsage`:** (UserId, Day) primary key, ChatRequests, AudioBytes. It is created automatically at start if missing.

### 21.3 Tokens

- **Format:** HS256 JWTs signed with `Jwt:Key`. If empty, a key is generated once and saved in `App_Data/jwt.key`, so tokens survive restarts.
- **Lifetime:** `Jwt:LifetimeDays` (7).
- **Claims:** sub, email, name, role, **stamp**, exp.

### 21.4 E-mail

- **Sending:** `EmailSender` uses Gmail SMTP with an **App Password** (spaces removed). Port 465 is switched to 587 STARTTLS, because .NET's SmtpClient doesn't support implicit TLS.
- **Messages:** bilingual RTL/LTR HTML plus a plain-text alternative.
- **Codes:** 6 digits, salted SHA-256, 10 min lifetime, 5 attempts, 60 s resend, 5 per hour. Purposes are `register` and `reset`.
- **Storage:** codes live in memory, so a server restart just means asking for a new code.

### 21.5 Admin

`/api/admin/users` (Admin role):

- list and search users;
- create a user;
- update name, role or active status, or reset a password (disabling a user or changing their password rotates the stamp);
- delete a user.

At least one active admin is always kept (`last_admin`).

### 21.6 Publishing

Publish from Visual Studio or `dotnet publish` to the host (runasp.net). The site needs:

- `appsettings.json` (connection string, CORS origins);
- `appsettings.Secrets.json` (SMTP + `Ai:Groq:ApiKey`).

`AllowedHosts` must stay `"*"`. Putting a URL there causes "HTTP 400 Invalid Hostname".

---

## 22. The admin panel

- **Stack:** React 18 + TypeScript + Vite, deployed on Netlify (`netlify.toml`).
- **Files:**
  - `Login.tsx` (admin sign-in against `/api/auth/login`);
  - `Dashboard.tsx` (users table and search);
  - `UserModals.tsx` (create/edit/reset/delete);
  - `api.ts` (fetch with the Bearer token);
  - `i18n.ts` and `countries.ts` (Arabic/English, country names), `ThemeToggle.tsx` (light/dark), `ui.tsx` (shared components).
- **Connection:** it talks to the account server over HTTPS. CORS allows its Netlify origin (`Cors:AllowedOrigins`).

---

## 23. Reference: local API

The engine listens on `http://127.0.0.1:<random>`. **Every request needs `X-Auth-Token`** (or `?token=` for `/media/stream`). Errors look like `{"error": {"code", "detail"}}`.

| Area | Method & path | Purpose |
|---|---|---|
| System | GET `/health` · GET `/system` | Liveness · devices, defaults, paths |
| Models | GET `/models` · POST/GET `/models/{id}/download` · DELETE `/models/{id}` | Catalog + state · download/progress · delete |
| Media | POST `/probe` · GET `/media/stream?path=&token=` | Media info · stream a local file to the player (Range) |
| Jobs | POST `/jobs` · GET `/jobs/{id}?since=N` · POST `/jobs/{id}/cancel` | Start · progress + new segments · cancel |
| Live | POST `/live` · GET `/live/current` · POST `/live/{id}/audio` · GET `/live/{id}?since=N` · POST `/live/{id}/stop` · POST `/live/{id}/cancel` | Start session · running session · raw PCM · state + new lines · stop & save · discard |
| Archive | GET `/archive?q=&course=` · GET/DELETE `/archive/{id}` · POST `/archive` · PUT `/archive/{id}/summary` · PUT `/archive/{id}/translation` | List/search · open/delete · create/update · store summary/translation |
| Courses | GET `/archive/courses` · POST `/archive/courses/rename` · PUT `/archive/{id}/course` · GET `/archive/stats` | Courses · rename · move entry · statistics |
| Find & replace | POST `/archive/replace/preview` · POST `/archive/replace/apply` · GET/POST `/archive/replace/undo` | Preview · apply to chosen ids · undo state / undo |
| Backup | POST `/archive/backup` · POST `/archive/restore` | `.ltbackup` · merge |
| Cloud | GET `/cloud/providers` · POST `/cloud/test` | Providers/models · validate key (nothing billed) |
| Summary | GET `/summary/providers` · POST `/summary/test` · POST `/summary` · GET `/summary/{id}` · POST `/summary/{id}/cancel` | LLM providers · key test · start · progress/result · cancel |
| Translation | GET `/translate/catalog` · POST `/translate/models/{key}/download` · DELETE `/translate/models/{key}` · POST `/translate/test` · POST `/translate` · GET `/translate/{id}` · POST `/translate/{id}/cancel` | Engines · offline model · key test · run/follow/cancel |
| Ask | POST `/assist/ask` · GET `/assist/{id}` · POST `/assist/{id}/cancel` | Ask the course |
| Course tools | GET `/courses/lessons?course=` · POST `/courses/db/preview` · POST `/courses/db` · POST `/courses/export` · GET `/courses/tasks/{id}` · POST `/courses/tasks/{id}/cancel` | Lessons · DB insert · export/website · task progress |
| Exports | POST `/export/pdf` · POST `/export/document` · POST `/export/subtitles` · POST `/export/burn` · GET `/export/burn/{id}` · POST `/export/burn/{id}/cancel` | PDF · Word/TXT/JSON · SRT/VTT · burned video |
| Batch | GET `/batch` · POST `/batch/add` · POST `/batch/add_youtube` · POST `/batch/start` · POST `/batch/stop` · POST `/batch/items/{id}/retry` · POST `/batch/items/{id}/move` · DELETE `/batch/items/{id}` · POST `/batch/clear` · POST `/batch/dismiss_restored` | Queue control |
| Watch | GET `/watch` · POST `/watch/folders` · PATCH/DELETE `/watch/folders/{id}` · POST `/watch/scan` | Watched folders |
| YouTube | POST `/youtube/inspect` · POST `/youtube/subtitles` | Info + tracks · captions → segments |
| Database | POST `/db/test` · POST `/db/preview` · POST `/db/execute` | Test connection · preview parameters · run in one transaction |

**Account server API** (`https://transcript.runasp.net`):

| Method & path | Auth | Purpose |
|---|---|---|
| GET `/health` | — | Liveness |
| GET `/api/auth/options` | — | `allowRegistration, minPasswordLength, requireEmailVerification, resendSeconds, passwordReset` |
| POST `/api/auth/register/send-code` | — (otp limit) | Validate details, e-mail a code |
| POST `/api/auth/register` | — | Create account with the code → JWT |
| POST `/api/auth/login` | — | JWT |
| POST `/api/auth/password/send-code` | — (otp limit) | E-mail a reset code |
| POST `/api/auth/password/reset` | — | Code + new password → JWT |
| GET `/api/auth/me` | Bearer | Current user |
| POST `/api/auth/change-password` | Bearer | Change password |
| GET/POST `/api/admin/users`, PATCH/DELETE `/api/admin/users/{id}` | Admin | Manage accounts |
| GET `/api/ai/usage` · GET `/api/ai/models` | Bearer | Today's allowance · allowed models |
| POST `/api/ai/chat/completions` · POST `/api/ai/audio/transcriptions` | Bearer | Groq relay |

---

## 24. Reference: Electron IPC bridge

`preload.js` exposes `window.desktop`. Each function calls one `ipcMain.handle` channel in `main.js`:

| Channel | Purpose |
|---|---|
| `auth:state`, `auth:options`, `auth:login`, `auth:logout` | Session state, server options, sign in/out |
| `auth:sendCode`, `auth:register` | Sign-up with OTP |
| `auth:sendResetCode`, `auth:resetPassword` | Forgot password |
| `backend:connection`, `backend:restart` | Engine URL + token (only when signed in), restart |
| `dialog:openMedia`, `dialog:openMediaMany`, `dialog:openFolder`, `dialog:saveFile`, `dialog:savePdf`, `dialog:openBackup` | Native file dialogs |
| `shell:showItem`, `shell:openOutputDir`, `shell:openModelsDir`, `shell:openPath` | Explorer |
| `secrets:get`, `secrets:getStored`, `secrets:hasBuiltin`, `secrets:set` | DPAPI-encrypted keys; free-AI pseudo-key |
| `db:loadProfiles`, `db:saveProfiles` | Database profiles (connection strings encrypted) |
| `power:keepAwake` | `powerSaveBlocker` during long work |
| `app:setBackground`, `app:getOpenAtLogin`, `app:setOpenAtLogin` | Tray mode, start with Windows |
| `log:get`, `log:write`, `log:openFolder`, `log:save` | The app log |
| `live:prepareSystemAudio` | Allow the next loopback capture |
| `update:get`, `update:check`, `update:install` | Automatic updates |

Events pushed to the UI: `backend:status`, `log:alert`, `update:state`.

---

## 25. Reference: where data lives

| What | Installed app | Development |
|---|---|---|
| Program files | `%LOCALAPPDATA%\Programs\Local Transcriber\` (or chosen folder) | the repo |
| Models | `%LOCALAPPDATA%\Local Transcriber\models\` | `windowsApplication\models\` |
| Archive database | `%APPDATA%\Local Transcriber\archive.db` | same |
| Logs | `%APPDATA%\Local Transcriber\logs\` (daily files + `backend.log`) | same |
| Session (remember me) | `%APPDATA%\Local Transcriber\session.json` (DPAPI) | same |
| API keys | `%APPDATA%\Local Transcriber\secrets.json` (DPAPI) | same |
| DB profiles | `%APPDATA%\Local Transcriber\db-profiles.json` (connection strings DPAPI) | same |
| Queue / watched folders | `%APPDATA%\Local Transcriber\batch-queue.json`, `watch-folders.json` | same |
| Outputs (PDF, exports, burned videos, live recordings) | `Documents\Local Transcriber\` (`Live recordings\`) | same |
| UI settings | `localStorage` of the app origin | same |
| Update cache | `%LOCALAPPDATA%\local-transcriber-updater\` | — |
| Temporary audio | `%TEMP%` (deleted after each job; live uses `%TEMP%\local-transcriber-live`) | same |

---

## 26. Reference: configuration and environment variables

**`auth-config.json`** (app root; copied into `resources\`):

```json
{ "enabled": true, "apiBaseUrl": "https://transcript.runasp.net", "rememberDays": 7 }
```

Optional overrides: `loginUrl`, `registerUrl`, `sendCodeUrl`, `resetCodeUrl`, `resetUrl`, `meUrl`, `optionsUrl`, `tokenPaths`, `namePaths`. `enabled: false` works in development only.

**Environment given to the engine by Electron:**

| Variable | Meaning |
|---|---|
| `TRANSCRIBER_TOKEN` | Per-launch auth token |
| `TRANSCRIBER_PARENT_PID` | Exit when Electron dies |
| `TRANSCRIBER_MODELS_DIR` / `TRANSCRIBER_OUTPUT_DIR` / `TRANSCRIBER_DATA_DIR` | Folders |
| `FFMPEG_PATH` | Bundled FFmpeg |
| `TRANSCRIBER_AI_PROXY` | Account-server URL for the free AI |
| `TRANSCRIBER_PORT` | (testing) fixed port instead of random |
| `TRANSCRIBER_LOG_LEVEL` | (optional) logging level |
| `PYTHONUTF8`, `PYTHONIOENCODING`, `PYTHONUNBUFFERED` | Console behaviour |

**Other switches:**

- `LT_DISABLE_UPDATES=1` turns off update checks.
- `ELECTRON_START_URL` makes Electron load a dev server.
- `PYTHON=` picks the interpreter for setup.
- `LOCAL_TRANSCRIBER_SKIP_PYTHON=1` skips the Python setup.

**Account server `appsettings.json` sections:**

- `Cors:AllowedOrigins`;
- `ConnectionStrings:DefaultConnection`;
- `Jwt` (Issuer, Audience, Key, LifetimeDays);
- `Accounts` (AllowRegistration, RequireApproval, MinPasswordLength, MaxFailedAttempts, LockoutMinutes);
- `EmailVerification` (Enabled, CodeMinutes, ResendSeconds, MaxAttempts, MaxSendsPerHour);
- `Ai` (DailyChatRequests, DailyAudioMB, MaxOutputTokens, ChatModels, AudioModels);
- `Admin` (Email, Password, Name).

`appsettings.Secrets.json` holds `Smtp` (Host, Port, EnableSsl, UserName, Password, FromAddress, FromName) and `Ai:Groq:ApiKey`.

---

## 27. Interface, languages and RTL

- **Languages:**
  - Arabic (default, RTL) and English (LTR), switchable at any time, including on the sign-in screen;
  - every string and every error message is in `frontend/lib/i18n.ts` (`STRINGS.ar` / `STRINGS.en`, and `ERRORS`);
  - the `<html dir>` and `lang` attributes follow the choice.
- **Mixed text:**
  - Arabic transcripts are shown RTL regardless of the UI language;
  - file names and mixed text use `<bdi>`/`dir="auto"`, so they never jump around.
- **Design:**
  - Fluent-style design in plain CSS: tokens on `:root`, dark mode via `prefers-color-scheme`, logical properties (`margin-inline-start`) for RTL/LTR;
  - long transcripts use `content-visibility: auto` so only visible rows are rendered;
  - the player highlight updates the DOM directly, without re-rendering.
- **Settings:** all preferences are stored in `localStorage` through `usePersistentState`. These include the transcription settings, export options, live source and microphone, and queue options.

---

## 28. Development workflow

1. **Requirements:** Windows 10/11, Node.js ≥ 22.12, Python 3.10–3.13, Git. For the server: .NET 8 SDK and SQL Server (or the hosted one).
2. **First time:** `npm install`. This installs the JS packages and, automatically, the Python environment. Then `npm run dev`.
3. **Adding an engine feature:**
   1. write a module in `backend/app/`;
   2. create its manager in `create_app()` (`server.py`) and add a route;
   3. add typed methods and types in `frontend/lib/api.ts`;
   4. add a component in `frontend/components/`;
   5. add strings to `i18n.ts` (both languages), plus any new error code in `errors.py` and in `ERRORS`;
   6. PyInstaller picks up the new module automatically (`collect_submodules("app")`).
4. **Adding a desktop capability:** add an `ipcMain.handle` in `main.js`, expose it in `preload.js`, and type it in `desktop.d.ts`.
5. **Checks:**
   - `npm run typecheck`;
   - `python -m compileall backend/app`;
   - the server builds with `dotnet build`;
   - `npm run doctor` for environment problems.
6. **Shipping:** see §20.4.

---

## 29. Known limits and design trade-offs

- **Unsigned installer:** Windows SmartScreen may warn on first run. Code-signing would remove that.
- **Installer size:** building on an NVIDIA machine bundles the CUDA libraries (~1.3 GB installer). A CPU-only build (`npm run setup:cpu` in a fresh clone) is much smaller.
- **Cohere Arabic:**
  - CPU only, needs ~2.4 GB of free RAM, and handles Arabic/English only;
  - its timestamps are per speech chunk, not per word.
- **Live transcription:**
  - it is as fast as the machine: on a weak CPU with a big model, text lags and catches up (the backlog is shown);
  - computer-audio capture is Windows-only;
  - a file transcription and a live session can't run at the same time.
- **Updates:**
  - require publishing the three files with each release;
  - "latest" must always point to an app release, not to the model-mirror release.
- **Polling:**
  - the UI polls the engine (simple and robust on localhost), and watched folders are polled every 5 s instead of using file-system notifications;
  - both are deliberate, for reliability on OneDrive and network drives.
- **Codes:** e-mail codes live in the server's memory; a server restart invalidates pending codes (users just request a new one).
- **Free AI:** the allowance is per user per UTC day; heavy users should add their own Groq key.

---

*This guide describes the code as of version 1.0.0. The shorter [ARCHITECTURE.md](ARCHITECTURE.md) and the [README](../README.md) remain the quick references.*
