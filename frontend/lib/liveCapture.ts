/**
 * Captures the microphone and/or the computer's audio for live transcription
 * and turns it into 16 kHz mono 16-bit PCM (what the engine expects).
 *
 * Computer audio ("what you hear": a Zoom/Teams lecture, a video playing) uses
 * getDisplayMedia with Windows loopback audio, allowed by the desktop app for
 * this one request; the video track is dropped at once.
 */
export type LiveSource = "mic" | "system" | "both";

export interface CaptureOptions {
  source: LiveSource;
  micDeviceId?: string;
  /** About every 100 ms: 1600 samples as 16-bit PCM, and the loudness (0–1). */
  onBlock: (pcm: Int16Array, rms: number) => void;
  /** A source stopped by itself (mic unplugged, capture ended). */
  onEnded?: () => void;
}

export class CaptureError extends Error {
  constructor(
    public code: "mic_denied" | "mic_missing" | "system_unsupported" | "system_denied" | "capture_failed",
    message: string,
  ) {
    super(message);
  }
}

export class LiveCaptureSession {
  private ctx: AudioContext | null = null;
  private streams: MediaStream[] = [];
  private node: AudioWorkletNode | null = null;
  private stopped = false;

  async start(opts: CaptureOptions): Promise<void> {
    try {
      if (opts.source === "mic" || opts.source === "both") this.streams.push(await micStream(opts.micDeviceId));
      if (opts.source === "system" || opts.source === "both") this.streams.push(await systemStream());
    } catch (err) {
      this.stop();
      throw err;
    }
    const ctx = new AudioContext({ sampleRate: 16000, latencyHint: "interactive" });
    this.ctx = ctx;
    await ctx.audioWorklet.addModule(new URL("/live-worklet.js", window.location.href).toString());
    const node = new AudioWorkletNode(ctx, "live-capture", { numberOfInputs: 1, numberOfOutputs: 1, channelCountMode: "max" });
    this.node = node;
    // Connected to the output (silently) so the audio graph keeps pulling it.
    const mute = ctx.createGain();
    mute.gain.value = 0;
    node.connect(mute).connect(ctx.destination);
    node.port.onmessage = (e: MessageEvent<{ samples: Float32Array; rms: number }>) => {
      if (this.stopped) return;
      const f = e.data.samples;
      const pcm = new Int16Array(f.length);
      for (let i = 0; i < f.length; i++) {
        const v = Math.max(-1, Math.min(1, f[i]));
        pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
      }
      opts.onBlock(pcm, e.data.rms);
    };
    for (const stream of this.streams) {
      ctx.createMediaStreamSource(stream).connect(node); // several sources are summed
      for (const track of stream.getAudioTracks()) track.addEventListener("ended", () => !this.stopped && opts.onEnded?.());
    }
    if (ctx.state === "suspended") await ctx.resume();
  }

  stop(): void {
    this.stopped = true;
    try {
      this.node?.port.close();
      this.node?.disconnect();
    } catch {
      /* already gone */
    }
    for (const s of this.streams) for (const t of s.getTracks()) t.stop();
    this.streams = [];
    this.ctx?.close().catch(() => undefined);
    this.ctx = null;
  }
}

async function micStream(deviceId?: string): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
  } catch (err) {
    const name = (err as DOMException)?.name;
    if (name === "NotAllowedError" || name === "SecurityError") throw new CaptureError("mic_denied", String(err));
    if (name === "NotFoundError" || name === "OverconstrainedError") throw new CaptureError("mic_missing", String(err));
    throw new CaptureError("capture_failed", String(err));
  }
}

async function systemStream(): Promise<MediaStream> {
  const allowed = await window.desktop?.liveSystemAudio?.();
  if (!allowed) throw new CaptureError("system_unsupported", "Computer audio capture needs Windows");
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  } catch (err) {
    throw new CaptureError("system_denied", String(err));
  }
  for (const t of stream.getVideoTracks()) {
    t.stop();
    stream.removeTrack(t);
  }
  if (!stream.getAudioTracks().length) throw new CaptureError("system_denied", "No audio track");
  return stream;
}

/** Microphones the user can choose from (names appear once permission was given). */
export async function listMicrophones(): Promise<{ id: string; label: string }[]> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((d) => d.kind === "audioinput" && d.deviceId !== "communications")
      .map((d, i) => ({ id: d.deviceId, label: d.label || `Microphone ${i + 1}` }));
  } catch {
    return [];
  }
}
