"""Media probing and audio extraction with FFmpeg.

Performance notes
-----------------
* Only the audio stream is decoded (``-vn -sn -dn``); video frames are never
  decoded or transcoded, so a 2 GB MP4 costs roughly what its soundtrack does.
* Audio is resampled once, straight to what Whisper consumes (16 kHz mono),
  and written as raw 16-bit PCM to a temporary file (~115 MB per hour).
* The PCM file is memory-mapped: the transcriber converts one window at a time
  to float32 instead of holding hours of audio in RAM.
"""

from __future__ import annotations

import logging
import subprocess
import sys
import threading
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Callable

import numpy as np

from .errors import AppError, Cancelled, ErrorCode

log = logging.getLogger(__name__)

SAMPLE_RATE = 16_000

SUPPORTED_EXTENSIONS = {
    # Required formats
    ".mp4", ".mkv", ".avi", ".mov", ".webm", ".mp3", ".wav", ".m4a", ".flac",
    # Other common formats FFmpeg decodes just as well
    ".m4v", ".mpg", ".mpeg", ".ts", ".3gp", ".wmv", ".ogg", ".oga", ".opus", ".aac", ".wma",
}

_NO_WINDOW = 0x08000000 if sys.platform == "win32" else 0  # CREATE_NO_WINDOW


@dataclass
class MediaInfo:
    path: str
    name: str
    size_bytes: int
    duration: float | None
    has_video: bool
    has_audio: bool
    audio_codec: str | None
    container: str | None

    def to_dict(self) -> dict[str, object]:
        return asdict(self)


def probe(path_str: str) -> MediaInfo:
    """Read container headers (no decoding) to get duration and stream info."""
    path = Path(path_str)
    if not path.is_file():
        raise AppError(ErrorCode.FILE_NOT_FOUND, str(path))
    if path.suffix.lower() not in SUPPORTED_EXTENSIONS:
        raise AppError(ErrorCode.UNSUPPORTED_MEDIA, f"Unsupported file type '{path.suffix}'")

    import av  # PyAV ships with faster-whisper; it reads headers without decoding.

    try:
        with av.open(str(path), metadata_errors="ignore") as container:
            audio = next(iter(container.streams.audio), None)
            video = next((s for s in container.streams.video if not _is_cover_art(s)), None)
            duration: float | None = None
            if container.duration:
                duration = float(container.duration) / 1_000_000  # AV_TIME_BASE
            elif audio is not None and audio.duration and audio.time_base:
                duration = float(audio.duration * audio.time_base)
            info = MediaInfo(
                path=str(path),
                name=path.name,
                size_bytes=path.stat().st_size,
                duration=duration,
                has_video=video is not None,
                has_audio=audio is not None,
                audio_codec=audio.codec_context.name if audio is not None else None,
                container=container.format.name if container.format else None,
            )
    except (av.error.InvalidDataError, av.error.EOFError) as exc:  # type: ignore[attr-defined]
        raise AppError(ErrorCode.CORRUPTED_MEDIA, str(exc)[:300]) from exc
    except av.error.FFmpegError as exc:  # type: ignore[attr-defined]
        raise AppError(ErrorCode.UNSUPPORTED_MEDIA, str(exc)[:300]) from exc

    if not info.has_audio:
        raise AppError(ErrorCode.NO_AUDIO_STREAM, "The file has no audio track")
    return info


def _is_cover_art(stream) -> bool:  # noqa: ANN001 - PyAV stream
    disposition = getattr(stream, "disposition", None)
    try:
        return bool(disposition is not None and int(disposition) & 0x400)  # AV_DISPOSITION_ATTACHED_PIC
    except (TypeError, ValueError):
        return False


def extract_audio(
    ffmpeg: str | None,
    source: str,
    target: Path,
    duration: float | None,
    on_progress: Callable[[float], None],
    cancel: threading.Event,
) -> None:
    """Decode the best audio stream to 16 kHz mono s16le PCM at ``target``."""
    if not ffmpeg:
        raise AppError(ErrorCode.FFMPEG_MISSING, "FFmpeg executable not found")

    cmd = [
        ffmpeg, "-hide_banner", "-nostdin", "-nostats", "-loglevel", "error",
        "-i", source,
        "-vn", "-sn", "-dn",           # ignore video/subtitle/data: no video decoding
        "-ac", "1", "-ar", str(SAMPLE_RATE),
        "-c:a", "pcm_s16le", "-f", "s16le",
        "-progress", "pipe:1",
        "-y", str(target),
    ]
    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            stdin=subprocess.DEVNULL,
            creationflags=_NO_WINDOW,
        )
    except OSError as exc:
        raise AppError(ErrorCode.FFMPEG_MISSING, str(exc)) from exc

    stderr_chunks: list[bytes] = []
    stderr_reader = threading.Thread(
        target=lambda: stderr_chunks.append(proc.stderr.read() if proc.stderr else b""), daemon=True
    )
    stderr_reader.start()

    # ``-progress`` writes key=value lines; out_time_us is the decoded position.
    assert proc.stdout is not None
    for raw in proc.stdout:
        if cancel.is_set():
            proc.kill()
            proc.wait()
            raise Cancelled()
        line = raw.decode("utf-8", "ignore").strip()
        if line.startswith("out_time_us=") and duration:
            try:
                seconds = int(line.split("=", 1)[1]) / 1_000_000
                on_progress(max(0.0, min(1.0, seconds / duration)))
            except ValueError:
                pass

    code = proc.wait()
    stderr_reader.join(timeout=2)
    if cancel.is_set():
        raise Cancelled()
    if code != 0:
        message = b"".join(stderr_chunks).decode("utf-8", "ignore").strip()
        log.warning("ffmpeg failed (%s): %s", code, message)
        lowered = message.lower()
        if "invalid data" in lowered or "moov atom" in lowered or "corrupt" in lowered:
            raise AppError(ErrorCode.CORRUPTED_MEDIA, message[-300:])
        if "does not contain any stream" in lowered or "output file #0 does not contain" in lowered:
            raise AppError(ErrorCode.NO_AUDIO_STREAM, message[-300:])
        raise AppError(ErrorCode.UNSUPPORTED_MEDIA, message[-300:] or f"ffmpeg exit code {code}")
    on_progress(1.0)


class PcmAudio:
    """Memory-mapped 16 kHz mono PCM produced by :func:`extract_audio`."""

    def __init__(self, path: Path) -> None:
        self.path = path
        size = path.stat().st_size
        if size < 2:
            self._data = np.zeros(0, dtype=np.int16)
        else:
            self._data = np.memmap(path, dtype=np.int16, mode="r", shape=(size // 2,))

    @property
    def num_samples(self) -> int:
        return int(self._data.shape[0])

    @property
    def duration(self) -> float:
        return self.num_samples / SAMPLE_RATE

    def window(self, start: int, end: int) -> np.ndarray:
        """Return samples [start, end) as float32 in [-1, 1] (only this slice is loaded)."""
        return np.asarray(self._data[start:end], dtype=np.float32) / 32768.0

    def quietest_point(self, target: int, search_seconds: float = 8.0) -> int:
        """Find a low-energy sample index just before ``target``.

        Splitting long audio at a pause keeps words from being cut in half at
        window boundaries.
        """
        frame = SAMPLE_RATE // 50  # 20 ms
        lo = max(0, target - int(search_seconds * SAMPLE_RATE))
        segment = np.asarray(self._data[lo:target], dtype=np.float32)
        usable = (len(segment) // frame) * frame
        if usable < frame:
            return target
        energy = np.square(segment[:usable]).reshape(-1, frame).mean(axis=1)
        return lo + int(np.argmin(energy)) * frame

    def close(self) -> None:
        mm = getattr(self._data, "_mmap", None)
        self._data = np.zeros(0, dtype=np.int16)
        if mm is not None:
            try:
                mm.close()
            except (BufferError, ValueError):
                pass
