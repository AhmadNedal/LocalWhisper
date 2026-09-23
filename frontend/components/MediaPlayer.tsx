"use client";

import { useEffect, useRef, useState } from "react";
import type { Strings } from "@/lib/i18n";
import type { PlayerClock } from "@/lib/playerClock";
import { AlertIcon, PlayIcon } from "./Icons";

export interface SeekRequest {
  time: number;
  nonce: number;
}

interface Props {
  t: Strings;
  /** Local file streamed by the backend, or null for YouTube. */
  src: string | null;
  youtubeId: string | null;
  clock: PlayerClock;
  seek: SeekRequest | null;
  follow: boolean;
  onFollow: (on: boolean) => void;
  onOpenExternal?: () => void;
  onClose: () => void;
}

const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2];

/**
 * Player above the transcript. Local files play in a <video> element (audio
 * files too — the picture area collapses); YouTube sources use YouTube's embed,
 * driven through its postMessage protocol so no script is loaded from the web.
 */
export function MediaPlayer({ t, src, youtubeId, clock, seek, follow, onFollow, onOpenExternal, onClose }: Props) {
  const video = useRef<HTMLVideoElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [rate, setRate] = useState(1);
  const [failed, setFailed] = useState(false);
  const [audioOnly, setAudioOnly] = useState(false);

  useEffect(() => {
    setFailed(false);
    setAudioOnly(false);
  }, [src, youtubeId]);

  // ---- local file ----
  useEffect(() => {
    const el = video.current;
    if (!el) return;
    let raf = 0;
    const tick = () => {
      clock.set(el.currentTime, !el.paused);
      if (!el.paused) raf = requestAnimationFrame(tick);
    };
    const onPlay = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(tick);
    };
    const onPause = () => clock.set(el.currentTime, false);
    const onSeeked = () => clock.set(el.currentTime, !el.paused);
    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onPause);
    el.addEventListener("seeked", onSeeked);
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener("play", onPlay);
      el.removeEventListener("pause", onPause);
      el.removeEventListener("seeked", onSeeked);
      clock.set(clock.time, false);
    };
  }, [clock, src]);

  useEffect(() => {
    if (video.current) video.current.playbackRate = rate;
  }, [rate, src]);

  // ---- YouTube embed (postMessage API) ----
  const ytCommand = (func: string, args: unknown[] = []) =>
    frame.current?.contentWindow?.postMessage(JSON.stringify({ event: "command", func, args }), "*");

  useEffect(() => {
    if (!youtubeId) return;
    const onMessage = (e: MessageEvent) => {
      if (!/^https:\/\/www\.youtube(-nocookie)?\.com$/.test(e.origin) || typeof e.data !== "string") return;
      try {
        const data = JSON.parse(e.data) as { event?: string; info?: { currentTime?: number; playerState?: number } };
        if (data.event === "infoDelivery" && data.info) {
          const time = data.info.currentTime ?? clock.time;
          const playing = data.info.playerState === undefined ? clock.playing : data.info.playerState === 1;
          clock.set(time, playing);
        }
      } catch {
        /* not ours */
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [youtubeId, clock]);

  useEffect(() => {
    if (youtubeId) ytCommand("setPlaybackRate", [rate]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rate, youtubeId]);

  // ---- seek requests from the transcript ----
  useEffect(() => {
    if (!seek) return;
    if (youtubeId) {
      ytCommand("seekTo", [seek.time, true]);
      ytCommand("playVideo");
      clock.set(seek.time, true);
      return;
    }
    const el = video.current;
    if (!el) return;
    el.currentTime = seek.time;
    el.play().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seek?.nonce]);

  // Keyboard: Ctrl+Space play/pause, Ctrl+←/→ ±5 s (ignored while editing text).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (!e.ctrlKey || target?.isContentEditable || target?.tagName === "INPUT" || target?.tagName === "TEXTAREA") return;
      const el = video.current;
      if (e.code === "Space") {
        e.preventDefault();
        if (el) (el.paused ? el.play().catch(() => undefined) : el.pause());
        else ytCommand(clock.playing ? "pauseVideo" : "playVideo");
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        const rtl = document.documentElement.dir === "rtl";
        const forward = (e.key === "ArrowRight") !== rtl;
        const next = Math.max(0, clock.time + (forward ? 5 : -5));
        if (el) el.currentTime = next;
        else ytCommand("seekTo", [next, true]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clock]);

  return (
    <section className={`card player${audioOnly ? " is-audio" : ""}`} aria-label={t.playerTitle}>
      <div className="player-media">
        {youtubeId ? (
          <iframe
            ref={frame}
            title={t.playerTitle}
            src={`https://www.youtube-nocookie.com/embed/${youtubeId}?enablejsapi=1&rel=0&modestbranding=1`}
            allow="autoplay; encrypted-media; picture-in-picture"
            allowFullScreen
            onLoad={() => {
              // Ask the embed to report its time (the IFrame API's "listening" handshake).
              frame.current?.contentWindow?.postMessage(JSON.stringify({ event: "listening", id: 1, channel: "widget" }), "*");
            }}
          />
        ) : src && !failed ? (
          <video
            ref={video}
            src={src}
            controls
            preload="metadata"
            onLoadedMetadata={(e) => setAudioOnly(e.currentTarget.videoWidth === 0)}
            onError={() => setFailed(true)}
          />
        ) : (
          <div className="player-error">
            <AlertIcon size={18} />
            <div>
              <div>{t.playerCannotPlay}</div>
              {onOpenExternal ? (
                <button className="link-btn" onClick={onOpenExternal}>
                  <PlayIcon size={13} /> {t.playerOpenExternal}
                </button>
              ) : null}
            </div>
          </div>
        )}
      </div>
      <div className="player-bar">
        <label className="check">
          <input type="checkbox" checked={follow} onChange={(e) => onFollow(e.target.checked)} />
          <span>{t.playerFollow}</span>
        </label>
        <label className="inline-select">
          <span>{t.playerSpeed}</span>
          <select value={rate} onChange={(e) => setRate(Number(e.target.value))}>
            {RATES.map((r) => (
              <option key={r} value={r}>
                {r}×
              </option>
            ))}
          </select>
        </label>
        <span className="muted small player-keys">{t.playerKeys}</span>
        <span className="batch-spacer" />
        <button className="btn btn-small btn-subtle" onClick={onClose}>
          {t.playerHide}
        </button>
      </div>
    </section>
  );
}
