"use client";

import { useState } from "react";
import type { MediaInfo } from "@/lib/api";
import { formatBytes, formatDuration } from "@/lib/format";
import type { Strings, UiLang } from "@/lib/i18n";
import { FileMediaIcon, FolderIcon, QueueIcon, UploadIcon } from "./Icons";
import { FileName } from "./FileName";

interface Props {
  t: Strings;
  lang: UiLang;
  media: MediaInfo | null;
  loading: boolean;
  disabled: boolean;
  onPick: () => void;
  onDropPath: (path: string) => void;
  /** Several files or folders → batch queue. */
  onAddMany: (paths: string[]) => void;
  onPickFolder: () => void;
  onPickMany: () => void;
}

/** Large drag & drop area; turns into a compact file card once a file is chosen. */
export function MediaPicker({
  t,
  lang,
  media,
  loading,
  disabled,
  onPick,
  onDropPath,
  onAddMany,
  onPickFolder,
  onPickMany,
}: Props) {
  const [dragging, setDragging] = useState(false);

  const handleDrop = (event: React.DragEvent) => {
    event.preventDefault();
    setDragging(false);
    if (disabled) return;
    const files = Array.from(event.dataTransfer.files ?? []);
    if (!files.length || !window.desktop) return;
    // Only local paths are used; files are never read into the UI.
    const paths = files.map((f) => window.desktop!.getPathForFile(f)).filter(Boolean);
    const hasFolder = Array.from(event.dataTransfer.items ?? []).some(
      (item) => item.kind === "file" && item.webkitGetAsEntry?.()?.isDirectory,
    );
    // A folder or several files → transcribe them all through the queue.
    if (paths.length > 1 || hasFolder) onAddMany(paths);
    else if (paths[0]) onDropPath(paths[0]);
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
          <div className="file-name" title={media.path}>
            <FileName name={media.name} />
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
      <div className="dropzone-more" onClick={(e) => e.stopPropagation()}>
        <button className="btn btn-small" disabled={disabled || loading} onClick={onPickFolder}>
          <FolderIcon size={14} /> {t.pickFolder}
        </button>
        <button className="btn btn-small" disabled={disabled || loading} onClick={onPickMany}>
          <QueueIcon size={14} /> {t.pickMany}
        </button>
      </div>
      <div className="dropzone-hint">{t.pickManyHint}</div>
    </section>
  );
}
