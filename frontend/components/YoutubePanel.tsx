"use client";

import { useState } from "react";
import type { YoutubeCaption, YoutubeInfo } from "@/lib/api";
import { formatDuration } from "@/lib/format";
import type { Strings, UiLang } from "@/lib/i18n";
import { languageName } from "@/lib/languages";
import { AlertIcon, CheckIcon, PlayIcon, QueueIcon, YoutubeIcon } from "./Icons";

interface Props {
  t: Strings;
  lang: UiLang;
  info: YoutubeInfo | null;
  loading: boolean;
  disabled: boolean;
  /** Caption track currently loaded into the transcript, if any. */
  usedCaption: YoutubeCaption | null;
  captionLoading: string | null;
  onInspect: (url: string) => void;
  onUseCaption: (track: YoutubeCaption) => void;
  /** A playlist link: offer to add all its videos to the batch queue. */
  onPlaylist: (url: string) => void;
}

/** Link to a YouTube playlist (not a personal "Mix")? */
export function isPlaylistUrl(url: string): boolean {
  return /[?&]list=(?!RD)[A-Za-z0-9_-]{10,}/.test(url) && /youtu\.?be/i.test(url);
}

/** A playlist page link with no specific video in it. */
function isPlaylistOnly(url: string): boolean {
  return isPlaylistUrl(url) && !/[?&]v=[A-Za-z0-9_-]{11}/.test(url) && !/youtu\.be\/[A-Za-z0-9_-]{11}/i.test(url);
}

function captionLabel(track: YoutubeCaption, lang: UiLang): string {
  const base = track.lang.replace("-orig", "").split("-")[0];
  const localized = languageName(base, lang);
  return localized && localized !== base ? localized : track.name || track.lang;
}

/** Paste a YouTube link → use its existing captions, or transcribe it with Whisper. */
export function YoutubePanel({
  t,
  lang,
  info,
  loading,
  disabled,
  usedCaption,
  captionLoading,
  onInspect,
  onUseCaption,
  onPlaylist,
}: Props) {
  const [url, setUrl] = useState("");
  const playlist = isPlaylistUrl(url);
  const manual = info?.captions.filter((c) => c.kind === "manual") ?? [];
  const auto = info?.captions.filter((c) => c.kind === "auto") ?? [];

  const go = (value: string) => {
    if (!value || loading || disabled) return;
    if (isPlaylistOnly(value)) onPlaylist(value);
    else onInspect(value);
  };
  const submit = () => go(url.trim());

  return (
    <section className="card youtube">
      <div className="yt-input-row">
        <span className="yt-badge" aria-hidden="true">
          <YoutubeIcon size={18} />
        </span>
        <input
          type="text"
          dir="ltr"
          placeholder={t.ytPlaceholder}
          value={url}
          disabled={disabled}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          onPaste={(e) => {
            const pasted = e.clipboardData.getData("text").trim();
            if (/youtu\.?be/i.test(pasted)) {
              e.preventDefault();
              setUrl(pasted);
              go(pasted);
            }
          }}
        />
        <button className="btn" onClick={submit} disabled={!url.trim() || loading || disabled}>
          {loading ? t.ytFetching : t.ytFetch}
        </button>
      </div>

      {playlist ? (
        <div className="notice info yt-playlist">
          <QueueIcon size={16} />
          <div>
            <div>{t.ytPlaylistDetected}</div>
            <button className="btn btn-small btn-accent" disabled={disabled} onClick={() => onPlaylist(url.trim())}>
              {t.ytPlaylistAdd}
            </button>
          </div>
        </div>
      ) : null}

      {info ? (
        <div className="yt-body">
          <div className="yt-video">
            {info.thumbnail ? <img
                src={info.thumbnail}
                alt=""
                className="yt-thumb"
                referrerPolicy="no-referrer"
                onError={(e) => (e.currentTarget.style.display = "none")}
              /> : null}
            <div className="yt-meta">
              <div className="file-name" dir="auto" title={info.title}>
                {info.title}
              </div>
              <div className="file-meta">
                {info.channel ? <span dir="auto">{info.channel}</span> : null}
                <span>
                  {t.fileDuration}: <b>{formatDuration(info.duration, lang)}</b>
                </span>
              </div>
            </div>
          </div>

          {info.captions.length ? (
            <>
              <p className="hint">{t.ytHasCaptions}</p>
              <ul className="yt-captions">
                {[...manual, ...auto].map((track) => {
                  const active = usedCaption?.lang === track.lang && usedCaption.kind === track.kind;
                  const busy = captionLoading === `${track.kind}:${track.lang}`;
                  return (
                    <li key={`${track.kind}:${track.lang}`} className={active ? "is-active" : ""}>
                      <div>
                        <div className="yt-caption-name">{captionLabel(track, lang)}</div>
                        <div className="muted small">{track.kind === "manual" ? t.ytManual : t.ytAuto}</div>
                      </div>
                      {active ? (
                        <span className="pill pill-ok">
                          <CheckIcon size={12} /> {t.ytUsed}
                        </span>
                      ) : (
                        <button
                          className={`btn btn-small ${track.kind === "manual" ? "btn-accent" : ""}`}
                          disabled={disabled || !!captionLoading}
                          onClick={() => onUseCaption(track)}
                        >
                          {busy ? t.ytFetching : t.ytUse}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
              <p className="hint muted">
                <PlayIcon size={12} /> {t.ytOrWhisper}
              </p>
            </>
          ) : (
            <div className="notice info">
              <AlertIcon size={16} />
              <div>{t.ytNoCaptions}</div>
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}
