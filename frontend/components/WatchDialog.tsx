"use client";

import { useEffect, useState } from "react";
import { ApiError, type BackendClient, type BatchState, type WatchState } from "@/lib/api";
import { errorMessage, type Strings, type UiLang } from "@/lib/i18n";
import type { BatchPrefs } from "./BatchDialog";
import { FileName } from "./FileName";
import { FolderIcon, FolderPlusIcon, QueueIcon, TrashIcon, WatchFolderIcon } from "./Icons";

interface Props {
  t: Strings;
  lang: UiLang;
  client: BackendClient;
  watch: WatchState | null;
  onWatch: (state: WatchState) => void;
  batch: BatchState | null;
  onBatch: (state: BatchState) => void;
  prefs: BatchPrefs;
  onPrefs: (patch: Partial<BatchPrefs>) => void;
  settingsLabel: string;
  onOpenQueue: () => void;
  onClose: () => void;
}

type Note = { kind: "ok" | "error"; text: string; detail?: string } | null;

function ago(t: Strings, ts: number | null): string {
  if (!ts) return "";
  const s = Math.max(0, Math.round(Date.now() / 1000 - ts));
  if (s < 60) return t.watchAgoNow;
  if (s < 3600) return t.watchAgoMin.replace("{n}", String(Math.round(s / 60)));
  if (s < 86400) return t.watchAgoHour.replace("{n}", String(Math.round(s / 3600)));
  return t.watchAgoDay.replace("{n}", String(Math.round(s / 86400)));
}

/** The folders the app listens to: every new video in them is transcribed automatically. */
export function WatchDialog({
  t,
  lang,
  client,
  watch,
  onWatch,
  batch,
  onBatch,
  prefs,
  onPrefs,
  settingsLabel,
  onOpenQueue,
  onClose,
}: Props) {
  const [note, setNote] = useState<Note>(null);
  const [busy, setBusy] = useState(false);
  const [includeExisting, setIncludeExisting] = useState(false);
  const [login, setLogin] = useState<{ supported: boolean; enabled: boolean } | null>(null);
  const [, setTick] = useState(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    window.desktop?.getOpenAtLogin?.().then(setLogin).catch(() => undefined);
    const id = window.setInterval(() => setTick((n) => n + 1), 30000); // refresh "5 min ago"
    return () => window.clearInterval(id);
  }, []);

  const fail = (err: unknown) => {
    const e = err instanceof ApiError ? err : new ApiError("internal", String(err));
    setNote({
      kind: "error",
      text: /already watched/i.test(e.detail) ? t.watchAlready : errorMessage(lang, e.code),
      detail: e.detail,
    });
  };

  const add = async () => {
    const picked = (await window.desktop?.openFolderDialog()) ?? [];
    if (!picked.length) return;
    setBusy(true);
    setNote(null);
    let added = 0;
    try {
      for (const path of picked) {
        const res = await client.watchAdd(path, includeExisting);
        added += res.added;
        onWatch(res);
      }
      setNote({ kind: "ok", text: added ? t.watchAddedWithFiles.replace("{added}", String(added)) : t.watchAdded });
      if (added) onBatch(await client.batchState());
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const update = async (id: string, enabled: boolean) => {
    try {
      onWatch(await client.watchUpdate(id, { enabled }));
    } catch (err) {
      fail(err);
    }
  };

  const remove = async (id: string) => {
    try {
      onWatch(await client.watchRemove(id));
    } catch (err) {
      fail(err);
    }
  };

  const setOpenAtLogin = async (on: boolean) => {
    const enabled = await window.desktop?.setOpenAtLogin?.(on);
    setLogin((l) => (l ? { ...l, enabled: Boolean(enabled) } : l));
  };

  const folders = watch?.folders ?? [];
  const active = folders.filter((f) => f.enabled && !f.error).length;
  const current = batch?.current ? batch.items.find((i) => i.id === batch.current?.itemId) : null;
  const queued = batch?.counts.queued ?? 0;

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal watch-modal" role="dialog" aria-modal="true" aria-labelledby="watch-dialog-title">
        <header className="modal-head">
          <div>
            <h2 id="watch-dialog-title">
              <WatchFolderIcon size={18} /> {t.watchTitle}
            </h2>
            <p className="hint">{t.watchHint}</p>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label={t.close}>
            ✕
          </button>
        </header>

        <div className="watch-body">
          <div className={`watch-live${active ? " is-on" : ""}`} role="status">
            <span className="watch-pulse" aria-hidden="true" />
            <div className="watch-live-text">
              <strong>{active ? t.watchLiveOn.replace("{n}", String(active)) : t.watchLiveOff}</strong>
              <span>
                {current
                  ? t.watchLiveNow.replace("{name}", current.name).replace("{p}", String(Math.round((batch?.current?.progress ?? 0) * 100)))
                  : watch?.waiting
                    ? t.watchWaiting.replace("{n}", String(watch.waiting))
                    : active
                      ? t.watchLiveIdle
                      : t.watchLiveHint}
              </span>
            </div>
            {queued || current ? (
              <button className="btn btn-subtle" onClick={onOpenQueue}>
                <QueueIcon size={15} /> {t.watchOpenQueue.replace("{n}", String(queued + (current ? 1 : 0)))}
              </button>
            ) : null}
          </div>

          <div className="watch-add-row">
            <button className="btn btn-accent" disabled={busy} onClick={add}>
              <FolderPlusIcon size={16} /> {t.watchAdd}
            </button>
            <label className="check">
              <input type="checkbox" checked={includeExisting} onChange={(e) => setIncludeExisting(e.target.checked)} />
              <span>{t.watchIncludeExisting}</span>
            </label>
          </div>

          {note ? (
            <div className={`notice ${note.kind === "ok" ? "ok" : "error"} watch-notice`} title={note.detail}>
              {note.text}
            </div>
          ) : null}

          {folders.length ? (
            <ul className="watch-list">
              {folders.map((f) => (
                <li key={f.id} className={`watch-item${f.enabled ? "" : " is-paused"}${f.error ? " is-error" : ""}`}>
                  <FolderIcon size={18} />
                  <div className="watch-main">
                    <div className="watch-name">
                      <bdi>{f.name}</bdi>
                      <span className={`watch-status${f.error ? " warn" : f.enabled ? " on" : ""}`}>
                        {f.error ? t.watchUnreachable : f.enabled ? t.watchOn : t.watchPaused}
                      </span>
                    </div>
                    <div className="watch-path" dir="ltr" title={f.path}>
                      {f.path}
                    </div>
                    <div className="watch-meta">
                      {f.added_count ? (
                        <>
                          {t.watchCount.replace("{n}", String(f.added_count))}
                          {f.last_added_name ? (
                            <>
                              {" · "}
                              {t.watchLast} <FileName name={f.last_added_name} /> {ago(t, f.last_added_at)}
                            </>
                          ) : null}
                        </>
                      ) : (
                        t.watchNothingYet
                      )}
                    </div>
                  </div>
                  <label className="check watch-toggle" title={f.enabled ? t.watchPause : t.watchResume}>
                    <input type="checkbox" checked={f.enabled} onChange={(e) => update(f.id, e.target.checked)} />
                    <span>{t.watchEnabled}</span>
                  </label>
                  <button className="icon-btn" aria-label={t.watchRemove} title={t.watchRemove} onClick={() => remove(f.id)}>
                    <TrashIcon size={15} />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="watch-empty">
              <WatchFolderIcon size={34} />
              <p>{t.watchEmpty}</p>
            </div>
          )}

          <div className="watch-settings">
            <label className="check">
              <input
                type="checkbox"
                checked={prefs.watchAutoStart !== false}
                onChange={(e) => onPrefs({ watchAutoStart: e.target.checked })}
              />
              <span>{t.watchAutoStart}</span>
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={prefs.watchBackground !== false}
                onChange={(e) => onPrefs({ watchBackground: e.target.checked })}
              />
              <span>{t.watchBackground}</span>
            </label>
            <label className="check" title={login && !login.supported ? t.watchLoginDev : undefined}>
              <input
                type="checkbox"
                checked={Boolean(login?.enabled)}
                disabled={!login?.supported}
                onChange={(e) => setOpenAtLogin(e.target.checked)}
              />
              <span>
                {t.watchLogin}
                {login && !login.supported ? <small className="muted"> — {t.watchLoginDev}</small> : null}
              </span>
            </label>
            <p className="muted small watch-using">
              {t.batchUsing} {settingsLabel}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
