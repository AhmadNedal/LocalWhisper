"use client";

import { useState } from "react";
import type { MediaInfo } from "@/lib/api";
import { formatBytes, formatDuration } from "@/lib/format";
import type { Strings, UiLang } from "@/lib/i18n";
import { FileMediaIcon, UploadIcon } from "./Icons";

interface Props {
  t: Strings;
  lang: UiLang;
  media: MediaInfo | null;
  loading: boolean;
  disabled: boolean;
  onPick: () => void;
  onDropPath: (path: string) => void;
}

/** Large drag & drop area; turns into a compact file card once a file is chosen. */
export function MediaPicker({ t, lang, media, loading, disabled, onPick, onDropPath }: Props) {
  const [dragging, setDragging] = useState(false);

  const handleDrop = (event: React.DragEvent) => {
    event.preventDefault();
    setDragging(false);
    if (disabled) return;
    const file = event.dataTransfer.files?.[0];
    if (!file || !window.desktop) return;
    // Only the local path is used; the file is never read into the UI.
    const path = window.desktop.getPathForFile(file);
    if (path) onDropPath(path);
  };

  const dropHandlers = {
    onDragOver: (e: React.DragEvent) => {
      e.preventDefault();
      if (!disabled) setDragging(true);
    },
    onDragLeave: () => setDragging(false),
    onDrop: handleDrop,
  };

  if (media && !loading) {
    return (
      <section className={`card file-card ${dragging ? "is-dragging" : ""}`} {...dropHandlers}>
        <div className="file-icon">
          <FileMediaIcon size={26} />
        </div>
        <div className="file-main">
          <div className="file-name" dir="auto" title={media.path}>
            {media.name}
          </div>
          <div className="file-meta">
            <span>
              {t.fileDuration}: <b>{formatDuration(media.duration, lang)}</b>
            </span>
            <span>
              {t.fileSize}: <b dir="ltr">{formatBytes(media.size_bytes)}</b>
            </span>
            <span>
              {t.fileType}: <b>{media.has_video ? t.video : t.audio}</b>
              {media.audio_codec ? (
                <span className="muted" dir="ltr">
                  {" "}
                  ({media.audio_codec})
                </span>
              ) : null}
            </span>
          </div>
        </div>
        <button className="btn btn-subtle" onClick={onPick} disabled={disabled}>
          {t.changeFile}
        </button>
      </section>
    );
  }

  return (
    <section
      className={`card dropzone ${dragging ? "is-dragging" : ""} ${disabled ? "is-disabled" : ""}`}
      {...dropHandlers}
      onClick={() => !disabled && !loading && onPick()}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if ((e.key === "Enter" || e.key === " ") && !disabled) onPick();
      }}
    >
      <div className="dropzone-icon">
        <UploadIcon size={34} />
      </div>
      <div className="dropzone-title">{loading ? t.reading : dragging ? t.dropActive : t.dropTitle}</div>
      <div className="dropzone-sub" dir="ltr">
        {t.dropSubtitle}
      </div>
      <button
        className="btn btn-accent"
        disabled={disabled || loading}
        onClick={(e) => {
          e.stopPropagation();
          onPick();
        }}
      >
        {t.chooseFile}
      </button>
    </section>
  );
}
