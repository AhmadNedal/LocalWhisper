"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError,
  type BackendClient,
  type DbInsertParams,
  type DbPreviewResult,
  type DbTestResult,
  type Segment,
  type AiSummary,
} from "@/lib/api";
import type { DbMode, DbProfile, DbType } from "@/lib/desktop";
import { errorMessage, type Strings, type UiLang } from "@/lib/i18n";
import { AlertIcon, CheckIcon, TrashIcon } from "./Icons";

interface Props {
  t: Strings;
  lang: UiLang;
  client: BackendClient;
  segments: Segment[];
  fileName: string;
  filePath: string;
  language: string;
  model: string;
  duration: number | null;
  translation?: { start: number; end: number; text: string }[] | null;
  translationLanguage?: string;
  summary?: AiSummary | null;
  course?: string | null;
  onClose: () => void;
}

type Err = { code: string; detail: string } | null;

const DB_TYPES: { id: DbType; label: string }[] = [
  { id: "sqlserver", label: "SQL Server" },
  { id: "oracle", label: "Oracle" },
  { id: "mysql", label: "MySQL / MariaDB" },
  { id: "postgresql", label: "PostgreSQL" },
];

const CONNECTION_EXAMPLES: Record<DbType, string> = {
  sqlserver: "Server=myserver,1433;Database=MyDb;User Id=myuser;Password=mypassword;TrustServerCertificate=True;",
  oracle: "myuser/mypassword@myhost:1521/ORCLPDB1",
  mysql: "Server=myhost;Port=3306;Database=mydb;Uid=myuser;Pwd=mypassword;",
  postgresql: "Host=myhost;Port=5432;Database=mydb;Username=myuser;Password=mypassword",
};

const SQL_EXAMPLES: Record<DbType, { pre: string; sql: string }> = {
  sqlserver: {
    pre: "DELETE FROM LessonTranscripts WHERE LessonId = @lesson_id;",
    sql: "INSERT INTO LessonTranscripts (LessonId, StartSeconds, EndSeconds, [Text])\nVALUES (@lesson_id, @start_seconds, @end_seconds, @text);",
  },
  oracle: {
    pre: "DELETE FROM LESSON_TRANSCRIPTS WHERE LESSON_ID = :lesson_id",
    sql: "INSERT INTO LESSON_TRANSCRIPTS (LESSON_ID, START_SECONDS, END_SECONDS, TEXT_CONTENT)\nVALUES (:lesson_id, :start_seconds, :end_seconds, :text)",
  },
  mysql: {
    pre: "DELETE FROM lesson_transcripts WHERE lesson_id = @lesson_id;",
    sql: "INSERT INTO lesson_transcripts (lesson_id, start_seconds, end_seconds, `text`)\nVALUES (@lesson_id, @start_seconds, @end_seconds, @text);",
  },
  postgresql: {
    pre: "DELETE FROM lesson_transcripts WHERE lesson_id = @lesson_id;",
    sql: "INSERT INTO lesson_transcripts (lesson_id, start_seconds, end_seconds, text)\nVALUES (@lesson_id, @start_seconds, @end_seconds, @text);",
  },
};

const ROW_VARS = ["text", "start_seconds", "end_seconds", "start_time", "end_time", "segment_index"];
const FILE_VARS = ["file_name", "file_path", "language", "model", "duration_seconds", "segment_count", "full_text", "transcribed_at"];
/** Filled from the translation, the AI summary and the archive (NULL when missing). */
const EXTRA_VARS: { name: string; needs: "translation" | "summary" | "course" }[] = [
  { name: "translation", needs: "translation" },
  { name: "text_en", needs: "translation" },
  { name: "full_translation", needs: "translation" },
  { name: "full_text_en", needs: "translation" },
  { name: "translation_language", needs: "translation" },
  { name: "summary", needs: "summary" },
  { name: "key_points", needs: "summary" },
  { name: "chapters", needs: "summary" },
  { name: "chapters_json", needs: "summary" },
  { name: "keywords", needs: "summary" },
  { name: "course", needs: "course" },
];
const LAST_PROFILE_KEY = "db-last-profile";

function newProfile(): DbProfile {
  return {
    id: "",
    name: "",
    dbType: "sqlserver",
    connectionString: "",
    sql: "",
    preSql: "",
    mode: "chunks",
    chunkSeconds: 10,
    variables: [{ name: "lesson_id", value: "" }],
  };
}

function toErr(err: unknown): Err {
  if (err instanceof ApiError) return { code: err.code, detail: err.detail };
  return { code: "internal", detail: err instanceof Error ? err.message : String(err) };
}

export function DatabaseDialog({
  t,
  lang,
  client,
  segments,
  fileName,
  filePath,
  language,
  model,
  duration,
  translation,
  translationLanguage,
  summary,
  course,
  onClose,
}: Props) {
  const [profiles, setProfiles] = useState<DbProfile[]>([]);
  const [form, setForm] = useState<DbProfile>(newProfile);
  const [showConn, setShowConn] = useState(false);
  const [busy, setBusy] = useState<"" | "test" | "preview" | "execute" | "save">("");
  const [testResult, setTestResult] = useState<DbTestResult | null>(null);
  const [preview, setPreview] = useState<DbPreviewResult | null>(null);
  const [confirming, setConfirming] = useState<number | null>(null);
  const [done, setDone] = useState<number | null>(null);
  const [error, setError] = useState<Err>(null);
  const [notice, setNotice] = useState("");
  const sqlRef = useRef<HTMLTextAreaElement>(null);
  const preRef = useRef<HTMLTextAreaElement>(null);
  const lastFocused = useRef<"sql" | "pre">("sql");

  // Load saved profiles once; reopen the last one used.
  useEffect(() => {
    window.desktop?.loadDbProfiles().then((list) => {
      setProfiles(list);
      let lastId = "";
      try {
        lastId = window.localStorage.getItem(LAST_PROFILE_KEY) ?? "";
      } catch {
        /* ignore */
      }
      const last = list.find((p) => p.id === lastId) ?? list[0];
      if (last) setForm({ ...newProfile(), ...last });
    });
  }, []);

  // Close with Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && busy !== "execute" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const update = useCallback((patch: Partial<DbProfile>) => {
    setForm((f) => ({ ...f, ...patch }));
    setPreview(null);
    setConfirming(null);
    setDone(null);
    setError(null);
    if ("connectionString" in patch || "dbType" in patch) setTestResult(null);
  }, []);

  const params = useMemo<DbInsertParams>(
    () => ({
      db_type: form.dbType,
      connection_string: form.connectionString,
      sql: form.sql,
      pre_sql: form.preSql,
      mode: form.mode,
      chunk_seconds: Math.max(1, Math.round(form.chunkSeconds || 10)),
      variables: Object.fromEntries(form.variables.filter((v) => v.name.trim()).map((v) => [v.name.trim(), v.value])),
      file_name: fileName,
      file_path: filePath,
      language,
      model,
      duration,
      segments: segments.filter((s) => s.text.trim()).map(({ start, end, text }) => ({ start, end, text })),
      translation: translation ?? null,
      translation_language: translationLanguage ?? "",
      summary: summary ?? null,
      course: course ?? "",
    }),
    [form, fileName, filePath, language, model, duration, segments, translation, translationLanguage, summary, course],
  );

  // ---- actions --------------------------------------------------------------
  const run = async <T,>(kind: typeof busy, fn: () => Promise<T>): Promise<T | null> => {
    setBusy(kind);
    setError(null);
    try {
      return await fn();
    } catch (err) {
      setError(toErr(err));
      return null;
    } finally {
      setBusy("");
    }
  };

  const testConnection = async () => {
    setTestResult(null);
    const r = await run("test", () => client.dbTest({ db_type: form.dbType, connection_string: form.connectionString }));
    if (r) setTestResult(r);
  };

  const doPreview = async () => {
    setDone(null);
    const r = await run("preview", () => client.dbPreview(params));
    if (r) setPreview(r);
    return r;
  };

  const execute = async () => {
    if (confirming === null) {
      const p = preview ?? (await doPreview());
      if (p) setConfirming(p.rowCount);
      return;
    }
    setConfirming(null);
    const r = await run("execute", () => client.dbExecute(params));
    if (r) {
      setDone(r.inserted);
      void saveProfile(true); // remember what worked
    }
  };

  const saveProfile = async (silent = false) => {
    if (!window.desktop) return;
    const id = form.id || `p${Date.now().toString(36)}`;
    const name = form.name.trim() || DB_TYPES.find((d) => d.id === form.dbType)?.label || "Database";
    const saved: DbProfile = { ...form, id, name };
    const next = profiles.some((p) => p.id === id) ? profiles.map((p) => (p.id === id ? saved : p)) : [...profiles, saved];
    setBusy((b) => b || "save");
    try {
      const res = await window.desktop.saveDbProfiles(next);
      setProfiles(next);
      setForm(saved);
      try {
        window.localStorage.setItem(LAST_PROFILE_KEY, id);
      } catch {
        /* ignore */
      }
      if (!silent) setNotice(res.encrypted ? t.dbSaved : t.dbNotEncrypted);
      if (!silent) setTimeout(() => setNotice(""), 2500);
    } finally {
      setBusy((b) => (b === "save" ? "" : b));
    }
  };

  const deleteProfile = async () => {
    if (!form.id || !window.desktop) return;
    const next = profiles.filter((p) => p.id !== form.id);
    await window.desktop.saveDbProfiles(next);
    setProfiles(next);
    setForm(newProfile());
  };

  const selectProfile = (id: string) => {
    const p = profiles.find((x) => x.id === id);
    setForm(p ? { ...newProfile(), ...p } : newProfile());
    setPreview(null);
    setTestResult(null);
    setConfirming(null);
    setDone(null);
    setError(null);
    try {
      window.localStorage.setItem(LAST_PROFILE_KEY, id);
    } catch {
      /* ignore */
    }
  };

  const insertVariable = (name: string) => {
    const target = lastFocused.current === "pre" ? preRef.current : sqlRef.current;
    const key = lastFocused.current === "pre" ? "preSql" : "sql";
    const token = `${form.dbType === "oracle" ? ":" : "@"}${name}`;
    if (!target) return;
    const { selectionStart: s, selectionEnd: e, value } = target;
    const next = value.slice(0, s) + token + value.slice(e);
    update({ [key]: next } as Partial<DbProfile>);
    requestAnimationFrame(() => {
      target.focus();
      target.selectionStart = target.selectionEnd = s + token.length;
    });
  };

  const fillExample = () => {
    const ex = SQL_EXAMPLES[form.dbType];
    const vars = form.variables.some((v) => v.name === "lesson_id")
      ? form.variables
      : [...form.variables, { name: "lesson_id", value: "" }];
    update({ sql: ex.sql, preSql: ex.pre, variables: vars });
  };

  const customNames = form.variables.map((v) => v.name.trim()).filter(Boolean);
  const hasTranscript = params.segments.length > 0;
  const canRun = hasTranscript && form.connectionString.trim() && form.sql.trim() && !busy;

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="db-title">
        <header className="modal-head">
          <div>
            <h2 id="db-title">{t.dbTitle}</h2>
            <p className="hint">{t.dbSubtitle}</p>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label={t.close} disabled={busy === "execute"}>
            ✕
          </button>
        </header>

        <div className="modal-body">
          {!hasTranscript ? (
            <div className="notice warn">
              <AlertIcon size={16} /> {t.dbNoTranscript}
            </div>
          ) : null}

          {/* ---- Profile ---------------------------------------------------- */}
          <div className="db-grid">
            <label className="field">
              <span className="field-label">{t.dbProfile}</span>
              <select value={form.id} onChange={(e) => selectProfile(e.target.value)}>
                <option value="">{t.dbNewProfile}</option>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field-label">{t.dbProfileName}</span>
              <input
                type="text"
                value={form.name}
                placeholder={t.dbProfileNamePlaceholder}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
            </label>
            <div className="db-profile-actions">
              <button className="btn" onClick={() => saveProfile()} disabled={!!busy}>
                {t.dbSave}
              </button>
              {form.id ? (
                <button className="icon-btn" title={t.dbDelete} aria-label={t.dbDelete} onClick={deleteProfile}>
                  <TrashIcon size={15} />
                </button>
              ) : null}
              {notice ? <span className="pill pill-ok">{notice}</span> : null}
            </div>
          </div>

          {/* ---- Connection ------------------------------------------------- */}
          <section className="db-section">
            <h3>{t.dbConnection}</h3>
            <div className="field">
              <span className="field-label">{t.dbType}</span>
              <div className="segmented" role="radiogroup" aria-label={t.dbType}>
                {DB_TYPES.map((d) => (
                  <button
                    key={d.id}
                    role="radio"
                    aria-checked={form.dbType === d.id}
                    className={form.dbType === d.id ? "is-active" : ""}
                    onClick={() => update({ dbType: d.id })}
                  >
                    {d.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="field">
              <span className="field-label">{t.dbConnectionString}</span>
              <div className="conn-row">
                <input
                  type={showConn ? "text" : "password"}
                  dir="ltr"
                  className="mono"
                  spellCheck={false}
                  autoComplete="off"
                  value={form.connectionString}
                  placeholder={CONNECTION_EXAMPLES[form.dbType]}
                  onChange={(e) => update({ connectionString: e.target.value })}
                />
                <button className="btn btn-subtle" onClick={() => setShowConn((s) => !s)}>
                  {showConn ? t.dbHide : t.dbShow}
                </button>
                <button className="btn" onClick={testConnection} disabled={!form.connectionString.trim() || !!busy}>
                  {busy === "test" ? t.dbTesting : t.dbTest}
                </button>
              </div>
              <p className="hint mono" dir="ltr">
                {CONNECTION_EXAMPLES[form.dbType]}
              </p>
              {testResult ? (
                <div className="notice ok">
                  <CheckIcon size={16} />
                  <div>
                    {t.dbConnected}{" "}
                    <span className="muted" dir="ltr">
                      ({testResult.driver}, {testResult.elapsedMs} ms)
                    </span>
                    <div className="mono small" dir="ltr">
                      {testResult.serverVersion}
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          </section>

          {/* ---- Shape ------------------------------------------------------ */}
          <section className="db-section">
            <h3>{t.dbShape}</h3>
            <div className="radio-list" role="radiogroup">
              <label className="check">
                <input type="radio" checked={form.mode === "chunks"} onChange={() => update({ mode: "chunks" as DbMode })} />
                <span>
                  {t.dbModeChunks}{" "}
                  <input
                    type="number"
                    className="num"
                    min={1}
                    max={3600}
                    value={form.chunkSeconds}
                    onChange={(e) => update({ chunkSeconds: Number(e.target.value) || 10, mode: "chunks" })}
                  />{" "}
                  {t.dbSeconds}
                </span>
              </label>
              <label className="check">
                <input type="radio" checked={form.mode === "segments"} onChange={() => update({ mode: "segments" })} />
                <span>{t.dbModeSegments}</span>
              </label>
              <label className="check">
                <input type="radio" checked={form.mode === "full"} onChange={() => update({ mode: "full" })} />
                <span>{t.dbModeFull}</span>
              </label>
            </div>
          </section>

          {/* ---- Variables -------------------------------------------------- */}
          <section className="db-section">
            <h3>{t.dbVariables}</h3>
            <p className="hint">{t.dbVariablesHint}</p>
            <div className="var-list">
              {form.variables.map((v, i) => (
                <div className="var-row" key={i}>
                  <span className="var-prefix" dir="ltr">
                    {form.dbType === "oracle" ? ":" : "@"}
                  </span>
                  <input
                    type="text"
                    dir="ltr"
                    className="mono"
                    placeholder={t.dbVarName}
                    value={v.name}
                    onChange={(e) =>
                      update({
                        variables: form.variables.map((x, j) =>
                          j === i ? { ...x, name: e.target.value.replace(/[^A-Za-z0-9_]/g, "") } : x,
                        ),
                      })
                    }
                  />
                  <input
                    type="text"
                    dir="auto"
                    placeholder={t.dbVarValue}
                    value={v.value}
                    onChange={(e) =>
                      update({ variables: form.variables.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })
                    }
                  />
                  <button
                    className="icon-btn"
                    aria-label={t.dbDelete}
                    onClick={() => update({ variables: form.variables.filter((_, j) => j !== i) })}
                  >
                    <TrashIcon size={14} />
                  </button>
                </div>
              ))}
              <button
                className="link-btn"
                onClick={() => update({ variables: [...form.variables, { name: "", value: "" }] })}
              >
                + {t.dbAddVariable}
              </button>
            </div>
          </section>

          {/* ---- SQL -------------------------------------------------------- */}
          <section className="db-section">
            <div className="field-head">
              <h3>SQL</h3>
              <button className="link-btn" onClick={fillExample}>
                {t.dbExample}
              </button>
            </div>

            <div className="chips">
              <span className="muted small">{t.dbInsertVar}</span>
              <span className="chip-group-label">{t.dbVarsRow}</span>
              {ROW_VARS.map((name) => (
                <button key={name} className="chip" dir="ltr" onClick={() => insertVariable(name)}>
                  {name}
                </button>
              ))}
              <span className="chip-group-label">{t.dbVarsFile}</span>
              {FILE_VARS.map((name) => (
                <button key={name} className="chip" dir="ltr" onClick={() => insertVariable(name)}>
                  {name}
                </button>
              ))}
              <span className="chip-group-label">{t.dbVarsExtra}</span>
              {EXTRA_VARS.map(({ name, needs }) => {
                const available =
                  needs === "translation"
                    ? Boolean(translation?.length)
                    : needs === "summary"
                      ? Boolean(summary)
                      : Boolean(course);
                return (
                  <button
                    key={name}
                    className={`chip${available ? "" : " chip-off"}`}
                    dir="ltr"
                    title={
                      available
                        ? undefined
                        : t[
                            needs === "translation"
                              ? "dbVarNeedsTranslation"
                              : needs === "summary"
                                ? "dbVarNeedsSummary"
                                : "dbVarNeedsCourse"
                          ]
                    }
                    onClick={() => insertVariable(name)}
                  >
                    {name}
                  </button>
                );
              })}
              {customNames.map((name) => (
                <button key={`c-${name}`} className="chip chip-custom" dir="ltr" onClick={() => insertVariable(name)}>
                  {name}
                </button>
              ))}
            </div>

            <label className="field">
              <span className="field-label">{t.dbPreSql}</span>
              <textarea
                ref={preRef}
                className="sql-editor small-editor"
                dir="ltr"
                spellCheck={false}
                rows={2}
                value={form.preSql}
                onFocus={() => (lastFocused.current = "pre")}
                onChange={(e) => update({ preSql: e.target.value })}
                placeholder={SQL_EXAMPLES[form.dbType].pre}
              />
              <span className="hint">{t.dbPreSqlHint}</span>
            </label>

            <label className="field">
              <span className="field-label">{t.dbSql}</span>
              <textarea
                ref={sqlRef}
                className="sql-editor"
                dir="ltr"
                spellCheck={false}
                rows={5}
                value={form.sql}
                onFocus={() => (lastFocused.current = "sql")}
                onChange={(e) => update({ sql: e.target.value })}
                placeholder={SQL_EXAMPLES[form.dbType].sql}
              />
            </label>
            <p className="hint">{t.dbTransaction}</p>
          </section>

          {/* ---- Preview ---------------------------------------------------- */}
          {preview ? (
            <section className="db-section preview">
              <h3>
                {t.dbPreviewTitle}{" "}
                <span className="pill">
                  {t.dbRows}: {preview.rowCount}
                </span>
              </h3>
              {preview.rowVariablesInPre.length ? (
                <div className="notice error">
                  <AlertIcon size={16} /> {t.dbRowVarInPre}{" "}
                  <code dir="ltr">{preview.rowVariablesInPre.join(", ")}</code>
                </div>
              ) : null}
              {preview.unknown.length ? (
                <div className="notice warn">
                  <AlertIcon size={16} /> {t.dbUnknownVars}{" "}
                  <code dir="ltr">{preview.unknown.map((u) => `@${u}`).join(", ")}</code>
                </div>
              ) : null}
              <div className="table-wrap">
                <table className="preview-table">
                  <thead>
                    <tr>
                      {preview.used.map((c) => (
                        <th key={c} dir="ltr">
                          {c}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {preview.sample.map((row, i) => (
                      <tr key={i}>
                        {preview.used.map((c) => (
                          <td key={c} dir="auto" title={String(row[c] ?? "")}>
                            {row[c] === null || row[c] === undefined ? <span className="muted">NULL</span> : String(row[c])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <details>
                <summary>{t.dbConvertedSql}</summary>
                {preview.preSql ? <pre dir="ltr">{preview.preSql}</pre> : null}
                <pre dir="ltr">{preview.sql}</pre>
              </details>
            </section>
          ) : null}

          {error ? (
            <div className="notice error">
              <AlertIcon size={16} />
              <div>
                <div>{errorMessage(lang, error.code)}</div>
                {error.detail ? <code dir="ltr">{error.detail}</code> : null}
              </div>
            </div>
          ) : null}
          {done !== null ? (
            <div className="notice ok">
              <CheckIcon size={16} /> {t.dbDone.replace("{n}", String(done))}
            </div>
          ) : null}
        </div>

        <footer className="modal-foot">
          <button className="btn" onClick={doPreview} disabled={!hasTranscript || !form.sql.trim() || !!busy}>
            {busy === "preview" ? "…" : t.dbPreview}
          </button>
          <button className={`btn ${confirming !== null ? "btn-danger" : "btn-accent"}`} onClick={execute} disabled={!canRun}>
            {busy === "execute"
              ? t.dbRunning
              : confirming !== null
                ? t.dbConfirm.replace("{n}", String(confirming))
                : t.dbExecute}
          </button>
          <button className="btn btn-subtle" onClick={onClose} disabled={busy === "execute"}>
            {t.close}
          </button>
        </footer>
      </div>
    </div>
  );
}
