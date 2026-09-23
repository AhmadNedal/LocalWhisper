"use client";

import { Fragment, memo, useEffect, useMemo, useRef, useState } from "react";
import type { AiChapter, Segment } from "@/lib/api";
import { formatTimestamp } from "@/lib/format";
import type { Strings } from "@/lib/i18n";
import { indexAt, type PlayerClock } from "@/lib/playerClock";
import { ArrowDownIcon, ArrowUpIcon, CopyIcon, SearchIcon } from "./Icons";

interface Props {
  t: Strings;
  segments: Segment[];
  rtl: boolean;
  live: boolean;
  onEdit: (id: number, text: string) => void;
  /** Chapters from the AI summary: shown as headings inside the transcript. */
  chapters?: AiChapter[];
  /** Scroll to this time (nonce changes on every request). */
  focus?: { time: number; nonce: number } | null;
  /** Translation aligned with the non-empty segments (bilingual view). */
  translation?: { start: number; end: number; text: string }[] | null;
  onEditTranslation?: (index: number, text: string) => void;
  /** Switch the view from outside (e.g. "Show bilingual"). */
  viewRequest?: { view: View; nonce: number } | null;
  /** Extra buttons for the header (e.g. "Translate"). */
  tools?: React.ReactNode;
  /** Built-in player: current time (highlight) and click-to-seek. */
  clock?: PlayerClock | null;
  onSeek?: ((time: number) => void) | null;
  follow?: boolean;
}

type View = "segments" | "paragraphs" | "bilingual";

/** Index of the translation line for each segment id. */
function translationIndex(segments: Segment[], translation: { start: number }[] | null | undefined): Map<number, number> {
  const out = new Map<number, number>();
  if (!translation?.length) return out;
  const nonEmpty = segments.filter((s) => s.text.trim());
  if (nonEmpty.length === translation.length) {
    nonEmpty.forEach((s, i) => out.set(s.id, i));
    return out;
  }
  // The transcript changed after translating: match by time.
  for (const s of nonEmpty) {
    let best = 0;
    for (let i = 1; i < translation.length; i++) {
      if (Math.abs(translation[i].start - s.start) < Math.abs(translation[best].start - s.start)) best = i;
    }
    out.set(s.id, best);
  }
  return out;
}

function TimeBadge({ start, onSeek, title }: { start: number; onSeek?: ((time: number) => void) | null; title?: string }) {
  if (!onSeek) {
    return (
      <span className="seg-time" dir="ltr">
        [{formatTimestamp(start)}]
      </span>
    );
  }
  return (
    <button type="button" className="seg-time seg-seek" dir="ltr" title={title} onClick={() => onSeek(start)}>
      [{formatTimestamp(start)}]
    </button>
  );
}

const BilingualRow = memo(function BilingualRow({
  segment,
  alt,
  altIndex,
  onEdit,
  onEditAlt,
  onSeek,
  seekTitle,
}: {
  segment: Segment;
  alt: string;
  altIndex: number | undefined;
  onEdit: (id: number, text: string) => void;
  onEditAlt?: (index: number, text: string) => void;
  onSeek?: ((time: number) => void) | null;
  seekTitle?: string;
}) {
  return (
    <div className="seg seg-bilingual" data-seg-id={segment.id}>
      <TimeBadge start={segment.start} onSeek={onSeek} title={seekTitle} />
      <div className="seg-pair">
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
        <div
          className="seg-alt"
          dir="auto"
          contentEditable={altIndex !== undefined}
          suppressContentEditableWarning
          spellCheck={false}
          onBlur={(e) => {
            const value = e.currentTarget.innerText.replace(/\s+/g, " ").trim();
            if (altIndex !== undefined && value !== alt) onEditAlt?.(altIndex, value);
          }}
        >
          {alt}
        </div>
      </div>
    </div>
  );
});

/** Index of the chapter that starts at each segment id (first segment at/after its start). */
function chapterStarts(segments: Segment[], chapters: AiChapter[] | undefined): Map<number, AiChapter> {
  const out = new Map<number, AiChapter>();
  if (!chapters?.length) return out;
  const sorted = [...chapters].sort((a, b) => a.start - b.start);
  let ci = 0;
  for (const seg of segments) {
    // A chapter "owns" the first segment whose start is at or after its own start.
    while (ci < sorted.length && seg.start + 0.01 >= sorted[ci].start) {
      if (!out.has(seg.id)) out.set(seg.id, sorted[ci]);
      ci += 1;
    }
  }
  return out;
}

function ChapterHeading({ chapter, onSeek }: { chapter: AiChapter; onSeek?: ((time: number) => void) | null }) {
  return (
    <div
      className={`chapter-heading${onSeek ? " seekable" : ""}`}
      onClick={onSeek ? () => onSeek(chapter.start) : undefined}
      role={onSeek ? "button" : undefined}
    >
      <span className="chapter-time" dir="ltr">
        {formatTimestamp(chapter.start)}
      </span>
      <span dir="auto">{chapter.title}</span>
    </div>
  );
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
  onSeek,
  seekTitle,
}: {
  segment: Segment;
  editable: boolean;
  query: string;
  onEdit: (id: number, text: string) => void;
  onSeek?: ((time: number) => void) | null;
  seekTitle?: string;
}) {
  return (
    <div className="seg" data-seg-id={segment.id}>
      <TimeBadge start={segment.start} onSeek={onSeek} title={seekTitle} />
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

export function TranscriptView({
  t,
  segments,
  rtl,
  live,
  onEdit,
  chapters,
  focus,
  translation,
  onEditTranslation,
  viewRequest,
  tools,
  clock,
  onSeek,
  follow = true,
}: Props) {
  const [query, setQuery] = useState("");
  const [view, setView] = useState<View>("segments");
  const altIndex = useMemo(() => translationIndex(segments, translation), [segments, translation]);
  const hasTranslation = Boolean(translation?.length);

  useEffect(() => {
    if (viewRequest) {
      setQuery("");
      setView(viewRequest.view);
    }
  }, [viewRequest]);
  // Translation deleted while shown: fall back to the normal view.
  useEffect(() => {
    if (!hasTranslation && view === "bilingual") setView("segments");
  }, [hasTranslation, view]);
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

  const chapterAt = useMemo(() => chapterStarts(segments, chapters), [segments, chapters]);
  const paragraphChapters = useMemo(() => chapterStarts(paragraphs, chapters), [paragraphs, chapters]);

  // Jump to a time (e.g. a chapter clicked in the summary).
  useEffect(() => {
    if (!focus || !segments.length) return;
    setQuery("");
    setView((v) => (v === "bilingual" ? v : "segments"));
    stickToBottom.current = false;
    const target = [...segments].reverse().find((s) => s.start <= focus.time + 0.01) ?? segments[0];
    requestAnimationFrame(() => {
      const el = scroller.current?.querySelector<HTMLElement>(`[data-seg-id="${target.id}"]`);
      if (!el) return;
      el.scrollIntoView({ block: "start", behavior: "smooth" });
      el.classList.remove("flash");
      void el.offsetWidth; // restart the highlight animation
      el.classList.add("flash");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.nonce]);

  // Follow new text while transcribing, unless the user scrolled up to read.
  useEffect(() => {
    const el = scroller.current;
    if (el && live && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [segments.length, live]);

  // ---- Built-in player: highlight the line being played and keep it in view ----
  const lastManualScroll = useRef(0);
  const followRef = useRef(follow);
  followRef.current = follow;
  const playList = useMemo(
    () => (view === "paragraphs" && !q ? paragraphs : q ? visible : segments.filter((s) => view !== "bilingual" || s.text.trim())),
    [view, q, paragraphs, visible, segments],
  );
  const playStarts = useMemo(() => playList.map((s) => s.start), [playList]);
  useEffect(() => {
    if (!clock) return;
    let current: HTMLElement | null = null;
    let currentId: number | null = null;
    const apply = (time: number, playing: boolean) => {
      const i = indexAt(playStarts, time);
      const id = i >= 0 ? playList[i].id : null;
      if (id === currentId && current?.isConnected) return;
      current?.classList.remove("is-playing");
      currentId = id;
      current = id === null ? null : (scroller.current?.querySelector<HTMLElement>(`[data-seg-id="${id}"]`) ?? null);
      if (!current) return;
      current.classList.add("is-playing");
      const box = scroller.current;
      if (!box || !followRef.current || !playing || Date.now() - lastManualScroll.current < 4000) return;
      const r = current.getBoundingClientRect();
      const b = box.getBoundingClientRect();
      if (r.top < b.top + b.height * 0.15 || r.bottom > b.top + b.height * 0.7) {
        stickToBottom.current = false;
        box.scrollTo({ top: box.scrollTop + (r.top - b.top) - b.height * 0.3, behavior: "smooth" });
      }
    };
    apply(clock.time, false);
    const off = clock.subscribe(apply);
    return () => {
      off();
      current?.classList.remove("is-playing");
    };
  }, [clock, playList, playStarts]);

  const copyAll = async () => {
    const text =
      view === "bilingual"
        ? segments
            .filter((s) => s.text.trim())
            .map((s) => `${s.text}\n${translation?.[altIndex.get(s.id) ?? -1]?.text ?? ""}`)
            .join("\n\n")
        : (view === "paragraphs" ? paragraphs : segments).map((s) => s.text).join("\n\n");
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
            {hasTranslation ? (
              <button className={view === "bilingual" ? "is-active" : ""} onClick={() => setView("bilingual")}>
                {t.viewBilingual}
              </button>
            ) : null}
          </div>
          {tools}
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
        onWheel={() => (lastManualScroll.current = Date.now())}
        onTouchMove={() => (lastManualScroll.current = Date.now())}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {segments.length === 0 ? (
          <div className="empty">{t.transcriptEmpty}</div>
        ) : view === "bilingual" && !q ? (
          segments
            .filter((s) => s.text.trim())
            .map((s) => (
              <Fragment key={s.id}>
                {chapterAt.has(s.id) ? <ChapterHeading chapter={chapterAt.get(s.id)!} onSeek={onSeek} /> : null}
                <BilingualRow
                  segment={s}
                  alt={translation?.[altIndex.get(s.id) ?? -1]?.text ?? ""}
                  altIndex={altIndex.get(s.id)}
                  onEdit={onEdit}
                  onEditAlt={onEditTranslation}
                  onSeek={onSeek}
                  seekTitle={t.playerClickToPlay}
                />
              </Fragment>
            ))
        ) : view === "paragraphs" && !q ? (
          <article className="reading">
            {paragraphs.map((p) => (
              <Fragment key={p.id}>
                {paragraphChapters.has(p.id) ? <ChapterHeading chapter={paragraphChapters.get(p.id)!} onSeek={onSeek} /> : null}
                <p
                  dir="auto"
                  data-seg-id={p.id}
                  className={onSeek ? "seekable" : undefined}
                  title={onSeek ? t.playerClickToPlay : undefined}
                  onClick={onSeek ? () => onSeek(p.start) : undefined}
                >
                  {p.text}
                </p>
              </Fragment>
            ))}
          </article>
        ) : (
          visible.map((s) => (
            <Fragment key={s.id}>
              {!q && chapterAt.has(s.id) ? <ChapterHeading chapter={chapterAt.get(s.id)!} onSeek={onSeek} /> : null}
              <SegmentRow segment={s} editable={!q} query={query.trim()} onEdit={onEdit} onSeek={onSeek} seekTitle={t.playerClickToPlay} />
            </Fragment>
          ))
        )}
      </div>
      {segments.length && !q && view !== "paragraphs" ? <footer className="hint transcript-foot">{t.editHint}</footer> : null}
    </section>
  );
}
