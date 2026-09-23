"""Subtitle export (SRT / WebVTT) from timed segments.

Whisper segments can be long (up to ~30 s and 200+ characters), which is too
much for one subtitle. Each segment is therefore cut into readable cues:

* at most 2 lines of ~42 characters (the common broadcast/YouTube guideline),
* at most ~7 seconds on screen,
* cut at punctuation when possible, otherwise between words,
* the segment's time is shared between its cues in proportion to their length.

Right-to-left lines get invisible RLM marks so players that assume
left-to-right still put the punctuation on the correct side.
"""

from __future__ import annotations

import math
import re
import unicodedata
from dataclasses import dataclass
from pathlib import Path

from .errors import AppError, ErrorCode

MAX_LINE = 42
MAX_LINES = 2
MAX_CUE_SECONDS = 7.0
MIN_CUE_SECONDS = 0.8
RLM = "‏"


@dataclass
class Cue:
    start: float
    end: float
    text: str  # may contain one "\n"


def _is_rtl(text: str) -> bool:
    for ch in text:
        bidi = unicodedata.bidirectional(ch)
        if bidi in ("R", "AL"):
            return True
        if bidi == "L":
            return False
    return False


def _wrap(text: str, width: int = MAX_LINE) -> list[str]:
    """Split into at most two balanced lines."""
    if len(text) <= width:
        return [text]
    words = text.split()
    best: tuple[int, int] | None = None
    for cut in range(1, len(words)):
        a, b = " ".join(words[:cut]), " ".join(words[cut:])
        score = max(len(a), len(b))
        if best is None or score < best[0]:
            best = (score, cut)
    if best is None:
        return [text]
    cut = best[1]
    return [" ".join(words[:cut]), " ".join(words[cut:])]


_BREAK = re.compile(r"(?<=[.!?؟؛،,;:…])\s+")


def _pieces(text: str, limit: int) -> list[str]:
    """Cut text into chunks of ≤ limit characters, preferring punctuation."""
    text = " ".join(text.split())
    if len(text) <= limit:
        return [text] if text else []
    chunks: list[str] = []
    cur = ""
    for clause in _BREAK.split(text):
        for word in clause.split():
            candidate = f"{cur} {word}".strip()
            if len(candidate) > limit and cur:
                chunks.append(cur)
                cur = word
            else:
                cur = candidate
        # Prefer ending a cue at punctuation when it is already reasonably full.
        if len(cur) >= limit * 0.6:
            chunks.append(cur)
            cur = ""
    if cur:
        chunks.append(cur)
    return chunks


def build_cues(segments: list[dict]) -> list[Cue]:
    cues: list[Cue] = []
    limit = MAX_LINE * MAX_LINES
    for seg in segments:
        text = " ".join(str(seg.get("text", "")).split())
        if not text:
            continue
        start, end = float(seg.get("start", 0)), float(seg.get("end", 0))
        if end <= start:
            end = start + max(MIN_CUE_SECONDS, len(text) / 15)
        duration = end - start
        parts = _pieces(text, limit)
        # A cue would stay on screen too long: cut the text into more, shorter cues.
        needed = math.ceil(duration / MAX_CUE_SECONDS)
        if len(parts) < needed:
            parts = _pieces(text, max(24, math.ceil(len(text) / needed)))
        total = sum(len(p) for p in parts) or 1
        t = start
        for i, part in enumerate(parts):
            share = duration * len(part) / total
            cue_end = end if i == len(parts) - 1 else t + share
            cues.append(Cue(round(t, 3), round(cue_end, 3), "\n".join(_wrap(part))))
            t = cue_end
    # No overlaps: a cue ends before the next one starts.
    for a, b in zip(cues, cues[1:]):
        if a.end > b.start:
            a.end = max(a.start + 0.2, b.start - 0.001)
    return cues


def _stamp(seconds: float, sep: str) -> str:
    ms = max(0, int(round(seconds * 1000)))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d}{sep}{ms:03d}"


def _line(text: str) -> str:
    return f"{RLM}{text}{RLM}" if _is_rtl(text) else text


def to_srt(cues: list[Cue]) -> str:
    blocks = []
    for i, c in enumerate(cues, start=1):
        body = "\n".join(_line(line) for line in c.text.split("\n"))
        blocks.append(f"{i}\n{_stamp(c.start, ',')} --> {_stamp(c.end, ',')}\n{body}\n")
    return "\n".join(blocks)


def to_vtt(cues: list[Cue]) -> str:
    blocks = ["WEBVTT\n"]
    for c in cues:
        body = "\n".join(_line(line) for line in c.text.split("\n"))
        blocks.append(f"{_stamp(c.start, '.')} --> {_stamp(c.end, '.')}\n{body}\n")
    return "\n".join(blocks)


def write_subtitles(segments: list[dict], fmt: str, path: Path) -> Path:
    cues = build_cues(segments)
    if not cues:
        raise AppError(ErrorCode.INVALID_REQUEST, "Nothing to export")
    content = to_srt(cues) if fmt == "srt" else to_vtt(cues)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".part")
        # SRT with a UTF-8 BOM: the most compatible choice for Windows players; VTT allows it too.
        tmp.write_text(content, encoding="utf-8-sig" if fmt == "srt" else "utf-8", newline="\n")
        tmp.replace(path)
    except PermissionError as exc:
        raise AppError(ErrorCode.EXPORT_FAILED, f"Cannot write to {path} (is it open in another program?)") from exc
    return path
