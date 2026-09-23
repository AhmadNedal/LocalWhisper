"use client";

import { useEffect, useState } from "react";
import { ApiError, type BackendClient, type BurnTask } from "@/lib/api";
import { errorMessage, type Strings, type UiLang } from "@/lib/i18n";
import { usePersistentState } from "@/lib/useBackend";
import { AlertIcon, CheckIcon, FilmIcon } from "./Icons";

interface Props {
  t: Strings;
  lang: UiLang;
  client: BackendClient;
  source: string;
  mediaName: string;
  duration: number | null;
  segments: { start: number; end: number; text: string }[];
  translation: { start: number; end: number; text: string }[] | null;
  translationName: string;
  onClose: () => void;
}

interface BurnPrefs {
  content: "original" | "translation" | "both";
  size: "small" | "medium" | "large";
  style: "box" | "outline";
}

function eta(seconds: number | null, lang: UiLang): string {
  if (seconds == null) return "";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return lang === "ar" ? (m ? `${m} د ${s} ث` : `${s} ث`) : m ? `${m}m ${s}s` : `${s}s`;
}

/** "Video with subtitles": writes a new MP4 with the text drawn on the picture. */
export function BurnDialog({ t, lang, client, source, mediaName, duration, segments, translation, translationName, onClose }: Props) {
  const [prefs, setPrefs] = usePersistentState<BurnPrefs>("burn-prefs", { content: "original", size: "medium", style: "box" });
  const [task, setTask] = useState<BurnTask | null>(null);
  const [error, setError] = useState<{ code: string; detail: string } | null>(null);
  const running = task?.status === "running";
  const content = translation?.length ? prefs.content : "original";

  useEffect(() => {
    if (!task || task.status !== "running") return;
    const timer = setInterval(async () => {
      try {
        setTask(await client.burnStatus(task.id));
      } catch (err) {
        if (err instanceof ApiError) setError({ code: err.code, detail: err.detail });
      }
    }, 700);
    return () => clearInterval(timer);
  }, [client, task]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !running && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, running]);

  const start = async (saveAs: boolean) => {
    setError(null);
    let outputPath: string | null = null;
    if (saveAs) {
      const base = mediaName.replace(/\.[^.]+$/, "");
      outputPath = (await window.desktop?.saveFileDialog(`${base} (${t.burnSuffix}).mp4`, "mp4")) ?? null;
      if (!outputPath) return;
    }
    try {
      setTask(
        await client.burnStart({
          source,
          output_path: outputPath,
          media_name: mediaName,
          segments,
          translation: translation?.length ? translation : null,
          content,
          size: prefs.size,
          style: prefs.style,
          duration,
        }),
      );
    } catch (err) {
      if (err instanceof ApiError) setError({ code: err.code, detail: err.detail });
    }
  };

  const set = (patch: Partial<BurnPrefs>) => setPrefs((p) => ({ ...p, ...patch }));
  const pct = Math.round((task?.progress ?? 0) * 100);
  const err = error ?? task?.error ?? null;

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && !running && onClose()}>
      <div className="modal burn-modal" role="dialog" aria-modal="true" aria-labelledby="burn-title">
        <header className="modal-head">
          <div>
            <h2 id="burn-title">
              <FilmIcon size={18} /> {t.burnTitle}
            </h2>
            <p className="hint">{t.burnHint}</p>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label={t.close} disabled={running}>
            ✕
          </button>
        </header>
        <div className="modal-body burn-body">
          {translation?.length ? (
            <div className="field-row">
              <span className="muted">{t.burnText}</span>
              <div className="segmented compact">
                {(
                  [
                    ["original", t.exportContentOriginal],
                    ["both", t.exportContentBoth],
                    ["translation", `${t.exportContentTranslation}${translationName ? ` (${translationName})` : ""}`],
                  ] as const
                ).map(([id, label]) => (
                  <button key={id} disabled={running} className={content === id ? "is-active" : ""} onClick={() => set({ content: id })}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          <div className="field-row">
            <span className="muted">{t.burnSize}</span>
            <div className="segmented compact">
              {(
                [
                  ["small", t.burnSmall],
                  ["medium", t.burnMedium],
                  ["large", t.burnLarge],
                ] as const
              ).map(([id, label]) => (
                <button key={id} disabled={running} className={prefs.size === id ? "is-active" : ""} onClick={() => set({ size: id })}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="field-row">
            <span className="muted">{t.burnStyle}</span>
            <div className="segmented compact">
              {(
                [
                  ["box", t.burnBox],
                  ["outline", t.burnOutline],
                ] as const
              ).map(([id, label]) => (
                <button key={id} disabled={running} className={prefs.style === id ? "is-active" : ""} onClick={() => set({ style: id })}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className={`burn-preview style-${prefs.style} size-${prefs.size}`} aria-hidden="true">
            <span className="burn-line" dir="auto">
              {content === "translation" ? (translation?.[0]?.text ?? segments[0]?.text) : segments[0]?.text}
            </span>
            {content === "both" ? (
              <span className="burn-line alt" dir="auto">
                {translation?.[0]?.text}
              </span>
            ) : null}
          </div>
          <p className="hint">{t.burnNote}</p>

          {task ? (
            <div className="course-progress">
              <div className="progress-bar">
                <div style={{ width: `${pct}%` }} />
              </div>
              <div className="small">
                {running
                  ? `${t.burnWorking} ${pct}%${task.etaSeconds != null ? ` · ${t.remaining} ${eta(task.etaSeconds, lang)}` : ""}`
                  : task.status === "completed"
                    ? null
                    : task.status === "cancelled"
                      ? t.cancelled
                      : null}
              </div>
            </div>
          ) : null}
          {task?.status === "completed" ? (
            <div className="notice ok">
              <CheckIcon size={16} />
              <div className="saved">
                <div>{t.burnDone}</div>
                <code dir="ltr" title={task.output}>
                  {task.output}
                </code>
                <div className="saved-actions">
                  <button className="link-btn" onClick={() => window.desktop?.openPath(task.output)}>
                    {t.openPdf}
                  </button>
                  <button className="link-btn" onClick={() => window.desktop?.showItemInFolder(task.output)}>
                    {t.showInFolder}
                  </button>
                </div>
              </div>
            </div>
          ) : null}
          {err ? (
            <div className="notice error">
              <AlertIcon size={16} />
              <div>
                <div>{errorMessage(lang, err.code)}</div>
                {err.detail ? (
                  <details>
                    <summary>{t.details}</summary>
                    <code dir="ltr">{err.detail}</code>
                  </details>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
        <footer className="modal-foot">
          {running ? (
            <button className="btn" onClick={() => task && client.burnCancel(task.id)}>
              {t.summaryCancel}
            </button>
          ) : (
            <>
              <button className="btn btn-accent" onClick={() => start(false)}>
                <FilmIcon size={15} /> {t.burnStart}
              </button>
              <button className="btn" onClick={() => start(true)}>
                {t.exportSaveAs}
              </button>
            </>
          )}
          <span className="batch-spacer" />
          <button className="btn btn-subtle" onClick={onClose} disabled={running}>
            {t.close}
          </button>
        </footer>
      </div>
    </div>
  );
}
