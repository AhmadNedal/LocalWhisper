"""Separate process that runs Cohere Transcribe Arabic with ONNX Runtime.

The model is the ONNX export in abdelmoez98/cohere-transcribe-arabic-07-2026-ONNX
(4-bit weights, "q4f16"), with the two small graph files replaced by repaired
copies shipped with the app (see cohere_engine.ensure_patched): the published
graphs mix 16/32-bit types and point at wrongly named weight files, so no ONNX
Runtime can load them as they are.

Pipeline per speech chunk (following sherpa-onnx's Cohere Transcribe recipe):
  16 kHz audio → 128 log-mel features (kaldi-native-fbank: Hann window,
  librosa mel, no DC removal, pre-emphasis 0.97) → per-feature normalization
  → encoder (cross-attention K/V) → greedy decoding from the task prompt
  <|startofcontext|><|startoftranscript|><|emo:undefined|><|ar|><|ar|><|pnc|><|itn|><|notimestamp|><|nodiarize|>
  with a growing self-attention cache → tokens → text.

Why a separate process: it keeps the model's ~1.8 GB out of the main backend
(given back as soon as a transcription ends) and a crash here can't take the
backend down.

Protocol (UTF-8 JSON lines). The worker stays alive and serves many requests:
  stdin  ← {"model_dir", "threads"}                   (first line: load the model)
  stdout → {"event": "ready"}                         (or {"event": "error", …} and exit)
  stdin  ← {"cmd": "transcribe", "pcm", "language", "chunks": [[start, end], …]}
           (sample indices into a 16 kHz mono int16 PCM file)
  stdout → {"event": "chunk", "i": <index>, "text": "…"} per chunk (in order),
           then {"event": "done"}  or  {"event": "error", "detail": "…"}
  stdin  ← {"cmd": "quit"}                            (or stdin closed)

Started as ``python -m app.cohere_worker`` (development) or
``transcriber-backend.exe --cohere-worker`` (installed app).
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

SAMPLE_RATE = 16000
ENCODER = "onnx/encoder.q4f16.onnx"
DECODER = "onnx/decoder.q4f16.onnx"
TOKENS = "onnx/tokens.txt"
SILENCE_FEATURE_ABS_MAX = 1.0  # normalized features of digital silence stay far below this
MAX_TOKENS_PER_SECOND = 6
_BYTE = re.compile(r"^<0x([0-9A-Fa-f]{2})>$")


def _send(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


class CohereModel:
    def __init__(self, model_dir: Path, threads: int) -> None:
        import onnxruntime as ort

        so = ort.SessionOptions()
        so.intra_op_num_threads = max(1, threads)
        so.inter_op_num_threads = 1
        so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        providers = ["CPUExecutionProvider"]
        self.encoder = ort.InferenceSession(str(model_dir / ENCODER), so, providers=providers)
        self.decoder = ort.InferenceSession(str(model_dir / DECODER), so, providers=providers)

        self.symbols = (model_dir / TOKENS).read_text(encoding="utf-8").splitlines()
        self.ids = {s: i for i, s in enumerate(self.symbols)}
        self.eos = self.ids["<|endoftext|>"]

        # Cache layout: [layers, batch, heads, seq, head_dim]; starts empty and grows.
        shape = self.decoder.get_inputs()[1].shape
        self.cache_shape = [int(shape[0]), 1, int(shape[2]), 0, int(shape[4])]

    def prompt(self, language: str, punctuation: bool = True, itn: bool = True) -> list[int]:
        parts = [
            "<|startofcontext|>",
            "<|startoftranscript|>",
            "<|emo:undefined|>",
            f"<|{language}|>",
            f"<|{language}|>",
            "<|pnc|>" if punctuation else "<|nopnc|>",
            "<|itn|>" if itn else "<|noitn|>",
            "<|notimestamp|>",
            "<|nodiarize|>",
        ]
        return [self.ids[p] for p in parts]

    @staticmethod
    def features(samples):  # noqa: ANN001, ANN205 - float32 [-1, 1] → (frames, 128)
        import kaldi_native_fbank as knf
        import numpy as np

        opts = knf.FbankOptions()
        opts.frame_opts.samp_freq = SAMPLE_RATE
        opts.frame_opts.dither = 0.0
        opts.frame_opts.snip_edges = False
        opts.frame_opts.frame_shift_ms = 10.0
        opts.frame_opts.frame_length_ms = 25.0
        opts.frame_opts.remove_dc_offset = False
        opts.frame_opts.preemph_coeff = 0.97
        opts.frame_opts.window_type = "hann"
        opts.frame_opts.round_to_power_of_two = True
        opts.mel_opts.num_bins = 128
        opts.mel_opts.low_freq = 0.0
        opts.mel_opts.high_freq = -400.0
        opts.mel_opts.is_librosa = True
        fbank = knf.OnlineFbank(opts)
        fbank.accept_waveform(SAMPLE_RATE, samples.tolist())
        fbank.input_finished()
        n = fbank.num_frames_ready
        if n == 0:
            return np.zeros((0, 128), dtype=np.float32)
        x = np.stack([np.asarray(fbank.get_frame(i), dtype=np.float32) for i in range(n)])
        # Per-feature normalization (NeMo "per_feature"), variance from centered values.
        mean = x.mean(axis=0, keepdims=True)
        std = np.sqrt(np.square(x - mean).mean(axis=0, keepdims=True))
        return ((x - mean) / (std + 1e-5)).astype(np.float32)

    def text(self, token_ids: list[int]) -> str:
        out = bytearray()
        for t in token_ids:
            if t < 0 or t >= len(self.symbols):
                continue
            s = self.symbols[t]
            m = _BYTE.match(s)
            if m:
                out.append(int(m.group(1), 16))
            elif s.startswith("<") and s.endswith(">"):
                continue  # <|...|>, <unk>, <pad>
            else:
                out.extend(s.replace("▁", " ").encode("utf-8"))
        return out.decode("utf-8", errors="ignore").strip()

    def transcribe(self, samples, language: str) -> str:  # noqa: ANN001
        import numpy as np

        feats = self.features(samples)
        if feats.shape[0] == 0 or float(np.abs(feats).max()) <= SILENCE_FEATURE_ABS_MAX:
            return ""  # silence: the decoder would otherwise invent a sentence
        cross_k, cross_v = self.encoder.run(
            None,
            {"input_features": feats[None, :, :], "attention_mask": np.ones((1, feats.shape[0]), dtype=bool)},
        )
        self_k = np.zeros(self.cache_shape, dtype=np.float32)
        self_v = np.zeros(self.cache_shape, dtype=np.float32)
        tokens = np.asarray([self.prompt(language)], dtype=np.int64)
        offset = 0
        result: list[int] = []
        limit = max(8, int(feats.shape[0] / 100.0 * MAX_TOKENS_PER_SECOND))
        for _ in range(limit + 1):
            logits, self_k, self_v = self.decoder.run(
                None,
                {
                    "tokens": tokens,
                    "self_k": self_k,
                    "self_v": self_v,
                    "cross_k": cross_k,
                    "cross_v": cross_v,
                    "offset": np.asarray([offset], dtype=np.int64),
                },
            )
            offset += tokens.shape[1]
            nxt = int(np.argmax(logits[0, -1]))
            if nxt == self.eos or len(result) >= limit:
                break
            result.append(nxt)
            tokens = np.asarray([[nxt]], dtype=np.int64)
        return self.text(result)


def run() -> int:
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
        except (AttributeError, ValueError):
            pass
    try:
        init = json.loads(sys.stdin.readline())
        import numpy as np

        model = CohereModel(Path(init["model_dir"]), int(init.get("threads") or 4))
    except Exception as exc:  # noqa: BLE001 - reported to the parent
        _send({"event": "error", "detail": f"{exc.__class__.__name__}: {exc}"[:500]})
        return 1
    _send({"event": "ready"})

    # Then any number of requests, until "quit" or the parent closes stdin.
    for line in sys.stdin:
        try:
            req = json.loads(line)
        except ValueError:
            continue
        if req.get("cmd") == "quit":
            break
        try:
            pcm_path = Path(req["pcm"])
            size = pcm_path.stat().st_size // 2
            pcm = np.memmap(pcm_path, dtype=np.int16, mode="r", shape=(size,))
            language = req.get("language") or "ar"
            for i, (start, end) in enumerate(req.get("chunks") or []):
                samples = np.asarray(pcm[int(start) : int(end)], dtype=np.float32) / 32768.0
                _send({"event": "chunk", "i": i, "text": model.transcribe(samples, language)})
            del pcm
            _send({"event": "done"})
        except Exception as exc:  # noqa: BLE001 - this request failed; the model stays loaded
            _send({"event": "error", "detail": f"{exc.__class__.__name__}: {exc}"[:500]})
    return 0


if __name__ == "__main__":
    sys.exit(run())
