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
- The UI sends **file paths, not file bytes**. Media never passes through the UI and is never uploaded. The one exception is the built-in player: `GET /media/stream?path=…&token=…` streams a local media file (supported extensions only, HTTP Range for seeking) back to the same window — `<video>` cannot send headers, so this single GET route also accepts the token as a query parameter. The CSP allows `media-src http://127.0.0.1:*` for it and `frame-src https://www.youtube-nocookie.com` for the YouTube player, used only for transcripts of YouTube videos.
- The renderer runs with `contextIsolation`, `sandbox` and no Node integration. The only native features it can use are the ones exposed by `electron/preload.js` (`window.desktop`).
- **Mandatory sign-in** (`electron/auth.js`) against the central **WindowsAppLoginBackend** service (`apiBaseUrl` → `/api/auth/login`, `/register`, `/me`, `/options`): `AuthGate` posts `{email, password}` from the main process (`net.fetch`, so no CORS/CSP change in the renderer) and reads the token from the first matching `tokenPaths` entry. Until then `backend:connection` / `backend:restart` return `{state: "locked"}`, status broadcasts are replaced by `locked`, and `secrets:*` / `db:loadProfiles` return nothing — the renderer never learns the backend's port or token. "Remember me" stores `{email, name, token, expiresAt}` encrypted with `safeStorage` in `session.json`; expiry comes from the JWT `exp` claim (else `rememberDays`). Packaged builds ignore `enabled: false`.
- **Built-in keys:** `builtin-keys.json` (project root in development, `resources/` when packaged; git-ignored) can hold default keys by secret name (e.g. `cloud:groq`). `secrets:get` returns the user's own DPAPI-encrypted key first and falls back to the built-in one; settings fields read `secrets:getStored` so the built-in key is never displayed. A key shipped this way is extractable from the installer.
- Hugging Face and Next.js telemetry are disabled. Network requests: the one-time model download, YouTube (only when the user pastes a link), and the selected paid provider (only when the user chooses one).

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
- **Batched inference + VAD:** Silero VAD removes silence, and speech chunks are decoded in batches (16 on GPU / 8 on CPU, halved for large models, 2 on a CPU when free RAM is low — batching stays on because it is the biggest CPU speed-up).
- **CPU decoding:** *Balanced* uses beam 2 on the CPU (beam 5 on a GPU); temperature fallback is limited to 0.0/0.4/0.8 except in *Most accurate*.
- **Cloud chunks:** providers that return segment timestamps (Groq, OpenAI whisper-1) get ~9–10-minute chunks with `verbose_json` (≈50× fewer requests — important with Groq's free 20 requests/minute); others get ~20-second speech chunks.
- **Overlapped start-up:** the model is loaded (or its download started) on a background thread while FFmpeg extracts the audio; the job joins that thread before decoding.
- **Queue look-ahead:** while file *N* is being transcribed, a `_Prefetch` thread probes and extracts file *N+1* into its own temp folder (`PreparedMedia`), which the next job uses directly. Unused prefetches are discarded on stop/cancel.
- **Custom vocabulary:** user terms go to faster-whisper `hotwords` locally and to the `prompt` field for OpenAI/Groq (deduplicated, capped at 400 characters).
- **Archive search:** a normalized `search_text` column (Arabic-insensitive: tashkeel, alef forms, ya/ta marbuta) is stored at save time and back-filled once for old archives, so search is a plain `LIKE` instead of normalizing every transcript per query (~3× faster on large archives). Transcript rows use `content-visibility: auto` so long lectures render only what is on screen.
- **Language is detected once** on up to 5 minutes of speech, then fixed for the whole file, so long recordings don't flip languages.
- **Hallucination guard:** drops well-known Whisper artefacts produced on silence (e.g. subtitle credits such as “ترجمة نانسي قنقر”) and breaks repetition loops.

### Presets

| Preset | Decoder | Use for |
|---|---|---|
| Fastest | batched, greedy (beam 1) | Drafts, very long recordings |
| Balanced | batched, beam 5 on GPU / beam 2 on CPU, VAD silence skipping | Default |
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

## Paid cloud providers

`backend/app/cloud.py` supports Cohere Transcribe, OpenAI and Groq with the user's own API key (stored by Electron with `safeStorage`/DPAPI, passed per job, wiped from memory when the job ends).

- Silero VAD (in 10-minute windows) finds speech; regions are merged into ≤ 28 s chunks and encoded as 16 kHz mono WAV (~0.9 MB) — silence is never uploaded or billed, and the 25 MB API limits are never reached.
- Up to 4 chunks are uploaded in parallel; results are emitted **in order**, each with its chunk's start/end as timestamps (Cohere returns plain text only).
- 429/5xx are retried with exponential backoff (honouring `Retry-After`); auth, quota and language errors fail fast with a clear message. Cancel returns immediately.

## Archive

`backend/app/archive.py` — SQLite (`archive.db` in the Electron userData folder). The UI saves every finished transcript (debounced, chained so edits update the same row). Search normalizes Arabic (tashkeel, tatweel, alef/ya/ta-marbuta forms) into a stored `search_text` column.

**Backup / restore:** `POST /archive/backup` writes a zip (`.ltbackup`) with `manifest.json` (`format`, `version`, counts) and a consistent SQLite snapshot taken with the SQLite backup API (`search_text` cleared and the file vacuumed to keep it small), first to `*.part` and then renamed. `POST /archive/restore` accepts that file or a raw `archive.db`, reads it read-only, tolerates older schemas (missing columns become NULL) and merges in one transaction: new ids are inserted, an existing id is replaced only when the backup's `updated_at` is newer, and summary/translation/course fall back to the local value when the incoming one is empty. Malformed rows are counted and skipped; any database error rolls everything back. Secrets and DB profiles stay in Electron's `safeStorage` and are never part of a backup.

## Batch queue

`backend/app/batch.py` — `BatchManager` keeps an in-memory queue of files (folders are expanded recursively, natural sort). A single worker thread starts each file through the normal `JobManager` (so the loaded model is reused and only one transcription runs at a time), waits for it, saves the result to the archive and optionally summarizes it. If the user starts a manual transcription meanwhile, the worker waits (`BUSY`) and continues afterwards. Errors that would repeat for every file (`cloud_auth`, `cloud_quota`, model download, FFmpeg missing) pause the queue; others mark only that file. API keys live only in memory and are cleared when the queue stops. YouTube items (`POST /batch/add_youtube`: a playlist is listed with yt-dlp's flat extraction, one request, nothing downloaded) first try `pick_caption` — a channel or original-language automatic track in the transcription language — and are archived straight from the captions; otherwise the job downloads only the audio. `youtube_bot_check` pauses the queue, and a short pause separates videos. The UI polls `GET /batch` and asks Electron's `powerSaveBlocker` to keep Windows awake while it runs.

**Surviving restarts:** a saver thread writes the item list and results to `batch-queue.json` in the data folder every 2 s when it changed (never options, keys or connection strings). On start, items that were `running` go back to `queued` with their results cleared, and `snapshot().restored` (`queued`, `interrupted`, `done`) makes the UI show "Continue where it stopped", which calls the normal `/batch/start` with the user's current options.

## Whole-course actions

`backend/app/course_tools.py` orders a course's lessons naturally by title (that order is `@lesson_index` and the `01 - …` file numbers) and runs background tasks: **insert into database** (the normal `db_export.execute` per lesson, one transaction each, with the lesson's translation/summary/course as extra variables; two consecutive connection failures stop the task) and **export** (PDF + SRT/VTT per lesson into one folder, plus `index.csv` with a UTF-8 BOM for Excel). The batch queue can call the same insert right after each lecture (`BatchOptions.db`), numbering lessons the same way.

**Other exports** (`documents.py`): Word, plain text and JSON take the same `ExportRequest` as the PDF. The `.docx` is written by hand (content types, rels, `document.xml`, `styles.xml`): paragraphs get `w:bidi` and runs `w:rtl` by majority script, so mixed lines like "JOIN يربط الجداول" lay out right-to-left while dates and times stay in order; chapters are `Heading 2` (Word's navigation pane). TXT is written with a BOM and CRLF for Notepad.

**Course website** (`course_site.py`): `website/index.html` + `lesson-NN.html` + `assets/{style.css,site.js,search-index.js}`. Pages are static HTML (readable without JavaScript); search runs in the browser over `search-index.js` (a script, because browsers block `fetch` of local files), with the same Arabic normalization as the archive, and highlights matches on the lesson page (`?q=`). YouTube lessons link each paragraph to `watch?v=…&t=…`. Nothing is loaded from the internet; light/dark via `prefers-color-scheme`.

## Built-in player & video with subtitles

`MediaPlayer` streams from `/media/stream` (or drives the YouTube embed through its `postMessage` API — `listening` handshake, `infoDelivery` for the time, `seekTo`/`playVideo` commands — without loading any script). The current time goes through a small `PlayerClock` subscription instead of React state, so the transcript moves its `is-playing` highlight directly in the DOM (binary search over segment starts) without re-rendering long lectures; auto-scroll pauses for 4 s after the user scrolls.

`burn.py` writes an ASS file (PlayRes = the video's size, font size relative to its height, `Encoding -1` so libass picks each line's base direction) and runs FFmpeg's `subtitles` filter with **relative** paths from a temp working directory (`subtitles=subs.ass:fontsdir=fonts`) to avoid Windows drive-letter escaping. Font: bundled Noto Sans Arabic. With the translation, two independent tracks (original above, translation smaller below). Video is re-encoded with libx264 CRF 20 `veryfast`; audio is copied when AAC/MP3, else AAC 192k; written to `*.part.mp4` then renamed; progress from `-progress pipe:1`.

## Ask the course

`assistant.py`. **Ask:** every lesson of the course is cut into ~45 s blocks (plus each lesson's summary), tokenized with Arabic normalization, prefix stripping (`ال`, `وال`, `بال`…) and a small stop-word list. If the whole course fits the provider's input budget it is sent as is; otherwise BM25 picks the best blocks (with a neighbour on each side) up to the budget. Excerpts are labelled `[L<lesson> mm:ss]`, the model must cite with those labels, and citations (inline or listed) are validated against real lessons and snapped to real block starts.

## AI summaries

`backend/app/summarize.py` calls the chat API of Anthropic (`/v1/messages`), OpenAI and Groq (`/chat/completions`, JSON mode) or Cohere (`/v2/chat`, JSON mode) with the user's key. The transcript is merged into ~40-second blocks prefixed with `[mm:ss]`, and the model returns JSON (`summary`, `key_points`, `chapters[{start,title,summary}]`, `keywords`). Chapter times are parsed, validated against the duration and snapped to real block starts. Transcripts longer than the provider's budget are summarized per part (map) and merged (reduce). Requests retry on 429/5xx with `Retry-After`. The result is stored in the archive (`summary_json` column, migrated in place) and can be printed in the PDF, where chapters become headings, bookmarks and link targets of the summary's chapter list.

## Translation & subtitles

`backend/app/translate.py` translates segment by segment, so every translated line keeps its original start/end time.

- **Offline:** [gaudi/opus-mt-ar-en-ctranslate2](https://huggingface.co/gaudi/opus-mt-ar-en-ctranslate2) (Helsinki-NLP Opus-MT converted to CTranslate2) is downloaded once into `models/extra/opus-mt-ar-en/` through the same resumable `ModelStore` download as Whisper. It runs on the CPU (`int8`) with SentencePiece tokenization; long segments are split at punctuation before translation and re-joined.
- **AI key:** segments are sent in numbered JSON batches (~4,500 characters, up to 60 items, with the previous 3 lines as context) through `summarize.chat`; items the model skips are re-requested in smaller groups.
- **DeepL** (`/v2/translate`, free keys `:fx` → `api-free.deepl.com`, usage via `/v2/usage`) and **Azure AI Translator** (`/translate?api-version=3.0`, optional region header) are called in batches with retries on 429/5xx.
- Results are stored in the archive (`translation_json`), edited in the bilingual view, printed in the PDF (`content = original | translation | both`) and exported by `backend/app/subtitles.py` as SRT/VTT cues (≤ 2 lines × 42 characters, ≤ 7 s, cut at punctuation, time shared by length, RLM marks on right-to-left lines, SRT written with a UTF-8 BOM).

## YouTube

`backend/app/youtube.py` uses [yt-dlp](https://github.com/yt-dlp/yt-dlp). YouTube requires a JavaScript runtime for full support; the `deno` pip package provides it (bundled into the installer under `_internal/deno/`), together with `yt-dlp-ejs`.

- `inspect` lists caption tracks: channel-uploaded (`subtitles`) and YouTube's original-language speech recognition (`automatic_captions` `*-orig`); machine-translated auto tracks are skipped.
- `fetch_subtitles` downloads the json3 track (millisecond timings; VTT fallback), clamps overlapping auto-caption events and merges 1–3-word events into readable segments.
- Without captions, the job gets a `downloading_media` stage: only the best **audio** stream is downloaded into the job's temp folder (deleted afterwards), then the normal pipeline runs.

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
| GET | `/cloud/providers` | Paid providers and their models |
| POST | `/cloud/test` | Validate an API key (lists models — nothing billed) |
| GET | `/archive?q=` | List/search archived transcripts |
| GET / DELETE | `/archive/{id}` | Open / delete an archived transcript |
| POST | `/archive` | Create or update an archive entry |
| POST | `/archive/backup` | Save the whole archive to one `.ltbackup` file |
| POST | `/archive/restore` | Merge a backup (or a raw `archive.db`) into the archive |
| PUT | `/archive/{id}/summary` | Store or clear the AI summary of an entry |
| GET | `/summary/providers` | Summary (LLM) providers and default models |
| POST | `/summary/test` | Validate an API key for summaries |
| POST | `/summary` | Start a summary task (optionally saved to an archive entry) |
| GET | `/summary/{id}` | Progress (`step`/`steps`) and result |
| POST | `/summary/{id}/cancel` | Cancel a summary |
| GET | `/translate/catalog` | Offline model state, AI providers, DeepL/Azure info |
| POST / DELETE | `/translate/models/{key}` (`/download`) | Download / delete the offline translation model |
| POST | `/translate/test` | Validate a DeepL / Azure / AI key (DeepL returns usage) |
| POST | `/translate` · GET `/translate/{id}` · POST `/translate/{id}/cancel` | Run, follow and cancel a translation |
| PUT | `/archive/{id}/translation` | Store or clear the translation of an entry |
| POST | `/export/subtitles` | Write SRT / VTT from timed segments |
| GET | `/courses/lessons?course=` | Lessons of a course in order |
| POST | `/courses/db/preview` · `/courses/db` | Preview / insert a whole course with a saved profile |
| POST | `/courses/export` | Export a whole course (PDF + subtitles + index.csv) |
| GET / POST | `/courses/tasks/{id}` · `/cancel` | Follow / cancel a course task |
| GET | `/archive/courses` · POST `/archive/courses/rename` · PUT `/archive/{id}/course` | Courses in the archive |
| GET | `/batch` | Queue state, items and progress of the current file |
| POST | `/batch/add` | Add files/folders (skips archived files if asked) |
| POST | `/batch/start` / `/batch/stop` | Run the queue / stop after current or now |
| POST | `/batch/items/{id}/retry` · `/move` | Retry a failed file / reorder |
| DELETE | `/batch/items/{id}` | Remove a file from the queue |
| POST | `/batch/clear?which=finished\|all` | Clear finished or all items |
| POST | `/youtube/inspect` | Video info + available caption tracks |
| POST | `/youtube/subtitles` | Fetch one caption track as transcript segments |
| POST | `/export/document` | Word / TXT / JSON (same body as `/export/pdf` + `format`) |
| POST · GET | `/export/burn` · `/export/burn/{id}` (+ `/cancel`) | Video with subtitles (background task) |
| GET | `/media/stream?path=&token=` | Local media for the built-in player (Range) |
| GET | `/archive/stats` | Totals, per course, per month |
| POST · GET | `/assist/ask` · `/assist/{id}` (+ `/cancel`) | Ask the course (background task) |
| POST | `/batch/dismiss_restored` | Hide the "continue the queue" notice |
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
  components/      MediaPicker, SettingsPanel, ProgressPanel, TranscriptView, SummaryPanel,
                   ExportPanel, BatchDialog, ArchiveDialog, DatabaseDialog, YoutubePanel,
                   MediaPlayer, BurnDialog, AskDialog, StatsDialog, CourseToolsDialog
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
  app/documents.py    Word / TXT / JSON exports
  app/course_site.py  static course website
  app/burn.py         video with burned-in subtitles (FFmpeg + libass)
  app/assistant.py    ask the course (retrieval + LLM)
  app/errors.py    user-facing error codes
  app/config.py    paths from environment (no hard-coded machine paths)
  transcriber-backend.spec  PyInstaller build
scripts/
  setup-python.mjs venv + pip (runs on npm install)
  dev.mjs          next dev + electron
  build-backend.mjs PyInstaller build
  doctor.mjs       diagnostics
```
