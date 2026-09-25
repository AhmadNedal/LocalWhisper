"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, type BackendClient, type ReplacePreview, type ReplaceUndo } from "@/lib/api";
import { formatTimestamp } from "@/lib/format";
import { errorMessage, type Strings, type UiLang } from "@/lib/i18n";
import { AlertIcon, CheckIcon, FolderIcon, ReplaceIcon } from "./Icons";

interface Props {
  t: Strings;
  lang: UiLang;
  client: BackendClient;
  /** undefined: the whole archive, "": entries without a course, else that course. */
  course: string | undefined;
  /** Entries whose text changed (to refresh what is on screen). */
  onChanged: (ids: string[]) => void;
  onClose: () => void;
}

/** Find & replace in every lecture of a course at once (a name or term the model keeps getting wrong). */
export function ReplaceDialog({ t, lang, client, course, onChanged, onClose }: Props) {
  const [find, setFind] = useState("");
  const [replace, setReplace] = useState("");
  const [wholeWord, setWholeWord] = useState(false);
  const [exact, setExact] = useState(false);
  const [includeSummary, setIncludeSummary] = useState(true);
  const [preview, setPreview] = useState<ReplacePreview | null>(null);
  const [undo, setUndo] = useState<ReplaceUndo | null>(null);
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<{ code: string; detail: string } | null>(null);
  const requestId = useRef(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const params = useMemo(
    () => ({ find, replace, course: course ?? null, exact, whole_word: wholeWord, include_summary: includeSummary }),
    [find, replace, course, exact, wholeWord, includeSummary],
  );

  // Live preview while typing.
  useEffect(() => {
    if (!find.trim()) {
      setPreview(null);
      return;
    }
    const id = ++requestId.current;
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await client.archiveReplacePreview(params);
        if (id !== requestId.current) return;
        setPreview(res);
        setUndo(res.undo);
        setError(null);
      } catch (err) {
        if (id === requestId.current && err instanceof ApiError) setError({ code: err.code, detail: err.detail });
      } finally {
        if (id === requestId.current) setLoading(false);
      }
    }, 350);
    return () => clearTimeout(timer);
  }, [client, params, find]);

  const chosen = (preview?.items ?? []).filter((i) => !skipped.has(i.id));
  const chosenMatches = chosen.reduce((n, i) => n + i.matches + (includeSummary ? i.summary_matches : 0), 0);

  const toggle = (id: string) =>
    setSkipped((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const apply = async () => {
    if (!chosen.length || busy) return;
    setBusy(true);
    setError(null);
    try {
      const ids = chosen.map((i) => i.id);
      const res = await client.archiveReplaceApply({ ...params, ids });
      setUndo(res.undo);
      setDone(
        t.replaceDone.replace("{n}", String(res.replacements)).replace("{items}", String(res.changed_items)),
      );
      onChanged(ids);
      setSkipped(new Set());
      requestId.current++;
      setPreview(await client.archiveReplacePreview(params));
    } catch (err) {
      if (err instanceof ApiError) setError({ code: err.code, detail: err.detail });
    } finally {
      setBusy(false);
    }
  };

  const runUndo = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await client.archiveReplaceUndo();
      setUndo(null);
      setDone(t.replaceUndone.replace("{items}", String(res.restored_items)));
      if (find.trim()) {
        requestId.current++;
        setPreview(await client.archiveReplacePreview(params));
      }
      // Every entry of the undone batch may be open: refresh broadly.
      onChanged(["*"]);
    } catch (err) {
      if (err instanceof ApiError) setError({ code: err.code, detail: err.detail });
    } finally {
      setBusy(false);
    }
  };

  const scope =
    course === undefined ? t.replaceScopeAll : course === "" ? t.replaceScopeLoose : t.replaceScopeCourse.replace("{course}", course);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal replace-modal" role="dialog" aria-modal="true" aria-labelledby="replace-title">
        <header className="modal-head">
          <div>
            <h2 id="replace-title">
              <ReplaceIcon size={18} /> {t.replaceTitle}
            </h2>
            <p className="hint">
              <FolderIcon size={13} /> <bdi>{scope}</bdi>
            </p>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label={t.close}>
            ✕
          </button>
        </header>

        <div className="replace-body">
          <div className="replace-fields">
            <label className="replace-field">
              <span>{t.replaceFind}</span>
              <input
                type="text"
                autoFocus
                dir="auto"
                value={find}
                maxLength={200}
                placeholder={t.replaceFindPlaceholder}
                onChange={(e) => {
                  setFind(e.target.value);
                  setDone(null);
                  setSkipped(new Set());
                }}
              />
            </label>
            <label className="replace-field">
              <span>{t.replaceWith}</span>
              <input
                type="text"
                dir="auto"
                value={replace}
                maxLength={500}
                placeholder={t.replaceWithPlaceholder}
                onChange={(e) => {
                  setReplace(e.target.value);
                  setDone(null);
                }}
              />
            </label>
          </div>
          <div className="replace-options">
            <label className="check" title={t.replaceWholeWordHint}>
              <input type="checkbox" checked={wholeWord} onChange={(e) => setWholeWord(e.target.checked)} />
              <span>{t.replaceWholeWord}</span>
            </label>
            <label className="check" title={t.replaceExactHint}>
              <input type="checkbox" checked={exact} onChange={(e) => setExact(e.target.checked)} />
              <span>{t.replaceExact}</span>
            </label>
            <label className="check">
              <input type="checkbox" checked={includeSummary} onChange={(e) => setIncludeSummary(e.target.checked)} />
              <span>{t.replaceIncludeSummary}</span>
            </label>
          </div>
          {!exact ? <p className="muted small replace-smart">{t.replaceSmartHint}</p> : null}

          {done ? (
            <div className="notice ok replace-note">
              <CheckIcon size={16} /> {done}
            </div>
          ) : null}
          {undo ? (
            <div className="replace-undo">
              <span>
                {t.replaceLast} <bdi className="replace-label">{undo.label}</bdi> ·{" "}
                {t.replaceLastItems.replace("{n}", String(undo.items))}
              </span>
              <button className="btn btn-small btn-subtle" onClick={runUndo} disabled={busy}>
                {t.replaceUndo}
              </button>
            </div>
          ) : null}
          {error ? (
            <div className="notice error">
              <AlertIcon size={16} /> {/empty the transcript/i.test(error.detail) ? t.replaceErrEmpty : errorMessage(lang, error.code)}
            </div>
          ) : null}

          <div className="replace-results" aria-busy={loading}>
            {!find.trim() ? (
              <div className="empty">{t.replaceStart}</div>
            ) : preview && !preview.items.length ? (
              <div className="empty">{loading ? t.replaceSearching : t.replaceNone}</div>
            ) : preview ? (
              <>
                <div className="replace-summary">
                  {t.replaceFound
                    .replace("{n}", String(preview.total_matches))
                    .replace("{items}", String(preview.total_items))}
                  {loading ? <span className="spinner small" /> : null}
                </div>
                <ul className="replace-list">
                  {preview.items.map((item) => (
                    <li key={item.id} className={skipped.has(item.id) ? "is-skipped" : ""}>
                      <label className="check replace-item-head">
                        <input type="checkbox" checked={!skipped.has(item.id)} onChange={() => toggle(item.id)} />
                        <bdi className="replace-item-title">{item.title}</bdi>
                        <span className="badge-count">{item.matches}</span>
                        {includeSummary && item.summary_matches ? (
                          <span className="muted small">{t.replaceInSummary.replace("{n}", String(item.summary_matches))}</span>
                        ) : null}
                      </label>
                      {item.samples.length ? (
                        <ul className="replace-samples">
                          {item.samples.map((m, i) => (
                            <li key={i} dir="auto">
                              <span className="replace-time" dir="ltr">
                                {formatTimestamp(m.start)}
                              </span>{" "}
                              {m.before}
                              <del>{m.match}</del>
                              {replace ? <ins>{replace}</ins> : null}
                              {m.after}
                            </li>
                          ))}
                          {item.matches > item.samples.length ? (
                            <li className="muted small">
                              {t.replaceMore.replace("{n}", String(item.matches - item.samples.length))}
                            </li>
                          ) : null}
                        </ul>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <div className="empty">
                <span className="spinner small" /> {t.replaceSearching}
              </div>
            )}
          </div>
        </div>

        <footer className="replace-foot">
          <span className="muted small">{replace.trim() ? "" : find.trim() ? t.replaceDeleteHint : ""}</span>
          <button className="btn btn-subtle" onClick={onClose}>
            {t.close}
          </button>
          <button className="btn btn-accent" onClick={apply} disabled={busy || !chosen.length || !chosenMatches}>
            {busy ? <span className="spinner small" /> : <ReplaceIcon size={15} />}{" "}
            {t.replaceApply.replace("{n}", String(chosenMatches)).replace("{items}", String(chosen.length))}
          </button>
        </footer>
      </div>
    </div>
  );
}
