"""Local archive of every transcript (SQLite, stored in the user's app-data folder).

Each finished transcription — local Whisper, a paid cloud provider or YouTube
captions — is saved automatically, and later edits update the same entry.
Nothing leaves the computer.
"""

from __future__ import annotations

import json
import sqlite3
import threading
import time
import uuid
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
"""

_LIST_COLUMNS = (
    "id, title, source_type, source, created_at, updated_at, duration, language, engine, model, "
    "segment_count, word_count, substr(full_text, 1, 220) AS preview"
)


def _normalize(text: str) -> str:
    """Arabic-insensitive matching: drop tashkeel/tatweel, unify alef/ya/ta marbuta."""
    import re

    text = re.sub(r"[ً-ْٰـ]", "", text.lower())
    return re.sub(r"[إأآ]", "ا", text).replace("ى", "ي").replace("ة", "ه")


class Archive:
    def __init__(self, path: Path) -> None:
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._db = sqlite3.connect(str(path), check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.executescript(_SCHEMA)
        # Search over normalized text (Arabic-insensitive) without extra columns.
        self._db.create_function("norm", 1, lambda s: _normalize(s or ""), deterministic=True)

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
            "segments_json": json.dumps(segments, ensure_ascii=False),
            "now": now,
        }
        with self._lock:
            self._db.execute(
                """
                INSERT INTO transcripts (id, title, source_type, source, created_at, updated_at, duration,
                    language, engine, model, segment_count, word_count, full_text, segments_json)
                VALUES (:id, :title, :source_type, :source, :now, :now, :duration,
                    :language, :engine, :model, :segment_count, :word_count, :full_text, :segments_json)
                ON CONFLICT(id) DO UPDATE SET
                    title=excluded.title, source_type=excluded.source_type, source=excluded.source,
                    updated_at=excluded.updated_at, duration=excluded.duration, language=excluded.language,
                    engine=excluded.engine, model=excluded.model, segment_count=excluded.segment_count,
                    word_count=excluded.word_count, full_text=excluded.full_text,
                    segments_json=excluded.segments_json
                """,
                values,
            )
            self._db.commit()
        return {"id": item_id, "updated_at": now}

    def list(self, query: str = "", limit: int = 50, offset: int = 0) -> dict[str, Any]:
        where, params = "", {}
        if query.strip():
            where = "WHERE norm(title) LIKE :q OR norm(full_text) LIKE :q OR norm(source) LIKE :q"
            params["q"] = f"%{_normalize(query.strip())}%"
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
        segments = json.loads(item.pop("segments_json") or "[]")
        item["segments"] = [{"id": i, **s} for i, s in enumerate(segments)]
        return item

    def delete(self, item_id: str) -> None:
        with self._lock:
            self._db.execute("DELETE FROM transcripts WHERE id = ?", (item_id,))
            self._db.commit()
