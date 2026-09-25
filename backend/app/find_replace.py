"""Find & replace across the archive — a whole course, or everything.

Typical use: a name or a term the model always gets wrong ("الخوارزميه" →
"الخوارزمية", "Jango" → "Django") fixed in every lecture at once.

Matching (default "smart" mode) ignores Arabic diacritics and tatweel, treats
أ/إ/آ/ا, ى/ي and ة/ه as the same letter, and ignores letter case; "exact" mode
matches the text as typed. "Whole word" stops "علم" from matching inside "العلم".

The preview lists every lecture with matches and a few examples in context;
applying changes the chosen lectures only (their transcript, and optionally
their summary), and the previous text is kept so the last replacement can be undone.
"""

from __future__ import annotations

import json
import re
import time
from typing import Any

from .archive import Archive, _search_text
from .errors import AppError, ErrorCode

MAX_FIND = 200
SAMPLES_PER_ITEM = 4
CONTEXT_CHARS = 48
MAX_PREVIEW_ITEMS = 500

_MARKS = "ً-ْٰـ"  # tashkeel + superscript alef + tatweel
_EQUIV = {
    "ا": "اأإآ",
    "أ": "اأإآ",
    "إ": "اأإآ",
    "آ": "اأإآ",
    "ي": "يى",
    "ى": "يى",
    "ه": "هة",
    "ة": "هة",
}

_UNDO_SCHEMA = """
CREATE TABLE IF NOT EXISTS replace_undo (
    batch_id      TEXT NOT NULL,
    item_id       TEXT NOT NULL,
    created_at    REAL NOT NULL,
    label         TEXT NOT NULL,
    segments_json TEXT NOT NULL,
    summary_json  TEXT,
    PRIMARY KEY (batch_id, item_id)
);
"""


def build_pattern(find: str, exact: bool, whole_word: bool) -> re.Pattern[str]:
    term = find.strip()
    if not term:
        raise AppError(ErrorCode.INVALID_REQUEST, "Nothing to find")
    if len(term) > MAX_FIND:
        raise AppError(ErrorCode.INVALID_REQUEST, "The text to find is too long")
    if exact:
        body = re.escape(term)
        flags = 0
    else:
        parts: list[str] = []
        for ch in re.sub(f"[{_MARKS}]", "", term):
            if ch.isspace():
                parts.append(r"\s+")
                continue
            chars = _EQUIV.get(ch)
            parts.append(f"[{chars}]" if chars else re.escape(ch))
        # Diacritics / tatweel may sit between any two letters of the original.
        body = f"[{_MARKS}]*".join(parts) + f"[{_MARKS}]*"
        flags = re.IGNORECASE
    if whole_word:
        body = rf"(?<![\w{_MARKS}])(?:{body})(?![\w])"
    return re.compile(body, flags)


def _scope(archive: Archive, course: str | None, ids: list[str] | None) -> list[dict[str, Any]]:
    conditions, params = [], []
    if course is not None:
        if course == "":
            conditions.append("(course IS NULL OR course = '')")
        else:
            conditions.append("course = ?")
            params.append(course)
    if ids is not None:
        if not ids:
            return []
        conditions.append(f"id IN ({','.join('?' * len(ids))})")
        params.extend(ids)
    where = ("WHERE " + " AND ".join(conditions)) if conditions else ""
    with archive._lock:  # noqa: SLF001 - same package
        rows = archive._db.execute(  # noqa: SLF001
            f"SELECT id, title, source, course, created_at, segments_json, summary_json FROM transcripts {where} "
            "ORDER BY created_at",
            params,
        ).fetchall()
    return [dict(r) for r in rows]


def _correct_spans(text: str, replacement: str) -> list[tuple[int, int]]:
    """Where the text already reads like the replacement (e.g. "Django" when fixing "jango")."""
    if not replacement:
        return []
    spans, i = [], text.find(replacement)
    while i >= 0:
        spans.append((i, i + len(replacement)))
        i = text.find(replacement, i + 1)
    return spans


def _already_correct(m: re.Match[str], spans: list[tuple[int, int]]) -> bool:
    return any(a <= m.start() and m.end() <= b for a, b in spans)


def _sub(pattern: re.Pattern[str], replacement: str, text: str) -> tuple[str, int]:
    """Replace; text that already reads like the replacement is left alone and not counted."""
    spans = _correct_spans(text, replacement)
    count = 0

    def fn(m: re.Match[str]) -> str:
        nonlocal count
        if _already_correct(m, spans):
            return m.group(0)
        count += 1
        return replacement

    return pattern.sub(fn, text), count


def _replace_strings(value: Any, pattern: re.Pattern[str], replacement: str) -> tuple[Any, int]:
    """Replace in every string inside a JSON value (the summary). Returns (new value, count)."""
    if isinstance(value, str):
        return _sub(pattern, replacement, value)
    if isinstance(value, list):
        total = 0
        out = []
        for v in value:
            nv, n = _replace_strings(v, pattern, replacement)
            out.append(nv)
            total += n
        return out, total
    if isinstance(value, dict):
        total = 0
        out_d: dict[str, Any] = {}
        for k, v in value.items():
            # Keys and machine fields (times, ids, language codes) stay as they are.
            if k in ("start", "end", "time", "id", "language", "model", "provider", "created_at"):
                out_d[k] = v
                continue
            nv, n = _replace_strings(v, pattern, replacement)
            out_d[k] = nv
            total += n
        return out_d, total
    return value, 0


def preview(
    archive: Archive,
    find: str,
    replace: str = "",
    course: str | None = None,
    exact: bool = False,
    whole_word: bool = False,
    include_summary: bool = True,
) -> dict[str, Any]:
    pattern = build_pattern(find, exact, whole_word)
    items: list[dict[str, Any]] = []
    total = 0
    for row in _scope(archive, course, None):
        segments = json.loads(row["segments_json"] or "[]")
        count = 0
        samples: list[dict[str, Any]] = []
        for i, seg in enumerate(segments):
            text = str(seg.get("text") or "")
            spans = _correct_spans(text, replace)
            for m in pattern.finditer(text):
                if _already_correct(m, spans):
                    continue  # already written that way
                count += 1
                if len(samples) < SAMPLES_PER_ITEM:
                    before = text[max(0, m.start() - CONTEXT_CHARS) : m.start()]
                    after = text[m.end() : m.end() + CONTEXT_CHARS]
                    samples.append(
                        {
                            "segment": i,
                            "start": float(seg.get("start") or 0),
                            "before": ("…" if m.start() > CONTEXT_CHARS else "") + before,
                            "match": m.group(0),
                            "after": after + ("…" if m.end() + CONTEXT_CHARS < len(text) else ""),
                        }
                    )
        summary_count = 0
        if include_summary and row["summary_json"]:
            _, summary_count = _replace_strings(json.loads(row["summary_json"]), pattern, replace)
        if count or summary_count:
            total += count
            items.append(
                {
                    "id": row["id"],
                    "title": row["title"],
                    "course": row["course"],
                    "matches": count,
                    "summary_matches": summary_count,
                    "samples": samples,
                }
            )
    return {
        "find": find,
        "replace": replace,
        "total_matches": total,
        "total_items": len(items),
        "items": items[:MAX_PREVIEW_ITEMS],
        "truncated": len(items) > MAX_PREVIEW_ITEMS,
    }


def apply(
    archive: Archive,
    find: str,
    replace: str,
    ids: list[str],
    course: str | None = None,
    exact: bool = False,
    whole_word: bool = False,
    include_summary: bool = True,
) -> dict[str, Any]:
    pattern = build_pattern(find, exact, whole_word)
    replacement = replace.strip() if replace.strip() else ""
    if len(replacement) > 500:
        raise AppError(ErrorCode.INVALID_REQUEST, "The replacement is too long")
    rows = _scope(archive, course, ids)
    now = time.time()
    batch_id = f"{now:.6f}"
    label = f"{find.strip()} → {replacement}"
    changed_items = 0
    changed = 0
    updates: list[tuple[str, str, str, int, int, str | None, str, float]] = []
    undo: list[tuple[str, str, float, str, str, str | None]] = []
    for row in rows:
        segments = json.loads(row["segments_json"] or "[]")
        count = 0
        new_segments = []
        for seg in segments:
            text, n = _sub(pattern, replacement, str(seg.get("text") or ""))
            count += n
            text = " ".join(text.split())
            if text:
                new_segments.append({**seg, "text": text})
        summary_json = row["summary_json"]
        if include_summary and summary_json:
            new_summary, n = _replace_strings(json.loads(summary_json), pattern, replacement)
            if n:
                count += n
                summary_json = json.dumps(new_summary, ensure_ascii=False)
        if not count:
            continue
        if not new_segments:
            raise AppError(ErrorCode.INVALID_REQUEST, f"Replacing would empty the transcript “{row['title']}”")
        full_text = " ".join(s["text"] for s in new_segments)
        updates.append(
            (
                json.dumps(new_segments, ensure_ascii=False),
                full_text,
                _search_text(row["title"], row["source"], full_text),
                len(new_segments),
                len(full_text.split()),
                summary_json,
                row["id"],
                now,
            )
        )
        undo.append((batch_id, row["id"], now, label, row["segments_json"], row["summary_json"]))
        changed_items += 1
        changed += count

    if updates:
        with archive._lock:  # noqa: SLF001
            db = archive._db  # noqa: SLF001
            db.executescript(_UNDO_SCHEMA)
            db.execute("DELETE FROM replace_undo")  # only the last replacement can be undone
            db.executemany(
                "INSERT INTO replace_undo (batch_id, item_id, created_at, label, segments_json, summary_json) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                undo,
            )
            db.executemany(
                "UPDATE transcripts SET segments_json = ?, full_text = ?, search_text = ?, segment_count = ?, "
                "word_count = ?, summary_json = ?, updated_at = ? WHERE id = ?",
                [(u[0], u[1], u[2], u[3], u[4], u[5], u[7], u[6]) for u in updates],
            )
            db.commit()
    return {"changed_items": changed_items, "replacements": changed, "undo": undo_state(archive)}


def undo_state(archive: Archive) -> dict[str, Any] | None:
    with archive._lock:  # noqa: SLF001
        db = archive._db  # noqa: SLF001
        db.executescript(_UNDO_SCHEMA)
        row = db.execute("SELECT label, MAX(created_at) AS at, COUNT(*) AS n FROM replace_undo").fetchone()
    if not row or not row["n"]:
        return None
    return {"label": row["label"], "at": row["at"], "items": row["n"]}


def undo(archive: Archive) -> dict[str, Any]:
    """Put back the text from before the last replacement."""
    with archive._lock:  # noqa: SLF001
        db = archive._db  # noqa: SLF001
        db.executescript(_UNDO_SCHEMA)
        rows = db.execute(
            "SELECT u.item_id, u.segments_json, u.summary_json, t.title, t.source "
            "FROM replace_undo u JOIN transcripts t ON t.id = u.item_id"
        ).fetchall()
        if not rows:
            raise AppError(ErrorCode.INVALID_REQUEST, "Nothing to undo")
        now = time.time()
        for r in rows:
            segments = json.loads(r["segments_json"] or "[]")
            full_text = " ".join(str(s.get("text") or "") for s in segments)
            db.execute(
                "UPDATE transcripts SET segments_json = ?, full_text = ?, search_text = ?, segment_count = ?, "
                "word_count = ?, summary_json = ?, updated_at = ? WHERE id = ?",
                (
                    r["segments_json"],
                    full_text,
                    _search_text(r["title"], r["source"], full_text),
                    len(segments),
                    len(full_text.split()),
                    r["summary_json"],
                    now,
                    r["item_id"],
                ),
            )
        db.execute("DELETE FROM replace_undo")
        db.commit()
    return {"restored_items": len(rows)}
