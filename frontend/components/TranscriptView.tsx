"use client";

import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { Segment } from "@/lib/api";
import { formatTimestamp } from "@/lib/format";
import type { Strings } from "@/lib/i18n";
import { ArrowDownIcon, ArrowUpIcon, CopyIcon, SearchIcon } from "./Icons";

interface Props {
  t: Strings;
  segments: Segment[];
  rtl: boolean;
  live: boolean;
  onEdit: (id: number, text: string) => void;
}

/** Strip Arabic diacritics/tatweel and unify alef forms so search is forgiving. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[ً-ْٰـ]/g, "")
    .replace(/[إأآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه");
}

function buildParagraphs(segments: Segment[]): Segment[] {
  const paragraphs: Segment[] = [];
  for (const seg of segments) {
    const last = paragraphs[paragraphs.length - 1];
    const endsSentence = last && /[.؟?!…]$/.test(last.text);
    if (!last || seg.start - last.end > 2 || (last.text.length > 700 && endsSentence)) {
      paragraphs.push({ ...seg });
    } else {
      last.text = `${last.text} ${seg.text}`;
      last.end = seg.end;
    }
  }
  return paragraphs;
}

function Highlighted({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  // Map matches found on the normalized text back to the original characters
  // (normalization is length-preserving except for removed diacritics).
  const map: number[] = [];
  let norm = "";
  for (let i = 0; i < text.length; i++) {
    const n = normalize(text[i]);
    for (let k = 0; k < n.length; k++) map.push(i);
    norm += n;
  }
  const q = normalize(query);
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  let idx = norm.indexOf(q);
  while (idx !== -1 && q) {
    const start = map[idx];
    const end = (map[idx + q.length - 1] ?? text.length - 1) + 1;
    if (start > cursor) parts.push(text.slice(cursor, start));
    parts.push(<mark key={start}>{text.slice(start, end)}</mark>);
    cursor = end;
    idx = norm.indexOf(q, idx + q.length);
  }
  parts.push(text.slice(cursor));
  return <>{parts}</>;
}

const SegmentRow = memo(function SegmentRow({
  segment,
  editable,
  query,
  onEdit,
}: {
  segment: Segment;
  editable: boolean;
  query: string;
  onEdit: (id: number, text: string) => void;
}) {
  return (
    <div className="seg">
      <span className="seg-time" dir="ltr">
        [{formatTimestamp(segment.start)}]
      </span>
      {editable ? (
        <div
          className="seg-text"
          dir="auto"
          contentEditable
          suppressContentEditableWarning
          spellCheck={false}
          onBlur={(e) => {
            const value = e.currentTarget.innerText.replace(/\s+/g, " ").trim();
            if (value !== segment.text) onEdit(segment.id, value);
          }}
        >
          {segment.text}
        </div>
      ) : (
        <div className="seg-text" dir="auto">
          <Highlighted text={segment.text} query={query} />
        </div>
      )}
    </div>
  );
});

export function TranscriptView({ t, segments, rtl, live, onEdit }: Props) {
  const [query, setQuery] = useState("");
  const [view, setView] = useState<"segments" | "paragraphs">("segments");
  const [copied, setCopied] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  const q = normalize(query.trim());
  const visible = useMemo(
    () => (q ? segments.filter((s) => normalize(s.text).includes(q)) : segments),
    [segments, q],
  );
  const paragraphs = useMemo(() => (view === "paragraphs" ? buildParagraphs(segments) : []), [segments, view]);
  const wordCount = useMemo(
    () => segments.reduce((n, s) => n + (s.text.trim() ? s.text.trim().split(/\s+/).length : 0), 0),
    [segments],
  );

  // Follow new text while transcribing, unless the user scrolled up to read.
  useEffect(() => {
    const el = scroller.current;
    if (el && live && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [segments.length, live]);

  const copyAll = async () => {
    const text = (view === "paragraphs" ? paragraphs : segments).map((s) => s.text).join("\n\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked */
    }
  };

  return (
    <section className="card transcript">
      <header className="transcript-head">
        <div className="transcript-title">
          <h2 className="card-title">{t.transcript}</h2>
          {segments.length ? (
            <span className="muted small">
              {segments.length} {t.segments} · {wordCount} {t.words}
            </span>
          ) : null}
        </div>
        <div className="transcript-tools">
          <div className="search">
            <SearchIcon size={15} />
            <input
              type="search"
              placeholder={t.searchPlaceholder}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              dir="auto"
            />
            {q ? (
              <span className="muted small">
                {visible.length} {t.matches}
              </span>
            ) : null}
          </div>
          <div className="segmented compact">
            <button className={view === "segments" ? "is-active" : ""} onClick={() => setView("segments")}>
              {t.viewSegments}
            </button>
            <button className={view === "paragraphs" ? "is-active" : ""} onClick={() => setView("paragraphs")}>
              {t.viewParagraphs}
            </button>
          </div>
          <button className="icon-btn" title={t.copyAll} onClick={copyAll} disabled={!segments.length}>
            <CopyIcon size={16} />
          </button>
          <button className="icon-btn" title={t.toTop} onClick={() => scroller.current?.scrollTo({ top: 0 })}>
            <ArrowUpIcon size={16} />
          </button>
          <button
            className="icon-btn"
            title={t.toBottom}
            onClick={() => scroller.current?.scrollTo({ top: scroller.current.scrollHeight })}
          >
            <ArrowDownIcon size={16} />
          </button>
          {copied ? <span className="pill pill-ok">{t.copied}</span> : null}
        </div>
      </header>

      <div
        ref={scroller}
        className={`transcript-body ${rtl ? "is-rtl" : "is-ltr"}`}
        dir={rtl ? "rtl" : "ltr"}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {segments.length === 0 ? (
          <div className="empty">{t.transcriptEmpty}</div>
        ) : view === "paragraphs" && !q ? (
          <article className="reading">
            {paragraphs.map((p) => (
              <p key={p.id} dir="auto">
                {p.text}
              </p>
            ))}
          </article>
        ) : (
          visible.map((s) => <SegmentRow key={s.id} segment={s} editable={!q} query={query.trim()} onEdit={onEdit} />)
        )}
      </div>
      {segments.length && !q && view === "segments" ? <footer className="hint transcript-foot">{t.editHint}</footer> : null}
    </section>
  );
}
