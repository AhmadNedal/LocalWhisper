"""YouTube support: read existing captions, or download the audio for Whisper.

Flow
----
1. ``inspect(url)`` reads the video's metadata and lists the caption tracks
   YouTube has for it:
   * **manual** – uploaded by the channel (usually the most accurate);
   * **auto**   – YouTube's own speech recognition, original language only
     (the machine-*translated* auto tracks are skipped: they're noise).
2. ``fetch_subtitles(url, lang, kind)`` downloads one track (json3 format, which
   carries exact millisecond timings) and turns it into transcript segments —
   no model and no audio download needed.
3. If there are no captions (or the user prefers Whisper), ``download_audio``
   fetches only the best *audio* stream into a temp folder and the normal
   transcription pipeline takes over.

yt-dlp does the YouTube work. Since late 2025 YouTube requires a JavaScript
runtime for full support; the ``deno`` pip package provides one, so nothing
has to be installed by hand.
"""

from __future__ import annotations

import html
import json
import logging
import re
import shutil
import sys
import threading
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Callable
from urllib.parse import parse_qs, urlparse

from .errors import AppError, Cancelled, ErrorCode
from .transcriber import TranscriptSegment, clean_text

log = logging.getLogger(__name__)

_YOUTUBE_HOSTS = ("youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be", "www.youtu.be")
_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")


# ------------------------------------------------------------------ helpers
def normalize_url(url: str) -> str:
    """Validate a YouTube URL and return a canonical watch URL (drops playlists etc.)."""
    url = (url or "").strip()
    if _ID_RE.match(url):
        return f"https://www.youtube.com/watch?v={url}"
    if not re.match(r"^https?://", url, re.I):
        url = "https://" + url
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    if host not in _YOUTUBE_HOSTS:
        raise AppError(ErrorCode.YOUTUBE_INVALID_URL, "Not a YouTube link")
    video_id = ""
    if host.endswith("youtu.be"):
        video_id = parsed.path.strip("/").split("/")[0]
    elif parsed.path == "/watch":
        video_id = (parse_qs(parsed.query).get("v") or [""])[0]
    else:
        m = re.match(r"^/(shorts|live|embed|v)/([A-Za-z0-9_-]{11})", parsed.path)
        video_id = m.group(2) if m else ""
    if not _ID_RE.match(video_id):
        raise AppError(ErrorCode.YOUTUBE_INVALID_URL, "Could not find a video id in the link")
    return f"https://www.youtube.com/watch?v={video_id}"


def _deno_path() -> str | None:
    """JavaScript runtime used by yt-dlp for YouTube (bundled via the `deno` pip package)."""
    meipass = getattr(sys, "_MEIPASS", None)
    if meipass:
        for name in ("deno.exe", "deno"):
            candidate = Path(meipass) / "deno" / name
            if candidate.is_file():
                return str(candidate)
    try:
        import deno

        path = deno.find_deno_bin()
        if path and Path(path).is_file():
            return str(path)
    except Exception:  # noqa: BLE001 - package missing or binary not found
        pass
    return shutil.which("deno")


def _base_options(extra: dict[str, Any] | None = None) -> dict[str, Any]:
    opts: dict[str, Any] = {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "noprogress": True,
        "socket_timeout": 30,
        "retries": 3,
        "logger": _YtLogger(),
    }
    deno = _deno_path()
    if deno:
        opts["js_runtimes"] = {"deno": {"path": deno}}
    if extra:
        opts.update(extra)
    return opts


class _YtLogger:
    def debug(self, msg: str) -> None:
        pass

    def info(self, msg: str) -> None:
        pass

    def warning(self, msg: str) -> None:
        log.info("yt-dlp: %s", msg)

    def error(self, msg: str) -> None:
        log.warning("yt-dlp: %s", msg)


def _classify(exc: Exception) -> AppError:
    if isinstance(exc, AppError):
        return exc
    text = " ".join(str(exc).split())
    text = re.sub(r"\x1b\[[0-9;]*m", "", text)  # strip terminal colours
    lowered = text.lower()
    if "sign in to confirm" in lowered or "not a bot" in lowered:
        code = ErrorCode.YOUTUBE_BOT_CHECK
    elif any(k in lowered for k in ("private video", "video unavailable", "has been removed", "not available", "members-only", "age-restricted", "confirm your age", "inappropriate")):
        code = ErrorCode.YOUTUBE_UNAVAILABLE
    elif any(k in lowered for k in ("getaddrinfo", "timed out", "network", "connection", "urlopen error", "unable to download webpage")):
        code = ErrorCode.YOUTUBE_NETWORK
    else:
        code = ErrorCode.YOUTUBE_FAILED
    return AppError(code, text[:500])


# ------------------------------------------------------------------ inspect
@dataclass
class CaptionTrack:
    lang: str  # yt-dlp key, e.g. "ar", "en-orig", "ar-SA"
    name: str
    kind: str  # "manual" | "auto"


@dataclass
class VideoInfo:
    id: str
    url: str
    title: str
    channel: str
    duration: float | None
    thumbnail: str | None
    language: str | None
    captions: list[CaptionTrack] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _base_lang(code: str) -> str:
    return code.replace("-orig", "").split("-")[0].lower()


def _collect_tracks(info: dict[str, Any]) -> list[CaptionTrack]:
    tracks: list[CaptionTrack] = []
    for lang, formats in (info.get("subtitles") or {}).items():
        if lang == "live_chat" or not formats:
            continue
        name = next((f.get("name") for f in formats if f.get("name")), lang)
        tracks.append(CaptionTrack(lang, name, "manual"))

    auto = info.get("automatic_captions") or {}
    # Keep only YouTube's *original-language* speech recognition; the other
    # ~100 entries are machine translations of it.
    originals = [k for k in auto if k.endswith("-orig")]
    if not originals:
        spoken = (info.get("language") or "").lower()
        originals = [k for k in auto if spoken and _base_lang(k) == spoken][:1]
    for lang in originals:
        formats = auto.get(lang) or []
        name = next((f.get("name") for f in formats if f.get("name")), lang)
        tracks.append(CaptionTrack(lang, name, "auto"))
    return tracks


def inspect(url: str) -> VideoInfo:
    url = normalize_url(url)
    import yt_dlp

    try:
        with yt_dlp.YoutubeDL(_base_options({"skip_download": True})) as ydl:
            info = ydl.extract_info(url, download=False)
    except Exception as exc:  # noqa: BLE001
        raise _classify(exc) from exc
    if not info:
        raise AppError(ErrorCode.YOUTUBE_FAILED, "No information returned")
    if info.get("is_live"):
        raise AppError(ErrorCode.YOUTUBE_UNAVAILABLE, "Live streams can't be transcribed until they end")
    return VideoInfo(
        id=info.get("id", ""),
        url=url,
        title=info.get("title") or info.get("id") or "YouTube",
        channel=info.get("channel") or info.get("uploader") or "",
        duration=float(info["duration"]) if info.get("duration") else None,
        thumbnail=info.get("thumbnail"),
        language=info.get("language"),
        captions=_collect_tracks(info),
    )


def pick_caption(info: VideoInfo, language: str | None) -> CaptionTrack | None:
    """Best caption track for unattended use (batch queue).

    With a chosen language, only tracks in that language are used (channel
    captions first, then YouTube's automatic ones); otherwise the video's own
    language is preferred. Returns None when nothing suitable exists.
    """
    wanted = (language or "").lower() or (info.language or "").lower() or None
    manual = [c for c in info.captions if c.kind == "manual"]
    auto = [c for c in info.captions if c.kind == "auto"]
    if wanted:
        for group in (manual, auto):
            match = next((c for c in group if _base_lang(c.lang) == wanted), None)
            if match:
                return match
        return None if language else (auto[0] if auto else None)
    return auto[0] if auto else (manual[0] if manual else None)


# ---------------------------------------------------------------- playlists
_PLAYLIST_ID_RE = re.compile(r"^[A-Za-z0-9_-]{10,64}$")
_HIDDEN_TITLES = {"[private video]", "[deleted video]", "[unavailable video]"}


def playlist_id(url: str) -> str | None:
    """The ``list=`` id of a YouTube link, if it points to a playlist."""
    url = (url or "").strip()
    if not re.match(r"^https?://", url, re.I):
        url = "https://" + url
    parsed = urlparse(url)
    if (parsed.hostname or "").lower() not in _YOUTUBE_HOSTS:
        return None
    pid = (parse_qs(parsed.query).get("list") or [""])[0]
    # Radio/"Mix" lists (RD…) are endless and personal: not a course playlist.
    if pid and _PLAYLIST_ID_RE.match(pid) and not pid.startswith("RD"):
        return pid
    return None


@dataclass
class PlaylistEntry:
    id: str
    url: str
    title: str
    duration: float | None


def inspect_playlist(url: str) -> dict[str, Any]:
    """List a playlist's videos without downloading anything (one quick request)."""
    pid = playlist_id(url)
    if not pid:
        raise AppError(ErrorCode.YOUTUBE_INVALID_URL, "Not a YouTube playlist link")
    import yt_dlp

    opts = _base_options({"skip_download": True, "extract_flat": "in_playlist", "noplaylist": False})
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(f"https://www.youtube.com/playlist?list={pid}", download=False)
    except Exception as exc:  # noqa: BLE001
        raise _classify(exc) from exc
    if not info:
        raise AppError(ErrorCode.YOUTUBE_FAILED, "No information returned")
    entries: list[PlaylistEntry] = []
    seen: set[str] = set()
    for e in info.get("entries") or []:
        if not e:
            continue
        vid = str(e.get("id") or "")
        title = str(e.get("title") or "").strip()
        if not _ID_RE.match(vid) or vid in seen or title.lower() in _HIDDEN_TITLES:
            continue
        if e.get("live_status") in ("is_live", "is_upcoming"):
            continue
        seen.add(vid)
        entries.append(
            PlaylistEntry(
                id=vid,
                url=f"https://www.youtube.com/watch?v={vid}",
                title=title or vid,
                duration=float(e["duration"]) if e.get("duration") else None,
            )
        )
    if not entries:
        raise AppError(ErrorCode.YOUTUBE_UNAVAILABLE, "The playlist is empty, private, or all its videos are unavailable")
    return {
        "id": pid,
        "title": info.get("title") or pid,
        "channel": info.get("channel") or info.get("uploader") or "",
        "entries": [asdict(e) for e in entries],
    }


# ---------------------------------------------------------------- subtitles
def parse_json3(raw: str | bytes) -> list[tuple[float, float, str]]:
    """Parse YouTube's json3 caption format into (start, end, text)."""
    data = json.loads(raw)
    items: list[tuple[float, float, str]] = []
    for ev in data.get("events", []):
        segs = ev.get("segs")
        if not segs or "tStartMs" not in ev:
            continue
        text = "".join(s.get("utf8", "") for s in segs)
        text = html.unescape(text).replace("\n", " ").strip()
        if not text:
            continue
        start = ev["tStartMs"] / 1000
        end = start + ev.get("dDurationMs", 0) / 1000
        items.append((start, end, text))
    # Auto captions overlap (rolling display): clamp each end to the next start.
    for i in range(len(items) - 1):
        s, e, t = items[i]
        nxt = items[i + 1][0]
        if e > nxt:
            items[i] = (s, max(s, nxt), t)
    return items


_VTT_TIME = re.compile(r"(\d+):(\d{2}):(\d{2})[.,](\d{3})|(\d{2}):(\d{2})[.,](\d{3})")


def _vtt_seconds(stamp: str) -> float:
    m = _VTT_TIME.match(stamp.strip())
    if not m:
        return 0.0
    if m.group(1) is not None:
        h, mi, s, ms = (int(m.group(i)) for i in range(1, 5))
    else:
        h, (mi, s, ms) = 0, (int(m.group(i)) for i in range(5, 8))
    return h * 3600 + mi * 60 + s + ms / 1000


def parse_vtt(raw: str) -> list[tuple[float, float, str]]:
    """Parse WebVTT; collapses the repeated rolling lines of YouTube auto captions."""
    items: list[tuple[float, float, str]] = []
    last_text = ""
    for block in re.split(r"\r?\n\r?\n", raw):
        lines = [l for l in block.strip().splitlines() if l.strip()]
        timing = next((l for l in lines if "-->" in l), None)
        if not timing:
            continue
        start_s, _, rest = timing.partition("-->")
        end_s = rest.strip().split(" ")[0]
        body = lines[lines.index(timing) + 1 :]
        text_lines = [html.unescape(re.sub(r"<[^>]+>", "", l)).strip() for l in body]
        text_lines = [l for l in text_lines if l and l != last_text]
        if not text_lines:
            continue
        text = " ".join(text_lines)
        last_text = text_lines[-1]
        items.append((_vtt_seconds(start_s), _vtt_seconds(end_s), text))
    return items


def _merge_into_sentences(items: list[tuple[float, float, str]], max_seconds: float = 12.0) -> list[tuple[float, float, str]]:
    """Caption events are often 1-3 words; join them into readable segments."""
    merged: list[tuple[float, float, str]] = []
    cur: list[Any] | None = None
    for start, end, text in items:
        if cur is None:
            cur = [start, end, text]
            continue
        gap = start - cur[1]
        ends_sentence = cur[2].endswith((".", "؟", "?", "!", "…", "。"))
        if gap > 1.5 or (end - cur[0]) > max_seconds or (ends_sentence and end - cur[0] > 4):
            merged.append((cur[0], cur[1], cur[2]))
            cur = [start, end, text]
        else:
            cur[1] = max(cur[1], end)
            cur[2] = f"{cur[2]} {text}"
    if cur is not None:
        merged.append((cur[0], cur[1], cur[2]))
    return merged


def fetch_subtitles(url: str, lang: str, kind: str) -> dict[str, Any]:
    url = normalize_url(url)
    import yt_dlp

    try:
        with yt_dlp.YoutubeDL(_base_options({"skip_download": True})) as ydl:
            info = ydl.extract_info(url, download=False)
            source = (info.get("subtitles") if kind == "manual" else info.get("automatic_captions")) or {}
            formats = source.get(lang) or []
            if not formats:
                raise AppError(ErrorCode.YOUTUBE_NO_CAPTIONS, f"Caption track '{lang}' not found")
            chosen = next((f for f in formats if f.get("ext") == "json3"), None) or next(
                (f for f in formats if f.get("ext") == "vtt"), None
            )
            if not chosen or not chosen.get("url"):
                raise AppError(ErrorCode.YOUTUBE_NO_CAPTIONS, "No supported caption format")
            raw = ydl.urlopen(chosen["url"]).read().decode("utf-8", "replace")
    except AppError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise _classify(exc) from exc

    items = parse_json3(raw) if chosen.get("ext") == "json3" else parse_vtt(raw)
    short_events = bool(items) and sum(e - s for s, e, _ in items) / len(items) < 3
    if kind == "auto" or short_events:
        items = _merge_into_sentences(items)
    segments = []
    for start, end, text in items:
        cleaned = clean_text(text)
        if cleaned:
            segments.append(TranscriptSegment(len(segments), round(start, 2), round(end, 2), cleaned).to_dict())
    if not segments:
        raise AppError(ErrorCode.YOUTUBE_NO_CAPTIONS, "The caption track is empty")
    return {
        "segments": segments,
        "language": _base_lang(lang),
        "kind": kind,
        "title": info.get("title") or "",
        "duration": info.get("duration"),
    }


# -------------------------------------------------------------------- audio
def download_audio(
    url: str,
    target_dir: Path,
    on_progress: Callable[[float, int, int], None],
    cancel: threading.Event,
) -> tuple[Path, dict[str, Any]]:
    """Download only the best audio stream. Returns (file path, info dict)."""
    url = normalize_url(url)
    import yt_dlp

    def hook(d: dict[str, Any]) -> None:
        if cancel.is_set():
            raise yt_dlp.utils.DownloadCancelled("cancelled")
        if d.get("status") == "downloading":
            done = int(d.get("downloaded_bytes") or 0)
            total = int(d.get("total_bytes") or d.get("total_bytes_estimate") or 0)
            on_progress(done / total if total else 0.0, done, total)

    opts = _base_options(
        {
            # Audio only: m4a/webm-opus is ~1 MB per minute, no video is downloaded.
            "format": "bestaudio[ext=m4a]/bestaudio/best[height<=360]/best",
            "outtmpl": str(target_dir / "%(id)s.%(ext)s"),
            "progress_hooks": [hook],
            "overwrites": True,
            "continuedl": False,
        }
    )
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=True)
            path = Path(ydl.prepare_filename(info))
    except yt_dlp.utils.DownloadCancelled as exc:
        raise Cancelled() from exc
    except Exception as exc:  # noqa: BLE001
        if cancel.is_set():
            raise Cancelled() from exc
        raise _classify(exc) from exc
    if not path.is_file():
        found = sorted(target_dir.glob(f"{info.get('id', '*')}.*"))
        if not found:
            raise AppError(ErrorCode.YOUTUBE_FAILED, "Downloaded file not found")
        path = found[0]
    on_progress(1.0, path.stat().st_size, path.stat().st_size)
    return path, info
