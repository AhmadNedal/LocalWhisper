"""Local archive of every transcript (SQLite, stored in the user's app-data folder).

Each finished transcription — local Whisper, a paid cloud provider or YouTube
captions — is saved automatically, and later edits update the same entry.
Nothing leaves the computer.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import sqlite3
import tempfile
import threading
import time
import uuid
import zipfile
from pathlib import Path
from typing import Any

from .errors import AppError, ErrorCode

_SCHEMA = """
CREATE TABLE IF NOT EXISTS transcripts (
    id            TEXT PRIMARY KEY,
    title         TEXT NOT NULL,
    source_type   TEXT NOT NULL,          -- file | youtube
    source        TEXT NOT NULL,          -- file path or YouTube URL
    created_at    REAL NOT NULL,
    updated_at    REAL NOT NULL,
    duration      REAL,
    language      TEXT,
    engine        TEXT,                   -- local | cloud | youtube
    model         TEXT,
    segment_count INTEGER NOT NULL DEFAULT 0,
    word_count    INTEGER NOT NULL DEFAULT 0,
    full_text     TEXT NOT NULL DEFAULT '',
    segments_json TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS ix_transcripts_updated ON transcripts(updated_at DESC);
CREATE INDEX IF NOT EXISTS ix_transcripts_source ON transcripts(source);
"""

BACKUP_FORMAT = "local-transcriber-archive"
BACKUP_VERSION = 1
_COPY_COLUMNS = (
    "id", "title", "source_type", "source", "created_at", "updated_at", "duration", "language", "engine", "model",
    "segment_count", "word_count", "full_text", "segments_json", "summary_json", "translation_json", "course",
    "quiz_json",
)

_LIST_COLUMNS = (
    "id, title, source_type, source, created_at, updated_at, duration, language, engine, model, course, "
    "segment_count, word_count, substr(full_text, 1, 220) AS preview, "
    "(summary_json IS NOT NULL) AS has_summary, (translation_json IS NOT NULL) AS has_translation, "
    "(quiz_json IS NOT NULL) AS has_quiz"
)


_MARKS = re.compile(r"[ً-ْٰـ]")
_ALEF = re.compile(r"[إأآ]")


def _normalize(text: str) -> str:
    """Arabic-insensitive matching: drop tashkeel/tatweel, unify alef/ya/ta marbuta."""
    text = _MARKS.sub("", text.lower())
    return _ALEF.sub("ا", text).replace("ى", "ي").replace("ة", "ه")


def _search_text(title: str, source: str, full_text: str) -> str:
    return _normalize(f"{title}\n{source}\n{full_text}")


def _clean_course(value: Any) -> str | None:
    text = " ".join(str(value or "").split())[:200]
    return text or None


class Archive:
    def __init__(self, path: Path) -> None:
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._db = sqlite3.connect(str(path), check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.executescript(_SCHEMA)
        columns = {r[1] for r in self._db.execute("PRAGMA table_info(transcripts)")}
        for column in ("summary_json", "translation_json", "course", "search_text", "quiz_json"):  # added in later versions: migrate in place
            if column not in columns:
                self._db.execute(f"ALTER TABLE transcripts ADD COLUMN {column} TEXT")
        self._db.execute("CREATE INDEX IF NOT EXISTS ix_transcripts_course ON transcripts(course)")
        self._db.create_function("norm", 1, lambda s: _normalize(s or ""), deterministic=True)
        # Search runs over a normalized copy stored once at save time, so a large archive is
        # scanned with a plain LIKE instead of normalizing every transcript on every keystroke.
        # Older archives are filled here once.
        self._db.execute(
            "UPDATE transcripts SET search_text = norm(title || char(10) || source || char(10) || full_text) "
            "WHERE search_text IS NULL"
        )
        self._db.commit()

    def save(self, item: dict[str, Any]) -> dict[str, Any]:
        """Insert or update (when ``id`` is given and exists)."""
        segments = [
            {"start": float(s["start"]), "end": float(s["end"]), "text": str(s["text"]).strip()}
            for s in item.get("segments", [])
            if str(s.get("text", "")).strip()
        ]
        if not segments:
            raise AppError(ErrorCode.INVALID_REQUEST, "Transcript is empty")
        full_text = " ".join(s["text"] for s in segments)
        now = time.time()
        item_id = str(item.get("id") or "") or uuid.uuid4().hex
        values = {
            "id": item_id,
            "title": (item.get("title") or "").strip()[:500] or "—",
            "source_type": item.get("source_type") or "file",
            "source": item.get("source") or "",
            "duration": item.get("duration"),
            "language": item.get("language"),
            "engine": item.get("engine"),
            "model": item.get("model"),
            "segment_count": len(segments),
            "word_count": len(full_text.split()),
            "full_text": full_text,
            "search_text": "",
            "segments_json": json.dumps(segments, ensure_ascii=False),
            "summary_json": json.dumps(item["summary"], ensure_ascii=False) if item.get("summary") else None,
            "translation_json": json.dumps(item["translation"], ensure_ascii=False) if item.get("translation") else None,
            "course": _clean_course(item.get("course")),
            "quiz_json": json.dumps(item["quiz"], ensure_ascii=False) if item.get("quiz") else None,
            "now": now,
        }
        values["search_text"] = _search_text(values["title"], values["source"], full_text)
        with self._lock:
            self._db.execute(
                """
                INSERT INTO transcripts (id, title, source_type, source, created_at, updated_at, duration,
                    language, engine, model, segment_count, word_count, full_text, segments_json, summary_json,
                    translation_json, course, search_text, quiz_json)
                VALUES (:id, :title, :source_type, :source, :now, :now, :duration,
                    :language, :engine, :model, :segment_count, :word_count, :full_text, :segments_json,
                    :summary_json, :translation_json, :course, :search_text, :quiz_json)
                ON CONFLICT(id) DO UPDATE SET
                    title=excluded.title, source_type=excluded.source_type, source=excluded.source,
                    updated_at=excluded.updated_at, duration=excluded.duration, language=excluded.language,
                    engine=excluded.engine, model=excluded.model, segment_count=excluded.segment_count,
                    word_count=excluded.word_count, full_text=excluded.full_text,
                    segments_json=excluded.segments_json,
                    summary_json=COALESCE(excluded.summary_json, transcripts.summary_json),
                    quiz_json=COALESCE(excluded.quiz_json, transcripts.quiz_json),
                    translation_json=COALESCE(excluded.translation_json, transcripts.translation_json),
                    course=COALESCE(excluded.course, transcripts.course),
                    search_text=excluded.search_text
                """,
                values,
            )
            self._db.commit()
        return {"id": item_id, "updated_at": now}

    def list(self, query: str = "", limit: int = 50, offset: int = 0, course: str | None = None) -> dict[str, Any]:
        """``course``: None → everything, "" → entries without a course, else that course."""
        conditions, params = [], {}
        if query.strip():
            conditions.append("(search_text LIKE :q ESCAPE '\\' OR norm(course) LIKE :q ESCAPE '\\')")
            term = _normalize(query.strip()).replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            params["q"] = f"%{term}%"
        if course is not None:
            if course == "":
                conditions.append("(course IS NULL OR course = '')")
            else:
                conditions.append("course = :course")
                params["course"] = course
        where = ("WHERE " + " AND ".join(conditions)) if conditions else ""
        with self._lock:
            total = self._db.execute(f"SELECT COUNT(*) FROM transcripts {where}", params).fetchone()[0]
            rows = self._db.execute(
                f"SELECT {_LIST_COLUMNS} FROM transcripts {where} ORDER BY updated_at DESC LIMIT :limit OFFSET :offset",
                {**params, "limit": max(1, min(limit, 200)), "offset": max(0, offset)},
            ).fetchall()
        return {"total": total, "items": [dict(r) for r in rows]}

    def get(self, item_id: str) -> dict[str, Any]:
        with self._lock:
            row = self._db.execute("SELECT * FROM transcripts WHERE id = ?", (item_id,)).fetchone()
        if row is None:
            raise AppError(ErrorCode.INVALID_REQUEST, "Archive entry not found")
        item = dict(row)
        item.pop("search_text", None)
        segments = json.loads(item.pop("segments_json") or "[]")
        item["segments"] = [{"id": i, **s} for i, s in enumerate(segments)]
        raw_summary = item.pop("summary_json", None)
        item["summary"] = json.loads(raw_summary) if raw_summary else None
        raw_translation = item.pop("translation_json", None)
        item["translation"] = json.loads(raw_translation) if raw_translation else None
        raw_quiz = item.pop("quiz_json", None)
        item["quiz"] = json.loads(raw_quiz) if raw_quiz else None
        return item

    def _set_json(self, column: str, item_id: str, value: dict[str, Any] | None) -> None:
        with self._lock:
            cur = self._db.execute(
                f"UPDATE transcripts SET {column} = ? WHERE id = ?",
                (json.dumps(value, ensure_ascii=False) if value else None, item_id),
            )
            self._db.commit()
        if cur.rowcount == 0:
            raise AppError(ErrorCode.INVALID_REQUEST, "Archive entry not found")

    def courses(self) -> dict[str, Any]:
        with self._lock:
            rows = self._db.execute(
                "SELECT course, COUNT(*) AS count, MAX(updated_at) AS updated_at FROM transcripts "
                "WHERE course IS NOT NULL AND course <> '' GROUP BY course ORDER BY MAX(updated_at) DESC"
            ).fetchall()
            total = self._db.execute("SELECT COUNT(*) FROM transcripts").fetchone()[0]
            loose = self._db.execute("SELECT COUNT(*) FROM transcripts WHERE course IS NULL OR course = ''").fetchone()[0]
        return {"courses": [dict(r) for r in rows], "total": total, "without_course": loose}

    def set_course(self, item_id: str, course: str | None) -> None:
        with self._lock:
            cur = self._db.execute("UPDATE transcripts SET course = ? WHERE id = ?", (_clean_course(course), item_id))
            self._db.commit()
        if cur.rowcount == 0:
            raise AppError(ErrorCode.INVALID_REQUEST, "Archive entry not found")

    def rename_course(self, old: str, new: str | None) -> int:
        """Rename a course (or dissolve it when ``new`` is empty). Returns entries changed."""
        with self._lock:
            cur = self._db.execute("UPDATE transcripts SET course = ? WHERE course = ?", (_clean_course(new), old))
            self._db.commit()
        return cur.rowcount

    def set_summary(self, item_id: str, summary: dict[str, Any] | None) -> None:
        self._set_json("summary_json", item_id, summary)

    def set_translation(self, item_id: str, translation: dict[str, Any] | None) -> None:
        self._set_json("translation_json", item_id, translation)

    def set_quiz(self, item_id: str, quiz: dict[str, Any] | None) -> None:
        self._set_json("quiz_json", item_id, quiz)

    def find_sources(self, sources: list[str]) -> dict[str, str]:
        """Map of source path → archive id for sources that were already transcribed."""
        found: dict[str, str] = {}
        with self._lock:
            for i in range(0, len(sources), 500):
                chunk = sources[i : i + 500]
                marks = ",".join("?" * len(chunk))
                for row in self._db.execute(
                    f"SELECT source, id FROM transcripts WHERE source IN ({marks}) ORDER BY updated_at", chunk
                ):
                    found[row[0]] = row[1]
        return found

    def delete(self, item_id: str) -> None:
        with self._lock:
            self._db.execute("DELETE FROM transcripts WHERE id = ?", (item_id,))
            self._db.commit()

    # ------------------------------------------------------------ backup
    def backup(self, dest: Path) -> dict[str, Any]:
        """Write the whole archive (transcripts, summaries, translations, courses) to one file.

        The file is a zip with ``manifest.json`` and a consistent SQLite snapshot, written to a
        temporary name first so an interrupted backup never leaves a half file behind.
        """
        dest = Path(dest)
        tmp_dir = Path(tempfile.mkdtemp(prefix="archive-backup-"))
        try:
            snapshot = tmp_dir / "archive.db"
            target = sqlite3.connect(str(snapshot))
            try:
                with self._lock:
                    self._db.backup(target)
                target.execute("UPDATE transcripts SET search_text = NULL")  # rebuilt on restore; keeps the file small
                target.commit()
                target.execute("VACUUM")
                count = target.execute("SELECT COUNT(*) FROM transcripts").fetchone()[0]
                courses = target.execute(
                    "SELECT COUNT(DISTINCT course) FROM transcripts WHERE course IS NOT NULL AND course <> ''"
                ).fetchone()[0]
            finally:
                target.close()
            manifest = {
                "format": BACKUP_FORMAT,
                "version": BACKUP_VERSION,
                "created_at": time.time(),
                "transcripts": count,
                "courses": courses,
            }
            dest.parent.mkdir(parents=True, exist_ok=True)
            partial = dest.with_name(dest.name + ".part")
            with zipfile.ZipFile(partial, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
                zf.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))
                zf.write(snapshot, "archive.db")
            os.replace(partial, dest)
        except OSError as exc:
            raise AppError(ErrorCode.EXPORT_FAILED, f"{dest}: {exc}") from exc
        finally:
            shutil.rmtree(tmp_dir, ignore_errors=True)
        return {"path": str(dest), "transcripts": count, "courses": courses, "size": dest.stat().st_size}

    def restore(self, src: Path) -> dict[str, Any]:
        """Merge a backup into this archive.

        New entries are added; an entry that exists on both sides is replaced only when the
        backup's copy is newer, so restoring never overwrites newer work on this computer.
        Summaries/translations/courses missing from the newer copy are kept from the older one.
        """
        src = Path(src)
        if not src.is_file():
            raise AppError(ErrorCode.FILE_NOT_FOUND, str(src))
        tmp_dir = Path(tempfile.mkdtemp(prefix="archive-restore-"))
        try:
            db_path = self._unpack_backup(src, tmp_dir)
            other = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
            other.row_factory = sqlite3.Row
            try:
                try:
                    columns = {r[1] for r in other.execute("PRAGMA table_info(transcripts)")}
                except sqlite3.DatabaseError as exc:
                    raise AppError(ErrorCode.BACKUP_INVALID, f"Not a readable archive: {exc}") from exc
                required = {"id", "title", "segments_json", "updated_at"}
                if not required <= columns:
                    raise AppError(ErrorCode.BACKUP_INVALID, "The file does not contain a transcript archive")
                select = ", ".join(c if c in columns else f"NULL AS {c}" for c in _COPY_COLUMNS)
                rows = other.execute(f"SELECT {select} FROM transcripts").fetchall()
            finally:
                other.close()
            return self._merge(rows)
        finally:
            shutil.rmtree(tmp_dir, ignore_errors=True)

    @staticmethod
    def _unpack_backup(src: Path, tmp_dir: Path) -> Path:
        with src.open("rb") as fh:
            head = fh.read(16)
        if head.startswith(b"SQLite format 3"):  # a raw archive.db copied by hand also works
            return src
        if not zipfile.is_zipfile(src):
            raise AppError(ErrorCode.BACKUP_INVALID, "Unknown file type")
        with zipfile.ZipFile(src) as zf:
            names = set(zf.namelist())
            if "manifest.json" not in names or "archive.db" not in names:
                raise AppError(ErrorCode.BACKUP_INVALID, "manifest.json or archive.db is missing")
            try:
                manifest = json.loads(zf.read("manifest.json"))
            except ValueError as exc:
                raise AppError(ErrorCode.BACKUP_INVALID, "Broken manifest") from exc
            if manifest.get("format") != BACKUP_FORMAT:
                raise AppError(ErrorCode.BACKUP_INVALID, "Not a Local Transcriber backup")
            if int(manifest.get("version") or 0) > BACKUP_VERSION:
                raise AppError(ErrorCode.BACKUP_INVALID, "The backup was made by a newer version of the app")
            target = tmp_dir / "archive.db"
            with zf.open("archive.db") as fin, target.open("wb") as fout:
                shutil.copyfileobj(fin, fout, 1 << 20)
        return target

    def _merge(self, rows: list[sqlite3.Row]) -> dict[str, Any]:
        added = updated = skipped = invalid = 0
        with self._lock:
            local = dict(self._db.execute("SELECT id, updated_at FROM transcripts").fetchall())
            try:
                for row in rows:
                    item = dict(row)
                    try:
                        segments = json.loads(item["segments_json"] or "[]")
                        if not item["id"] or not isinstance(segments, list):
                            raise ValueError
                    except (TypeError, ValueError):
                        invalid += 1
                        continue
                    item["title"] = item["title"] or "—"
                    item["source"] = item["source"] or ""
                    item["source_type"] = item["source_type"] or "file"
                    item["updated_at"] = float(item["updated_at"] or 0)
                    item["created_at"] = float(item["created_at"] or item["updated_at"])
                    item["segment_count"] = int(item["segment_count"] or len(segments))
                    item["full_text"] = item["full_text"] or " ".join(str(s.get("text", "")) for s in segments)
                    item["word_count"] = int(item["word_count"] or len(item["full_text"].split()))
                    item["course"] = _clean_course(item["course"])
                    item["search_text"] = _search_text(item["title"], item["source"], item["full_text"])
                    mine = local.get(item["id"])
                    if mine is not None and float(mine or 0) >= item["updated_at"]:
                        skipped += 1
                        continue
                    cols = [*_COPY_COLUMNS, "search_text"]
                    self._db.execute(
                        f"INSERT INTO transcripts ({', '.join(cols)}) VALUES ({', '.join(':' + c for c in cols)}) "
                        "ON CONFLICT(id) DO UPDATE SET "
                        + ", ".join(
                            f"{c}=COALESCE(excluded.{c}, transcripts.{c})"
                            if c in ("summary_json", "translation_json", "course", "quiz_json")
                            else f"{c}=excluded.{c}"
                            for c in cols
                            if c not in ("id", "created_at")
                        ),
                        item,
                    )
                    if mine is None:
                        added += 1
                    else:
                        updated += 1
                self._db.commit()
            except sqlite3.DatabaseError as exc:
                self._db.rollback()
                raise AppError(ErrorCode.BACKUP_INVALID, f"Restore failed, nothing was changed: {exc}") from exc
        return {"added": added, "updated": updated, "skipped": skipped, "invalid": invalid, "total": len(rows)}

    # ------------------------------------------------------------ stats
    def stats(self, months: int = 12) -> dict[str, Any]:
        """Totals for the statistics page: overall, per course, per month and what is missing."""
        with self._lock:
            total = dict(
                self._db.execute(
                    "SELECT COUNT(*) AS items, COALESCE(SUM(duration), 0) AS seconds, COALESCE(SUM(word_count), 0) AS words, "
                    "SUM(summary_json IS NOT NULL) AS with_summary, SUM(translation_json IS NOT NULL) AS with_translation, "
                    "COUNT(DISTINCT NULLIF(course, '')) AS courses FROM transcripts"
                ).fetchone()
            )
            courses = [
                dict(r)
                for r in self._db.execute(
                    "SELECT COALESCE(NULLIF(course, ''), '') AS course, COUNT(*) AS items, COALESCE(SUM(duration), 0) AS seconds, "
                    "COALESCE(SUM(word_count), 0) AS words, SUM(summary_json IS NOT NULL) AS with_summary, "
                    "SUM(translation_json IS NOT NULL) AS with_translation, MAX(updated_at) AS updated_at "
                    "FROM transcripts GROUP BY COALESCE(NULLIF(course, ''), '') ORDER BY SUM(duration) DESC"
                )
            ]
            engines = [
                dict(r)
                for r in self._db.execute(
                    "SELECT COALESCE(engine, 'local') AS engine, COUNT(*) AS items, COALESCE(SUM(duration), 0) AS seconds "
                    "FROM transcripts GROUP BY COALESCE(engine, 'local') ORDER BY 3 DESC"
                )
            ]
            rows = self._db.execute(
                "SELECT strftime('%Y-%m', created_at, 'unixepoch', 'localtime') AS month, COUNT(*) AS items, "
                "COALESCE(SUM(duration), 0) AS seconds FROM transcripts GROUP BY month"
            ).fetchall()
        by_month = {r["month"]: {"items": r["items"], "seconds": r["seconds"]} for r in rows}
        # A continuous run of months ending this month, so empty months show as gaps.
        y, m = time.localtime().tm_year, time.localtime().tm_mon
        series = []
        for _ in range(max(1, min(months, 36))):
            key = f"{y:04d}-{m:02d}"
            series.append({"month": key, **by_month.get(key, {"items": 0, "seconds": 0})})
            m -= 1
            if m == 0:
                y, m = y - 1, 12
        series.reverse()
        for key in ("with_summary", "with_translation"):
            total[key] = total[key] or 0
        return {"total": total, "courses": courses, "engines": engines, "months": series}
