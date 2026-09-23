"""Batch queue: transcribe many files one after another, unattended.

The user adds a whole folder (or several files); the queue runs them in order
through the normal :class:`~app.jobs.JobManager` pipeline, saves every
finished transcript to the archive and — optionally — summarizes it.

Only one transcription runs at a time (the model is loaded once and reused),
so a queue of 30 lectures behaves exactly like 30 manual runs, just without
anyone clicking "Start". Failures don't stop the queue unless every following
file would fail too (bad API key, no credit, FFmpeg missing).
"""

from __future__ import annotations

import json
import logging
import os
import re
import threading
import time
import uuid
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any

from .archive import Archive
from .errors import AppError, ErrorCode
from .jobs import JobManager, JobRequest, PreparedMedia, prepare_media
from .media import SUPPORTED_EXTENSIONS
from .summarize import SummaryRequest, summarize
from .translate import TranslateRequest, translate

log = logging.getLogger(__name__)

MAX_ITEMS = 2000
# Errors that would repeat for every remaining file → pause the queue instead.
_FATAL = {
    ErrorCode.CLOUD_AUTH,
    ErrorCode.CLOUD_QUOTA,
    ErrorCode.FFMPEG_MISSING,
    ErrorCode.MODEL_NOT_DOWNLOADED_OFFLINE,
    ErrorCode.MODEL_DOWNLOAD_FAILED,
    ErrorCode.CLOUD_LANGUAGE_REQUIRED,
    ErrorCode.CLOUD_LANGUAGE_UNSUPPORTED,
    ErrorCode.YOUTUBE_BOT_CHECK,  # YouTube is blocking this PC for now: every next video would fail
}
YOUTUBE_PAUSE_S = 2.0  # be gentle with YouTube between videos


def _natural_key(path: Path) -> list[Any]:
    """'Lecture 2' before 'Lecture 10'."""
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", str(path))]


def scan_with_course(paths: list[str], recursive: bool = True) -> list[tuple[str, str | None]]:
    """Expand folders into their media files (natural order, no duplicates).

    Files found inside an added folder get that folder's name as their course.
    """
    found: list[tuple[Path, str | None]] = []
    for raw in paths:
        p = Path(raw)
        if p.is_dir():
            walker = (Path(root) / f for root, _dirs, files in os.walk(p) for f in files) if recursive else p.iterdir()
            files = [f for f in walker if f.is_file() and f.suffix.lower() in SUPPORTED_EXTENSIONS]
            found.extend((f, p.name) for f in sorted(files, key=_natural_key))
        elif p.is_file() and p.suffix.lower() in SUPPORTED_EXTENSIONS:
            found.append((p, None))
        if len(found) > MAX_ITEMS:
            break
    seen: set[str] = set()
    out: list[tuple[str, str | None]] = []
    for f, course in found:
        key = str(f.resolve()) if f.exists() else str(f)
        if key not in seen:
            seen.add(key)
            out.append((str(f), course))
    return out[:MAX_ITEMS]


def scan(paths: list[str], recursive: bool = True) -> list[str]:
    return [f for f, _ in scan_with_course(paths, recursive)]


@dataclass
class BatchSummaryOptions:
    provider: str
    model: str
    language: str = "auto"
    api_key: str = field(default="", repr=False)


@dataclass
class BatchOptions:
    model: str
    language: str | None
    device: str = "auto"
    preset: str = "balanced"
    arabic_punctuation: bool = True
    engine: str = "local"
    cloud_provider: str | None = None
    cloud_model: str | None = None
    api_key: str = field(default="", repr=False)
    summary: BatchSummaryOptions | None = None
    translation: TranslateRequest | None = None  # template (engine, target, key…); segments filled per file
    youtube_captions: bool = True  # YouTube items: use the video's captions when they exist
    db: Any = None  # DbRequest: insert each finished lecture into the user's database
    vocabulary: str = ""  # custom vocabulary (names / terms)


@dataclass
class BatchItem:
    id: str
    path: str  # file path, or the watch URL for YouTube items
    name: str
    kind: str = "file"  # file | youtube
    course: str | None = None  # archive course (folder name / playlist title)
    via: str | None = None  # youtube: "captions" (used YouTube's) or "transcribed"
    status: str = "queued"  # queued | running | done | error | cancelled | skipped
    job_id: str | None = None
    archive_id: str | None = None
    duration: float | None = None
    language: str | None = None
    word_count: int | None = None
    error: dict[str, str] | None = None
    summary_status: str | None = None  # None | running | done | error
    summary_error: dict[str, str] | None = None
    translation_status: str | None = None  # None | running | done | error
    translation_error: dict[str, str] | None = None
    db_status: str | None = None  # None | running | done | error
    db_error: dict[str, str] | None = None
    db_inserted: int | None = None
    started_at: float | None = None
    finished_at: float | None = None

    def to_dict(self) -> dict[str, Any]:
        return {k: v for k, v in self.__dict__.items()}


class BatchManager:
    def __init__(self, jobs: JobManager, archive: Archive, state_path: Path | None = None) -> None:
        self.jobs = jobs
        self.archive = archive
        self.items: list[BatchItem] = []
        # The queue survives closing the app, a crash or a power cut: it is saved to disk
        # (file list and results only — never API keys or database connection strings).
        self.state_path = state_path
        self.restored: dict[str, Any] | None = None
        self._saved = ""
        self.options: BatchOptions | None = None
        self.state = "idle"  # idle | running | stopping
        self.pause_reason: dict[str, str] | None = None
        self._lock = threading.RLock()
        self._stop_after_current = threading.Event()
        self._cancel_summary = threading.Event()
        self._thread: threading.Thread | None = None
        # Look-ahead: the next file's audio is prepared while the current one transcribes.
        self._prefetch: _Prefetch | None = None
        if state_path is not None:
            self._restore()
            threading.Thread(target=self._saver, daemon=True, name="batch-saver").start()

    # ------------------------------------------------------------- persistence
    def _state_json(self) -> str:
        with self._lock:
            return json.dumps(
                {"version": 1, "was_running": self.state != "idle", "items": [i.to_dict() for i in self.items]},
                ensure_ascii=False,
            )

    def save(self) -> None:
        if self.state_path is None:
            return
        data = self._state_json()
        if data == self._saved:
            return
        try:
            tmp = self.state_path.with_suffix(".tmp")
            tmp.write_text(data, encoding="utf-8")
            tmp.replace(self.state_path)
            self._saved = data
        except OSError as exc:
            log.warning("Could not save the queue: %s", exc)

    def _saver(self) -> None:
        while True:
            time.sleep(2.0)
            self.save()

    def _restore(self) -> None:
        try:
            raw = json.loads(self.state_path.read_text(encoding="utf-8"))  # type: ignore[union-attr]
        except (OSError, ValueError):
            return
        fields = set(BatchItem.__dataclass_fields__)
        items: list[BatchItem] = []
        interrupted = 0
        for data in raw.get("items") or []:
            if not isinstance(data, dict) or not data.get("id") or not data.get("path"):
                continue
            item = BatchItem(**{k: v for k, v in data.items() if k in fields})
            if item.status == "running":  # the app closed in the middle of this file: do it again
                item = BatchItem(id=item.id, path=item.path, name=item.name, kind=item.kind, duration=item.duration, course=item.course)
                interrupted += 1
            item.job_id = None
            items.append(item)
        self.items = items[:MAX_ITEMS]
        queued = sum(1 for i in self.items if i.status == "queued")
        if queued and (raw.get("was_running") or interrupted):
            self.restored = {"queued": queued, "interrupted": interrupted, "done": sum(1 for i in self.items if i.status == "done")}
        self._saved = self._state_json()

    # ------------------------------------------------------------- queue edits
    def add(self, paths: list[str], skip_archived: bool = True, course: str | None = None) -> dict[str, Any]:
        found = scan_with_course(paths)
        courses = {f: (course or c) for f, c in found}
        files = [f for f, _ in found]
        archived = self.archive.find_sources(files) if skip_archived else {}
        added = skipped = 0
        with self._lock:
            existing = {i.path: i for i in self.items}
            for f in files:
                item = existing.get(f)
                if item is not None:
                    if item.status in ("error", "cancelled"):  # adding it again = retry
                        self.items[self.items.index(item)] = BatchItem(id=item.id, path=f, name=item.name, course=courses[f])
                        added += 1
                    elif item.status == "done":
                        skipped += 1
                    continue
                if f in archived:
                    skipped += 1
                    continue
                if len(self.items) >= MAX_ITEMS:
                    break
                self.items.append(BatchItem(id=uuid.uuid4().hex, path=f, name=Path(f).name, course=courses[f]))
                added += 1
        return {"found": len(files), "added": added, "skipped": skipped, **self.snapshot()}

    def add_youtube(self, url: str, skip_archived: bool = True, course: str | None = None) -> dict[str, Any]:
        """Add every video of a playlist (or a single video link) to the queue."""
        from .youtube import inspect, inspect_playlist, normalize_url, playlist_id

        if playlist_id(url):
            playlist = inspect_playlist(url)
            entries = playlist["entries"]
            title = playlist["title"]
            course = course or title  # a playlist is a course
        else:
            info = inspect(normalize_url(url))
            entries = [{"url": info.url, "title": info.title, "duration": info.duration}]
            title = info.title
        urls = [e["url"] for e in entries]
        archived = self.archive.find_sources(urls) if skip_archived else {}
        added = skipped = 0
        with self._lock:
            existing = {i.path: i for i in self.items}
            for e in entries:
                item = existing.get(e["url"])
                if item is not None:
                    if item.status in ("error", "cancelled"):
                        self.items[self.items.index(item)] = BatchItem(
                            id=item.id, path=item.path, name=item.name, kind="youtube", duration=item.duration, course=course
                        )
                        added += 1
                    elif item.status == "done":
                        skipped += 1
                    continue
                if e["url"] in archived:
                    skipped += 1
                    continue
                if len(self.items) >= MAX_ITEMS:
                    break
                self.items.append(
                    BatchItem(
                        id=uuid.uuid4().hex,
                        path=e["url"],
                        name=e["title"],
                        kind="youtube",
                        duration=e.get("duration"),
                        course=course,
                    )
                )
                added += 1
        return {"found": len(entries), "added": added, "skipped": skipped, "playlist": title, **self.snapshot()}

    def remove(self, item_id: str) -> None:
        with self._lock:
            item = self._item(item_id)
            if item.status == "running":
                raise AppError(ErrorCode.BUSY, "This file is being transcribed; stop the queue first")
            self.items.remove(item)

    def retry(self, item_id: str) -> None:
        with self._lock:
            item = self._item(item_id)
            if item.status in ("error", "cancelled"):
                fresh = BatchItem(
                    id=item.id, path=item.path, name=item.name, kind=item.kind, duration=item.duration, course=item.course
                )
                self.items[self.items.index(item)] = fresh

    def move(self, item_id: str, delta: int) -> None:
        with self._lock:
            item = self._item(item_id)
            i = self.items.index(item)
            j = max(0, min(len(self.items) - 1, i + delta))
            self.items.insert(j, self.items.pop(i))

    def clear(self, which: str) -> None:
        with self._lock:
            self.restored = None
            if which == "finished":
                self.items = [i for i in self.items if i.status in ("queued", "running")]
            else:
                self.items = [i for i in self.items if i.status == "running"]

    def _item(self, item_id: str) -> BatchItem:
        for item in self.items:
            if item.id == item_id:
                return item
        raise AppError(ErrorCode.INVALID_REQUEST, "Unknown queue item")

    # ------------------------------------------------------------- run control
    def start(self, options: BatchOptions) -> dict[str, Any]:
        if options.engine == "cloud":
            from .cloud import validate_request

            validate_request(options.cloud_provider or "", options.cloud_model or "", options.language, options.api_key)
        else:
            self.jobs.store.spec(options.model)
        if options.translation and options.translation.engine != "local" and not options.translation.api_key.strip():
            raise AppError(ErrorCode.CLOUD_AUTH, "No API key for translation")
        if options.summary:
            from .summarize import provider

            provider(options.summary.provider)
            if not options.summary.api_key.strip():
                raise AppError(ErrorCode.CLOUD_AUTH, "No API key for summaries")
        with self._lock:
            if self.state != "idle":
                raise AppError(ErrorCode.BUSY, "The queue is already running")
            if not any(i.status == "queued" for i in self.items):
                raise AppError(ErrorCode.INVALID_REQUEST, "The queue is empty")
            self.options = options
            self.restored = None
            self.state = "running"
            self.pause_reason = None
            self._stop_after_current.clear()
            self._cancel_summary.clear()
            self._thread = threading.Thread(target=self._run, daemon=True, name="batch")
            self._thread.start()
        return self.snapshot()

    def stop(self, cancel_current: bool) -> dict[str, Any]:
        with self._lock:
            if self.state == "idle":
                return self.snapshot()
            self.state = "stopping"
            self._stop_after_current.set()
            if cancel_current:
                self._cancel_summary.set()
                for item in self.items:
                    if item.status == "running" and item.job_id:
                        try:
                            self.jobs.cancel(item.job_id)
                        except AppError:
                            pass
        return self.snapshot()

    # ----------------------------------------------------------------- worker
    def _next(self) -> BatchItem | None:
        with self._lock:
            return next((i for i in self.items if i.status == "queued"), None)

    def _run(self) -> None:
        try:
            while not self._stop_after_current.is_set():
                item = self._next()
                if item is None:
                    break
                self._process(item)
        except Exception:  # noqa: BLE001
            log.exception("Batch worker crashed")
        finally:
            self._drop_prefetch()
            with self._lock:
                self.state = "idle"
                if self.options is not None:
                    # Forget the user's keys as soon as the queue stops.
                    self.options.api_key = ""
                    if self.options.summary:
                        self.options.summary.api_key = ""
                    if self.options.translation:
                        self.options.translation.api_key = ""
                    self.options.db = None  # drop the connection string from memory

    # ------------------------------------------------------------ look-ahead
    def _kick_prefetch(self, current: BatchItem, opts: BatchOptions) -> None:
        """Start preparing the next queued file (download / FFmpeg) in the background."""
        with self._lock:
            nxt = next((i for i in self.items if i.status == "queued" and i is not current), None)
            if nxt is None or (self._prefetch and self._prefetch.item_id == nxt.id):
                return
        self._drop_prefetch()
        pf = _Prefetch(nxt.id)
        self._prefetch = pf
        threading.Thread(
            target=pf.run, args=(self.jobs.settings, nxt.path, nxt.kind, opts), daemon=True, name="batch-prefetch"
        ).start()

    def _take_prefetch(self, item: BatchItem) -> "_Prefetch | None":
        pf = self._prefetch
        if pf is None or pf.item_id != item.id:
            return None
        self._prefetch = None
        while not pf.done.wait(0.3):  # it's this item's own preparation: waiting is no loss
            if self._stop_after_current.is_set() and self._cancel_summary.is_set():
                pf.discard()
                return None
        if pf.error is not None:
            pf.discard()
            return None  # prepare it the normal way (and report any error there)
        return pf

    def _drop_prefetch(self) -> None:
        pf, self._prefetch = self._prefetch, None
        if pf is not None:
            pf.discard()

    def _start_job(self, item: BatchItem, opts: BatchOptions, prepared: PreparedMedia | None = None):  # noqa: ANN202
        request = JobRequest(
            prepared=prepared,
            youtube_url=item.path if item.kind == "youtube" else None,
            path=item.path,
            model=opts.model,
            language=opts.language,
            device=opts.device,
            preset=opts.preset,
            arabic_punctuation=opts.arabic_punctuation,
            engine=opts.engine,
            cloud_provider=opts.cloud_provider,
            cloud_model=opts.cloud_model,
            api_key=opts.api_key,
            vocabulary=opts.vocabulary,
        )
        # The user may be running a manual transcription: wait for it to finish.
        while True:
            try:
                return self.jobs.start(request)
            except AppError as err:
                if err.code != ErrorCode.BUSY or self._stop_after_current.wait(2.0):
                    raise

    def _process(self, item: BatchItem) -> None:
        opts = self.options
        assert opts is not None
        with self._lock:
            item.status = "running"
            item.started_at = time.time()
        prefetched = self._take_prefetch(item)
        self._kick_prefetch(item, opts)
        prepared = prefetched.prepared if prefetched else None
        try:
            if item.kind == "youtube":
                if prepared is None:  # the look-ahead already decided when captions can't be used
                    if self._youtube_captions(item, opts, prefetched.captions if prefetched else None):
                        return
                    time.sleep(YOUTUBE_PAUSE_S)
            elif not Path(item.path).is_file():
                raise AppError(ErrorCode.FILE_NOT_FOUND, item.path)
            job = self._start_job(item, replace(opts, summary=None, translation=None, db=None), prepared)
            prepared = None  # the job owns (and deletes) the prepared audio now
            item.job_id = job.id
            while job.status == "running":
                time.sleep(0.5)
            if job.status != "completed":
                err = job.error or {"code": "internal", "detail": ""}
                self._finish(item, "cancelled" if job.status == "cancelled" else "error", err)
                if err.get("code") in {c.value for c in _FATAL}:
                    self._pause(err)
                return

            segments = [s.to_dict() for s in job.segments]
            media = job.media or {}
            model = opts.cloud_model if opts.engine == "cloud" else opts.model
            if item.kind == "youtube":
                item.via = "transcribed"
            self._complete(item, segments, media.get("duration") or item.duration, job.language, opts.engine, model, opts)
        except AppError as err:
            if err.code == ErrorCode.BUSY and self._stop_after_current.is_set():
                with self._lock:  # stopped while waiting for a manual run: keep it queued
                    item.status, item.started_at = "queued", None
                return
            self._finish(item, "error", err.to_dict())
            if err.code in _FATAL:
                self._pause(err.to_dict())
        except Exception as exc:  # noqa: BLE001
            log.exception("Batch item failed")
            self._finish(item, "error", {"code": "internal", "detail": f"{exc.__class__.__name__}: {exc}"[:300]})
        finally:
            if prepared is not None:  # never handed to a job (error / stop): clean it up
                import shutil

                shutil.rmtree(prepared.tmp_dir, ignore_errors=True)

    def _complete(
        self,
        item: BatchItem,
        segments: list[dict[str, Any]],
        duration: float | None,
        language: str | None,
        engine: str,
        model: str | None,
        opts: BatchOptions,
    ) -> None:
        """Save a finished transcript to the archive, then translate / summarize it."""
        saved = self.archive.save(
            {
                "title": item.name,
                "source_type": "youtube" if item.kind == "youtube" else "file",
                "source": item.path,
                "duration": duration,
                "language": language,
                "engine": engine,
                "model": model,
                "segments": segments,
                "course": item.course,
            }
        )
        with self._lock:
            item.archive_id = saved["id"]
            item.duration = duration
            item.language = language
            item.word_count = sum(len(str(s.get("text", "")).split()) for s in segments)
        self._finish(item, "done", None)
        if opts.translation and not self._cancel_summary.is_set():
            self._translate(item, segments, opts.translation)
        if opts.summary and not self._cancel_summary.is_set():
            self._summarize(item, segments, opts.summary)
        if opts.db is not None and not self._cancel_summary.is_set():
            self._insert_db(item, opts)

    def _insert_db(self, item: BatchItem, opts: BatchOptions) -> None:
        """Insert the finished lecture (with its translation and summary) into the database."""
        from .course_tools import course_lessons, payload_for
        from .db_export import execute

        with self._lock:
            item.db_status = "running"
        try:
            full = self.archive.get(item.archive_id) if item.archive_id else None
            if full is None:
                raise AppError(ErrorCode.INVALID_REQUEST, "Transcript was not saved")
            # Same numbering as "insert the whole course": title order within the course.
            lesson_index = next(
                (l["lesson_index"] for l in course_lessons(self.archive, item.course or "") if l["id"] == item.archive_id),
                None,
            )
            res = execute(opts.db, payload_for(full, lesson_index))
            with self._lock:
                item.db_status = "done"
                item.db_inserted = res["inserted"]
        except AppError as err:
            with self._lock:
                item.db_status = "error"
                item.db_error = err.to_dict()
            # Database unreachable: every next insert would fail too — stop inserting, keep transcribing.
            if err.code in (ErrorCode.DB_CONNECT_FAILED, ErrorCode.DB_DRIVER_MISSING) and self.options:
                self.options.db = None
                self.pause_reason = {"code": err.code.value, "detail": "db_disabled: " + err.detail}
        except Exception as exc:  # noqa: BLE001
            log.exception("Batch database insert failed")
            with self._lock:
                item.db_status = "error"
                item.db_error = {"code": "db_query_failed", "detail": str(exc)[:300]}

    def _youtube_captions(self, item: BatchItem, opts: BatchOptions, known: Any = None) -> bool:
        """Use the video's own captions when allowed and available. True when done."""
        if not opts.youtube_captions:
            return False
        from .youtube import fetch_subtitles, inspect, pick_caption

        info = known or inspect(item.path)  # errors (unavailable, bot check…) fail this item
        with self._lock:
            item.name = info.title or item.name
            item.duration = info.duration or item.duration
        track = pick_caption(info, opts.language)
        if track is None:
            return False
        try:
            res = fetch_subtitles(item.path, track.lang, track.kind)
        except AppError as err:
            if err.code == ErrorCode.YOUTUBE_NO_CAPTIONS:
                return False  # fall back to transcribing the audio
            raise
        item.via = "captions"
        label = "YouTube captions (channel)" if track.kind == "manual" else "YouTube automatic captions"
        self._complete(item, res["segments"], res.get("duration") or item.duration, res["language"], "youtube", label, opts)
        time.sleep(YOUTUBE_PAUSE_S)
        return True

    def _summarize(self, item: BatchItem, segments: list[dict[str, Any]], opts: BatchSummaryOptions) -> None:
        with self._lock:
            item.summary_status = "running"
        try:
            result = summarize(
                SummaryRequest(
                    segments=segments,
                    provider=opts.provider,
                    model=opts.model,
                    api_key=opts.api_key,
                    language=opts.language,
                    title=item.name,
                    duration=item.duration,
                    transcript_language=item.language,
                ),
                self._cancel_summary,
            )
            if item.archive_id:
                self.archive.set_summary(item.archive_id, result)
            with self._lock:
                item.summary_status = "done"
        except AppError as err:
            with self._lock:
                item.summary_status = "error"
                item.summary_error = err.to_dict()
            # A bad key/credit would fail every summary: stop summarizing, keep transcribing.
            if err.code in (ErrorCode.CLOUD_AUTH, ErrorCode.CLOUD_QUOTA, ErrorCode.SUMMARY_MODEL) and self.options:
                self.options.summary = None
                self.pause_reason = {"code": err.code.value, "detail": "summaries_disabled: " + err.detail}
        except Exception as exc:  # noqa: BLE001
            log.exception("Batch summary failed")
            with self._lock:
                item.summary_status = "error"
                item.summary_error = {"code": "summary_failed", "detail": str(exc)[:300]}

    def _translate(self, item: BatchItem, segments: list[dict[str, Any]], template: TranslateRequest) -> None:
        with self._lock:
            item.translation_status = "running"
        try:
            result = translate(
                replace(template, segments=segments, source=item.language, title=item.name),
                self.jobs.store,
                self._cancel_summary,
            )
            if item.archive_id:
                self.archive.set_translation(item.archive_id, result)
            with self._lock:
                item.translation_status = "done"
        except AppError as err:
            if err.code == ErrorCode.TRANSLATE_SAME_LANGUAGE:  # e.g. an English lecture in the batch
                with self._lock:
                    item.translation_status = "skipped"
                return
            with self._lock:
                item.translation_status = "error"
                item.translation_error = err.to_dict()
            # Would fail for every file: stop translating, keep transcribing.
            if err.code in (ErrorCode.CLOUD_AUTH, ErrorCode.CLOUD_QUOTA, ErrorCode.SUMMARY_MODEL, ErrorCode.MODEL_DOWNLOAD_FAILED) and self.options:
                self.options.translation = None
                self.pause_reason = {"code": err.code.value, "detail": "translation_disabled: " + err.detail}
        except Exception as exc:  # noqa: BLE001
            log.exception("Batch translation failed")
            with self._lock:
                item.translation_status = "error"
                item.translation_error = {"code": "translate_failed", "detail": str(exc)[:300]}

    def _finish(self, item: BatchItem, status: str, error: dict[str, str] | None) -> None:
        with self._lock:
            item.status = status
            item.error = error
            item.finished_at = time.time()

    def _pause(self, error: dict[str, str]) -> None:
        with self._lock:
            self.pause_reason = error
            self._stop_after_current.set()
            self.state = "stopping"

    # --------------------------------------------------------------- snapshot
    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            items = [i.to_dict() for i in self.items]
            running = next((i for i in self.items if i.status == "running"), None)
            state = self.state
            opts = self.options
        current = None
        if running and running.job_id:
            try:
                snap = self.jobs.get(running.job_id).snapshot(since=10**9)
                current = {
                    "itemId": running.id,
                    "stage": snap["stage"],
                    "progress": snap["progress"],
                    "etaSeconds": snap["etaSeconds"],
                    "segmentCount": snap["segmentCount"],
                    "duration": (snap.get("media") or {}).get("duration"),
                }
            except AppError:
                current = None
        counts: dict[str, int] = {}
        for i in items:
            counts[i["status"]] = counts.get(i["status"], 0) + 1
        return {
            "state": state,
            "items": items,
            "counts": counts,
            "current": current,
            "pauseReason": self.pause_reason,
            "restored": self.restored,
            "summarize": bool(opts and opts.summary) if state != "idle" else None,
            "translate": bool(opts and opts.translation) if state != "idle" else None,
            "database": bool(opts and opts.db is not None) if state != "idle" else None,
        }


class _Prefetch:
    """Background preparation of one queued item."""

    def __init__(self, item_id: str) -> None:
        self.item_id = item_id
        self.done = threading.Event()
        self.cancel = threading.Event()
        self.prepared: PreparedMedia | None = None
        self.captions: Any = None  # YouTube VideoInfo when its captions will be used
        self.error: BaseException | None = None
        self._tmp: Path | None = None

    def run(self, settings: Any, path: str, kind: str, opts: BatchOptions) -> None:
        import shutil
        import tempfile

        try:
            if kind == "youtube" and opts.youtube_captions:
                from .youtube import inspect, pick_caption

                info = inspect(path)
                if pick_caption(info, opts.language) is not None:
                    self.captions = info  # captions will be used: nothing to download
                    return
            elif kind != "youtube" and not Path(path).is_file():
                raise AppError(ErrorCode.FILE_NOT_FOUND, path)
            self._tmp = Path(tempfile.mkdtemp(prefix="local-transcriber-next-"))
            pcm, media = prepare_media(
                settings, path, path if kind == "youtube" else None, self._tmp, self.cancel
            )
            self.prepared = PreparedMedia(pcm, media, self._tmp)
        except BaseException as exc:  # noqa: BLE001 - redone (and reported) when the item's turn comes
            self.error = exc
            if self._tmp is not None:
                shutil.rmtree(self._tmp, ignore_errors=True)
        finally:
            self.done.set()

    def discard(self) -> None:
        import shutil

        self.cancel.set()
        self.done.wait(30)
        if self._tmp is not None:
            shutil.rmtree(self._tmp, ignore_errors=True)
