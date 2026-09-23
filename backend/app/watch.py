"""Watched folders: new videos dropped into a folder are queued automatically.

The user picks one or more folders (e.g. where courses are downloaded). Every
few seconds each folder is scanned; a media file that wasn't there before is
added to the batch queue once it has finished copying/downloading (its size
and modification time stay the same for a little while). The desktop app sees
the queue grow and starts it with the user's current settings.

Course names follow the folder layout: a file in "Courses/React/01.mp4" goes
to the course "React"; a file directly in the watched folder goes to a course
named after the watched folder.

Polling (not OS change notifications) is used on purpose: it needs no extra
package, works the same on network drives and OneDrive folders, and a scan of
a few thousand files every few seconds costs next to nothing.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any

from .errors import AppError, ErrorCode
from .media import SUPPORTED_EXTENSIONS

if TYPE_CHECKING:
    from .batch import BatchManager

log = logging.getLogger(__name__)

POLL_SECONDS = 5.0
STABLE_SECONDS = 8.0  # unchanged this long = finished copying
MAX_FOLDERS = 20
MAX_KNOWN = 50_000  # files remembered per folder
# Files still being written by browsers / download managers / copy tools.
_PARTIAL_SUFFIXES = (".part", ".crdownload", ".download", ".partial", ".tmp", ".!ut", ".opdownload")


@dataclass
class WatchFolder:
    id: str
    path: str
    enabled: bool = True
    recursive: bool = True
    added_count: int = 0  # files this folder has put in the queue
    last_added_at: float | None = None
    last_added_name: str | None = None
    error: str | None = None  # e.g. the folder was removed or the drive is unplugged
    known: list[str] = field(default_factory=list)  # relative paths already seen (persisted)

    def public(self) -> dict[str, Any]:
        d = asdict(self)
        d.pop("known")
        d["name"] = Path(self.path).name or self.path
        return d


class WatchManager:
    def __init__(self, batch: "BatchManager", state_path: Path | None = None) -> None:
        self.batch = batch
        self.state_path = state_path
        self.folders: list[WatchFolder] = []
        # Bumped every time watched files are queued; the app starts the queue when it changes.
        self.seq = 0
        self._pending: dict[str, tuple[int, float, float]] = {}  # abs path -> (size, mtime, unchanged since)
        self._known: dict[str, set[str]] = {}
        self._lock = threading.RLock()
        self._dirty = False
        self._wake = threading.Event()
        self._load()
        threading.Thread(target=self._loop, daemon=True, name="watch-folders").start()

    # ------------------------------------------------------------- persistence
    def _load(self) -> None:
        if self.state_path is None:
            return
        try:
            raw = json.loads(self.state_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return
        fields = set(WatchFolder.__dataclass_fields__)
        for data in raw.get("folders") or []:
            if isinstance(data, dict) and data.get("id") and data.get("path"):
                folder = WatchFolder(**{k: v for k, v in data.items() if k in fields})
                folder.error = None
                self.folders.append(folder)
                self._known[folder.id] = set(folder.known)

    def _save(self) -> None:
        if self.state_path is None:
            return
        with self._lock:
            for f in self.folders:
                known = self._known.get(f.id, set())
                f.known = sorted(known)[:MAX_KNOWN]
            data = json.dumps({"version": 1, "folders": [asdict(f) for f in self.folders]}, ensure_ascii=False)
            self._dirty = False
        try:
            tmp = self.state_path.with_suffix(".tmp")
            tmp.write_text(data, encoding="utf-8")
            tmp.replace(self.state_path)
        except OSError as exc:
            log.warning("Could not save watched folders: %s", exc)

    # ------------------------------------------------------------- edits
    def add(self, path: str, include_existing: bool = False, recursive: bool = True) -> dict[str, Any]:
        root = Path(path)
        if not root.is_dir():
            raise AppError(ErrorCode.INVALID_REQUEST, "Not a folder")
        resolved = str(root.resolve())
        with self._lock:
            for f in self.folders:
                if str(Path(f.path).resolve()) == resolved:
                    raise AppError(ErrorCode.INVALID_REQUEST, "This folder is already watched")
            if len(self.folders) >= MAX_FOLDERS:
                raise AppError(ErrorCode.INVALID_REQUEST, "Too many watched folders")
            folder = WatchFolder(id=uuid.uuid4().hex, path=str(root), recursive=recursive)
            files = self._scan(folder)
            if include_existing:
                # The files already there are queued (the archive check skips finished ones).
                self._known[folder.id] = set()
                ready = {rel: absolute for rel, absolute in files.items()}
            else:
                self._known[folder.id] = set(files)
                ready = {}
            self.folders.append(folder)
        added = self._enqueue(folder, ready) if ready else 0
        self._save()
        return {"added": added, **self.snapshot()}

    def update(self, folder_id: str, enabled: bool | None = None, recursive: bool | None = None) -> dict[str, Any]:
        with self._lock:
            folder = self._folder(folder_id)
            if enabled is not None:
                # Files that arrived while paused count as new when watching resumes.
                folder.enabled = enabled
                folder.error = None
            if recursive is not None and recursive != folder.recursive:
                folder.recursive = recursive
                # Files already in newly included subfolders aren't "new".
                try:
                    self._known[folder.id] = set(self._scan(folder))
                except OSError:
                    pass
        self._save()
        self._wake.set()
        return self.snapshot()

    def remove(self, folder_id: str) -> dict[str, Any]:
        with self._lock:
            folder = self._folder(folder_id)
            self.folders.remove(folder)
            self._known.pop(folder.id, None)
            root = str(Path(folder.path))
            self._pending = {p: v for p, v in self._pending.items() if not p.startswith(root)}
        self._save()
        return self.snapshot()

    def scan_now(self) -> dict[str, Any]:
        self._wake.set()
        return self.snapshot()

    def _folder(self, folder_id: str) -> WatchFolder:
        for f in self.folders:
            if f.id == folder_id:
                return f
        raise AppError(ErrorCode.INVALID_REQUEST, "Unknown watched folder")

    # ------------------------------------------------------------- scanning
    @staticmethod
    def _scan(folder: WatchFolder) -> dict[str, str]:
        """relative path -> absolute path of every media file in the folder."""
        root = Path(folder.path)
        out: dict[str, str] = {}
        if folder.recursive:
            walker = ((Path(d), files) for d, _dirs, files in os.walk(root))
        else:
            walker = iter([(root, [p.name for p in root.iterdir() if p.is_file()])])
        for directory, files in walker:
            for name in files:
                lower = name.lower()
                if lower.endswith(_PARTIAL_SUFFIXES) or name.startswith(("~$", ".")):
                    continue
                if Path(lower).suffix not in SUPPORTED_EXTENSIONS:
                    continue
                full = directory / name
                out[str(full.relative_to(root))] = str(full)
        return out

    def _course_for(self, folder: WatchFolder, rel: str) -> str:
        parts = Path(rel).parts
        return parts[0] if len(parts) > 1 else (Path(folder.path).name or folder.path)

    def _enqueue(self, folder: WatchFolder, files: dict[str, str]) -> int:
        """Queue files, grouped by course; returns how many were added."""
        by_course: dict[str, list[str]] = {}
        for rel, absolute in files.items():
            by_course.setdefault(self._course_for(folder, rel), []).append(absolute)
        added = 0
        last_name = None
        for course, paths in by_course.items():
            try:
                res = self.batch.add(paths, skip_archived=True, course=course)
            except AppError as exc:
                log.warning("Watched folder: could not queue %d file(s): %s", len(paths), exc)
                continue
            added += int(res.get("added") or 0)
            last_name = Path(paths[-1]).name
        with self._lock:
            for rel in files:
                self._known.setdefault(folder.id, set()).add(rel)
            if added:
                folder.added_count += added
                folder.last_added_at = time.time()
                folder.last_added_name = last_name
                self.seq += 1
                log.info("Watched folder %s: queued %d new file(s)", folder.path, added)
            self._dirty = True
        return added

    def _tick(self) -> None:
        now = time.time()
        with self._lock:
            folders = [f for f in self.folders if f.enabled]
        for folder in folders:
            if not Path(folder.path).is_dir():
                # Unplugged drive / renamed folder: keep what we know, so reconnecting
                # doesn't make every old file look new.
                with self._lock:
                    folder.error = "unreachable"
                continue
            try:
                files = self._scan(folder)
            except OSError as exc:
                log.debug("Watched folder unreachable: %s (%s)", folder.path, exc)
                with self._lock:
                    folder.error = "unreachable"
                continue
            with self._lock:
                folder.error = None
                known = self._known.setdefault(folder.id, set())
                # Forget files that were deleted/moved away, so bringing them back counts as new.
                gone = known - files.keys()
                if gone:
                    known -= gone
                    self._dirty = True
                candidates = {rel: p for rel, p in files.items() if rel not in known}
                # Stop tracking half-copied files that disappeared.
                root = str(Path(folder.path))
                for p in [p for p in self._pending if p.startswith(root) and p not in candidates.values()]:
                    self._pending.pop(p, None)
            ready: dict[str, str] = {}
            for rel, absolute in candidates.items():
                try:
                    st = os.stat(absolute)
                except OSError:
                    continue
                sig = (st.st_size, st.st_mtime)
                prev = self._pending.get(absolute)
                if prev is None or (prev[0], prev[1]) != sig or st.st_size == 0:
                    self._pending[absolute] = (sig[0], sig[1], now)
                    continue
                if now - prev[2] < STABLE_SECONDS:
                    continue
                # Still locked by the program writing it? (Windows refuses the open.)
                try:
                    with open(absolute, "rb"):
                        pass
                except OSError:
                    continue
                ready[rel] = absolute
                self._pending.pop(absolute, None)
            if ready:
                self._enqueue(folder, ready)
        if self._dirty:
            self._save()

    def _loop(self) -> None:
        while True:
            self._wake.wait(POLL_SECONDS)
            self._wake.clear()
            try:
                self._tick()
            except Exception:  # noqa: BLE001
                log.exception("Watched folders scan failed")

    # ------------------------------------------------------------- state
    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            waiting = len(self._pending)
            return {
                "seq": self.seq,
                "waiting": waiting,  # files still being copied / downloaded
                "folders": [f.public() for f in self.folders],
            }
