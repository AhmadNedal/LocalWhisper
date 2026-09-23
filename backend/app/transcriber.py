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


PRESETS: dict[str, Preset] = {
    "fast": Preset(batched=True, beam_size=1, condition_on_previous_text=False),
    "balanced": Preset(batched=True, beam_size=5, condition_on_previous_text=False),
    "accurate": Preset(batched=False, beam_size=5, condition_on_previous_text=True),
}

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

            threads = psutil.cpu_count(logical=False) or psutil.cpu_count() or 4
            try:
                self._model = WhisperModel(
                    str(model_path),
                    device=device,
                    compute_type=compute_type,
                    cpu_threads=threads if device == "cpu" else 0,
                    num_workers=1,
                    local_files_only=True,  # never touch the network here
                )
            except Exception as exc:  # noqa: BLE001
                from .errors import classify_exception

                err = classify_exception(exc)
                if err.code == ErrorCode.TRANSCRIPTION_FAILED:
                    err = AppError(ErrorCode.MODEL_LOAD_FAILED, err.detail)
                raise err from exc
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

        # Batching decodes several chunks at once, which needs extra RAM. When
        # memory is tight on the CPU, fall back to the classic sequential decoder
        # (the same call as a plain `model.transcribe(...)`), which is lean.
        batched = preset.batched and not (low_memory and device == "cpu")
        runner = model
        if batched:
            from faster_whisper import BatchedInferencePipeline

            runner = BatchedInferencePipeline(model=model)

        big_model = model.model.n_mels == 128  # large-v3 / large-v3-turbo
        batch_size = (8 if big_model else 16) if device == "cuda" else (4 if big_model else 8)
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
                beam_size=preset.beam_size,
                condition_on_previous_text=preset.condition_on_previous_text,
                initial_prompt=prompt,
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
