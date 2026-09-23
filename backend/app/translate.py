"""Translate a transcript segment by segment (Arabic ⇄ English).

Every segment keeps its start/end time, so a translation can be exported as
subtitles (SRT/VTT), shown side by side with the original and printed in a
bilingual PDF.

Engines
-------
* ``local``  — free and offline. Helsinki-NLP Opus-MT Arabic→English (a
  CTranslate2 conversion, ~150 MB) downloaded once into the models folder and
  run on the CPU with the same CTranslate2 runtime Whisper uses.
* ``llm``    — the user's own key for Anthropic / OpenAI / Cohere / Groq (the
  same providers as AI summaries). Best quality: understands context, keeps
  technical terms and silently fixes speech-recognition mistakes.
* ``deepl``  — DeepL API (the free plan has a monthly character allowance).
* ``azure``  — Azure AI Translator (the F0 plan has a monthly free allowance).

Only text is ever sent to online engines, never audio.
"""

from __future__ import annotations

import json
import logging
import random
import re
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from typing import Any, Callable

from .errors import AppError, Cancelled, ErrorCode

log = logging.getLogger(__name__)

MAX_RETRIES = 4
TIMEOUT = 120.0


# ------------------------------------------------------------------ catalog
@dataclass(frozen=True)
class LocalTranslationModel:
    key: str
    repo: str
    source: str
    target: str
    size_mb: int
    patterns: tuple[str, ...] = ("config.json", "model.bin", "shared_vocabulary.json", "source.spm", "target.spm")


LOCAL_MODELS: dict[tuple[str, str], LocalTranslationModel] = {
    ("ar", "en"): LocalTranslationModel("opus-mt-ar-en", "gaudi/opus-mt-ar-en-ctranslate2", "ar", "en", 158),
}

ENGINES = ("local", "llm", "deepl", "azure")

ENGINE_INFO = {
    "deepl": {"name": "DeepL", "key_url": "https://www.deepl.com/your-account/keys"},
    "azure": {"name": "Azure AI Translator", "key_url": "https://portal.azure.com/#create/Microsoft.CognitiveServicesTextTranslation"},
}

_LANG_NAMES = {"ar": "Arabic", "en": "English"}


def catalog(store) -> dict[str, Any]:  # noqa: ANN001 - ModelStore
    from .summarize import list_providers

    local = []
    for m in LOCAL_MODELS.values():
        state = store.extra_state(m.key)
        local.append(
            {
                "key": m.key,
                "source": m.source,
                "target": m.target,
                "size_mb": m.size_mb,
                "downloaded": store.extra_downloaded(m.key),
                "download": state.to_dict(),
            }
        )
    return {"local": local, "llm": list_providers(), "services": ENGINE_INFO}


# ----------------------------------------------------------------- requests
@dataclass
class TranslateRequest:
    segments: list[dict[str, Any]]
    engine: str
    target: str = "en"
    source: str | None = None  # language of the transcript (None → unknown)
    provider: str = ""  # llm: anthropic | openai | cohere | groq
    model: str = ""  # llm model id
    api_key: str = field(default="", repr=False)
    region: str = ""  # azure resource region (optional for global resources)
    title: str = ""


ProgressFn = Callable[[str, int, int], None]  # (stage, done, total)


def _texts(segments: list[dict[str, Any]]) -> list[str]:
    return [" ".join(str(s.get("text", "")).split()) for s in segments]


def translate(req: TranslateRequest, store, cancel: threading.Event, on_progress: ProgressFn | None = None) -> dict[str, Any]:  # noqa: ANN001
    if req.engine not in ENGINES:
        raise AppError(ErrorCode.INVALID_REQUEST, f"Unknown translation engine '{req.engine}'")
    if req.target not in _LANG_NAMES:
        raise AppError(ErrorCode.INVALID_REQUEST, f"Unsupported target language '{req.target}'")
    source = (req.source or "").split("-")[0].lower() or None
    if source == req.target:
        raise AppError(ErrorCode.TRANSLATE_SAME_LANGUAGE, f"The transcript is already in {_LANG_NAMES[req.target]}")
    segments = [s for s in req.segments if str(s.get("text", "")).strip()]
    if not segments:
        raise AppError(ErrorCode.INVALID_REQUEST, "Transcript is empty")
    texts = _texts(segments)
    progress = on_progress or (lambda *_: None)

    if req.engine == "local":
        out = _translate_local(texts, source, req.target, store, cancel, progress)
        meta = {"provider": "local", "provider_name": "Opus-MT", "model": LOCAL_MODELS[(source or "ar", req.target)].key}
    elif req.engine == "llm":
        out = _translate_llm(texts, source, req, cancel, progress)
        from .summarize import provider as llm_provider

        meta = {"provider": req.provider, "provider_name": llm_provider(req.provider).name, "model": req.model}
    elif req.engine == "deepl":
        out = _translate_deepl(texts, source, req.target, req.api_key, cancel, progress)
        meta = {"provider": "deepl", "provider_name": "DeepL", "model": ""}
    else:
        out = _translate_azure(texts, source, req.target, req.api_key, req.region, cancel, progress)
        meta = {"provider": "azure", "provider_name": "Azure AI Translator", "model": ""}

    return {
        "language": req.target,
        "source_language": source,
        "engine": req.engine,
        **meta,
        "created_at": time.time(),
        "segments": [
            {"start": float(s.get("start", 0)), "end": float(s.get("end", 0)), "text": t.strip()}
            for s, t in zip(segments, out)
        ],
    }


# -------------------------------------------------------- local (Opus-MT)
_local_lock = threading.Lock()
_local_cache: dict[str, Any] = {}


def _load_local(model: LocalTranslationModel, store):  # noqa: ANN001, ANN202
    import ctranslate2
    import sentencepiece as spm

    with _local_lock:
        cached = _local_cache.get(model.key)
        if cached:
            return cached
        path = store.extra_path(model.key)
        try:
            import os

            translator = ctranslate2.Translator(
                str(path), device="cpu", compute_type="int8", intra_threads=max(1, (os.cpu_count() or 4) // 2)
            )
            sp_src = spm.SentencePieceProcessor(model_file=str(path / "source.spm"))
            sp_tgt = spm.SentencePieceProcessor(model_file=str(path / "target.spm"))
        except Exception as exc:  # noqa: BLE001
            raise AppError(ErrorCode.MODEL_LOAD_FAILED, f"{exc.__class__.__name__}: {exc}"[:300]) from exc
        _local_cache.clear()  # keep only one translator in memory
        _local_cache[model.key] = (translator, sp_src, sp_tgt)
        return _local_cache[model.key]


_SENTENCE_END = re.compile(r"(?<=[.!?؟؛،,;:])\s+")


def _split_long(text: str, sp_src, limit: int = 180) -> list[str]:  # noqa: ANN001
    """Opus-MT works best on sentences; split very long segments at punctuation or words."""
    if len(sp_src.encode(text)) <= limit:
        return [text]
    parts: list[str] = []
    cur = ""
    pieces = _SENTENCE_END.split(text)
    if len(pieces) == 1:
        words = text.split()
        pieces = [" ".join(words[i : i + 40]) for i in range(0, len(words), 40)]
    for piece in pieces:
        candidate = f"{cur} {piece}".strip()
        if cur and len(sp_src.encode(candidate)) > limit:
            parts.append(cur)
            cur = piece
        else:
            cur = candidate
    if cur:
        parts.append(cur)
    return parts


def _translate_local(
    texts: list[str], source: str | None, target: str, store, cancel: threading.Event, progress: ProgressFn  # noqa: ANN001
) -> list[str]:
    model = LOCAL_MODELS.get((source or "ar", target))
    if model is None:
        raise AppError(
            ErrorCode.TRANSLATE_UNSUPPORTED,
            f"Offline translation supports Arabic → English only ({source or '?'} → {target})",
        )
    if not store.extra_downloaded(model.key):
        state = store.start_extra_download(model.key, model.repo, list(model.patterns), model.size_mb)
        while state.status == "downloading":
            if cancel.is_set():
                raise Cancelled()
            progress("downloading", state.downloaded_bytes, state.total_bytes)
            time.sleep(0.4)
        if state.status == "error":
            err = state.error or {}
            raise AppError(ErrorCode.MODEL_DOWNLOAD_FAILED, err.get("detail", ""))
    progress("loading", 0, len(texts))
    translator, sp_src, sp_tgt = _load_local(model, store)

    # Flatten long segments into sentence-sized pieces, translate in batches, re-join.
    pieces: list[tuple[int, str]] = []
    for i, text in enumerate(texts):
        for part in _split_long(text, sp_src):
            pieces.append((i, part))
    results: list[list[str]] = [[] for _ in texts]
    batch = 16
    done_segments: set[int] = set()
    for start in range(0, len(pieces), batch):
        if cancel.is_set():
            raise Cancelled()
        chunk = pieces[start : start + batch]
        tokens = [sp_src.encode(text, out_type=str) + ["</s>"] for _, text in chunk]
        out = translator.translate_batch(
            tokens, beam_size=4, max_decoding_length=256, repetition_penalty=1.1, no_repeat_ngram_size=4
        )
        for (i, _), res in zip(chunk, out):
            hyp = [t for t in res.hypotheses[0] if t not in ("</s>", "<pad>")]
            results[i].append(sp_tgt.decode(hyp))
            done_segments.add(i)
        progress("translating", len(done_segments), len(texts))
    return [" ".join(r).strip() for r in results]


# ------------------------------------------------------------- LLM (your key)
_LLM_SYSTEM = (
    "You are a professional translator of lectures and courses. You translate transcript segments "
    "from {src} to {tgt}. The transcript comes from automatic speech recognition, so it may contain "
    "misheard words: translate the intended meaning. Keep technical terms, code, product and people's "
    "names in their usual {tgt} form (e.g. SQL Server, CREATE INDEX). Each input item is one subtitle "
    "segment: translate every item separately, never merge, split, skip or reorder items, and keep "
    "each translation about as short as the original. Reply with a single JSON object only."
)


def _llm_batches(texts: list[str], max_chars: int = 4500, max_items: int = 60) -> list[list[int]]:
    batches: list[list[int]] = [[]]
    size = 0
    for i, t in enumerate(texts):
        if batches[-1] and (size + len(t) > max_chars or len(batches[-1]) >= max_items):
            batches.append([])
            size = 0
        batches[-1].append(i)
        size += len(t) + 12
    return [b for b in batches if b]


def _llm_call(req: TranslateRequest, texts: list[str], idx: list[int], src: str, tgt: str, cancel: threading.Event) -> dict[int, str]:
    from .summarize import chat, parse_json, provider

    prov = provider(req.provider)
    context = ""
    if idx[0] > 0:
        prev = [texts[j] for j in range(max(0, idx[0] - 3), idx[0])]
        context = "Previous lines, for context only (do not translate them):\n" + "\n".join(prev) + "\n\n"
    items = [{"i": i, "text": texts[i]} for i in idx]
    user = (
        (f"Recording: {req.title}\n" if req.title else "")
        + context
        + f"Translate these {len(items)} segments to {tgt}. Return JSON exactly like "
        + '{"translations": [{"i": <same i>, "text": "<translation>"}, ...]} with one entry per input item.\n\n'
        + json.dumps(items, ensure_ascii=False)
    )
    raw = parse_json(chat(prov, req.model, req.api_key, _LLM_SYSTEM.format(src=src, tgt=tgt), user, cancel))
    out: dict[int, str] = {}
    entries = raw.get("translations")
    if isinstance(entries, list):
        for pos, entry in enumerate(entries):
            if isinstance(entry, dict) and "text" in entry:
                try:
                    i = int(entry.get("i", idx[pos] if pos < len(idx) else -1))
                except (TypeError, ValueError):
                    continue
                if i in idx:
                    out[i] = " ".join(str(entry["text"]).split())
            elif isinstance(entry, str) and pos < len(idx) and len(entries) == len(idx):
                out[idx[pos]] = " ".join(entry.split())
    return out


def _translate_llm(texts: list[str], source: str | None, req: TranslateRequest, cancel: threading.Event, progress: ProgressFn) -> list[str]:
    from .summarize import provider

    provider(req.provider)
    if not req.model.strip():
        raise AppError(ErrorCode.INVALID_REQUEST, "No model selected")
    if not req.api_key.strip():
        raise AppError(ErrorCode.CLOUD_AUTH, "No API key")
    src = _LANG_NAMES.get(source or "", "the source language")
    tgt = _LANG_NAMES[req.target]
    results: dict[int, str] = {}
    lock = threading.Lock()
    workers = 2 if req.provider == "groq" else 3  # Groq's free tier has low token limits

    def run(idx: list[int]) -> None:
        got = _llm_call(req, texts, idx, src, tgt, cancel)
        # Items the model skipped: retry them in smaller groups (twice), one by one last.
        for size in (max(1, len(idx) // 4), 1):
            missing = [i for i in idx if not got.get(i)]
            if not missing:
                break
            for k in range(0, len(missing), size):
                got.update(_llm_call(req, texts, missing[k : k + size], src, tgt, cancel))
        with lock:
            results.update({i: got.get(i, "") for i in idx})
            progress("translating", len(results), len(texts))

    progress("translating", 0, len(texts))
    # Workers use their own stop flag: the first real error stops the others
    # without being reported as a user cancel.
    stop = threading.Event()
    watcher_done = threading.Event()

    def watch() -> None:
        while not watcher_done.wait(0.2):
            if cancel.is_set():
                stop.set()
                return

    threading.Thread(target=watch, daemon=True).start()
    real_cancel = cancel
    cancel = stop  # noqa: PLW2901 - the workers below read this name
    try:
        with ThreadPoolExecutor(workers, thread_name_prefix="translate") as pool:
            futures = [pool.submit(run, b) for b in _llm_batches(texts)]
            for f in as_completed(futures):
                exc = f.exception()
                if exc is not None:
                    stop.set()
                    for other in futures:
                        other.cancel()
                    if real_cancel.is_set():
                        raise Cancelled()
                    raise exc
    finally:
        watcher_done.set()
    missing = sum(1 for i in range(len(texts)) if not results.get(i))
    if missing > max(2, len(texts) // 20):
        raise AppError(ErrorCode.TRANSLATE_FAILED, f"The model skipped {missing} of {len(texts)} segments")
    return [results.get(i, "") for i in range(len(texts))]


# -------------------------------------------------------------- DeepL / Azure
def _http_error(status: int, body: str, service: str) -> AppError:
    detail = f"{service} HTTP {status}: {' '.join(body.split())[:300]}"
    low = body.lower()
    if status in (401, 403) and "quota" not in low and "exceeded" not in low:
        return AppError(ErrorCode.CLOUD_AUTH, detail)
    if status == 456 or "quota" in low or "exceeded" in low:
        return AppError(ErrorCode.CLOUD_QUOTA, detail)
    if status == 429:
        return AppError(ErrorCode.CLOUD_RATE_LIMIT, detail)
    return AppError(ErrorCode.TRANSLATE_FAILED, detail)


def _post(url: str, headers: dict[str, str], body: Any, service: str, cancel: threading.Event) -> Any:
    import httpx

    delay = 1.5
    for attempt in range(MAX_RETRIES + 1):
        if cancel.is_set():
            raise Cancelled()
        try:
            resp = httpx.post(url, headers=headers, json=body, timeout=TIMEOUT)
        except httpx.HTTPError as exc:
            if attempt < MAX_RETRIES:
                if cancel.wait(delay + random.random()):
                    raise Cancelled() from exc
                delay *= 2
                continue
            raise AppError(ErrorCode.CLOUD_NETWORK, f"{exc.__class__.__name__}: {exc}"[:300]) from exc
        if resp.status_code == 200:
            return resp.json()
        err = _http_error(resp.status_code, resp.text, service)
        if (resp.status_code == 429 or resp.status_code >= 500) and err.code != ErrorCode.CLOUD_QUOTA and attempt < MAX_RETRIES:
            ra = resp.headers.get("retry-after", "")
            if cancel.wait(min(float(ra) if ra.replace(".", "").isdigit() else delay, 60) + random.random()):
                raise Cancelled()
            delay *= 2
            continue
        raise err
    raise AppError(ErrorCode.TRANSLATE_FAILED, "Too many retries")


def _deepl_base(key: str) -> str:
    return "https://api-free.deepl.com" if key.strip().endswith(":fx") else "https://api.deepl.com"


def _translate_deepl(
    texts: list[str], source: str | None, target: str, key: str, cancel: threading.Event, progress: ProgressFn
) -> list[str]:
    if not key.strip():
        raise AppError(ErrorCode.CLOUD_AUTH, "No API key")
    url = _deepl_base(key) + "/v2/translate"
    headers = {"Authorization": f"DeepL-Auth-Key {key.strip()}"}
    out: list[str] = []
    progress("translating", 0, len(texts))
    for batch in _chunks(texts, 50, 60_000):
        body: dict[str, Any] = {"text": batch, "target_lang": "EN-US" if target == "en" else target.upper()}
        if source:
            body["source_lang"] = source.upper()
        data = _post(url, headers, body, "DeepL", cancel)
        got = [str(t.get("text", "")) for t in data.get("translations", [])]
        if len(got) != len(batch):
            raise AppError(ErrorCode.TRANSLATE_FAILED, "DeepL returned a different number of lines")
        out.extend(got)
        progress("translating", len(out), len(texts))
    return out


def _translate_azure(
    texts: list[str], source: str | None, target: str, key: str, region: str, cancel: threading.Event, progress: ProgressFn
) -> list[str]:
    if not key.strip():
        raise AppError(ErrorCode.CLOUD_AUTH, "No API key")
    url = "https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to=" + target
    if source:
        url += "&from=" + source
    headers = {"Ocp-Apim-Subscription-Key": key.strip()}
    if region.strip():
        headers["Ocp-Apim-Subscription-Region"] = region.strip()
    out: list[str] = []
    progress("translating", 0, len(texts))
    for batch in _chunks(texts, 100, 40_000):
        data = _post(url, headers, [{"Text": t} for t in batch], "Azure", cancel)
        got = [str(((item.get("translations") or [{}])[0]).get("text", "")) for item in data]
        if len(got) != len(batch):
            raise AppError(ErrorCode.TRANSLATE_FAILED, "Azure returned a different number of lines")
        out.extend(got)
        progress("translating", len(out), len(texts))
    return out


def _chunks(texts: list[str], max_items: int, max_chars: int) -> list[list[str]]:
    batches: list[list[str]] = [[]]
    size = 0
    for t in texts:
        if batches[-1] and (len(batches[-1]) >= max_items or size + len(t) > max_chars):
            batches.append([])
            size = 0
        batches[-1].append(t)
        size += len(t)
    return [b for b in batches if b]


# -------------------------------------------------------------- key checks
def test_key(engine: str, key: str, region: str = "", provider: str = "") -> dict[str, Any]:
    """Validate a key. DeepL also reports this month's usage."""
    import httpx

    if engine == "llm":
        from .summarize import test_key as llm_test

        return llm_test(provider, key)
    if not key.strip():
        raise AppError(ErrorCode.CLOUD_AUTH, "No API key")
    try:
        if engine == "deepl":
            resp = httpx.get(
                _deepl_base(key) + "/v2/usage", headers={"Authorization": f"DeepL-Auth-Key {key.strip()}"}, timeout=20
            )
            if resp.status_code == 200:
                data = resp.json()
                return {"ok": True, "used": data.get("character_count"), "limit": data.get("character_limit")}
            raise _http_error(resp.status_code, resp.text, "DeepL")
        if engine == "azure":
            headers = {"Ocp-Apim-Subscription-Key": key.strip()}
            if region.strip():
                headers["Ocp-Apim-Subscription-Region"] = region.strip()
            resp = httpx.post(
                "https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to=en",
                headers=headers,
                json=[{"Text": "مرحبا"}],
                timeout=20,
            )
            if resp.status_code == 200:
                return {"ok": True}
            raise _http_error(resp.status_code, resp.text, "Azure")
    except httpx.HTTPError as exc:
        raise AppError(ErrorCode.CLOUD_NETWORK, f"{exc.__class__.__name__}: {exc}"[:300]) from exc
    raise AppError(ErrorCode.INVALID_REQUEST, f"Nothing to test for engine '{engine}'")


# ------------------------------------------------------------ background tasks
@dataclass
class TranslationTask:
    id: str
    status: str = "running"
    stage: str = "starting"  # downloading | loading | translating
    done: int = 0
    total: int = 0
    result: dict[str, Any] | None = None
    error: dict[str, str] | None = None
    cancel: threading.Event = field(default_factory=threading.Event)

    def snapshot(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "status": self.status,
            "stage": self.stage,
            "done": self.done,
            "total": self.total,
            "result": self.result,
            "error": self.error,
        }


class TranslationManager:
    def __init__(self, store, on_done: Callable[[str, dict[str, Any]], None] | None = None) -> None:  # noqa: ANN001
        self.store = store
        self._on_done = on_done
        self._tasks: dict[str, TranslationTask] = {}
        self._lock = threading.Lock()

    def start(self, req: TranslateRequest, archive_id: str | None = None) -> TranslationTask:
        if req.engine not in ENGINES:
            raise AppError(ErrorCode.INVALID_REQUEST, f"Unknown translation engine '{req.engine}'")
        task = TranslationTask(id=uuid.uuid4().hex, total=len(req.segments))
        with self._lock:
            self._tasks = {k: v for k, v in self._tasks.items() if v.status == "running"}
            self._tasks[task.id] = task
        threading.Thread(target=self._run, args=(task, req, archive_id), daemon=True, name="translate").start()
        return task

    def get(self, task_id: str) -> TranslationTask:
        task = self._tasks.get(task_id)
        if task is None:
            raise AppError(ErrorCode.INVALID_REQUEST, "Unknown translation task")
        return task

    def cancel(self, task_id: str) -> None:
        self.get(task_id).cancel.set()

    def _run(self, task: TranslationTask, req: TranslateRequest, archive_id: str | None) -> None:
        def progress(stage: str, done: int, total: int) -> None:
            task.stage, task.done, task.total = stage, done, total

        try:
            result = translate(req, self.store, task.cancel, progress)
            if self._on_done and archive_id:
                try:
                    self._on_done(archive_id, result)
                except Exception:  # noqa: BLE001
                    log.exception("Saving the translation to the archive failed")
            task.result = result
            task.status = "completed"
        except BaseException as exc:  # noqa: BLE001
            if isinstance(exc, AppError):
                err = exc
            else:
                log.exception("Translation failed")
                err = AppError(ErrorCode.TRANSLATE_FAILED, f"{exc.__class__.__name__}: {exc}"[:300])
            task.status = "cancelled" if err.code == ErrorCode.CANCELLED else "error"
            task.error = err.to_dict()
        finally:
            req.api_key = ""

