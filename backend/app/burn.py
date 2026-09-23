"""Burn subtitles into a copy of the video ("hardcoded" subtitles).

The text is written as an ASS subtitle file and drawn by FFmpeg's ``subtitles``
filter (libass), which shapes Arabic and handles right-to-left lines. The
original video is never modified: a new MP4 is written next to the other
exports. Everything runs locally.

With the translation, both languages are shown: the original on top, the
translation (smaller) under it. They are two independent tracks, so each keeps
its own timing and its own text direction.
"""

from __future__ import annotations

import logging
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .errors import AppError, Cancelled, ErrorCode
from .media import _NO_WINDOW
from .subtitles import Cue, build_cues

log = logging.getLogger(__name__)

FONT_FILE = "NotoSansArabic-Variable.ttf"  # clear on screen; its Latin letters match
FONT_NAME = "Noto Sans Arabic"
SIZES = {"small": 0.05, "medium": 0.06, "large": 0.072}  # font size as a share of the video height


@dataclass
class BurnRequest:
    source: str
    output: Path
    segments: list[dict]
    translation: list[dict] | None = None
    content: str = "original"  # original | translation | both
    size: str = "medium"
    style: str = "box"  # box | outline
    duration: float | None = None


@dataclass
class BurnTask:
    id: str
    output: str
    status: str = "running"  # running | completed | error | cancelled
    progress: float = 0.0
    error: dict[str, str] | None = None
    started: float = field(default_factory=time.time)
    cancel: threading.Event = field(default_factory=threading.Event)

    def snapshot(self) -> dict[str, Any]:
        elapsed = time.time() - self.started
        eta = elapsed * (1 - self.progress) / self.progress if 0.03 < self.progress < 1 else None
        return {
            "id": self.id,
            "status": self.status,
            "progress": round(self.progress, 4),
            "output": self.output,
            "error": self.error,
            "etaSeconds": round(eta) if eta is not None else None,
        }


# --------------------------------------------------------------------- ASS
def _ass_time(seconds: float) -> str:
    cs = max(0, int(round(seconds * 100)))
    h, rem = divmod(cs, 360000)
    m, rem = divmod(rem, 6000)
    s, cs = divmod(rem, 100)
    return f"{h}:{m:02d}:{s:02d}.{cs:02d}"


def _ass_text(text: str) -> str:
    # Braces start override blocks and backslashes start tags in ASS.
    text = text.replace("\\", "⧵").replace("{", "(").replace("}", ")")
    return text.replace("\n", "\\N")


def build_ass(req: BurnRequest, width: int, height: int) -> str:
    main_size = round(height * SIZES.get(req.size, SIZES["medium"]))
    alt_size = round(main_size * 0.8)
    outline = max(2, round(main_size * 0.07))
    margin = round(height * 0.05)
    side = round(width * 0.06)
    # BorderStyle 3 = opaque box behind the text (most readable on any picture); 1 = outline + shadow.
    border = 3 if req.style == "box" else 1
    back = "&H64000000" if req.style == "box" else "&H80000000"
    shadow = 0 if req.style == "box" else max(1, outline // 2)

    tracks: list[tuple[str, list[Cue]]] = []
    original = build_cues(req.segments)
    translation = build_cues(req.translation or [])
    if req.content == "translation" and translation:
        tracks.append(("Main", translation))
    elif req.content == "both" and translation:
        tracks.append(("Main", original))
        tracks.append(("Alt", translation))
    else:
        tracks.append(("Main", original))

    # With two tracks the original sits above the translation (room for 2 translation lines).
    main_margin = margin + (round(alt_size * 1.35 * 2) + round(height * 0.012) if len(tracks) == 2 else 0)

    def style(name: str, size: int, colour: str, margin_v: int) -> str:
        # Encoding -1 lets libass pick each line's base direction (Arabic RTL, English LTR).
        return (
            f"Style: {name},{FONT_NAME},{size},{colour},&H000000FF,&H00000000,{back},"
            f"-1,0,0,0,100,100,0,0,{border},{outline},{shadow},2,{side},{side},{margin_v},-1"
        )

    lines = [
        "[Script Info]",
        "; Written by Local Transcriber",
        "ScriptType: v4.00+",
        f"PlayResX: {width}",
        f"PlayResY: {height}",
        "WrapStyle: 0",
        "ScaledBorderAndShadow: yes",
        "YCbCr Matrix: None",
        "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, "
        "Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, "
        "MarginR, MarginV, Encoding",
        style("Main", main_size, "&H00FFFFFF", main_margin),
        style("Alt", alt_size, "&H0040E8FF", margin),  # warm yellow for the second language
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]
    for name, cues in tracks:
        for cue in cues:
            if cue.end - cue.start < 0.05 or not cue.text.strip():
                continue
            lines.append(f"Dialogue: 0,{_ass_time(cue.start)},{_ass_time(cue.end)},{name},,0,0,0,,{_ass_text(cue.text)}")
    return "\n".join(lines) + "\n"


# --------------------------------------------------------------------- video
def _video_info(source: str) -> tuple[int, int, str | None]:
    """(width, height, audio codec) of the first video stream."""
    import av

    try:
        with av.open(source) as container:
            video = next((s for s in container.streams.video if not (s.disposition & 1024)), None)  # skip cover art
            if video is None:
                raise AppError(ErrorCode.UNSUPPORTED_MEDIA, "The file has no video picture to draw subtitles on")
            audio = container.streams.audio[0].codec_context.name if container.streams.audio else None
            width, height = int(video.codec_context.width or 0), int(video.codec_context.height or 0)
    except AppError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise AppError(ErrorCode.CORRUPTED_MEDIA, f"{exc.__class__.__name__}: {exc}"[:300]) from exc
    if not width or not height:
        raise AppError(ErrorCode.UNSUPPORTED_MEDIA, "Unknown video size")
    return width, height, audio


def burn(req: BurnRequest, ffmpeg: str | None, fonts_dir: Path, on_progress, cancel: threading.Event) -> Path:  # noqa: ANN001
    if not ffmpeg:
        raise AppError(ErrorCode.FFMPEG_MISSING, "FFmpeg executable not found")
    if not Path(req.source).is_file():
        raise AppError(ErrorCode.FILE_NOT_FOUND, req.source)
    width, height, audio = _video_info(req.source)
    tmp = Path(tempfile.mkdtemp(prefix="burn-"))
    partial = req.output.with_name(req.output.stem + ".part" + req.output.suffix)
    try:
        (tmp / "subs.ass").write_text(build_ass(req, width, height), encoding="utf-8")
        (tmp / "fonts").mkdir()
        shutil.copy2(fonts_dir / FONT_FILE, tmp / "fonts" / FONT_FILE)
        req.output.parent.mkdir(parents=True, exist_ok=True)
        audio_args = ["-c:a", "copy"] if audio in ("aac", "mp3") else ["-c:a", "aac", "-b:a", "192k"]
        # Relative paths inside the filter (cwd = tmp): no Windows drive-letter escaping needed.
        cmd = [
            ffmpeg, "-hide_banner", "-nostdin", "-nostats", "-loglevel", "error",
            "-i", req.source,
            "-map", "0:v:0", "-map", "0:a:0?",
            "-vf", "subtitles=subs.ass:fontsdir=fonts",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
            *audio_args,
            "-movflags", "+faststart",
            "-progress", "pipe:1",
            "-y", str(partial),
        ]
        try:
            proc = subprocess.Popen(
                cmd, cwd=str(tmp), stdout=subprocess.PIPE, stderr=subprocess.PIPE, stdin=subprocess.DEVNULL,
                creationflags=_NO_WINDOW,
            )
        except OSError as exc:
            raise AppError(ErrorCode.FFMPEG_MISSING, str(exc)) from exc
        errors: list[bytes] = []
        reader = threading.Thread(target=lambda: errors.append(proc.stderr.read() if proc.stderr else b""), daemon=True)
        reader.start()
        assert proc.stdout is not None
        for raw in proc.stdout:
            if cancel.is_set():
                proc.kill()
                proc.wait()
                raise Cancelled()
            line = raw.decode("utf-8", "ignore").strip()
            if line.startswith("out_time_us=") and req.duration:
                try:
                    on_progress(max(0.0, min(0.999, int(line.split("=", 1)[1]) / 1_000_000 / req.duration)))
                except ValueError:
                    pass
        code = proc.wait()
        reader.join(timeout=2)
        if cancel.is_set():
            raise Cancelled()
        if code != 0:
            message = b"".join(errors).decode("utf-8", "ignore").strip()
            log.warning("burn failed (%s): %s", code, message)
            raise AppError(ErrorCode.EXPORT_FAILED, message[-400:] or f"ffmpeg exit code {code}")
        partial.replace(req.output)
        on_progress(1.0)
        return req.output
    finally:
        partial.unlink(missing_ok=True)
        shutil.rmtree(tmp, ignore_errors=True)


class BurnManager:
    def __init__(self, ffmpeg: str | None, fonts_dir: Path) -> None:
        self.ffmpeg = ffmpeg
        self.fonts_dir = fonts_dir
        self._tasks: dict[str, BurnTask] = {}
        self._lock = threading.Lock()

    def start(self, req: BurnRequest) -> BurnTask:
        with self._lock:
            if any(t.status == "running" for t in self._tasks.values()):
                raise AppError(ErrorCode.BUSY, "Another video is being created")
            self._tasks = {k: v for k, v in self._tasks.items() if time.time() - v.started < 3600}
            task = BurnTask(id=uuid.uuid4().hex, output=str(req.output))
            self._tasks[task.id] = task
        threading.Thread(target=self._run, args=(task, req), daemon=True, name="burn").start()
        return task

    def _run(self, task: BurnTask, req: BurnRequest) -> None:
        try:
            burn(req, self.ffmpeg, self.fonts_dir, lambda p: setattr(task, "progress", p), task.cancel)
            task.status = "completed"
        except Cancelled:
            task.status = "cancelled"
        except AppError as err:
            task.status = "error"
            task.error = err.to_dict()
        except Exception as exc:  # noqa: BLE001
            log.exception("Burn failed")
            task.status = "error"
            task.error = {"code": "internal", "detail": f"{exc.__class__.__name__}: {exc}"[:300]}

    def get(self, task_id: str) -> BurnTask:
        task = self._tasks.get(task_id)
        if task is None:
            raise AppError(ErrorCode.INVALID_REQUEST, "Unknown task")
        return task

    def cancel(self, task_id: str) -> None:
        self.get(task_id).cancel.set()
