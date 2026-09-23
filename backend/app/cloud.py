"""Paid cloud transcription providers (Cohere, OpenAI, Groq).

The user brings their own API key; billing is entirely between the user and
the provider. The key is stored encrypted by the desktop shell (Windows DPAPI)
and is only passed to this process for the duration of a job.

How audio is sent
-----------------
Cloud APIs cap uploads (25 MB) and Cohere returns no timestamps. So instead of
uploading one big file, the 16 kHz PCM that FFmpeg already produced is cut
into short **speech chunks** with the Silero VAD (silence is never uploaded or
billed), each chunk is encoded as a small WAV and sent in parallel. Every
chunk's start/end in the original audio become the segment timestamps, so the
transcript, PDF and database export keep working exactly as with Whisper.
"""

from __future__ import annotations

import io
import logging
import random
import threading
import time
import wave
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from dataclasses import asdict, dataclass
from typing import Any, Callable

import numpy as np

from .errors import AppError, Cancelled, ErrorCode
from .media import SAMPLE_RATE, PcmAudio
from .transcriber import TranscriptSegment, _is_hallucination, clean_text

log = logging.getLogger(__name__)

CHUNK_TARGET_S = 20.0  # merge speech regions up to ~20 s (readable timestamps)
CHUNK_MAX_S = 28.0  # hard cap per upload (≈0.9 MB WAV — far below every limit)
# Models that return their own segment timestamps (verbose_json) get long
# chunks instead: ~50× fewer requests, which matters with per-minute limits
# (Groq's free plan allows 20 requests a minute). 10 min of 16 kHz mono WAV
# is 19.2 MB — under the 25 MB upload limit.
LONG_CHUNK_TARGET_S = 540.0
LONG_CHUNK_MAX_S = 600.0
PARALLEL_REQUESTS = 4
MAX_RETRIES = 5
REQUEST_TIMEOUT = 120.0


@dataclass(frozen=True)
class CloudModel:
    id: str
    label: str
    languages: tuple[str, ...] | None = None  # None → any language
    segments: bool = False  # returns per-segment timestamps (verbose_json)


@dataclass(frozen=True)
class CloudProvider:
    id: str
    name: str
    url: str
    models: tuple[CloudModel, ...]
    requires_language: bool
    languages: tuple[str, ...] | None  # None → all Whisper languages
    key_url: str  # where the user creates an API key
    check_url: str  # cheap authenticated GET used by "Test key"

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d.pop("check_url")
        return d


_COHERE_LANGS = ("ar", "en", "de", "fr", "it", "es", "pt", "el", "nl", "pl", "vi", "zh", "ja", "ko")

PROVIDERS: dict[str, CloudProvider] = {
    p.id: p
    for p in (
        CloudProvider(
            id="cohere",
            name="Cohere Transcribe",
            url="https://api.cohere.com/v2/audio/transcriptions",
            models=(
                CloudModel("cohere-transcribe-arabic-07-2026", "Cohere Transcribe — Arabic", ("ar",)),
                CloudModel("cohere-transcribe-03-2026", "Cohere Transcribe (14 languages)", _COHERE_LANGS),
            ),
            requires_language=True,  # Cohere has no automatic language detection
            languages=_COHERE_LANGS,
            key_url="https://dashboard.cohere.com/api-keys",
            check_url="https://api.cohere.com/v1/models?page_size=1",
        ),
        CloudProvider(
            id="openai",
            name="OpenAI",
            url="https://api.openai.com/v1/audio/transcriptions",
            models=(
                CloudModel("gpt-4o-transcribe", "gpt-4o-transcribe"),
                CloudModel("gpt-4o-mini-transcribe", "gpt-4o-mini-transcribe"),
                CloudModel("whisper-1", "whisper-1", segments=True),
            ),
            requires_language=False,
            languages=None,
            key_url="https://platform.openai.com/api-keys",
            check_url="https://api.openai.com/v1/models",
        ),
        CloudProvider(
            id="groq",
            name="Groq",
            url="https://api.groq.com/openai/v1/audio/transcriptions",
            models=(
                CloudModel("whisper-large-v3-turbo", "whisper-large-v3-turbo — fastest", segments=True),
                CloudModel("whisper-large-v3", "whisper-large-v3", segments=True),
            ),
            requires_language=False,
            languages=None,
            key_url="https://console.groq.com/keys",
            check_url="https://api.groq.com/openai/v1/models",
        ),
    )
}


def provider(provider_id: str) -> CloudProvider:
    p = PROVIDERS.get(provider_id)
    if p is None:
        raise AppError(ErrorCode.INVALID_REQUEST, f"Unknown provider '{provider_id}'")
    return p


def list_providers() -> list[dict[str, Any]]:
    return [p.to_dict() for p in PROVIDERS.values()]


# --------------------------------------------------------------------- chunking
@dataclass
class Chunk:
    index: int
    start: int  # sample index
    end: int


def plan_chunks(
    audio: PcmAudio,
    cancel: threading.Event | None = None,
    target_s: float = CHUNK_TARGET_S,
    max_s: float = CHUNK_MAX_S,
    max_gap_s: float = 2.0,
) -> list[Chunk]:
    """Speech-only chunks of ≤ ``max_s`` seconds, cut at pauses.

    VAD runs over 10-minute windows so memory stays flat for long recordings.
    """
    from faster_whisper.vad import VadOptions, get_speech_timestamps

    options = VadOptions(
        min_silence_duration_ms=400,
        speech_pad_ms=200,
        max_speech_duration_s=CHUNK_MAX_S - 1,
    )
    total = audio.num_samples
    window = 10 * 60 * SAMPLE_RATE
    regions: list[tuple[int, int]] = []
    pos = 0
    while pos < total:
        if cancel is not None and cancel.is_set():
            raise Cancelled()
        end = min(total, pos + window)
        if end < total:
            end = max(pos + SAMPLE_RATE, audio.quietest_point(end))
        samples = audio.window(pos, end)
        for r in get_speech_timestamps(samples, options):
            regions.append((pos + int(r["start"]), pos + int(r["end"])))
        pos = end

    # Merge neighbouring regions into chunks of ~CHUNK_TARGET_S.
    chunks: list[Chunk] = []
    target = int(target_s * SAMPLE_RATE)
    hard = int(max_s * SAMPLE_RATE)
    cur_start: int | None = None
    cur_end = 0
    for start, end in regions:
        if cur_start is None:
            cur_start, cur_end = start, end
            continue
        gap = start - cur_end
        if (end - cur_start) <= target and gap < max_gap_s * SAMPLE_RATE:
            cur_end = end
        else:
            chunks.append(Chunk(len(chunks), cur_start, min(cur_end, cur_start + hard)))
            cur_start, cur_end = start, end
    if cur_start is not None:
        chunks.append(Chunk(len(chunks), cur_start, min(cur_end, cur_start + hard)))
    return chunks


def encode_wav(audio: PcmAudio, chunk: Chunk) -> bytes:
    pcm = np.asarray(audio._data[chunk.start : chunk.end], dtype=np.int16)  # noqa: SLF001
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


# ------------------------------------------------------------------- requests
def _error_from_response(status: int, body: str) -> AppError:
    detail = f"HTTP {status}: {' '.join(body.split())[:400]}"
    lowered = body.lower()
    if status in (401, 403):
        return AppError(ErrorCode.CLOUD_AUTH, detail)
    if status == 402 or "insufficient_quota" in lowered or "billing" in lowered or "quota" in lowered:
        return AppError(ErrorCode.CLOUD_QUOTA, detail)
    if status == 429:
        return AppError(ErrorCode.CLOUD_RATE_LIMIT, detail)
    if status == 413:
        return AppError(ErrorCode.CLOUD_FAILED, detail + " (file too large)")
    return AppError(ErrorCode.CLOUD_FAILED, detail)


def _post_chunk(
    client,  # noqa: ANN001 - httpx.Client
    prov: CloudProvider,
    model: str,
    api_key: str,
    language: str | None,
    wav: bytes,
    cancel: threading.Event,
    verbose: bool = False,
    vocabulary: str = "",
) -> str | list[tuple[float, float, str]]:
    """Upload one chunk. Returns its text, or (start, end, text) segments when ``verbose``."""
    import httpx

    data = {"model": model}
    if language:
        data["language"] = language
    if prov.id != "cohere":
        data["response_format"] = "verbose_json" if verbose else "json"
        if vocabulary:
            data["prompt"] = vocabulary  # OpenAI / Groq: spelling hints for names and terms
    delay = 1.5
    for attempt in range(MAX_RETRIES + 1):
        if cancel.is_set():
            raise Cancelled()
        try:
            resp = client.post(
                prov.url,
                headers={"Authorization": f"Bearer {api_key}"},
                data=data,
                files={"file": ("chunk.wav", wav, "audio/wav")},
                timeout=REQUEST_TIMEOUT,
            )
        except httpx.HTTPError as exc:
            if attempt < MAX_RETRIES:
                time.sleep(delay + random.random())
                delay *= 2
                continue
            raise AppError(ErrorCode.CLOUD_NETWORK, f"{exc.__class__.__name__}: {exc}"[:300]) from exc

        if resp.status_code == 200:
            try:
                payload = resp.json()
            except ValueError:
                return resp.text.strip()
            if verbose and isinstance(payload.get("segments"), list):
                return [
                    (float(sg.get("start") or 0), float(sg.get("end") or 0), str(sg.get("text") or "").strip())
                    for sg in payload["segments"]
                    if str(sg.get("text") or "").strip()
                ]
            return str(payload.get("text") or "").strip()

        retryable = resp.status_code == 429 or resp.status_code >= 500
        err = _error_from_response(resp.status_code, resp.text)
        if retryable and err.code != ErrorCode.CLOUD_QUOTA and attempt < MAX_RETRIES:
            retry_after = resp.headers.get("retry-after")
            wait_s = float(retry_after) if retry_after and retry_after.replace(".", "").isdigit() else delay
            time.sleep(min(wait_s, 30) + random.random())
            delay *= 2
            continue
        raise err
    raise AppError(ErrorCode.CLOUD_FAILED, "Too many retries")


def validate_request(provider_id: str, model: str, language: str | None, api_key: str) -> CloudProvider:
    prov = provider(provider_id)
    if not api_key.strip():
        raise AppError(ErrorCode.CLOUD_AUTH, "No API key")
    m = next((x for x in prov.models if x.id == model), None)
    if m is None:
        raise AppError(ErrorCode.INVALID_REQUEST, f"Unknown model '{model}' for {prov.name}")
    if prov.requires_language and not language:
        raise AppError(ErrorCode.CLOUD_LANGUAGE_REQUIRED, f"{prov.name} needs the spoken language to be selected")
    allowed = m.languages or prov.languages
    if language and allowed and language not in allowed:
        raise AppError(ErrorCode.CLOUD_LANGUAGE_UNSUPPORTED, f"{m.label} supports: {', '.join(allowed)}")
    return prov


def transcribe(
    audio: PcmAudio,
    *,
    provider_id: str,
    model: str,
    api_key: str,
    language: str | None,
    cancel: threading.Event,
    on_segment: Callable[[TranscriptSegment, float], None],
    on_planned: Callable[[int], None] | None = None,
    vocabulary: str = "",
) -> list[TranscriptSegment]:
    """Upload speech chunks in parallel; emit segments in order as they complete."""
    import httpx

    prov = validate_request(provider_id, model, language, api_key)
    verbose = next((m.segments for m in prov.models if m.id == model), False)
    if verbose:
        chunks = plan_chunks(audio, cancel, LONG_CHUNK_TARGET_S, LONG_CHUNK_MAX_S, max_gap_s=8.0)
    else:
        chunks = plan_chunks(audio, cancel)
    if not chunks:
        raise AppError(ErrorCode.NO_SPEECH, "No speech was detected in the audio")
    if on_planned:
        on_planned(len(chunks))

    results: dict[int, str | list[tuple[float, float, str]]] = {}
    segments: list[TranscriptSegment] = []
    next_to_emit = 0
    recent: list[str] = []

    def emit_ready() -> None:
        nonlocal next_to_emit, recent
        while next_to_emit in results:
            chunk = chunks[next_to_emit]
            result = results.pop(next_to_emit)
            next_to_emit += 1
            offset = chunk.start / SAMPLE_RATE
            chunk_end = chunk.end / SAMPLE_RATE
            # Whole-chunk text → one segment; verbose results → their own timed segments.
            parts = [(0.0, chunk_end - offset, result)] if isinstance(result, str) else result
            for start, end, raw in parts:
                text = clean_text(raw)
                if not text or _is_hallucination(text, 0.0, 0.0):
                    continue
                if len(recent) >= 2 and recent[-1] == text and recent[-2] == text:
                    continue
                recent = (recent + [text])[-2:]
                seg = TranscriptSegment(
                    id=len(segments),
                    start=round(offset + max(0.0, start), 2),
                    end=round(min(chunk_end, offset + max(start, end)), 2),
                    text=text,
                )
                segments.append(seg)
                on_segment(seg, next_to_emit / len(chunks))

    limits = httpx.Limits(max_connections=PARALLEL_REQUESTS, max_keepalive_connections=PARALLEL_REQUESTS)
    client = httpx.Client(limits=limits)
    pool = ThreadPoolExecutor(PARALLEL_REQUESTS, thread_name_prefix="cloud")
    pending: dict[Future[str], int] = {}
    queue = list(chunks)
    failed = False
    try:
        while queue or pending:
            if cancel.is_set():
                raise Cancelled()
            while queue and len(pending) < PARALLEL_REQUESTS:
                chunk = queue.pop(0)
                wav = encode_wav(audio, chunk)
                fut = pool.submit(_post_chunk, client, prov, model, api_key, language, wav, cancel, verbose, vocabulary)
                pending[fut] = chunk.index
            done, _ = wait(list(pending), timeout=0.5, return_when=FIRST_COMPLETED)
            for fut in done:
                idx = pending.pop(fut)
                results[idx] = fut.result()  # re-raises AppError / Cancelled
            emit_ready()
    except BaseException:
        failed = True
        raise
    finally:
        # On cancel/error don't wait for in-flight uploads: drop queued work and
        # return immediately (running requests end on their own).
        pool.shutdown(wait=not failed, cancel_futures=True)
        if not failed:
            client.close()
    emit_ready()
    if not segments:
        raise AppError(ErrorCode.NO_SPEECH, "The provider returned no text")
    return segments


def test_key(provider_id: str, api_key: str) -> dict[str, Any]:
    """Cheap authenticated request (lists models) — nothing is transcribed or billed."""
    import httpx

    prov = provider(provider_id)
    if not api_key.strip():
        raise AppError(ErrorCode.CLOUD_AUTH, "No API key")
    try:
        resp = httpx.get(prov.check_url, headers={"Authorization": f"Bearer {api_key.strip()}"}, timeout=20)
    except httpx.HTTPError as exc:
        raise AppError(ErrorCode.CLOUD_NETWORK, f"{exc.__class__.__name__}: {exc}"[:300]) from exc
    if resp.status_code == 200:
        return {"ok": True, "provider": prov.name}
    raise _error_from_response(resp.status_code, resp.text)
