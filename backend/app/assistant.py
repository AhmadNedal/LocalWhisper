"""AI helpers on top of the archive, with the user's own key (same providers as the summary).

* **Ask the course** — a question about a whole course is answered from its
  transcripts, with the lesson and minute of every source. Only the most relevant
  excerpts are sent when the course is larger than the model's budget (simple
  keyword retrieval, Arabic-normalized, runs locally).
"""

from __future__ import annotations

import logging
import math
import re
import threading
import uuid
from collections import Counter
from dataclasses import dataclass, field
from typing import Any, Callable

from .archive import Archive, _normalize
from .errors import AppError, ErrorCode
from .summarize import (
    build_blocks,
    chat,
    format_clock,
    parse_clock,
    parse_json,
    provider,
)

log = logging.getLogger(__name__)

# ------------------------------------------------------------------ retrieval
_STOP = set(
    """
    في من على الى إلى عن مع هذا هذه ذلك تلك التي الذي الذين هو هي هم انا أنا نحن انت أنت كان كانت يكون تكون
    ما ماذا لماذا كيف متى أين اين هل او أو ثم لكن بل قد لقد كل بعض اي أي ان أن إن لا لم لن اذا إذا حتى عند بين
    شو ايش وش ليش وين كيفية يعني طيب اللي هاد هذي هيك
    the a an of to in on for and or is are was were be been how what why when where which who does do did can
    about from with this that these those it its as at by explain explained
    """.split()
)
_PREFIXES = ("وال", "بال", "فال", "كال", "لل", "ال")
_WORD = re.compile(r"[\w؀-ۿ]+")


def terms(text: str) -> list[str]:
    out = []
    for word in _WORD.findall(_normalize(text or "")):
        if word in _STOP or len(word) < 2:
            continue
        for prefix in _PREFIXES:
            if word.startswith(prefix) and len(word) - len(prefix) >= 3:
                word = word[len(prefix) :]
                break
        if word not in _STOP:
            out.append(word)
    return out


@dataclass
class Chunk:
    lesson_id: str
    lesson_index: int
    title: str
    start: float
    text: str
    counts: Counter = field(default_factory=Counter)


def course_chunks(archive: Archive, course: str | None) -> list[Chunk]:
    from .course_tools import course_lessons

    chunks: list[Chunk] = []
    for lesson in course_lessons(archive, course):
        item = archive.get(lesson["id"])
        for block in build_blocks(item.get("segments", []), min_seconds=45.0, max_chars=700):
            chunks.append(Chunk(item["id"], lesson["lesson_index"], item.get("title") or "", block.start, block.text, Counter(terms(block.text))))
        summary = item.get("summary") or {}
        if summary.get("summary"):
            # The lesson summary helps "which lesson talks about…" questions.
            text = str(summary["summary"])
            chunks.append(Chunk(item["id"], lesson["lesson_index"], item.get("title") or "", -1.0, text, Counter(terms(text))))
    return chunks


def retrieve(chunks: list[Chunk], question: str, budget: int) -> list[Chunk]:
    """The chunks to send: everything when it fits, else the best BM25 matches (+ their neighbours)."""
    if sum(len(c.text) + 24 for c in chunks) <= budget:
        return chunks
    q = terms(question)
    n = len(chunks) or 1
    avg = sum(sum(c.counts.values()) for c in chunks) / n or 1
    df = Counter(t for c in chunks for t in set(c.counts) if t in q)
    # Partial matches ("جداول" ~ "الجداول") through a prefix check on rare terms.
    scores: list[tuple[float, int]] = []
    for i, c in enumerate(chunks):
        length = sum(c.counts.values()) or 1
        score = 0.0
        for t in set(q):
            f = c.counts.get(t, 0)
            if not f:
                f = sum(v for k, v in c.counts.items() if len(t) >= 4 and (k.startswith(t) or t.startswith(k)) and len(k) >= 4) * 0.6
            if not f:
                continue
            idf = math.log(1 + (n - df.get(t, 0) + 0.5) / (df.get(t, 0) + 0.5))
            score += idf * f * 2.2 / (f + 1.2 * (0.25 + 0.75 * length / avg))
        scores.append((score, i))
    scores.sort(reverse=True)
    picked: set[int] = set()
    size = 0
    for score, i in scores:
        if score <= 0 and picked:
            break
        for j in (i, i - 1, i + 1):  # a little context around each hit
            if 0 <= j < len(chunks) and j not in picked and chunks[j].lesson_id == chunks[i].lesson_id:
                if size + len(chunks[j].text) + 24 > budget:
                    continue
                picked.add(j)
                size += len(chunks[j].text) + 24
        if size >= budget * 0.95:
            break
    return [chunks[i] for i in sorted(picked, key=lambda k: (chunks[k].lesson_index, chunks[k].start))]


def render_chunks(chunks: list[Chunk]) -> str:
    lines: list[str] = []
    current = None
    for c in chunks:
        if c.lesson_index != current:
            current = c.lesson_index
            lines.append(f"\n### L{c.lesson_index}: {c.title}")
        stamp = "summary" if c.start < 0 else format_clock(c.start)
        lines.append(f"[L{c.lesson_index} {stamp}] {c.text}")
    return "\n".join(lines).strip()


# ------------------------------------------------------------------ ask
@dataclass
class AskRequest:
    course: str | None
    question: str
    provider: str
    model: str
    api_key: str = field(repr=False)


_ASK_SYSTEM = (
    "You are a teaching assistant for a recorded course. Answer the student's question using ONLY the "
    "course excerpts provided (automatic transcripts of the lessons; they may contain misheard words — "
    "infer the intended meaning). Answer in the same language as the question, clearly and concisely; "
    "use short paragraphs or a short list when helpful. After each fact, cite where it is said as "
    "[L<lesson> <mm:ss>] using the exact labels of the excerpts (e.g. [L3 12:40]). If the excerpts do not "
    "contain the answer, say so plainly and set found to false — never invent content. "
    "Reply with a single JSON object and nothing else."
)

_CITE = re.compile(r"\[L(\d+)\s+(\d{1,2}:\d{2}(?::\d{2})?|summary)\]")


def ask(archive: Archive, req: AskRequest, cancel: threading.Event) -> dict[str, Any]:
    prov = provider(req.provider)
    question = " ".join(req.question.split())
    if not question:
        raise AppError(ErrorCode.INVALID_REQUEST, "Empty question")
    chunks = course_chunks(archive, req.course)
    if not chunks:
        raise AppError(ErrorCode.INVALID_REQUEST, "The course has no transcripts")
    budget = int(min(prov.max_input_chars, 90_000) * 0.85)
    picked = retrieve(chunks, question, budget)
    lessons = {c.lesson_index: (c.lesson_id, c.title) for c in chunks}
    user = (
        f"Course: {req.course or '—'} ({len(lessons)} lessons)\n\n"
        f"Excerpts:\n<excerpts>\n{render_chunks(picked)}\n</excerpts>\n\n"
        f"Question: {question}\n\n"
        'Return JSON: {"answer": "the answer with [L<lesson> <mm:ss>] citations", "found": true, '
        '"citations": [{"lesson": 3, "time": "12:40"}]}'
    )
    raw = parse_json(chat(prov, req.model, req.api_key, _ASK_SYSTEM, user, cancel))
    answer = str(raw.get("answer") or "").strip()
    if not answer:
        raise AppError(ErrorCode.SUMMARY_FAILED, "The model returned an empty answer")
    cites: dict[tuple[int, float], dict[str, Any]] = {}

    def add(lesson: Any, stamp: Any) -> None:
        try:
            idx = int(lesson)
        except (TypeError, ValueError):
            return
        if idx not in lessons:
            return
        t = 0.0 if str(stamp) == "summary" else parse_clock(stamp)
        if t is None:
            return
        lesson_id, title = lessons[idx]
        # Snap to a real block start of that lesson so the jump lands on the sentence.
        starts = [c.start for c in chunks if c.lesson_index == idx and c.start >= 0]
        if starts:
            t = max([s for s in starts if s <= t + 1] or [starts[0]])
        cites.setdefault((idx, round(t)), {"lesson_index": idx, "id": lesson_id, "title": title, "start": t})

    for m in _CITE.finditer(answer):
        add(m.group(1), m.group(2))
    for c in raw.get("citations") or []:
        if isinstance(c, dict):
            add(c.get("lesson"), c.get("time"))
    return {
        "question": question,
        "answer": answer,
        "found": bool(raw.get("found", True)),
        "citations": sorted(cites.values(), key=lambda c: (c["lesson_index"], c["start"])),
        "lessons": {str(k): {"id": v[0], "title": v[1]} for k, v in lessons.items()},
        "searched": len(picked),
        "total": len(chunks),
        "provider": prov.id,
        "model": req.model,
    }


# ------------------------------------------------------------------ tasks
@dataclass
class AssistTask:
    id: str
    kind: str  # ask
    status: str = "running"
    step: int = 0
    steps: int = 1
    result: dict[str, Any] | None = None
    error: dict[str, str] | None = None
    cancel: threading.Event = field(default_factory=threading.Event)

    def snapshot(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "kind": self.kind,
            "status": self.status,
            "step": self.step,
            "steps": self.steps,
            "result": self.result,
            "error": self.error,
        }


class AssistantManager:
    def __init__(self, archive: Archive) -> None:
        self.archive = archive
        self._tasks: dict[str, AssistTask] = {}
        self._lock = threading.Lock()

    def _start(self, kind: str, work: Callable[[AssistTask], dict[str, Any]], secret_holder: Any) -> AssistTask:
        task = AssistTask(id=uuid.uuid4().hex, kind=kind)
        with self._lock:
            self._tasks = {k: v for k, v in self._tasks.items() if v.status == "running"}
            self._tasks[task.id] = task

        def run() -> None:
            try:
                task.result = work(task)
                task.status = "completed"
            except BaseException as exc:  # noqa: BLE001
                from .errors import classify_exception

                err = exc if isinstance(exc, AppError) else classify_exception(exc)
                if not isinstance(exc, AppError):
                    log.exception("Assistant task failed")
                    err = AppError(ErrorCode.SUMMARY_FAILED, err.detail)
                task.status = "cancelled" if err.code == ErrorCode.CANCELLED else "error"
                task.error = err.to_dict()
            finally:
                secret_holder.api_key = ""  # keys live only for the request

        threading.Thread(target=run, daemon=True, name=f"assist-{kind}").start()
        return task

    def start_ask(self, req: AskRequest) -> AssistTask:
        provider(req.provider)
        return self._start("ask", lambda task: ask(self.archive, req, task.cancel), req)

    def get(self, task_id: str) -> AssistTask:
        task = self._tasks.get(task_id)
        if task is None:
            raise AppError(ErrorCode.INVALID_REQUEST, "Unknown task")
        return task

    def cancel(self, task_id: str) -> None:
        self.get(task_id).cancel.set()
