"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import { ApiError, type AskResult, type BackendClient, type LlmProvider } from "@/lib/api";
import { formatTimestamp } from "@/lib/format";
import { errorMessage, type Strings, type UiLang } from "@/lib/i18n";
import { usePersistentState } from "@/lib/useBackend";
import { secretName } from "./CloudSettings";
import { DEFAULT_SUMMARY_SETTINGS, type SummarySettings } from "./SummaryPanel";
import { AlertIcon, FolderIcon, QuestionIcon } from "./Icons";

interface Props {
  t: Strings;
  lang: UiLang;
  client: BackendClient;
  course: string;
  onOpenAt: (id: string, time: number) => void;
  onClose: () => void;
}

type Entry = { question: string; result?: AskResult; error?: { code: string; detail: string }; taskId?: string };

const CITE = /\[L(\d+)\s+(\d{1,2}:\d{2}(?::\d{2})?|summary)\]/g;

function clockToSeconds(value: string): number {
  if (value === "summary") return 0;
  return value.split(":").reduce((acc, part) => acc * 60 + Number(part), 0);
}

/** Answer text with its [L3 12:40] citations turned into buttons that open the lesson there. */
function AnswerText({ result, t, onOpenAt, dir }: { result: AskResult; t: Strings; onOpenAt: Props["onOpenAt"]; dir: "rtl" | "ltr" }) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const m of result.answer.matchAll(CITE)) {
    const lesson = result.lessons[m[1]];
    parts.push(result.answer.slice(last, m.index));
    const time = clockToSeconds(m[2]);
    parts.push(
      lesson ? (
        <button key={`${m.index}`} className="cite" dir="ltr" title={lesson.title} onClick={() => onOpenAt(lesson.id, time)}>
          {t.askLessonShort.replace("{n}", m[1])} {m[2] === "summary" ? "" : m[2]}
        </button>
      ) : (
        m[0]
      ),
    );
    last = (m.index ?? 0) + m[0].length;
  }
  parts.push(result.answer.slice(last));
  return (
    <div className="ask-answer" dir={dir}>
      {parts.map((p, i) => (
        <Fragment key={i}>{p}</Fragment>
      ))}
    </div>
  );
}

export function AskDialog({ t, lang, client, course, onOpenAt, onClose }: Props) {
  const [settings] = usePersistentState<SummarySettings>("summary-settings", DEFAULT_SUMMARY_SETTINGS);
  const [providers, setProviders] = useState<LlmProvider[]>([]);
  const [question, setQuestion] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const answerDir = lang === "ar" ? "rtl" : "ltr";
  const running = entries.some((e) => e.taskId);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    client.summaryProviders().then(setProviders).catch(() => undefined);
  }, [client]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  // Poll the running question.
  const pending = entries.find((e) => e.taskId);
  useEffect(() => {
    if (!pending?.taskId) return;
    const id = pending.taskId;
    const timer = setInterval(async () => {
      try {
        const st = await client.assistStatus(id);
        if (st.status === "running") return;
        setEntries((prev) =>
          prev.map((e) =>
            e.taskId === id
              ? { question: e.question, result: st.status === "completed" ? (st.result as AskResult) : undefined, error: st.error ?? undefined }
              : e,
          ),
        );
      } catch (err) {
        setEntries((prev) =>
          prev.map((e) => (e.taskId === id ? { question: e.question, error: err instanceof ApiError ? { code: err.code, detail: err.detail } : { code: "internal", detail: "" } } : e)),
        );
      }
    }, 900);
    return () => clearInterval(timer);
  }, [client, pending?.taskId]);

  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight, behavior: "smooth" });
  }, [entries.length, pending?.taskId]);

  const ask = async () => {
    const q = question.trim();
    if (!q || running) return;
    const apiKey = (await window.desktop?.getSecret(secretName(settings.provider))) ?? "";
    if (!apiKey) {
      setEntries((prev) => [...prev, { question: q, error: { code: "cloud_auth", detail: "" } }]);
      return;
    }
    setQuestion("");
    try {
      const task = await client.assistAsk({ course, question: q, provider: settings.provider, model: settings.model, api_key: apiKey });
      setEntries((prev) => [...prev, { question: q, taskId: task.id }]);
    } catch (err) {
      setEntries((prev) => [...prev, { question: q, error: err instanceof ApiError ? { code: err.code, detail: err.detail } : { code: "internal", detail: "" } }]);
    }
  };

  const providerName = providers.find((p) => p.id === settings.provider)?.name ?? settings.provider;

  return (
    <div className="modal-backdrop nested" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal ask-modal" role="dialog" aria-modal="true" aria-labelledby="ask-title">
        <header className="modal-head">
          <div>
            <h2 id="ask-title">
              <QuestionIcon size={18} /> {t.askTitle}
            </h2>
            <p className="hint">
              <FolderIcon size={13} /> <bdi>{course || t.archiveNoCourse}</bdi> · {t.askHint.split("{provider}")[0]}
              <bdi dir="ltr">
                {providerName} ({settings.model})
              </bdi>
              {t.askHint.split("{provider}")[1] ?? ""}
            </p>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label={t.close}>
            ✕
          </button>
        </header>
        <div className="modal-body ask-body" ref={list}>
          {entries.length === 0 ? (
            <div className="ask-empty">
              <p>{t.askEmpty}</p>
              <div className="ask-examples">
                {[t.askExample1, t.askExample2, t.askExample3].map((ex) => (
                  <button key={ex} className="chip" onClick={() => setQuestion(ex)}>
                    {ex}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          {entries.map((e, i) => (
            <div key={i} className="ask-entry">
              <div className="ask-q" dir="auto">
                {e.question}
              </div>
              {e.taskId ? (
                <div className="ask-wait">
                  <span className="spinner small" /> {t.askWorking}
                </div>
              ) : e.error ? (
                <div className="notice error">
                  <AlertIcon size={16} /> {e.error.code === "cloud_auth" ? t.quizNeedsKey : errorMessage(lang, e.error.code)}
                </div>
              ) : e.result ? (
                <div className={`ask-a${e.result.found ? "" : " not-found"}`}>
                  <AnswerText result={e.result} t={t} onOpenAt={onOpenAt} dir={/[\u0600-\u06FF]/.test(e.question) ? "rtl" : answerDir} />
                  {e.result.citations.length ? (
                    <div className="ask-sources">
                      <span className="muted small">{t.askSources}:</span>
                      {e.result.citations.map((c) => (
                        <button key={`${c.id}-${c.start}`} className="chip" onClick={() => onOpenAt(c.id, c.start)} title={c.title}>
                          {t.askLessonShort.replace("{n}", String(c.lesson_index))} ·{" "}
                          <span dir="ltr">{formatTimestamp(c.start)}</span>
                        </button>
                      ))}
                    </div>
                  ) : null}
                  {e.result.searched < e.result.total ? (
                    <div className="muted small">{t.askSearched.replace("{n}", String(e.result.searched)).replace("{total}", String(e.result.total))}</div>
                  ) : null}
                </div>
              ) : null}
            </div>
          ))}
        </div>
        <footer className="modal-foot ask-foot">
          <textarea
            dir="auto"
            rows={2}
            value={question}
            placeholder={t.askPlaceholder}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                ask();
              }
            }}
          />
          <button className="btn btn-accent" disabled={!question.trim() || running} onClick={ask}>
            <QuestionIcon size={15} /> {t.askButton}
          </button>
        </footer>
      </div>
    </div>
  );
}
