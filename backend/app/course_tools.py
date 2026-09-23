"""Whole-course actions on the archive: insert every lesson into a database,
or export every lesson as files (PDF + subtitles) in one folder.

Lessons are ordered naturally by title ("Lesson 2" before "Lesson 10"), and
that order gives ``@lesson_index`` / the file-name numbers, so the website and
the exported folder use the same numbering.
"""

from __future__ import annotations

import csv
import logging
import re
import threading
import time
import uuid
from dataclasses import dataclass, field, replace
from datetime import datetime
from pathlib import Path
from typing import Any

from .archive import Archive
from .db_export import DbRequest, TranscriptPayload, execute
from .errors import AppError, ErrorCode
from .pdf_export import ExportRequest, ExportSegment, generate_pdf
from .subtitles import write_subtitles
from .course_site import SiteLesson, write_site
from .documents import write_document

log = logging.getLogger(__name__)

_LANGUAGE_NAMES = {
    "ar": {"ar": "العربية", "en": "الإنجليزية", "fr": "الفرنسية", "tr": "التركية", "es": "الإسبانية", "de": "الألمانية"},
    "en": {"ar": "Arabic", "en": "English", "fr": "French", "tr": "Turkish", "es": "Spanish", "de": "German"},
}


def natural_key(text: str) -> list[Any]:
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", text or "")]


def course_lessons(archive: Archive, course: str | None) -> list[dict[str, Any]]:
    """Summaries of a course's lessons in natural title order ("" → lessons without a course)."""
    items: list[dict[str, Any]] = []
    offset = 0
    while True:
        page = archive.list("", 200, offset, course if course is not None else None)
        items.extend(page["items"])
        offset += 200
        if offset >= page["total"]:
            break
    items.sort(key=lambda i: (natural_key(i["title"]), i["created_at"]))
    return [{**i, "lesson_index": n} for n, i in enumerate(items, start=1)]


def _selected(archive: Archive, course: str | None, ids: list[str] | None) -> list[tuple[int, dict[str, Any]]]:
    """(lesson index in the full course, full archive item) for the chosen lessons."""
    lessons = course_lessons(archive, course)
    wanted = set(ids) if ids else None
    out = [(l["lesson_index"], archive.get(l["id"])) for l in lessons if wanted is None or l["id"] in wanted]
    if not out:
        raise AppError(ErrorCode.INVALID_REQUEST, "No lessons selected")
    return out


def payload_for(item: dict[str, Any], lesson_index: int | None) -> TranscriptPayload:
    translation = item.get("translation") or {}
    return TranscriptPayload(
        segments=[ExportSegment(float(s["start"]), float(s["end"]), str(s["text"])) for s in item.get("segments", [])],
        file_name=item.get("title") or "",
        file_path=item.get("source") or "",
        language=item.get("language") or "",
        model=item.get("model") or "",
        duration=item.get("duration"),
        translation=[ExportSegment(float(s["start"]), float(s["end"]), str(s["text"])) for s in translation.get("segments", [])]
        or None,
        translation_language=translation.get("language") or "",
        summary=item.get("summary"),
        quiz=item.get("quiz"),
        course=item.get("course") or "",
        lesson_index=lesson_index,
    )


def _safe(name: str, limit: int = 90) -> str:
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name or "").strip(" .")
    return name[:limit].rstrip(" .") or "lesson"


def _stem(title: str) -> str:
    stem, dot, ext = (title or "").rpartition(".")
    return stem if dot and stem and 1 <= len(ext) <= 5 and ext.isalnum() else (title or "lesson")


# --------------------------------------------------------------------- tasks
@dataclass
class CourseTask:
    id: str
    kind: str  # db | export
    total: int
    status: str = "running"  # running | completed | error | cancelled
    done: int = 0
    current: str = ""
    results: list[dict[str, Any]] = field(default_factory=list)
    error: dict[str, str] | None = None
    output_dir: str | None = None
    course_name: str = ""
    site_index: str | None = None
    cancel: threading.Event = field(default_factory=threading.Event)

    def snapshot(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "kind": self.kind,
            "status": self.status,
            "done": self.done,
            "total": self.total,
            "current": self.current,
            "results": list(self.results),
            "error": self.error,
            "outputDir": self.output_dir,
            "siteIndex": self.site_index,
        }


@dataclass
class ExportOptions:
    dest_dir: str | None = None
    pdf: bool = True
    pdf_timestamps: bool = False
    pdf_content: str = "original"  # original | both | translation (falls back to original when missing)
    include_summary: bool = True
    subtitles: bool = True
    subtitles_translation: bool = True
    subtitle_format: str = "srt"
    ui_language: str = "ar"
    documents: list[str] = field(default_factory=list)  # docx | txt | json
    website: bool = False


class CourseTools:
    def __init__(self, archive: Archive, fonts_dir: Path, output_dir: Path) -> None:
        self.archive = archive
        self.fonts_dir = fonts_dir
        self.output_dir = output_dir
        self._tasks: dict[str, CourseTask] = {}
        self._lock = threading.Lock()

    def get(self, task_id: str) -> CourseTask:
        task = self._tasks.get(task_id)
        if task is None:
            raise AppError(ErrorCode.INVALID_REQUEST, "Unknown task")
        return task

    def cancel(self, task_id: str) -> None:
        self.get(task_id).cancel.set()

    def _start(self, kind: str, total: int, target, *args) -> CourseTask:  # noqa: ANN001
        task = CourseTask(id=uuid.uuid4().hex, kind=kind, total=total)
        with self._lock:
            self._tasks = {k: v for k, v in self._tasks.items() if v.status == "running"}
            if any(t.kind == kind for t in self._tasks.values()):
                raise AppError(ErrorCode.BUSY, "Another course task is running")
            self._tasks[task.id] = task
        threading.Thread(target=self._run, args=(task, target, *args), daemon=True, name=f"course-{kind}").start()
        return task

    def _run(self, task: CourseTask, target, *args) -> None:  # noqa: ANN001
        try:
            target(task, *args)
            task.status = "cancelled" if task.cancel.is_set() else "completed"
        except AppError as err:
            task.status = "error"
            task.error = err.to_dict()
        except Exception as exc:  # noqa: BLE001
            log.exception("Course task failed")
            task.status = "error"
            task.error = {"code": "internal", "detail": f"{exc.__class__.__name__}: {exc}"[:300]}
        finally:
            task.current = ""

    # ---------------------------------------------------------- database
    def start_db(self, req: DbRequest, course: str | None, ids: list[str] | None) -> CourseTask:
        lessons = _selected(self.archive, course, ids)
        return self._start("db", len(lessons), self._db, req, lessons)

    def _db(self, task: CourseTask, req: DbRequest, lessons: list[tuple[int, dict[str, Any]]]) -> None:
        connect_errors = 0
        for index, item in lessons:
            if task.cancel.is_set():
                break
            task.current = item["title"]
            try:
                res = execute(req, payload_for(item, index))
                task.results.append({"id": item["id"], "title": item["title"], "index": index, "ok": True, "inserted": res["inserted"]})
                connect_errors = 0
            except AppError as err:
                task.results.append({"id": item["id"], "title": item["title"], "index": index, "ok": False, "error": err.to_dict()})
                # Each lesson has its own transaction; stop only when the database itself is unreachable.
                if err.code in (ErrorCode.DB_CONNECT_FAILED, ErrorCode.DB_DRIVER_MISSING):
                    connect_errors += 1
                    if connect_errors >= 2:
                        raise AppError(err.code, err.detail) from err
            task.done += 1

    # ------------------------------------------------------------ export
    def start_export(self, course: str | None, ids: list[str] | None, options: ExportOptions) -> CourseTask:
        lessons = _selected(self.archive, course, ids)
        name = course or ("Lessons" if options.ui_language == "en" else "دروس")
        dest = Path(options.dest_dir) if options.dest_dir else self.output_dir / _safe(name)
        task = self._start("export", len(lessons), self._export, lessons, dest, replace(options), course or "")
        task.output_dir = str(dest)
        return task

    def _export(
        self, task: CourseTask, lessons: list[tuple[int, dict[str, Any]]], dest: Path, opt: ExportOptions, course: str = ""
    ) -> None:
        task.course_name = course
        try:
            dest.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise AppError(ErrorCode.EXPORT_FAILED, f"Cannot create {dest}: {exc}") from exc
        width = max(2, len(str(lessons[-1][0])))
        index_rows: list[dict[str, Any]] = []
        site_lessons: list[SiteLesson] = []
        names = _LANGUAGE_NAMES.get(opt.ui_language, _LANGUAGE_NAMES["ar"])
        for index, item in lessons:
            if task.cancel.is_set():
                break
            title = item["title"]
            task.current = title
            base = f"{index:0{width}d} - {_safe(_stem(title))}"
            files: dict[str, str] = {}
            try:
                segments = [s for s in item.get("segments", []) if str(s.get("text", "")).strip()]
                translation = item.get("translation") or None
                lang = (item.get("language") or "").split("-")[0]
                content = opt.pdf_content if translation else "original"
                req = ExportRequest(
                    output_path=dest / f"{base}.pdf",
                    media_name=title,
                    language_code=lang,
                    language_name=names.get(lang, lang),
                    model_name=item.get("model"),
                    duration=item.get("duration"),
                    include_timestamps=opt.pdf_timestamps,
                    ui_language=opt.ui_language,
                    segments=[ExportSegment(float(s["start"]), float(s["end"]), str(s["text"])) for s in segments],
                    transcribed_at=datetime.fromtimestamp(item.get("updated_at") or time.time()),
                    source=item.get("source") or "",
                    engine=item.get("engine") if item.get("engine") in ("local", "cloud", "youtube") else "local",
                    summary=item.get("summary") if opt.include_summary else None,
                    translation=[
                        ExportSegment(float(s["start"]), float(s["end"]), str(s["text"]))
                        for s in (translation or {}).get("segments", [])
                    ]
                    or None,
                    translation_language_name=names.get((translation or {}).get("language", ""), ""),
                    content=content,
                )
                if opt.pdf:
                    files["pdf"] = generate_pdf(req, self.fonts_dir).name
                for fmt in ("docx", "txt", "json"):
                    if fmt in opt.documents:
                        extra = {"course": item.get("course") or "", "lesson_index": index} if fmt == "json" else None
                        files[fmt] = write_document(req, fmt, extra).name
                if opt.subtitles and segments:
                    suffix = f".{lang}" if lang else ""
                    path = write_subtitles(segments, opt.subtitle_format, dest / f"{base}{suffix}.{opt.subtitle_format}")
                    files["subtitles"] = path.name
                if opt.subtitles_translation and translation and translation.get("segments"):
                    tl = translation.get("language") or "tr"
                    path = write_subtitles(
                        translation["segments"], opt.subtitle_format, dest / f"{base}.{tl}.{opt.subtitle_format}"
                    )
                    files["subtitles_translation"] = path.name
                task.results.append({"id": item["id"], "title": title, "index": index, "ok": True, "files": files})
                if opt.website:
                    # The site shows everything: summary always, both languages behind a toggle.
                    site_lessons.append(
                        SiteLesson(index, title, replace(req, summary=item.get("summary"), content="both"), dict(files))
                    )
            except AppError as err:
                task.results.append({"id": item["id"], "title": title, "index": index, "ok": False, "error": err.to_dict()})
            index_rows.append(
                {
                    "lesson_index": index,
                    "title": title,
                    "source": item.get("source") or "",
                    "duration_seconds": round(float(item.get("duration") or 0), 1),
                    "language": item.get("language") or "",
                    "pdf": files.get("pdf", ""),
                    "subtitles": files.get("subtitles", ""),
                    "subtitles_translation": files.get("subtitles_translation", ""),
                    "docx": files.get("docx", ""),
                    "txt": files.get("txt", ""),
                    "json": files.get("json", ""),
                }
            )
            task.done += 1
        if index_rows:
            # A lesson list for the platform upload; the BOM makes Excel read Arabic correctly.
            with (dest / "index.csv").open("w", encoding="utf-8-sig", newline="") as fh:
                writer = csv.DictWriter(fh, fieldnames=list(index_rows[0].keys()))
                writer.writeheader()
                writer.writerows(index_rows)
        if site_lessons and not task.cancel.is_set():
            task.current = "website"
            course_name = task.course_name or ("Lessons" if opt.ui_language == "en" else "دروس")
            task.site_index = str(write_site(dest / "website", course_name, site_lessons, opt.ui_language))
