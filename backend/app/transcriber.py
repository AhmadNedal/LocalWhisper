"""faster-whisper / CTranslate2 transcription engine.

Speed strategy
--------------
* CTranslate2 runs Whisper with ``float16`` on NVIDIA GPUs and ``int8`` on
  CPUs (see ``system_info.resolve_device``).
* "Fast" and "Balanced" presets use faster-whisper's
  ``BatchedInferencePipeline``: Silero VAD cuts the audio at pauses, silence is
  skipped entirely and several speech chunks are decoded in one batch — the
  single biggest speed-up faster-whisper offers (often 3-4x on GPU).
* "Accurate" uses the classic sequential decoder that conditions on previous
  text, which gives the most coherent punctuation for long Arabic speech.
* Long recordings are processed in ~20 minute windows cut at a quiet moment,
  so RAM stays flat no matter how long the video is.
* The loaded model is cached between jobs; switching files does not reload it.
"""

from __future__ import annotations

import logging
import re
import threading
import time
import unicodedata
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Callable

import psutil

from .errors import AppError, Cancelled, ErrorCode
from .media import SAMPLE_RATE, PcmAudio
from .model_store import ModelSpec

log = logging.getLogger(__name__)

WINDOW_SECONDS = 20 * 60


@dataclass
class TranscriptSegment:
    id: int
    start: float
    end: float
    text: str

    def to_dict(self) -> dict[str, object]:
        return asdict(self)


@dataclass(frozen=True)
class Preset:
    batched: bool
    beam_size: int
    condition_on_previous_text: bool
    # Beam search dominates CPU time. Beam 2 keeps most of beam 5's accuracy
    # gain over greedy decoding at well under half the cost; GPUs keep beam 5.
    beam_size_cpu: int | None = None


PRESETS: dict[str, Preset] = {
    "fast": Preset(batched=True, beam_size=1, condition_on_previous_text=False),
    "balanced": Preset(batched=True, beam_size=5, condition_on_previous_text=False, beam_size_cpu=2),
    "accurate": Preset(batched=False, beam_size=5, condition_on_previous_text=True),
}

# Retrying a failed decode at every temperature (0.0 … 1.0, six passes) can
# multiply the time spent on noisy parts; three steps catch the same failures.
TEMPERATURES_FAST = (0.0, 0.4, 0.8)
TEMPERATURES_FULL = (0.0, 0.2, 0.4, 0.6, 0.8, 1.0)

# A short, well punctuated Arabic sentence nudges Whisper to emit Arabic
# punctuation (، ؟ .) instead of long unpunctuated runs.
ARABIC_PUNCTUATION_PROMPT = "مرحبًا بكم، هذا تسجيل باللغة العربية. سنبدأ الآن؟ نعم."

# Phrases Whisper is known to hallucinate on silence/music (mostly from
# subtitle credits in its training data).
_ALWAYS_DROP = ("نانسي قنقر", "ترجمة نانسي", "amara.org", "subtitles by the amara")
_DROP_IF_UNCERTAIN = (
    "اشتركوا في القناة",
    "اشترك في القناة",
    "شكرا للمشاهدة",
    "شكرا على المشاهدة",
    "لا تنسوا الاشتراك",
    "thanks for watching",
    "thank you for watching",
    "please subscribe",
)

_ARABIC_DIACRITICS = re.compile(r"[ً-ْٰـ]")  # tashkeel + tatweel
_SPACE_BEFORE_PUNCT = re.compile(r"\s+([،؛؟.,!?:;])")


def _normalize_for_matching(text: str) -> str:
    text = unicodedata.normalize("NFKC", text).lower()
    text = _ARABIC_DIACRITICS.sub("", text)
    text = re.sub(r"[إأآ]", "ا", text).replace("ى", "ي").replace("ة", "ه")
    text = re.sub(r"[^\w\s.]", " ", text)
    return " ".join(text.split())


def clean_text(text: str) -> str:
    """Tidy whitespace and Arabic punctuation spacing without altering words."""
    text = unicodedata.normalize("NFC", text).replace("​", "")
    text = " ".join(text.split())
    return _SPACE_BEFORE_PUNCT.sub(r"\1", text).strip()


def _is_hallucination(text: str, no_speech_prob: float, avg_logprob: float) -> bool:
    norm = _normalize_for_matching(text)
    if not norm:
        return True
    if any(_normalize_for_matching(p) in norm for p in _ALWAYS_DROP):
        return True
    if norm == _normalize_for_matching(ARABIC_PUNCTUATION_PROMPT):
        return True
    uncertain = no_speech_prob > 0.2 or avg_logprob < -0.7
    if uncertain and any(norm.strip(" .") == _normalize_for_matching(p) for p in _DROP_IF_UNCERTAIN):
        return True
    return False


class Engine:
    """Owns the (single) loaded Whisper model and runs transcriptions."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._model = None
        self._key: tuple[str, str, str] | None = None

    def loaded_key(self) -> tuple[str, str, str] | None:
        return self._key

    def load(self, spec: ModelSpec, model_path: Path, device: str, compute_type: str):  # noqa: ANN201
        key = (spec.id, device, compute_type)
        with self._lock:
            if self._model is not None and self._key == key:
                return self._model
            # Free the previous model before loading another (RAM/VRAM).
            self._model = None
            self._key = None

            if device == "cpu":
                # Only refuse when the model truly cannot fit. Windows moves idle
                # memory of other programs to the pagefile, so "available RAM"
                # alone is far too pessimistic (a plain WhisperModel("medium")
                # runs fine on an 8 GB laptop showing 0.5 GB free).
                needed = spec.ram_cpu_mb * 1024 * 1024
                capacity = psutil.virtual_memory().available + psutil.swap_memory().free
                if capacity < needed:
                    raise AppError(
                        ErrorCode.INSUFFICIENT_MEMORY,
                        f"Model '{spec.id}' needs about {spec.ram_cpu_mb / 1024:.1f} GB of memory; "
                        f"only {capacity / 1024**3:.1f} GB available including the page file",
                    )

            from faster_whisper import WhisperModel

            from .errors import classify_exception

            threads = psutil.cpu_count(logical=False) or psutil.cpu_count() or 4

            def create():  # noqa: ANN202
                return WhisperModel(
                    str(model_path),
                    device=device,
                    compute_type=compute_type,
                    cpu_threads=threads if device == "cpu" else 0,
                    num_workers=1,
                    local_files_only=True,  # never touch the network here
                )

            err: AppError | None = None
            for attempt in range(2):
                try:
                    self._model = create()
                    err = None
                    break
                except Exception as exc:  # noqa: BLE001
                    err = classify_exception(exc)
                    if err.code == ErrorCode.TRANSCRIPTION_FAILED:
                        err = AppError(ErrorCode.MODEL_LOAD_FAILED, err.detail)
                    # Out of memory: free what Python still holds (a previous model,
                    # decoded audio of an earlier job) and try once more.
                    if err.code != ErrorCode.INSUFFICIENT_MEMORY or attempt == 1:
                        raise err from exc
                    log.warning("Model load ran out of memory; retrying once after freeing memory: %s", err.detail)
                    import gc

                    gc.collect()
                    time.sleep(1.0)
            if err is not None:
                raise err
            self._key = key
            return self._model

    def unload(self) -> None:
        with self._lock:
            self._model = None
            self._key = None

    def transcribe(
        self,
        model,  # noqa: ANN001 - faster_whisper.WhisperModel
        audio: PcmAudio,
        *,
        device: str,
        language: str | None,
        preset_name: str,
        arabic_punctuation: bool,
        low_memory: bool = False,
        vocabulary: str = "",
        cancel: threading.Event,
        on_language: Callable[[str, float], None],
        on_segment: Callable[[TranscriptSegment, float], None],
    ) -> list[TranscriptSegment]:
        preset = PRESETS.get(preset_name, PRESETS["balanced"])
        total = audio.num_samples
        if total < SAMPLE_RATE // 2:
            raise AppError(ErrorCode.NO_SPEECH, "Audio is shorter than half a second")

        # Detect the language once (on the first window) and keep it fixed so
        # a long recording is not split into different languages.
        if not language:
            # Up to 5 minutes of audio; VAD skips intros/music so the sample is speech.
            probe = audio.window(0, min(total, 5 * 60 * SAMPLE_RATE))
            try:
                lang, prob, _ = model.detect_language(
                    audio=probe, vad_filter=True, language_detection_segments=3
                )
            except Exception:  # noqa: BLE001 - e.g. VAD found no speech in the sample
                lang, prob, _ = model.detect_language(audio=probe[: 30 * SAMPLE_RATE])
            del probe
            language = lang
            on_language(lang, float(prob))
        else:
            on_language(language, 1.0)

        # Batching decodes several speech chunks at once — the biggest speed-up on
        # a CPU too. Extra RAM grows with the batch, so when memory is tight the
        # batch shrinks to 2 (still much faster than one-by-one) instead of
        # turning batching off.
        batched = preset.batched
        runner = model
        if batched:
            from faster_whisper import BatchedInferencePipeline

            runner = BatchedInferencePipeline(model=model)

        big_model = model.model.n_mels == 128  # large-v3 / large-v3-turbo
        if device == "cuda":
            batch_size = 8 if big_model else 16
        elif low_memory:
            batch_size = 2
        else:
            batch_size = 4 if big_model else 8
        beam_size = preset.beam_size_cpu if (device == "cpu" and preset.beam_size_cpu) else preset.beam_size
        temperatures = TEMPERATURES_FULL if preset_name == "accurate" else TEMPERATURES_FAST
        prompt = ARABIC_PUNCTUATION_PROMPT if (arabic_punctuation and language == "ar") else None

        segments: list[TranscriptSegment] = []
        recent: list[str] = []
        position = 0
        while position < total:
            if cancel.is_set():
                raise Cancelled()
            end = min(total, position + WINDOW_SECONDS * SAMPLE_RATE)
            if end < total:
                end = audio.quietest_point(end)
                if end <= position:  # pathological: no quiet point found
                    end = min(total, position + WINDOW_SECONDS * SAMPLE_RATE)
            offset = position / SAMPLE_RATE
            chunk = audio.window(position, end)

            common = dict(
                language=language,
                task="transcribe",
                beam_size=beam_size,
                temperature=list(temperatures),
                condition_on_previous_text=preset.condition_on_previous_text,
                initial_prompt=prompt,
                # Names and terms the user listed: nudges the decoder toward their spelling.
                hotwords=vocabulary or None,
                vad_filter=True,
                vad_parameters={"min_silence_duration_ms": 500, "speech_pad_ms": 300},
                without_timestamps=False,
            )
            if batched:
                seg_iter, _info = runner.transcribe(chunk, batch_size=batch_size, **common)
            else:
                seg_iter, _info = runner.transcribe(chunk, **common)

            for seg in seg_iter:
                if cancel.is_set():
                    raise Cancelled()
                text = clean_text(seg.text)
                progress = min(1.0, (offset + seg.end) / (total / SAMPLE_RATE))
                if not text or _is_hallucination(text, seg.no_speech_prob, seg.avg_logprob):
                    continue
                # Break repetition loops (the same line 3+ times in a row).
                if len(recent) >= 2 and recent[-1] == text and recent[-2] == text:
                    continue
                recent = (recent + [text])[-2:]
                item = TranscriptSegment(
                    id=len(segments),
                    start=round(offset + seg.start, 2),
                    end=round(offset + seg.end, 2),
                    text=text,
                )
                segments.append(item)
                on_segment(item, progress)

            del chunk
            position = end

        if not segments:
            raise AppError(ErrorCode.NO_SPEECH, "No speech was detected in the audio")
        return segments
