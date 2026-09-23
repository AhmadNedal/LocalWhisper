/**
 * Current playback time shared between the player and the transcript without
 * re-rendering React on every tick: the transcript subscribes and moves its
 * highlight directly in the DOM.
 */
export class PlayerClock {
  time = 0;
  playing = false;
  private listeners = new Set<(time: number, playing: boolean) => void>();

  set(time: number, playing: boolean): void {
    this.time = time;
    this.playing = playing;
    this.listeners.forEach((l) => l(time, playing));
  }

  subscribe(listener: (time: number, playing: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

/** Index of the last item whose start is <= time (items sorted by start), or -1. */
export function indexAt(starts: number[], time: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= time + 0.05) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

export function youtubeIdFrom(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^(www\.|m\.)/, "");
    let id = "";
    if (host === "youtu.be") id = u.pathname.slice(1).split("/")[0];
    else if (host.endsWith("youtube.com")) {
      id = u.searchParams.get("v") ?? "";
      if (!id) {
        const m = u.pathname.match(/^\/(shorts|live|embed)\/([^/?#]+)/);
        id = m ? m[2] : "";
      }
    }
    return /^[A-Za-z0-9_-]{6,20}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}
