"use client";

import { useEffect, useRef, useState } from "react";
import type { UpdateState } from "@/lib/desktop";
import type { Strings } from "@/lib/i18n";
import { DownloadIcon, RefreshIcon } from "./Icons";

interface Props {
  t: Strings;
  /** A transcription / queue is running: restarting would stop it, so ask twice. */
  busy: boolean;
}

/**
 * Title-bar control for automatic updates (installed app only):
 * a quiet "check for updates" button, the download progress, then
 * "Restart to update" once the new version is ready.
 */
export function UpdateButton({ t, busy }: Props) {
  const [state, setState] = useState<UpdateState | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const d = window.desktop;
    if (!d?.updateGet) return;
    d.updateGet().then(setState).catch(() => undefined);
    return d.onUpdateState?.(setState);
  }, []);

  // After a manual check: say "up to date" / the error briefly.
  useEffect(() => {
    if (!state?.manual) return;
    if (state.status === "none" || state.status === "error") {
      setFlash(state.status === "none" ? t.updateNone.replace("{v}", state.current) : t.updateError);
      if (flashTimer.current) clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => setFlash(null), 6000);
    }
  }, [state, t]);

  useEffect(() => {
    if (!confirm) return;
    const id = setTimeout(() => setConfirm(false), 6000);
    return () => clearTimeout(id);
  }, [confirm]);

  if (!state || state.status === "disabled") return null;

  if (state.status === "ready") {
    const install = () => {
      if (busy && !confirm) {
        setConfirm(true);
        return;
      }
      void window.desktop?.updateInstall?.();
    };
    return (
      <button
        className={`btn update-btn is-ready${confirm ? " is-confirm" : ""}`}
        onClick={install}
        title={t.updateReadyHint.replace("{v}", state.version ?? "")}
      >
        <DownloadIcon size={16} />
        {confirm ? t.updateConfirmBusy : t.updateReady.replace("{v}", state.version ?? "")}
      </button>
    );
  }

  if (state.status === "available" || state.status === "downloading") {
    const pct = Math.round((state.progress || 0) * 100);
    return (
      <span className="pill update-pill" title={t.updateDownloadingHint.replace("{v}", state.version ?? "")}>
        <span className="spinner small" />
        {t.updateDownloading.replace("{v}", state.version ?? "").replace("{p}", String(pct))}
      </span>
    );
  }

  const checking = state.status === "checking";
  return (
    <button
      className={`btn btn-subtle update-btn${flash ? " has-flash" : ""}`}
      onClick={() => {
        setFlash(null);
        void window.desktop?.updateCheck?.();
      }}
      disabled={checking}
      title={`${t.updateCheck} — ${t.updateCurrent.replace("{v}", state.current)}${state.error ? `\n${state.error}` : ""}`}
      aria-label={t.updateCheck}
    >
      <RefreshIcon size={16} className={checking ? "spin" : undefined} />
      {checking ? <span>{t.updateChecking}</span> : flash ? <span>{flash}</span> : null}
    </button>
  );
}
