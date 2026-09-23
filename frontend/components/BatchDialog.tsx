"use client";

import { useEffect, useState } from "react";
import { ApiError, type BackendClient, type BatchItem, type BatchState, type WatchState } from "@/lib/api";
import { formatDuration } from "@/lib/format";
import { FileName } from "./FileName";
import { loadUsableProfiles } from "@/lib/dbProfiles";
import type { DbProfile } from "@/lib/desktop";
import { errorMessage, type Strings, type UiLang } from "@/lib/i18n";
import {
  AlertIcon,
  DatabaseIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  FileMediaIcon,
  FolderIcon,
  FolderPlusIcon,
  GlobeIcon,
  PlayIcon,
  QueueIcon,
  RefreshIcon,
  SparkIcon,
  StopIcon,
  TrashIcon,
  UploadIcon,
  WatchFolderIcon,
  YoutubeIcon,
} from "./Icons";

export interface BatchPrefs {
  skipArchived: boolean;
  summarize: boolean;
  translate?: boolean;
  youtubeCaptions?: boolean;
  dbInsert?: boolean;
  dbProfileId?: string;
  keepAwake: boolean;
  /** Start the queue by itself when a watched folder adds videos (default on). */
  watchAutoStart?: boolean;
  /** Keep running in the tray after the window is closed while folders are watched (default on). */
  watchBackground?: boolean;
}

interface Props {
  t: Strings;
  lang: UiLang;
  client: BackendClient;
  batch: BatchState | null;
  prefs: BatchPrefs;
  onPrefs: (patch: Partial<BatchPrefs>) => void;
  settingsLabel: string;
  summaryReady: boolean;
  translateReady: boolean;
  translateLabel: string;
  onState: (state: BatchState) => void;
  onStart: () => Promise<void>;
  onOpen: (archiveId: string) => void;
  onClose: () => void;
  /** Playlist link handed over from the YouTube field: added right away. */
  initialYoutubeUrl?: string | null;
  /** Files/folders handed over from the main screen: added right away. */
  initialPaths?: string[] | null;
  /** Watched folders (new videos are queued automatically). */
  watch: WatchState | null;
  /** Opens the watched-folders window. */
  onOpenWatch: () => void;
}

type Note = { kind: "ok" | "error"; text: string; detail?: string } | null;

const STAGE_ICON: Record<string, string> = { queued: "•", running: "", done: "", error: "!", cancelled: "×", skipped: "–" };

export function BatchDialog({
  t,
  lang,
  client,
  batch,
  prefs,
  onPrefs,
  settingsLabel,
  summaryReady,
  translateReady,
  translateLabel,
  onState,
  onStart,
  onOpen,
  onClose,
  initialYoutubeUrl,
  initialPaths,
  watch,
  onOpenWatch,
}: Props) {
  const [note, setNote] = useState<Note>(null);
  const [ytUrl, setYtUrl] = useState(initialYoutubeUrl ?? "");
  const [ytBusy, setYtBusy] = useState(false);
  const [profiles, setProfiles] = useState<DbProfile[]>([]);
  useEffect(() => {
    loadUsableProfiles().then(setProfiles);
  }, []);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const items = batch?.items ?? [];
  const state = batch?.state ?? "idle";
  const counts = batch?.counts ?? {};
  const done = counts.done ?? 0;
  const failed = (counts.error ?? 0) + (counts.cancelled ?? 0);
  const queued = counts.queued ?? 0;
  const total = items.length;

  const run = async (fn: () => Promise<BatchState | void>) => {
    setBusy(true);
    try {
      const res = await fn();
      if (res) onState(res);
    } catch (err) {
      const e = err instanceof ApiError ? err : new ApiError("internal", String(err));
      setNote({ kind: "error", text: errorMessage(lang, e.code), detail: e.detail });
    } finally {
      setBusy(false);
    }
  };

  const add = (paths: string[]) =>
    run(async () => {
      if (!paths.length) return;
      const res = await client.batchAdd(paths, prefs.skipArchived);
      if (!res.found) setNote({ kind: "error", text: t.batchNoneFound });
      else {
        const text = t.batchAdded.replace("{added}", String(res.added));
        setNote({
          kind: "ok",
          text: res.skipped ? `${text} — ${t.batchSkipped.replace("{skipped}", String(res.skipped))}` : text,
        });
      }
      return res;
    });

  const addYoutube = async (value: string) => {
    if (!value.trim()) return;
    setYtBusy(true);
    await run(async () => {
      const res = await client.batchAddYoutube(value.trim(), prefs.skipArchived);
      const text = t.batchYoutubeAdded.replace("{playlist}", res.playlist).replace("{added}", String(res.added));
      setNote({
        kind: "ok",
        text: res.skipped ? `${text} — ${t.batchSkipped.replace("{skipped}", String(res.skipped))}` : text,
      });
      setYtUrl("");
      return res;
    });
    setYtBusy(false);
  };

  // Opened with files/folders from the main screen: add them immediately.
  useEffect(() => {
    if (initialPaths?.length) add(initialPaths);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPaths]);

  // Opened from a playlist link in the YouTube field: add it immediately.
  useEffect(() => {
    if (initialYoutubeUrl) addYoutube(initialYoutubeUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialYoutubeUrl]);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const paths = Array.from(e.dataTransfer.files)
      .map((f) => window.desktop?.getPathForFile(f) ?? "")
      .filter(Boolean);
    add(paths);
  };

  const watchedCount = (watch?.folders ?? []).filter((f) => f.enabled).length;

  const statusText = (item: BatchItem) => t[`batchStatus_${item.status}` as keyof Strings] ?? item.status;
  const current = batch?.current;

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className={`modal batch-modal${dragging ? " is-dragging" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="batch-title"
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(e) => {
          if (e.currentTarget === e.target) setDragging(false);
        }}
        onDrop={onDrop}
      >
        <header className="modal-head">
          <div>
            <h2 id="batch-title">
              <QueueIcon size={18} /> {t.batchTitle}
            </h2>
            <p className="hint">{t.batchHint}</p>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label={t.close}>
            ✕
          </button>
        </header>

        <div className="batch-toolbar">
          <button className="btn" disabled={busy} onClick={async () => add((await window.desktop?.openFolderDialog()) ?? [])}>
            <FolderPlusIcon size={16} /> {t.batchAddFolder}
          </button>
          <button
            className="btn"
            disabled={busy}
            onClick={async () => add((await window.desktop?.openMediaFilesDialog()) ?? [])}
          >
            <UploadIcon size={16} /> {t.batchAddFiles}
          </button>
          <span className="muted small">{t.batchDropHint}</span>
          <span className="batch-spacer" />
          {total ? (
            <span className="batch-count">
              {t.batchProgress.replace("{done}", String(done)).replace("{total}", String(total))}
            </span>
          ) : null}
        </div>

        <div className="batch-yt">
          <span className="yt-badge" aria-hidden="true">
            <YoutubeIcon size={16} />
          </span>
          <input
            type="text"
            dir="ltr"
            placeholder={t.batchYoutubePlaceholder}
            value={ytUrl}
            disabled={ytBusy}
            onChange={(e) => setYtUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addYoutube(ytUrl)}
          />
          <button className="btn" disabled={ytBusy || !ytUrl.trim()} onClick={() => addYoutube(ytUrl)}>
            {ytBusy ? (
              <>
                <span className="spinner small" /> {t.batchYoutubeAdding}
              </>
            ) : (
              t.batchYoutubeAdd
            )}
          </button>
        </div>

        <button type="button" className="batch-watch-link" onClick={onOpenWatch}>
          <WatchFolderIcon size={16} />
          <span>
            {watchedCount ? t.watchIndicator.replace("{n}", String(watchedCount)) : t.watchLinkNone}
          </span>
          <span className="batch-watch-link-go">{t.watchManage}</span>
        </button>

        <div className="batch-options">
          <label className="check">
            <input type="checkbox" checked={prefs.skipArchived} onChange={(e) => onPrefs({ skipArchived: e.target.checked })} />
            <span>{t.batchSkipArchived}</span>
          </label>
          <label className="check" title={!summaryReady ? t.batchSummarizeNeedsKey : undefined}>
            <input
              type="checkbox"
              checked={prefs.summarize && summaryReady}
              disabled={!summaryReady || state !== "idle"}
              onChange={(e) => onPrefs({ summarize: e.target.checked })}
            />
            <span>
              <SparkIcon size={13} /> {t.batchSummarize}
            </span>
          </label>
          {!summaryReady ? <span className="hint warn small-hint">{t.batchSummarizeNeedsKey}</span> : null}
          <label className="check" title={!translateReady ? t.batchTranslateNeedsKey : undefined}>
            <input
              type="checkbox"
              checked={Boolean(prefs.translate) && translateReady}
              disabled={!translateReady || state !== "idle"}
              onChange={(e) => onPrefs({ translate: e.target.checked })}
            />
            <span>
              <GlobeIcon size={13} /> {t.batchTranslate.replace("{engine}", translateLabel)}
            </span>
          </label>
          {!translateReady ? <span className="hint warn small-hint">{t.batchTranslateNeedsKey}</span> : null}
          {items.some((i) => i.kind === "youtube") ? (
            <label className="check">
              <input
                type="checkbox"
                checked={prefs.youtubeCaptions !== false}
                disabled={state !== "idle"}
                onChange={(e) => onPrefs({ youtubeCaptions: e.target.checked })}
              />
              <span>
                <YoutubeIcon size={13} /> {t.batchYoutubeCaptions}
              </span>
            </label>
          ) : null}
          <label className="check" title={!profiles.length ? t.batchDbNoProfiles : undefined}>
            <input
              type="checkbox"
              checked={Boolean(prefs.dbInsert) && profiles.length > 0}
              disabled={!profiles.length || state !== "idle"}
              onChange={(e) => onPrefs({ dbInsert: e.target.checked })}
            />
            <span>
              <DatabaseIcon size={13} /> {t.batchDb}
            </span>
          </label>
          {prefs.dbInsert && profiles.length ? (
            <select
              className="batch-db-profile"
              aria-label={t.courseDbProfile}
              value={profiles.find((p) => p.id === prefs.dbProfileId)?.id ?? profiles[0].id}
              disabled={state !== "idle"}
              onChange={(e) => onPrefs({ dbProfileId: e.target.value })}
            >
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          ) : null}
          {!profiles.length ? <span className="hint small-hint muted">{t.batchDbNoProfiles}</span> : null}
          <label className="check">
            <input type="checkbox" checked={prefs.keepAwake} onChange={(e) => onPrefs({ keepAwake: e.target.checked })} />
            <span>{t.batchKeepAwake}</span>
          </label>
          <div className="muted small batch-using">
            {t.batchUsing} <span dir="auto">{settingsLabel}</span>
          </div>
        </div>

        {note ? (
          <div className={`notice ${note.kind === "error" ? "error" : "ok"} batch-note`}>
            {note.kind === "error" ? <AlertIcon size={16} /> : <CheckIcon size={16} />}
            <div>
              {note.text}
              {note.detail ? <code dir="ltr"> {note.detail}</code> : null}
            </div>
            <button className="icon-btn" onClick={() => setNote(null)} aria-label={t.close}>
              ✕
            </button>
          </div>
        ) : null}
        {batch?.pauseReason ? (
          <div className="notice warn batch-note">
            <AlertIcon size={16} />
            <div>
              {batch.pauseReason.detail?.startsWith("summaries_disabled")
                ? t.batchSummariesDisabled
                : batch.pauseReason.detail?.startsWith("translation_disabled")
                  ? t.batchTranslationDisabled
                  : batch.pauseReason.detail?.startsWith("db_disabled")
                    ? t.batchDbDisabled
                    : t.batchPaused}{" "}
              <strong>{errorMessage(lang, batch.pauseReason.code)}</strong>
            </div>
          </div>
        ) : null}

        <div className="modal-body batch-body">
          {!items.length ? <div className="empty archive-empty">{t.batchEmpty}</div> : null}
          <ol className="batch-list">
            {items.map((item, index) => {
              const isCurrent = current?.itemId === item.id;
              const pct = isCurrent ? Math.round((current?.progress ?? 0) * 100) : 0;
              return (
                <li key={item.id} className={`batch-item is-${item.status}`}>
                  <span className="batch-index">{index + 1}</span>
                  <div className="batch-main">
                    <div className="batch-name" title={item.path}>
                      {item.kind === "youtube" ? <YoutubeIcon size={15} /> : <FileMediaIcon size={15} />}{" "}
                      {item.kind === "youtube" ? <bdi dir="auto">{item.name}</bdi> : <FileName name={item.name} />}
                    </div>
                    <div className="file-meta">
                      <span className={`batch-status s-${item.status}`}>
                        {item.status === "running" ? <span className="spinner small" /> : null}
                        {item.status === "done" ? <CheckIcon size={12} /> : STAGE_ICON[item.status]} {statusText(item)}
                        {isCurrent ? ` · ${pct}%` : ""}
                      </span>
                      {item.duration ? <span>{formatDuration(item.duration, lang)}</span> : null}
                      {item.via ? (
                        <span className={`batch-via via-${item.via}`}>
                          {item.via === "captions" ? t.batchViaCaptions : t.batchViaTranscribed}
                        </span>
                      ) : null}
                      {item.course ? (
                        <span className="batch-course" title={t.batchCourse.replace("{course}", item.course)}>
                          <FolderIcon size={12} /> <bdi>{item.course}</bdi>
                        </span>
                      ) : null}
                      {item.word_count ? (
                        <span>
                          {item.word_count} {t.words}
                        </span>
                      ) : null}
                      {item.translation_status === "running" ? (
                        <span className="batch-sum">
                          <span className="spinner small" /> {t.batchTranslationRunning}
                        </span>
                      ) : item.translation_status === "done" ? (
                        <span className="batch-sum ok-text">
                          <GlobeIcon size={12} /> {t.batchTranslationDone}
                        </span>
                      ) : item.translation_status === "skipped" ? (
                        <span className="batch-sum muted">{t.batchTranslationSkipped}</span>
                      ) : item.translation_status === "error" ? (
                        <span className="batch-sum warn" title={item.translation_error?.detail}>
                          {t.batchTranslationError}: {errorMessage(lang, item.translation_error?.code)}
                        </span>
                      ) : null}
                      {item.db_status === "running" ? (
                        <span className="batch-sum">
                          <span className="spinner small" /> {t.batchDbRunning}
                        </span>
                      ) : item.db_status === "done" ? (
                        <span className="batch-sum ok-text">
                          <DatabaseIcon size={12} /> {t.batchDbDone.replace("{n}", String(item.db_inserted ?? 0))}
                        </span>
                      ) : item.db_status === "error" ? (
                        <span className="batch-sum warn" title={item.db_error?.detail}>
                          {t.batchDbError}: {errorMessage(lang, item.db_error?.code)}
                        </span>
                      ) : null}
                      {item.summary_status === "running" ? (
                        <span className="batch-sum">
                          <span className="spinner small" /> {t.batchSummaryRunning}
                        </span>
                      ) : item.summary_status === "done" ? (
                        <span className="batch-sum ok-text">
                          <SparkIcon size={12} /> {t.batchSummaryDone}
                        </span>
                      ) : item.summary_status === "error" ? (
                        <span className="batch-sum warn" title={item.summary_error?.detail}>
                          {t.batchSummaryError}: {errorMessage(lang, item.summary_error?.code)}
                        </span>
                      ) : null}
                    </div>
                    {isCurrent ? (
                      <div className="progress-bar batch-bar">
                        <div style={{ width: `${pct}%` }} />
                      </div>
                    ) : null}
                    {item.error && item.status !== "cancelled" ? (
                      <div className="batch-error" title={item.error.detail}>
                        {errorMessage(lang, item.error.code)}
                      </div>
                    ) : null}
                  </div>
                  <div className="batch-actions">
                    {item.status === "done" && item.archive_id ? (
                      <button className="btn btn-small" onClick={() => onOpen(item.archive_id!)}>
                        {t.batchOpen}
                      </button>
                    ) : null}
                    {item.status === "error" || item.status === "cancelled" ? (
                      <button className="btn btn-small" onClick={() => run(() => client.batchRetry(item.id))}>
                        <RefreshIcon size={13} /> {t.batchRetry}
                      </button>
                    ) : null}
                    {item.status === "queued" ? (
                      <>
                        <button
                          className="icon-btn"
                          title={t.batchMoveUp}
                          aria-label={t.batchMoveUp}
                          disabled={index === 0}
                          onClick={() => run(() => client.batchMove(item.id, -1))}
                        >
                          <ArrowUpIcon size={14} />
                        </button>
                        <button
                          className="icon-btn"
                          title={t.batchMoveDown}
                          aria-label={t.batchMoveDown}
                          disabled={index === items.length - 1}
                          onClick={() => run(() => client.batchMove(item.id, 1))}
                        >
                          <ArrowDownIcon size={14} />
                        </button>
                      </>
                    ) : null}
                    {item.status !== "running" ? (
                      <button
                        className="icon-btn"
                        title={t.batchRemove}
                        aria-label={t.batchRemove}
                        onClick={() => run(() => client.batchRemove(item.id))}
                      >
                        <TrashIcon size={14} />
                      </button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ol>
        </div>

        <footer className="modal-foot batch-foot">
          <div className="batch-foot-left">
            <button
              className="btn btn-subtle"
              disabled={busy || !(done || failed)}
              onClick={() => run(() => client.batchClear("finished"))}
            >
              {t.batchClearFinished}
            </button>
            <button
              className="btn btn-subtle"
              disabled={busy || !total || state !== "idle"}
              onClick={() => run(() => client.batchClear("all"))}
            >
              {t.batchClearAll}
            </button>
          </div>
          <div className="batch-foot-right">
            {state === "stopping" ? <span className="muted small">{t.batchStopping}</span> : null}
            {state === "idle" ? (
              <button
                className="btn btn-accent"
                disabled={busy || !queued}
                onClick={() =>
                  run(async () => {
                    setNote(null);
                    await onStart();
                  })
                }
              >
                <PlayIcon size={15} /> {done || failed ? t.batchResume : t.batchStart}
                {queued ? ` (${queued})` : ""}
              </button>
            ) : (
              <>
                <button
                  className="btn"
                  disabled={busy || state === "stopping"}
                  onClick={() => run(() => client.batchStop(false))}
                >
                  {t.batchStopAfter}
                </button>
                <button className="btn btn-danger" disabled={busy} onClick={() => run(() => client.batchStop(true))}>
                  <StopIcon size={14} /> {t.batchCancelNow}
                </button>
              </>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}
