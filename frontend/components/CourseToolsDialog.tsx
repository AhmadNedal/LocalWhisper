"use client";

import { useEffect, useMemo, useState } from "react";
import { ApiError, type BackendClient, type CourseLesson, type CourseTaskState, type DbPreviewResult } from "@/lib/api";
import { loadUsableProfiles, profileToDb } from "@/lib/dbProfiles";
import type { DbProfile } from "@/lib/desktop";
import { formatDuration } from "@/lib/format";
import { errorMessage, type Strings, type UiLang } from "@/lib/i18n";
import { usePersistentState } from "@/lib/useBackend";
import { FileName } from "./FileName";
import { AlertIcon, CheckIcon, DatabaseIcon, FolderIcon, GlobeIcon, SparkIcon, WebIcon } from "./Icons";

export type CourseToolMode = "db" | "export";

interface Props {
  t: Strings;
  lang: UiLang;
  client: BackendClient;
  course: string;
  mode: CourseToolMode;
  onClose: () => void;
}

interface ExportPrefs {
  pdf: boolean;
  pdfTimestamps: boolean;
  pdfContent: "original" | "both" | "translation";
  includeSummary: boolean;
  subtitles: boolean;
  subtitlesTranslation: boolean;
  subtitleFormat: "srt" | "vtt";
  website?: boolean;
  documents?: ("docx" | "txt" | "json")[];
}

const DEFAULT_EXPORT: ExportPrefs = {
  pdf: true,
  pdfTimestamps: false,
  pdfContent: "both",
  includeSummary: true,
  subtitles: true,
  subtitlesTranslation: true,
  subtitleFormat: "srt",
  website: true,
  documents: [],
};

type Err = { code: string; detail: string } | null;
const toErr = (err: unknown): Err =>
  err instanceof ApiError ? { code: err.code, detail: err.detail } : { code: "internal", detail: String(err) };

/** "Insert the whole course into a database" and "Export the whole course" (PDF + subtitles). */
export function CourseToolsDialog({ t, lang, client, course, mode, onClose }: Props) {
  const [lessons, setLessons] = useState<CourseLesson[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [profiles, setProfiles] = useState<DbProfile[] | null>(null);
  const [profileId, setProfileId] = usePersistentState<string>("course-db-profile", "");
  const [exportPrefs, setExportPrefs] = usePersistentState<ExportPrefs>("course-export", DEFAULT_EXPORT);
  const [destDir, setDestDir] = useState<string | null>(null);
  const [preview, setPreview] = useState<(DbPreviewResult & { lessonTitle: string; lessonIndex: number }) | null>(null);
  const [task, setTask] = useState<CourseTaskState | null>(null);
  const [error, setError] = useState<Err>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    client
      .courseLessons(course)
      .then((list) => {
        setLessons(list);
        setSelected(new Set(list.map((l) => l.id)));
      })
      .catch((err) => setError(toErr(err)));
    if (mode === "db") loadUsableProfiles().then(setProfiles);
  }, [client, course, mode]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

  // Follow the running task.
  const running = task?.status === "running";
  const taskId = task?.id;
  useEffect(() => {
    if (!taskId || !running) return;
    const timer = setInterval(async () => {
      try {
        setTask(await client.courseTask(taskId));
      } catch (err) {
        setError(toErr(err));
      }
    }, 600);
    return () => clearInterval(timer);
  }, [client, taskId, running]);

  const profile = profiles?.find((p) => p.id === profileId) ?? profiles?.[0] ?? null;
  const ids = useMemo(
    () => (selected.size === lessons.length ? null : lessons.filter((l) => selected.has(l.id)).map((l) => l.id)),
    [selected, lessons],
  );
  const count = selected.size;
  const anyTranslation = lessons.some((l) => l.has_translation && selected.has(l.id));
  const anySummary = lessons.some((l) => l.has_summary && selected.has(l.id));

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const doPreview = async () => {
    if (!profile) return;
    setError(null);
    setBusy(true);
    try {
      setPreview(await client.courseDbPreview(course, ids, profileToDb(profile)));
    } catch (err) {
      setError(toErr(err));
    } finally {
      setBusy(false);
    }
  };

  const runDb = async () => {
    if (!profile || !count) return;
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setConfirming(false);
    setError(null);
    try {
      setTask(await client.courseDbStart(course, ids, profileToDb(profile)));
    } catch (err) {
      setError(toErr(err));
    }
  };

  const runExport = async () => {
    if (!count) return;
    setError(null);
    try {
      setTask(
        await client.courseExportStart({
          course,
          ids,
          dest_dir: destDir,
          pdf: exportPrefs.pdf,
          pdf_timestamps: exportPrefs.pdfTimestamps,
          pdf_content: exportPrefs.pdfContent,
          include_summary: exportPrefs.includeSummary,
          subtitles: exportPrefs.subtitles,
          subtitles_translation: exportPrefs.subtitlesTranslation,
          subtitle_format: exportPrefs.subtitleFormat,
          ui_language: lang,
          documents: exportPrefs.documents ?? [],
          website: Boolean(exportPrefs.website),
        }),
      );
    } catch (err) {
      setError(toErr(err));
    }
  };

  const failed = task?.results.filter((r) => !r.ok) ?? [];
  const pct = task && task.total ? Math.round((task.done / task.total) * 100) : 0;
  const setPref = (patch: Partial<ExportPrefs>) => setExportPrefs((p) => ({ ...p, ...patch }));

  return (
    <div className="modal-backdrop nested" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && !running && onClose()}>
      <div className="modal course-tools" role="dialog" aria-modal="true" aria-labelledby="course-tools-title">
        <header className="modal-head">
          <div>
            <h2 id="course-tools-title">
              {mode === "db" ? <DatabaseIcon size={18} /> : <FolderIcon size={18} />}{" "}
              {(mode === "db" ? t.courseDbTitle : t.courseExportTitle).replace("{course}", course)}
            </h2>
            <p className="hint">{mode === "db" ? t.courseDbHint : t.courseExportHint}</p>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label={t.close} disabled={running}>
            ✕
          </button>
        </header>

        <div className="modal-body course-tools-body">
          {mode === "db" ? (
            profiles === null ? null : profiles.length === 0 ? (
              <div className="notice warn">
                <AlertIcon size={16} /> {t.courseDbNoProfiles}
              </div>
            ) : (
              <div className="course-settings">
                <label className="field">
                  <span>{t.courseDbProfile}</span>
                  <select
                    value={profile?.id ?? ""}
                    disabled={running}
                    onChange={(e) => {
                      setProfileId(e.target.value);
                      setPreview(null);
                      setConfirming(false);
                    }}
                  >
                    {profiles.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
                {profile ? <pre className="sql-view" dir="ltr">{profile.sql}</pre> : null}
                <p className="hint">{t.courseDbVarsHint}</p>
              </div>
            )
          ) : (
            <div className="course-settings export-grid">
              <label className={`check site-option${exportPrefs.website ? " is-on" : ""}`}>
                <input type="checkbox" checked={Boolean(exportPrefs.website)} onChange={(e) => setPref({ website: e.target.checked })} />
                <span>
                  <strong>
                    <WebIcon size={15} /> {t.courseExportWebsite}
                  </strong>
                  <small className="muted">{t.courseExportWebsiteHint}</small>
                </span>
              </label>
              <label className="check">
                <input type="checkbox" checked={exportPrefs.pdf} onChange={(e) => setPref({ pdf: e.target.checked })} />
                <span>{t.courseExportPdf}</span>
              </label>
              {exportPrefs.pdf ? (
                <div className="sub-options">
                  <div className="segmented compact">
                    <button className={!exportPrefs.pdfTimestamps ? "is-active" : ""} onClick={() => setPref({ pdfTimestamps: false })}>
                      {t.exportModeReading}
                    </button>
                    <button className={exportPrefs.pdfTimestamps ? "is-active" : ""} onClick={() => setPref({ pdfTimestamps: true })}>
                      {t.exportModeTimed}
                    </button>
                  </div>
                  {anyTranslation ? (
                    <div className="segmented compact">
                      {(
                        [
                          ["original", t.exportContentOriginal],
                          ["both", t.exportContentBoth],
                          ["translation", t.exportContentTranslation],
                        ] as const
                      ).map(([id, label]) => (
                        <button key={id} className={exportPrefs.pdfContent === id ? "is-active" : ""} onClick={() => setPref({ pdfContent: id })}>
                          {label}
                        </button>
                      ))}
                    </div>
                  ) : null}
                  {anySummary ? (
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={exportPrefs.includeSummary}
                        onChange={(e) => setPref({ includeSummary: e.target.checked })}
                      />
                      <span>
                        <SparkIcon size={13} /> {t.includeSummary}
                      </span>
                    </label>
                  ) : null}
                </div>
              ) : null}
              <label className="check">
                <input type="checkbox" checked={exportPrefs.subtitles} onChange={(e) => setPref({ subtitles: e.target.checked })} />
                <span>{t.courseExportSubtitles}</span>
              </label>
              {anyTranslation ? (
                <label className="check">
                  <input
                    type="checkbox"
                    checked={exportPrefs.subtitlesTranslation}
                    onChange={(e) => setPref({ subtitlesTranslation: e.target.checked })}
                  />
                  <span>
                    <GlobeIcon size={13} /> {t.courseExportSubtitlesTranslation}
                  </span>
                </label>
              ) : null}
              <div className="doc-formats">
                <span className="muted">{t.courseExportFormats}:</span>
                {(
                  [
                    ["docx", "Word"],
                    ["txt", t.exportTxt],
                    ["json", "JSON"],
                  ] as const
                ).map(([id, label]) => {
                  const on = (exportPrefs.documents ?? []).includes(id);
                  return (
                    <label key={id} className="check">
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() =>
                          setPref({
                            documents: on ? (exportPrefs.documents ?? []).filter((f) => f !== id) : [...(exportPrefs.documents ?? []), id],
                          })
                        }
                      />
                      <span>{label}</span>
                    </label>
                  );
                })}
              </div>
              {exportPrefs.subtitles || (anyTranslation && exportPrefs.subtitlesTranslation) ? (
                <label className="inline-select">
                  <span>{t.subtitlesTitle}</span>
                  <select
                    value={exportPrefs.subtitleFormat}
                    onChange={(e) => setPref({ subtitleFormat: e.target.value as "srt" | "vtt" })}
                  >
                    <option value="srt">SRT</option>
                    <option value="vtt">VTT</option>
                  </select>
                </label>
              ) : null}
              <div className="dest-row">
                <span className="muted">{t.courseExportDest}:</span>
                <code dir="ltr" title={destDir ?? ""}>
                  {destDir ?? t.courseExportDestDefault.replace("{course}", course)}
                </code>
                <button
                  className="btn btn-small"
                  disabled={running}
                  onClick={async () => {
                    const picked = (await window.desktop?.openFolderDialog())?.[0];
                    if (picked) setDestDir(picked);
                  }}
                >
                  {t.courseExportChange}
                </button>
              </div>
            </div>
          )}

          <div className="lesson-head">
            <strong>{t.courseLessons.replace("{n}", String(count)).replace("{total}", String(lessons.length))}</strong>
            <button
              className="link-btn"
              disabled={running}
              onClick={() => setSelected(count === lessons.length ? new Set() : new Set(lessons.map((l) => l.id)))}
            >
              {count === lessons.length ? t.courseSelectNone : t.courseSelectAll}
            </button>
          </div>
          <ol className="lesson-list">
            {lessons.map((l) => {
              const result = task?.results.find((r) => r.id === l.id);
              return (
                <li key={l.id} className={selected.has(l.id) ? "" : "is-off"}>
                  <label className="check">
                    <input type="checkbox" checked={selected.has(l.id)} disabled={running} onChange={() => toggle(l.id)} />
                    <span className="lesson-index">{l.index}</span>
                    <span className="lesson-title">
                      <FileName name={l.title} />
                    </span>
                  </label>
                  <span className="lesson-meta">
                    {l.duration ? <span className="muted small">{formatDuration(l.duration, lang)}</span> : null}
                    {l.has_translation ? <GlobeIcon size={12} /> : null}
                    {l.has_summary ? <SparkIcon size={12} /> : null}
                    {result ? (
                      result.ok ? (
                        <span className="ok-text small">
                          <CheckIcon size={12} />{" "}
                          {result.inserted !== undefined ? t.courseInsertedRows.replace("{n}", String(result.inserted)) : t.courseExported}
                        </span>
                      ) : (
                        <span className="warn small" title={result.error?.detail}>
                          <AlertIcon size={12} /> {errorMessage(lang, result.error?.code)}
                        </span>
                      )
                    ) : task?.current === l.title && running ? (
                      <span className="spinner small" />
                    ) : null}
                  </span>
                </li>
              );
            })}
          </ol>

          {preview ? (
            <div className="course-preview">
              <div className="muted small">
                {t.coursePreviewOf.replace("{index}", String(preview.lessonIndex)).replace("{title}", preview.lessonTitle)} ·{" "}
                {t.dbRows}: {preview.rowCount}
              </div>
              {preview.unknown.length ? (
                <div className="notice warn">
                  <AlertIcon size={14} /> {t.dbUnknownVars} <code dir="ltr">{preview.unknown.join(", ")}</code>
                </div>
              ) : null}
              <div className="table-wrap">
                <table className="preview-table" dir="ltr">
                  <thead>
                    <tr>
                      {preview.used.map((v) => (
                        <th key={v}>@{v}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {preview.sample.map((row, i) => (
                      <tr key={i}>
                        {preview.used.map((v) => (
                          <td key={v} dir="auto">
                            {row[v] === null || row[v] === undefined ? <span className="muted">NULL</span> : String(row[v]).slice(0, 120)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}

          {task ? (
            <div className="course-progress">
              <div className="progress-bar">
                <div style={{ width: `${pct}%` }} />
              </div>
              <div className="small">
                {running
                  ? t.courseProgress.replace("{done}", String(task.done)).replace("{total}", String(task.total))
                  : task.status === "completed"
                    ? (mode === "db" ? t.courseDbDone : t.courseExportDone)
                        .replace("{ok}", String(task.results.filter((r) => r.ok).length))
                        .replace("{failed}", String(failed.length))
                    : task.status === "cancelled"
                      ? t.cancelled
                      : null}
              </div>
            </div>
          ) : null}

          {error || task?.error ? (
            <div className="notice error">
              <AlertIcon size={16} />
              <div>
                <div>{errorMessage(lang, (error ?? task?.error)?.code)}</div>
                {(error ?? task?.error)?.detail ? <code dir="ltr">{(error ?? task?.error)?.detail}</code> : null}
              </div>
            </div>
          ) : null}
        </div>

        <footer className="modal-foot course-foot">
          {running ? (
            <button className="btn" onClick={() => task && client.courseTaskCancel(task.id)}>
              {t.summaryCancel}
            </button>
          ) : mode === "db" ? (
            <>
              <button className="btn" disabled={!profile || !count || busy} onClick={doPreview}>
                {t.dbPreview}
              </button>
              <button
                className={`btn ${confirming ? "btn-danger" : "btn-accent"}`}
                disabled={!profile || !count}
                onClick={runDb}
                onBlur={() => setConfirming(false)}
              >
                <DatabaseIcon size={15} />{" "}
                {confirming ? t.courseDbConfirm.replace("{n}", String(count)) : t.courseDbRun.replace("{n}", String(count))}
              </button>
            </>
          ) : (
            <>
              <button
                className="btn btn-accent"
                disabled={
                  !count ||
                  !(
                    exportPrefs.pdf ||
                    exportPrefs.subtitles ||
                    exportPrefs.website ||
                    (exportPrefs.documents ?? []).length ||
                    (anyTranslation && exportPrefs.subtitlesTranslation)
                  )
                }
                onClick={runExport}
              >
                <FolderIcon size={15} /> {t.courseExportRun.replace("{n}", String(count))}
              </button>
              {task?.status === "completed" && task.siteIndex ? (
                <button className="btn" onClick={() => window.desktop?.openPath(task.siteIndex!)}>
                  <WebIcon size={15} /> {t.courseOpenWebsite}
                </button>
              ) : null}
              {task?.status === "completed" && task.outputDir ? (
                <button className="btn" onClick={() => window.desktop?.openPath(task.outputDir!)}>
                  {t.courseOpenFolder}
                </button>
              ) : null}
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
