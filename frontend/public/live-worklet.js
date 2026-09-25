// Live transcription: runs on the audio thread of an AudioContext created at
// 16 kHz (the browser resamples the microphone / computer audio to it).
// Mixes all input channels to mono and hands 100 ms blocks of float samples,
// with their loudness, to the page.
class LiveCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = new Float32Array(1600);
    this.filled = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const frames = input[0].length;
    const channels = input.length;
    for (let i = 0; i < frames; i++) {
      let v = 0;
      for (let c = 0; c < channels; c++) v += input[c][i];
      this.block[this.filled++] = v / channels;
      if (this.filled === this.block.length) {
        let sum = 0;
        for (let j = 0; j < this.block.length; j++) sum += this.block[j] * this.block[j];
        const out = this.block;
        this.port.postMessage({ samples: out, rms: Math.sqrt(sum / out.length) }, [out.buffer]);
        this.block = new Float32Array(1600);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor("live-capture", LiveCapture);
