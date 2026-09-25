"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, type ArchiveSummary, type BackendClient } from "@/lib/api";
import { formatDuration } from "@/lib/format";
import { errorMessage, type Strings, type UiLang } from "@/lib/i18n";
import { languageName } from "@/lib/languages";
import { FileName } from "./FileName";
import { CourseToolsDialog, type CourseToolMode } from "./CourseToolsDialog";
import { StatsDialog } from "./StatsDialog";
import { AskDialog } from "./AskDialog";
import { ReplaceDialog } from "./ReplaceDialog";
import { AlertIcon, ArchiveIcon, ChartIcon, QuestionIcon, CheckIcon, CloudIcon, DatabaseIcon, DownloadIcon, UploadIcon, FileMediaIcon, FolderIcon, ReplaceIcon, SearchIcon, TrashIcon, YoutubeIcon } from "./Icons";

interface Props {
  t: Strings;
  lang: UiLang;
  client: BackendClient;
  activeId: string | null;
  onOpen: (id: string) => void;
  /** Open an entry and jump to a time (answers of "Ask the course"). */
  onOpenAt?: (id: string, time: number) => void;
  onDeleted: (id: string) => void;
  /** Find & replace changed these entries ("*": maybe any). */
  onEdited?: (ids: string[]) => void;
  onClose: () => void;
}

const PAGE = 40;

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function ArchiveDialog({ t, lang, client, activeId, onOpen, onOpenAt, onDeleted, onEdited, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<ArchiveSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [error, setError] = useState<{ code: string; detail: string } | null>(null);
  const requestId = useRef(0);
  // Courses: undefined → all, "" → without a course, otherwise that course
  const [course, setCourse] = useState<string | undefined>(undefined);
  const [courses, setCourses] = useState<{ courses: { course: string; count: number }[]; total: number; without_course: number } | null>(
    null,
  );
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [courseTool, setCourseTool] = useState<CourseToolMode | null>(null);
  const [statsOpen, setStatsOpen] = useState(false);
  const [askOpen, setAskOpen] = useState(false);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [backupBusy, setBackupBusy] = useState<"backup" | "restore" | null>(null);
  const [backupResult, setBackupResult] = useState<{ text: string; path?: string } | null>(null);

  const loadCourses = useCallback(async () => {
    try {
      setCourses(await client.archiveCourses());
    } catch {
      /* the list still works without the sidebar */
    }
  }, [client]);

  useEffect(() => {
    loadCourses();
  }, [loadCourses]);

  const statsRef = useRef(false);
  statsRef.current = statsOpen || askOpen || replaceOpen;
  const courseToolRef = useRef(courseTool);
  courseToolRef.current = courseTool;

  const load = useCallback(
    async (q: string, offset: number) => {
      const id = ++requestId.current;
      setLoading(true);
      try {
        const res = await client.archiveList(q, PAGE, offset, course);
        if (id !== requestId.current) return; // a newer search already started
        setTotal(res.total);
        setItems((prev) => (offset === 0 ? res.items : [...prev, ...res.items]));
        setError(null);
      } catch (err) {
        if (err instanceof ApiError) setError({ code: err.code, detail: err.detail });
      } finally {
        if (id === requestId.current) setLoading(false);
      }
    },
    [client, course],
  );

  // Debounced search.
  useEffect(() => {
    const timer = setTimeout(() => load(query, 0), query ? 250 : 0);
    return () => clearTimeout(timer);
  }, [query, load]);

  const saveCourse = async (id: string, value: string | null) => {
    try {
      await client.archiveSetCourse(id, value && value.trim() ? value.trim() : null);
      setEditing(null);
      await Promise.all([load(query, 0), loadCourses()]);
    } catch (err) {
      if (err instanceof ApiError) setError({ code: err.code, detail: err.detail });
    }
  };

  const renameCourse = async (oldName: string, newName: string) => {
    try {
      const name = newName.trim();
      await client.archiveRenameCourse(oldName, name || null);
      setRenaming(null);
      setCourse(name || undefined);
      await loadCourses();
    } catch (err) {
      if (err instanceof ApiError) setError({ code: err.code, detail: err.detail });
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !courseToolRef.current && !statsRef.current && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const remove = async (id: string) => {
    if (confirmId !== id) {
      setConfirmId(id);
      return;
    }
    setConfirmId(null);
    try {
      await client.archiveDelete(id);
      setItems((prev) => prev.filter((x) => x.id !== id));
      setTotal((n) => Math.max(0, n - 1));
      onDeleted(id);
      loadCourses();
    } catch (err) {
      if (err instanceof ApiError) setError({ code: err.code, detail: err.detail });
    }
  };

  const runBackup = async () => {
    const name = `archive-backup-${new Date().toISOString().slice(0, 10)}.ltbackup`;
    let path: string | null = null;
    if (window.desktop) {
      path = await window.desktop.saveFileDialog(name, "ltbackup");
      if (!path) return;
    }
    setBackupBusy("backup");
    setBackupResult(null);
    setError(null);
    try {
      const res = await client.archiveBackup(path);
      setBackupResult({
        text: t.backupDone.replace("{n}", String(res.transcripts)).replace("{size}", formatSize(res.size)),
        path: res.path,
      });
    } catch (err) {
      if (err instanceof ApiError) setError({ code: err.code, detail: err.detail });
    } finally {
      setBackupBusy(null);
    }
  };

  const runRestore = async () => {
    const path = await window.desktop?.openBackupDialog();
    if (!path) return;
    setBackupBusy("restore");
    setBackupResult(null);
    setError(null);
    try {
      const res = await client.archiveRestore(path);
      let text = t.restoreDone
        .replace("{added}", String(res.added))
        .replace("{updated}", String(res.updated))
        .replace("{skipped}", String(res.skipped));
      if (res.invalid) text += " " + t.restoreInvalid.replace("{n}", String(res.invalid));
      setBackupResult({ text });
      await Promise.all([load(query, 0), loadCourses()]);
    } catch (err) {
      if (err instanceof ApiError) setError({ code: err.code, detail: err.detail });
    } finally {
      setBackupBusy(null);
    }
  };

  const dateFmt = new Intl.DateTimeFormat(lang === "ar" ? "ar" : "en", { dateStyle: "medium", timeStyle: "short" });
  const engineLabel = (e: string | null) =>
    e === "cloud" ? t.archiveEngineCloud : e === "youtube" ? t.archiveEngineYoutube : t.archiveEngineLocal;

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal archive-modal" role="dialog" aria-modal="true" aria-labelledby="archive-title">
        <header className="modal-head">
          <div>
            <h2 id="archive-title">
              <ArchiveIcon size={18} /> {t.archiveTitle}
            </h2>
            <p className="hint">{t.archiveHint}</p>
          </div>
          <div className="archive-head-actions">
            <button className="btn btn-small" onClick={() => setReplaceOpen(true)} title={t.replaceHint}>
              <ReplaceIcon size={14} /> {t.replaceButton}
            </button>
            <button className="btn btn-small" onClick={() => setStatsOpen(true)}>
              <ChartIcon size={14} /> {t.statsButton}
            </button>
            <button className="btn btn-small" onClick={runBackup} disabled={backupBusy !== null} title={t.backupHint}>
              <DownloadIcon size={14} /> {backupBusy === "backup" ? t.backupWorking : t.backupButton}
            </button>
            {typeof window !== "undefined" && window.desktop ? (
              <button className="btn btn-small" onClick={runRestore} disabled={backupBusy !== null} title={t.restoreHint}>
                <UploadIcon size={14} /> {backupBusy === "restore" ? t.restoreWorking : t.restoreButton}
              </button>
            ) : null}
            <button className="icon-btn" onClick={onClose} aria-label={t.close}>
              ✕
            </button>
          </div>
        </header>

        {backupResult ? (
          <div className="notice ok archive-backup-note">
            <CheckIcon size={16} />
            <div>
              <div>
                {backupResult.text}{" "}
                {backupResult.path && window.desktop ? (
                  <button className="link-btn" onClick={() => window.desktop?.showItemInFolder(backupResult.path!)}>
                    {t.backupShow}
                  </button>
                ) : null}
              </div>
              {backupResult.path ? <div className="muted small">{t.backupNoKeys}</div> : null}
            </div>
            <button className="icon-btn" onClick={() => setBackupResult(null)} aria-label={t.close}>
              ✕
            </button>
          </div>
        ) : null}

        <div className="archive-search">
          <SearchIcon size={16} />
          <input
            type="search"
            autoFocus
            dir="auto"
            placeholder={t.archiveSearch}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <span className="muted small">{t.archiveCount.replace("{n}", String(total))}</span>
        </div>

        <div className="archive-layout">
        {courses && courses.courses.length ? (
          <nav className="course-list" aria-label={t.archiveCourses}>
            <button className={course === undefined ? "is-active" : ""} onClick={() => setCourse(undefined)}>
              <span>{t.archiveAll}</span>
              <span className="count">{courses.total}</span>
            </button>
            {courses.courses.map((c) => (
              <button key={c.course} className={course === c.course ? "is-active" : ""} onClick={() => setCourse(c.course)}>
                <FolderIcon size={14} />
                <span dir="auto" className="course-name">
                  {c.course}
                </span>
                <span className="count">{c.count}</span>
              </button>
            ))}
            {courses.without_course ? (
              <button className={course === "" ? "is-active" : ""} onClick={() => setCourse("")}>
                <span className="muted">{t.archiveNoCourse}</span>
                <span className="count">{courses.without_course}</span>
              </button>
            ) : null}
          </nav>
        ) : null}
        <div className="modal-body archive-body">
          {course ? (
            <div className="course-head">
              {renaming !== null ? (
                <form
                  className="course-edit"
                  onSubmit={(e) => {
                    e.preventDefault();
                    renameCourse(course, renaming);
                  }}
                >
                  <input autoFocus dir="auto" value={renaming} onChange={(e) => setRenaming(e.target.value)} />
                  <button className="btn btn-small btn-accent" type="submit">
                    {t.archiveCourseSave}
                  </button>
                  <button className="btn btn-small btn-subtle" type="button" onClick={() => setRenaming(null)}>
                    ✕
                  </button>
                </form>
              ) : (
                <>
                  <h3 dir="auto">
                    <FolderIcon size={16} /> {course}
                  </h3>
                  <button className="link-btn" onClick={() => setRenaming(course)}>
                    {t.archiveCourseRename}
                  </button>
                  <span className="batch-spacer" />
                  {onOpenAt ? (
                    <button className="btn btn-small btn-accent" onClick={() => setAskOpen(true)}>
                      <QuestionIcon size={14} /> {t.askButtonCourse}
                    </button>
                  ) : null}
                  <button className="btn btn-small" onClick={() => setCourseTool("db")}>
                    <DatabaseIcon size={14} /> {t.courseDbButton}
                  </button>
                  <button className="btn btn-small" onClick={() => setCourseTool("export")}>
                    <FolderIcon size={14} /> {t.courseExportButton}
                  </button>
                </>
              )}
            </div>
          ) : null}
          {error ? (
            <div className="notice error">
              <AlertIcon size={16} /> {errorMessage(lang, error.code)}
            </div>
          ) : null}

          {!loading && items.length === 0 ? (
            <div className="empty archive-empty">{query ? t.archiveNoResults : t.archiveEmpty}</div>
          ) : null}

          <ul className="archive-list">
            {items.map((item) => (
              <li key={item.id} className={item.id === activeId ? "is-active" : ""}>
                <div className="archive-icon" aria-hidden="true">
                  {item.source_type === "youtube" ? <YoutubeIcon size={20} /> : <FileMediaIcon size={20} />}
                </div>
                <div className="archive-main">
                  <div className="file-name" title={item.source}>
                    <FileName name={item.title} />
                  </div>
                  <div className="file-meta">
                    <span>{dateFmt.format(new Date(item.updated_at * 1000))}</span>
                    {item.duration ? <span>{formatDuration(item.duration, lang)}</span> : null}
                    {item.language ? <span>{languageName(item.language, lang)}</span> : null}
                    <span>
                      {item.engine === "cloud" ? <CloudIcon size={12} /> : null} {engineLabel(item.engine)}
                    </span>
                    {item.model ? (
                      <span className="muted" dir="auto">
                        {item.model}
                      </span>
                    ) : null}
                    {editing?.id === item.id ? null : item.course ? (
                      <button
                        className="course-pill"
                        title={t.archiveCourseSet}
                        onClick={() => setEditing({ id: item.id, value: item.course ?? "" })}
                      >
                        <FolderIcon size={12} /> <bdi>{item.course}</bdi>
                      </button>
                    ) : (
                      <button className="link-btn small" onClick={() => setEditing({ id: item.id, value: course || "" })}>
                        + {t.archiveCourseSet}
                      </button>
                    )}
                    <span>
                      {item.word_count} {t.words}
                    </span>
                  </div>
                  {editing?.id === item.id ? (
                    <form
                      className="course-edit"
                      onSubmit={(e) => {
                        e.preventDefault();
                        saveCourse(item.id, editing.value);
                      }}
                    >
                      <input
                        autoFocus
                        dir="auto"
                        list="archive-course-names"
                        placeholder={t.archiveCoursePlaceholder}
                        value={editing.value}
                        onChange={(e) => setEditing({ id: item.id, value: e.target.value })}
                      />
                      <button className="btn btn-small btn-accent" type="submit" disabled={!editing.value.trim()}>
                        {t.archiveCourseSave}
                      </button>
                      {item.course ? (
                        <button className="btn btn-small" type="button" onClick={() => saveCourse(item.id, null)}>
                          {t.archiveCourseRemove}
                        </button>
                      ) : null}
                      <button className="btn btn-small btn-subtle" type="button" onClick={() => setEditing(null)}>
                        ✕
                      </button>
                    </form>
                  ) : null}
                  <div className="archive-preview" dir="auto">
                    {item.preview}
                  </div>
                </div>
                <div className="archive-actions">
                  <button className="btn btn-small btn-accent" onClick={() => onOpen(item.id)}>
                    {t.archiveOpen}
                  </button>
                  <button
                    className={`btn btn-small ${confirmId === item.id ? "btn-danger" : "btn-subtle"}`}
                    onClick={() => remove(item.id)}
                    onBlur={() => setConfirmId((c) => (c === item.id ? null : c))}
                    aria-label={t.archiveDelete}
                  >
                    {confirmId === item.id ? t.archiveConfirmDelete : <TrashIcon size={14} />}
                  </button>
                </div>
              </li>
            ))}
          </ul>

          {items.length < total ? (
            <button className="btn archive-more" disabled={loading} onClick={() => load(query, items.length)}>
              {loading ? "…" : t.archiveLoadMore}
            </button>
          ) : null}
          {askOpen && course && onOpenAt ? (
            <AskDialog t={t} lang={lang} client={client} course={course} onOpenAt={onOpenAt} onClose={() => setAskOpen(false)} />
          ) : null}
          {replaceOpen ? (
            <ReplaceDialog
              t={t}
              lang={lang}
              client={client}
              course={course}
              onChanged={(ids) => {
                load(query, 0);
                onEdited?.(ids);
              }}
              onClose={() => setReplaceOpen(false)}
            />
          ) : null}
          {statsOpen ? (
            <StatsDialog
              t={t}
              lang={lang}
              client={client}
              onClose={() => setStatsOpen(false)}
              onSelectCourse={(c) => {
                setStatsOpen(false);
                setQuery("");
                setCourse(c);
              }}
            />
          ) : null}
          {courseTool && course ? (
            <CourseToolsDialog t={t} lang={lang} client={client} course={course} mode={courseTool} onClose={() => setCourseTool(null)} />
          ) : null}
          <datalist id="archive-course-names">
            {courses?.courses.map((c) => <option key={c.course} value={c.course} />)}
          </datalist>
        </div>
        </div>
      </div>
    </div>
  );
}
