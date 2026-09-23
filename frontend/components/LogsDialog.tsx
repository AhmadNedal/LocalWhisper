"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { LogEntry } from "@/lib/desktop";
import type { Strings } from "@/lib/i18n";
import { AlertIcon, CopyIcon, DownloadIcon, FolderIcon, LogIcon, SearchIcon } from "./Icons";

type LevelFilter = "all" | "problems" | "error";
type SourceFilter = "all" | LogEntry["source"];

interface Props {
  t: Strings;
  /** Open with "errors only" (e.g. from an error message). */
  initialFilter?: LevelFilter;
  onClose: () => void;
}

const POLL_MS = 1000;

function time(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function dateTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${time(ts)}`;
}

/** Everything that happened in the app — main process, transcription engine and interface. */
export function LogsDialog({ t, initialFilter = "all", onClose }: Props) {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [file, setFile] = useState("");
  const [level, setLevel] = useState<LevelFilter>(initialFilter);
  const [source, setSource] = useState<SourceFilter>("all");
  const [query, setQuery] = useState("");
  const [follow, setFollow] = useState(true);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [note, setNote] = useState<string | null>(null);
  const rev = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Pull new and changed entries (a traceback grows its entry line by line).
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const res = await window.desktop?.logGet?.(rev.current);
        if (res && !stopped) {
          setFile(res.file);
          if (res.entries.length) {
            setEntries((prev) => {
              const byId = new Map(prev.map((e) => [e.id, e]));
              for (const e of res.entries) byId.set(e.id, e);
              return [...byId.values()].sort((a, b) => a.id - b.id).slice(-5000);
            });
          }
          rev.current = res.rev;
        }
      } catch {
        /* keep what we have */
      }
      if (!stopped) timer = setTimeout(tick, POLL_MS);
    };
    tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, []);

  const counts = useMemo(() => {
    let errors = 0;
    let warnings = 0;
    for (const e of entries) {
      if (e.level === "error") errors++;
      else if (e.level === "warn") warnings++;
    }
    return { errors, warnings };
  }, [entries]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries.filter((e) => {
      if (level === "error" && e.level !== "error") return false;
      if (level === "problems" && e.level !== "error" && e.level !== "warn") return false;
      if (source !== "all" && e.source !== source) return false;
      if (q && !e.message.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [entries, level, source, query]);

  // Live follow: stay at the bottom while new lines arrive.
  useEffect(() => {
    if (follow && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [visible, follow]);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (atBottom !== follow) setFollow(atBottom);
  };

  const asText = (list: LogEntry[]) =>
    list.map((e) => `${dateTime(e.ts)} ${e.level.toUpperCase().padEnd(5)} [${e.source}] ${e.message}`).join("\n");

  const copy = async (list: LogEntry[], done: string) => {
    try {
      await navigator.clipboard.writeText(asText(list));
      setNote(done);
    } catch {
      setNote(t.logsCopyFailed);
    }
    setTimeout(() => setNote(null), 2500);
  };

  const save = async () => {
    const path = await window.desktop?.logSave?.();
    if (path) {
      setNote(t.logsSaved);
      setTimeout(() => setNote(null), 2500);
    }
  };

  const toggle = (id: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const sourceLabel: Record<LogEntry["source"], string> = {
    app: t.logsSourceApp,
    backend: t.logsSourceBackend,
    ui: t.logsSourceUi,
  };
  const levelLabel: Record<LogEntry["level"], string> = {
    debug: "DEBUG",
    info: "INFO",
    warn: "WARN",
    error: "ERROR",
  };
  const lastError = [...entries].reverse().find((e) => e.level === "error");

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal logs-modal" role="dialog" aria-modal="true" aria-labelledby="logs-title">
        <header className="modal-head">
          <div>
            <h2 id="logs-title">
              <LogIcon size={18} /> {t.logsTitle}
            </h2>
            <p className="hint">{t.logsHint}</p>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label={t.close}>
            ✕
          </button>
        </header>

        {lastError ? (
          <div className="logs-last-error" role="status">
            <AlertIcon size={16} />
            <div>
              <strong>{t.logsLastError}</strong> <span className="muted">{dateTime(lastError.ts)}</span>
              <div className="logs-last-error-msg" dir="ltr">
                {lastError.message.split("\n")[0]}
              </div>
            </div>
            <button className="btn btn-subtle" onClick={() => copy([lastError], t.logsCopiedOne)}>
              <CopyIcon size={14} /> {t.logsCopyError}
            </button>
          </div>
        ) : null}

        <div className="logs-toolbar">
          <div className="segmented compact" role="group" aria-label={t.logsLevel}>
            <button className={level === "all" ? "is-active" : ""} onClick={() => setLevel("all")}>
              {t.logsAll} <span className="logs-count">{entries.length}</span>
            </button>
            <button className={level === "problems" ? "is-active" : ""} onClick={() => setLevel("problems")}>
              {t.logsProblems} <span className="logs-count warn">{counts.errors + counts.warnings}</span>
            </button>
            <button className={level === "error" ? "is-active" : ""} onClick={() => setLevel("error")}>
              {t.logsErrors} <span className="logs-count err">{counts.errors}</span>
            </button>
          </div>
          <select className="logs-source" value={source} onChange={(e) => setSource(e.target.value as SourceFilter)} aria-label={t.logsSource}>
            <option value="all">{t.logsSourceAll}</option>
            <option value="app">{t.logsSourceApp}</option>
            <option value="backend">{t.logsSourceBackend}</option>
            <option value="ui">{t.logsSourceUi}</option>
          </select>
          <label className="logs-search">
            <SearchIcon size={14} />
            <input type="search" dir="auto" placeholder={t.logsSearch} value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
        </div>

        <div className="logs-list" ref={listRef} onScroll={onScroll} dir="ltr" role="log" aria-live="off">
          {visible.length ? (
            visible.map((e) => {
              const [first, ...rest] = e.message.split("\n");
              const open = expanded.has(e.id);
              return (
                <div key={e.id} className={`log-row lv-${e.level}`}>
                  <span className="log-time" title={dateTime(e.ts)}>
                    {time(e.ts)}
                  </span>
                  <span className={`log-level lv-${e.level}`}>{levelLabel[e.level]}</span>
                  <span className={`log-src src-${e.source}`} dir="auto">
                    {sourceLabel[e.source]}
                  </span>
                  <div className="log-msg">
                    <span dir="auto">{first}</span>
                    {rest.length ? (
                      <>
                        <button className="log-more" onClick={() => toggle(e.id)}>
                          {open ? t.logsLess : t.logsMore.replace("{n}", String(rest.length))}
                        </button>
                        {open ? <pre>{rest.join("\n")}</pre> : null}
                      </>
                    ) : null}
                  </div>
                </div>
              );
            })
          ) : (
            <div className="logs-empty" dir="auto">
              {entries.length ? t.logsNoMatch : t.logsEmpty}
            </div>
          )}
        </div>

        <footer className="logs-foot">
          <div className="logs-foot-left">
            <button className="btn" onClick={() => copy(visible, t.logsCopied)} disabled={!visible.length}>
              <CopyIcon size={15} /> {t.logsCopy}
            </button>
            <button className="btn" onClick={save} disabled={!entries.length}>
              <DownloadIcon size={15} /> {t.logsSave}
            </button>
            <button className="btn btn-subtle" onClick={() => window.desktop?.logOpenFolder?.()}>
              <FolderIcon size={15} /> {t.logsOpenFolder}
            </button>
            {note ? <span className="logs-note">{note}</span> : null}
          </div>
          <div className="logs-foot-right">
            {!follow ? (
              <button
                className="btn btn-subtle"
                onClick={() => {
                  setFollow(true);
                  if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
                }}
              >
                {t.logsFollow}
              </button>
            ) : (
              <span className="logs-live">
                <span className="logs-live-dot" /> {t.logsLive}
              </span>
            )}
          </div>
        </footer>
        {file ? (
          <div className="logs-file muted small" dir="ltr" title={file}>
            {file}
          </div>
        ) : null}
      </div>
    </div>
  );
}
