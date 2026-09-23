"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, type ArchiveSummary, type BackendClient } from "@/lib/api";
import { formatDuration } from "@/lib/format";
import { errorMessage, type Strings, type UiLang } from "@/lib/i18n";
import { languageName } from "@/lib/languages";
import { AlertIcon, ArchiveIcon, CloudIcon, FileMediaIcon, SearchIcon, TrashIcon, YoutubeIcon } from "./Icons";

interface Props {
  t: Strings;
  lang: UiLang;
  client: BackendClient;
  activeId: string | null;
  onOpen: (id: string) => void;
  onDeleted: (id: string) => void;
  onClose: () => void;
}

const PAGE = 40;

export function ArchiveDialog({ t, lang, client, activeId, onOpen, onDeleted, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<ArchiveSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [error, setError] = useState<{ code: string; detail: string } | null>(null);
  const requestId = useRef(0);

  const load = useCallback(
    async (q: string, offset: number) => {
      const id = ++requestId.current;
      setLoading(true);
      try {
        const res = await client.archiveList(q, PAGE, offset);
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
    [client],
  );

  // Debounced search.
  useEffect(() => {
    const timer = setTimeout(() => load(query, 0), query ? 250 : 0);
    return () => clearTimeout(timer);
  }, [query, load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
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
    } catch (err) {
      if (err instanceof ApiError) setError({ code: err.code, detail: err.detail });
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
          <button className="icon-btn" onClick={onClose} aria-label={t.close}>
            ✕
          </button>
        </header>

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

        <div className="modal-body archive-body">
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
                  <div className="file-name" dir="auto" title={item.source}>
                    {item.title}
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
                    <span>
                      {item.word_count} {t.words}
                    </span>
                  </div>
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
        </div>
      </div>
    </div>
  );
}
