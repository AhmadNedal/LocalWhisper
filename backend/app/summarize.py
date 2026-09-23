"""AI summaries of a transcript: overview, key points and timed chapters.

Summaries use a large language model from a provider the user already pays
for (Anthropic, OpenAI, Cohere or Groq) with the user's own API key. Only the
*text* of the transcript is sent — never audio or video — and only when the
user presses "Summarize" (or enables it for a batch).

Long lectures are handled with a map → reduce pass: the transcript is cut into
parts that fit the provider's budget, each part is summarized, and a final
request merges the partial results. Chapter times always come from the
transcript's own timestamps, so they line up with the PDF and the player.
"""

from __future__ import annotations

import json
import logging
import random
import re
import threading
import time
import uuid
from dataclasses import asdict, dataclass, field
from typing import Any, Callable

from .errors import AppError, Cancelled, ErrorCode

log = logging.getLogger(__name__)

MAX_RETRIES = 4
REQUEST_TIMEOUT = 300.0


@dataclass(frozen=True)
class LlmModel:
    id: str
    label: str


@dataclass(frozen=True)
class LlmProvider:
    id: str
    name: str
    models: tuple[LlmModel, ...]
    key_url: str
    check_url: str
    # Characters of transcript per request. Arabic is ~2.5–3.5 chars/token, so
    # these stay well inside each context window (and Groq's free-tier limits).
    max_input_chars: int

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d.pop("check_url")
        return d


PROVIDERS: dict[str, LlmProvider] = {
    p.id: p
    for p in (
        LlmProvider(
            id="anthropic",
            name="Anthropic (Claude)",
            models=(
                LlmModel("claude-sonnet-5", "Claude Sonnet 5"),
                LlmModel("claude-haiku-4-5-20251001", "Claude Haiku 4.5 — faster, cheaper"),
                LlmModel("claude-opus-5-5", "Claude Opus 5.5 — most capable"),
            ),
            key_url="https://console.anthropic.com/settings/keys",
            check_url="https://api.anthropic.com/v1/models?limit=1",
            max_input_chars=240_000,
        ),
        LlmProvider(
            id="openai",
            name="OpenAI",
            models=(
                LlmModel("gpt-5.4-mini", "GPT-5.4 mini"),
                LlmModel("gpt-5.4", "GPT-5.4"),
                LlmModel("gpt-5-mini", "GPT-5 mini"),
            ),
            key_url="https://platform.openai.com/api-keys",
            check_url="https://api.openai.com/v1/models",
            max_input_chars=200_000,
        ),
        LlmProvider(
            id="cohere",
            name="Cohere",
            models=(
                LlmModel("command-a-plus-05-2026", "Command A+"),
                LlmModel("command-a-03-2025", "Command A"),
            ),
            key_url="https://dashboard.cohere.com/api-keys",
            check_url="https://api.cohere.com/v1/models?page_size=1",
            max_input_chars=150_000,
        ),
        LlmProvider(
            id="groq",
            name="Groq",
            models=(
                LlmModel("openai/gpt-oss-120b", "GPT-OSS 120B"),
                LlmModel("llama-3.3-70b-versatile", "Llama 3.3 70B"),
            ),
            key_url="https://console.groq.com/keys",
            check_url="https://api.groq.com/openai/v1/models",
            max_input_chars=18_000,
        ),
    )
}


def provider(provider_id: str) -> LlmProvider:
    p = PROVIDERS.get(provider_id)
    if p is None:
        raise AppError(ErrorCode.INVALID_REQUEST, f"Unknown summary provider '{provider_id}'")
    return p


def list_providers() -> list[dict[str, Any]]:
    return [p.to_dict() for p in PROVIDERS.values()]


# ----------------------------------------------------------------- transcript
def format_clock(seconds: float) -> str:
    seconds = max(0, int(seconds))
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"


def parse_clock(value: Any) -> float | None:
    """'05:12', '1:02:03', '312', 312 → seconds."""
    if isinstance(value, (int, float)):
        return float(value) if value >= 0 else None
    text = str(value or "").strip().strip("[]()")
    if re.fullmatch(r"\d+(\.\d+)?", text):
        return float(text)
    m = re.fullmatch(r"(?:(\d+):)?(\d{1,2}):(\d{2})", text)
    if not m:
        return None
    h, mnt, s = int(m.group(1) or 0), int(m.group(2)), int(m.group(3))
    if s >= 60 or (m.group(1) and mnt >= 60):
        return None
    return float(h * 3600 + mnt * 60 + s)


@dataclass
class Block:
    start: float
    text: str


def build_blocks(segments: list[dict[str, Any]], min_seconds: float = 40.0, max_chars: int = 600) -> list[Block]:
    """Merge segments into ~40 s blocks: fewer timestamps → fewer tokens."""
    blocks: list[Block] = []
    cur: Block | None = None
    for seg in segments:
        text = " ".join(str(seg.get("text", "")).split())
        if not text:
            continue
        start = float(seg.get("start", 0))
        if cur is None:
            cur = Block(start, text)
        elif start - cur.start >= min_seconds or len(cur.text) >= max_chars:
            blocks.append(cur)
            cur = Block(start, text)
        else:
            cur.text = f"{cur.text} {text}"
    if cur is not None:
        blocks.append(cur)
    return blocks


def split_parts(blocks: list[Block], max_chars: int) -> list[list[Block]]:
    parts: list[list[Block]] = [[]]
    size = 0
    for b in blocks:
        line = len(b.text) + 12
        if parts[-1] and size + line > max_chars:
            parts.append([])
            size = 0
        parts[-1].append(b)
        size += line
    return [p for p in parts if p]


def render_blocks(blocks: list[Block]) -> str:
    return "\n".join(f"[{format_clock(b.start)}] {b.text}" for b in blocks)


# -------------------------------------------------------------------- prompts
_LANG_NAMES = {"ar": "Arabic (Modern Standard Arabic)", "en": "English"}

_SCHEMA = """{
  "title": "short descriptive title of the recording",
  "summary": "one to three paragraphs summarizing the whole recording",
  "key_points": ["the most important ideas, facts, definitions or conclusions — 5 to 12 items"],
  "chapters": [
    {"start": "mm:ss (copied from a timestamp in the transcript)", "title": "short chapter title", "summary": "one or two sentences"}
  ],
  "keywords": ["5 to 10 main terms"]
}"""


def _system_prompt(out_lang: str) -> str:
    language = _LANG_NAMES.get(out_lang, "the same language as the transcript")
    return (
        "You summarize transcripts of lectures, lessons, meetings and videos. "
        "The transcript was produced by automatic speech recognition, so it can contain "
        "misheard words; infer the intended meaning and never copy obvious recognition errors. "
        "Be faithful: do not invent facts that are not in the transcript. "
        f"Write every text value in {language}. Keep technical terms, code, product names "
        "and numbers exactly as spoken (e.g. SQL Server, CREATE INDEX). "
        "Reply with a single JSON object and nothing else — no markdown fences."
    )


def _chapter_rule(duration: float) -> str:
    minutes = max(1, int(duration // 60))
    target = max(2, min(20, round(minutes / 6)))
    return (
        f"Split the recording into about {target} chapters that follow the actual topic changes "
        "(not fixed intervals). Each chapter start must be one of the [timestamps] shown in the "
        "transcript; the first chapter starts at the first timestamp. Chapters are in time order."
    )


def _full_prompt(title: str, duration: float, transcript: str) -> str:
    return (
        f"Recording: {title}\nDuration: {format_clock(duration)}\n\n"
        f"{_chapter_rule(duration)}\n\nReturn JSON with exactly this shape:\n{_SCHEMA}\n\n"
        f"Transcript (each line starts with its [timestamp]):\n<transcript>\n{transcript}\n</transcript>"
    )


def _part_prompt(title: str, index: int, total: int, transcript: str) -> str:
    return (
        f"Recording: {title}\nThis is part {index} of {total} of a long transcript.\n\n"
        "Summarize ONLY this part. Split it into chapters at real topic changes; each chapter "
        "start must be one of the [timestamps] shown. Return JSON with this shape:\n"
        '{"summary": "one paragraph", "key_points": ["..."], '
        '"chapters": [{"start": "mm:ss", "title": "...", "summary": "..."}], "keywords": ["..."]}\n\n'
        f"<transcript>\n{transcript}\n</transcript>"
    )


def _merge_prompt(title: str, duration: float, parts: list[dict[str, Any]]) -> str:
    return (
        f"Recording: {title}\nDuration: {format_clock(duration)}\n\n"
        "Below are summaries of consecutive parts of one long recording, in order. Merge them into "
        "one summary of the whole recording. For chapters: keep the given start times (you may merge "
        "neighbouring chapters about the same topic, keeping the earlier start), and rewrite titles so "
        f"they read as one table of contents. {_chapter_rule(duration)}\n\n"
        f"Return JSON with exactly this shape:\n{_SCHEMA}\n\n"
        f"<parts>\n{json.dumps(parts, ensure_ascii=False, indent=1)}\n</parts>"
    )


# ------------------------------------------------------------------ requests
def _error_from_response(status: int, body: str) -> AppError:
    detail = f"HTTP {status}: {' '.join(body.split())[:400]}"
    lowered = body.lower()
    if status in (401, 403):
        return AppError(ErrorCode.CLOUD_AUTH, detail)
    if status == 402 or "insufficient_quota" in lowered or "credit balance" in lowered or "billing" in lowered:
        return AppError(ErrorCode.CLOUD_QUOTA, detail)
    if status == 429:
        return AppError(ErrorCode.CLOUD_RATE_LIMIT, detail)
    if status == 404 or "model_not_found" in lowered or "does not exist" in lowered:
        return AppError(ErrorCode.SUMMARY_MODEL, detail)
    if status == 413 or "context" in lowered and ("length" in lowered or "window" in lowered):
        return AppError(ErrorCode.SUMMARY_TOO_LONG, detail)
    return AppError(ErrorCode.SUMMARY_FAILED, detail)


def _request_spec(prov: LlmProvider, model: str, api_key: str, system: str, user: str) -> tuple[str, dict, dict]:
    if prov.id == "anthropic":
        return (
            "https://api.anthropic.com/v1/messages",
            {"x-api-key": api_key, "anthropic-version": "2023-06-01"},
            {
                "model": model,
                "max_tokens": 8000,
                "system": system,
                "messages": [{"role": "user", "content": user}],
            },
        )
    if prov.id == "cohere":
        return (
            "https://api.cohere.com/v2/chat",
            {"Authorization": f"Bearer {api_key}"},
            {
                "model": model,
                "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
                "response_format": {"type": "json_object"},
                "max_tokens": 8000,
            },
        )
    url = (
        "https://api.openai.com/v1/chat/completions"
        if prov.id == "openai"
        else "https://api.groq.com/openai/v1/chat/completions"
    )
    body: dict[str, Any] = {
        "model": model,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        "response_format": {"type": "json_object"},
        "max_completion_tokens": 16000 if prov.id == "openai" else 8000,
    }
    # Reasoning models: keep thinking short — summarizing doesn't need much.
    if re.match(r"^(gpt-5|o\d)", model) or "gpt-oss" in model:
        body["reasoning_effort"] = "low"
    return url, {"Authorization": f"Bearer {api_key}"}, body


def _extract_text(prov: LlmProvider, payload: dict[str, Any]) -> str:
    if prov.id == "anthropic":
        return "".join(c.get("text", "") for c in payload.get("content", []) if c.get("type") == "text")
    if prov.id == "cohere":
        content = (payload.get("message") or {}).get("content") or []
        return "".join(c.get("text", "") for c in content if isinstance(c, dict))
    choices = payload.get("choices") or [{}]
    return str((choices[0].get("message") or {}).get("content") or "")


def chat(prov: LlmProvider, model: str, api_key: str, system: str, user: str, cancel: threading.Event) -> str:
    import httpx

    url, headers, body = _request_spec(prov, model, api_key.strip(), system, user)
    delay = 2.0
    for attempt in range(MAX_RETRIES + 1):
        if cancel.is_set():
            raise Cancelled()
        try:
            resp = httpx.post(url, headers=headers, json=body, timeout=REQUEST_TIMEOUT)
        except httpx.HTTPError as exc:
            if attempt < MAX_RETRIES:
                _sleep(delay, cancel)
                delay *= 2
                continue
            raise AppError(ErrorCode.CLOUD_NETWORK, f"{exc.__class__.__name__}: {exc}"[:300]) from exc
        if resp.status_code == 200:
            try:
                return _extract_text(prov, resp.json())
            except ValueError as exc:
                raise AppError(ErrorCode.SUMMARY_FAILED, "Provider returned invalid JSON") from exc
        err = _error_from_response(resp.status_code, resp.text)
        retryable = resp.status_code in (429, 500, 502, 503, 504, 529) and err.code != ErrorCode.CLOUD_QUOTA
        if retryable and attempt < MAX_RETRIES:
            retry_after = resp.headers.get("retry-after", "")
            wait_s = float(retry_after) if re.fullmatch(r"\d+(\.\d+)?", retry_after) else delay
            _sleep(min(wait_s, 60), cancel)
            delay *= 2
            continue
        raise err
    raise AppError(ErrorCode.SUMMARY_FAILED, "Too many retries")


def _sleep(seconds: float, cancel: threading.Event) -> None:
    if cancel.wait(seconds + random.random()):
        raise Cancelled()


def parse_json(text: str) -> dict[str, Any]:
    """Parse the model's JSON, tolerating code fences or text around it."""
    text = text.strip()
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text)
    try:
        value = json.loads(text)
    except ValueError:
        start, end = text.find("{"), text.rfind("}")
        if start < 0 or end <= start:
            raise AppError(ErrorCode.SUMMARY_FAILED, "The model did not return JSON: " + text[:200]) from None
        try:
            value = json.loads(text[start : end + 1])
        except ValueError as exc:
            raise AppError(ErrorCode.SUMMARY_FAILED, "The model returned malformed JSON") from exc
    if not isinstance(value, dict):
        raise AppError(ErrorCode.SUMMARY_FAILED, "The model did not return a JSON object")
    return value


def _strings(value: Any, limit: int) -> list[str]:
    if not isinstance(value, list):
        return []
    out = [" ".join(str(v).split()) for v in value if str(v).strip()]
    return out[:limit]


def normalize_result(raw: dict[str, Any], starts: list[float], duration: float) -> dict[str, Any]:
    """Validate the model's output and snap chapter times to real transcript times."""
    chapters: list[dict[str, Any]] = []
    for ch in raw.get("chapters") or []:
        if not isinstance(ch, dict):
            continue
        t = parse_clock(ch.get("start"))
        title = " ".join(str(ch.get("title") or "").split())
        if t is None or not title:
            continue
        if duration and t > duration + 5:
            continue
        if starts:
            t = min(starts, key=lambda s: abs(s - t))  # snap to an existing timestamp
        chapters.append({"start": round(t, 2), "title": title[:200], "summary": " ".join(str(ch.get("summary") or "").split())})
    chapters.sort(key=lambda c: c["start"])
    deduped: list[dict[str, Any]] = []
    for ch in chapters:
        if deduped and abs(deduped[-1]["start"] - ch["start"]) < 1:
            continue
        deduped.append(ch)
    if deduped and starts:
        deduped[0]["start"] = min(deduped[0]["start"], starts[0])

    summary = str(raw.get("summary") or "").strip()
    if not summary and not deduped:
        raise AppError(ErrorCode.SUMMARY_FAILED, "The model returned an empty summary")
    return {
        "title": " ".join(str(raw.get("title") or "").split())[:300],
        "summary": summary,
        "key_points": _strings(raw.get("key_points"), 20),
        "chapters": deduped,
        "keywords": _strings(raw.get("keywords"), 15),
    }


# ----------------------------------------------------------------- main entry
@dataclass
class SummaryRequest:
    segments: list[dict[str, Any]]
    provider: str
    model: str
    api_key: str = field(repr=False)
    language: str = "auto"  # auto (same as transcript) | ar | en
    title: str = ""
    duration: float | None = None
    transcript_language: str | None = None


def summarize(
    req: SummaryRequest,
    cancel: threading.Event,
    on_progress: Callable[[int, int], None] | None = None,
) -> dict[str, Any]:
    prov = provider(req.provider)
    model = req.model.strip()
    if not model:
        raise AppError(ErrorCode.INVALID_REQUEST, "No model selected")
    if not req.api_key.strip():
        raise AppError(ErrorCode.CLOUD_AUTH, "No API key")
    blocks = build_blocks(req.segments)
    if not blocks:
        raise AppError(ErrorCode.INVALID_REQUEST, "Transcript is empty")

    duration = float(req.duration or 0) or max(float(s.get("end", 0)) for s in req.segments)
    out_lang = req.language if req.language in ("ar", "en") else (req.transcript_language or "")
    system = _system_prompt(out_lang)
    title = req.title or "—"
    starts = [b.start for b in blocks]

    parts = split_parts(blocks, prov.max_input_chars)
    steps = len(parts) + (1 if len(parts) > 1 else 0)
    if on_progress:
        on_progress(0, steps)

    if len(parts) == 1:
        raw = parse_json(chat(prov, model, req.api_key, system, _full_prompt(title, duration, render_blocks(blocks)), cancel))
    else:
        partials: list[dict[str, Any]] = []
        for i, part in enumerate(parts, start=1):
            text = chat(prov, model, req.api_key, system, _part_prompt(title, i, len(parts), render_blocks(part)), cancel)
            partial = parse_json(text)
            part_starts = [b.start for b in part]
            partial["chapters"] = normalize_result({**partial, "summary": partial.get("summary") or "."}, part_starts, duration)[
                "chapters"
            ]
            for ch in partial["chapters"]:
                ch["start"] = format_clock(ch["start"])
            partials.append({"part": i, **partial})
            if on_progress:
                on_progress(i, steps)
        raw = parse_json(chat(prov, model, req.api_key, system, _merge_prompt(title, duration, partials), cancel))

    result = normalize_result(raw, starts, duration)
    result.update(
        {
            "provider": prov.id,
            "provider_name": prov.name,
            "model": model,
            "language": out_lang or None,
            "created_at": time.time(),
        }
    )
    if on_progress:
        on_progress(steps, steps)
    return result


def test_key(provider_id: str, api_key: str) -> dict[str, Any]:
    """Authenticated GET of the model list — nothing is generated or billed."""
    import httpx

    prov = provider(provider_id)
    key = api_key.strip()
    if not key:
        raise AppError(ErrorCode.CLOUD_AUTH, "No API key")
    headers = (
        {"x-api-key": key, "anthropic-version": "2023-06-01"}
        if prov.id == "anthropic"
        else {"Authorization": f"Bearer {key}"}
    )
    try:
        resp = httpx.get(prov.check_url, headers=headers, timeout=20)
    except httpx.HTTPError as exc:
        raise AppError(ErrorCode.CLOUD_NETWORK, f"{exc.__class__.__name__}: {exc}"[:300]) from exc
    if resp.status_code == 200:
        return {"ok": True, "provider": prov.name}
    raise _error_from_response(resp.status_code, resp.text)


# ------------------------------------------------------------ background tasks
@dataclass
class SummaryTask:
    id: str
    status: str = "running"  # running | completed | error | cancelled
    step: int = 0
    steps: int = 1
    result: dict[str, Any] | None = None
    error: dict[str, str] | None = None
    cancel: threading.Event = field(default_factory=threading.Event)

    def snapshot(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "status": self.status,
            "step": self.step,
            "steps": self.steps,
            "result": self.result,
            "error": self.error,
        }


class SummaryManager:
    """Runs summaries in the background so the UI can poll progress and cancel."""

    def __init__(self, on_done: Callable[[str | None, dict[str, Any]], None] | None = None) -> None:
        self._tasks: dict[str, SummaryTask] = {}
        self._lock = threading.Lock()
        self._on_done = on_done

    def start(self, req: SummaryRequest, archive_id: str | None = None) -> SummaryTask:
        provider(req.provider)  # validate early
        task = SummaryTask(id=uuid.uuid4().hex)
        with self._lock:
            self._tasks = {k: v for k, v in self._tasks.items() if v.status == "running"}
            self._tasks[task.id] = task
        threading.Thread(target=self._run, args=(task, req, archive_id), daemon=True, name="summary").start()
        return task

    def get(self, task_id: str) -> SummaryTask:
        task = self._tasks.get(task_id)
        if task is None:
            raise AppError(ErrorCode.INVALID_REQUEST, "Unknown summary task")
        return task

    def cancel(self, task_id: str) -> None:
        self.get(task_id).cancel.set()

    def _run(self, task: SummaryTask, req: SummaryRequest, archive_id: str | None) -> None:
        def progress(step: int, steps: int) -> None:
            task.step, task.steps = step, steps

        try:
            result = summarize(req, task.cancel, progress)
            if self._on_done and archive_id:
                try:
                    self._on_done(archive_id, result)
                except Exception:  # noqa: BLE001 - the UI still gets the result
                    log.exception("Saving the summary to the archive failed")
            task.result = result
            task.status = "completed"
        except BaseException as exc:  # noqa: BLE001
            from .errors import classify_exception

            err = exc if isinstance(exc, AppError) else classify_exception(exc)
            if not isinstance(exc, AppError):
                log.exception("Summary failed")
                err = AppError(ErrorCode.SUMMARY_FAILED, err.detail)
            task.status = "cancelled" if err.code == ErrorCode.CANCELLED else "error"
            task.error = err.to_dict()
        finally:
            req.api_key = ""
