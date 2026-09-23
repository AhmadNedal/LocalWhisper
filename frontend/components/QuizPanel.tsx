"use client";

import { useEffect, useState } from "react";
import { ApiError, type BackendClient, type QuizData } from "@/lib/api";
import { formatTimestamp } from "@/lib/format";
import { errorMessage, type Strings, type UiLang } from "@/lib/i18n";
import { usePersistentState } from "@/lib/useBackend";
import { secretName } from "./CloudSettings";
import type { SummarySettings } from "./SummaryPanel";
import { AlertIcon, ChevronDownIcon, CopyIcon, QuizIcon, RefreshIcon, SettingsIcon, TrashIcon } from "./Icons";

interface Props {
  t: Strings;
  lang: UiLang;
  client: BackendClient | null;
  settings: SummarySettings;
  providerName: string;
  quiz: QuizData | null;
  onQuiz: (quiz: QuizData | null) => void;
  archiveId: string | null;
  title: string;
  duration: number | null;
  segments: { start: number; end: number; text: string }[];
  canGenerate: boolean;
  onJump: (time: number) => void;
}

interface QuizPrefs {
  count: number;
  mcq: boolean;
  tf: boolean;
}

function asText(quiz: QuizData, t: Strings): string {
  return quiz.questions
    .map((q, n) => {
      const opts = q.options.map((o, i) => `   ${i === q.answer ? "✓" : " "} ${String.fromCharCode(65 + i)}) ${o}`).join("\n");
      return `${n + 1}. ${q.question}\n${opts}${q.explanation ? `\n   ${t.quizWhy}: ${q.explanation}` : ""}`;
    })
    .join("\n\n");
}

/** Quiz for the lesson on screen: multiple choice and true/false, answered interactively. */
export function QuizPanel({ t, lang, client, settings, providerName, quiz, onQuiz, archiveId, title, duration, segments, canGenerate, onJump }: Props) {
  const [prefs, setPrefs] = usePersistentState<QuizPrefs>("quiz-prefs", { count: 8, mcq: true, tf: true });
  const [taskId, setTaskId] = useState<string | null>(null);
  const [error, setError] = useState<{ code: string; detail: string } | null>(null);
  const [picked, setPicked] = useState<Record<number, number>>({});
  const [showAll, setShowAll] = useState(false);
  const [open, setOpen] = useState(false); // collapsed by default: the quiz stays out of the way
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [index, setIndex] = useState(0);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setPicked({});
    setShowAll(false);
    setIndex(0);
  }, [quiz]);

  useEffect(() => {
    if (!client || !taskId) return;
    let stop = false;
    const tick = async () => {
      try {
        const st = await client.assistStatus(taskId);
        if (stop) return;
        if (st.status === "running") {
          setTimeout(tick, 900);
          return;
        }
        setTaskId(null);
        if (st.status === "completed" && st.result) {
          onQuiz(st.result as QuizData);
          setOpen(true); // just asked for it: show the first question
          setSettingsOpen(false);
        }
        else if (st.error) setError(st.error);
      } catch (err) {
        if (!stop) {
          setTaskId(null);
          if (err instanceof ApiError) setError({ code: err.code, detail: err.detail });
        }
      }
    };
    const timer = setTimeout(tick, 900);
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [client, taskId, onQuiz]);

  const generate = async () => {
    if (!client) return;
    setError(null);
    const apiKey = (await window.desktop?.getSecret(secretName(settings.provider))) ?? "";
    if (!apiKey) {
      setError({ code: "cloud_auth", detail: "" });
      return;
    }
    const types = [prefs.mcq ? "mcq" : null, prefs.tf ? "tf" : null].filter(Boolean) as ("mcq" | "tf")[];
    try {
      const task = await client.assistQuiz({
        provider: settings.provider,
        model: settings.model,
        api_key: apiKey,
        count: prefs.count,
        types: types.length ? types : ["mcq"],
        language: settings.language,
        title,
        duration,
        archive_id: archiveId,
        segments,
      });
      setTaskId(task.id);
    } catch (err) {
      if (err instanceof ApiError) setError({ code: err.code, detail: err.detail });
    }
  };

  // Arabic questions often start with an English term ("ORDER BY يحذف…"): use the quiz language.
  const textDir = quiz?.language === "ar" ? "rtl" : quiz?.language === "en" ? "ltr" : "auto";
  const total = quiz?.questions.length ?? 0;
  const score = quiz ? quiz.questions.filter((q, i) => picked[i] === q.answer).length : 0;
  const answered = Object.keys(picked).length;
  const running = Boolean(taskId);
  const q = quiz && total ? quiz.questions[Math.min(index, total - 1)] : null;
  const qi = Math.min(index, Math.max(0, total - 1));
  const choice = picked[qi];
  const revealed = showAll || choice !== undefined;
  const finished = total > 0 && answered === total;

  const copy = async () => {
    if (!quiz) return;
    try {
      await navigator.clipboard.writeText(asText(quiz, t));
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* blocked */
    }
  };

  const meta = running
    ? t.quizWorking
    : !quiz
      ? t.quizNone
      : answered
        ? t.quizProgress.replace("{done}", String(answered)).replace("{n}", String(total)).replace("{score}", String(score))
        : t.quizCountLabel.replace("{n}", String(total));

  return (
    <section className={`card quiz-card${open ? " is-open" : ""}`}>
      <header className="quiz-bar">
        <button className="quiz-toggle" onClick={() => quiz && setOpen((o) => !o)} aria-expanded={open} disabled={!quiz}>
          <span className="quiz-badge">
            <QuizIcon size={16} />
          </span>
          <span className="quiz-titles">
            <span className="quiz-name">{t.quizTitle}</span>
            <span className="quiz-meta">
              {running ? <span className="spinner small" /> : null}
              {meta}
            </span>
          </span>
        </button>
        <span className="batch-spacer" />
        {!quiz && !running ? (
          <button className="btn btn-small" disabled={!canGenerate || (!prefs.mcq && !prefs.tf)} onClick={generate}>
            {t.quizGenerate}
          </button>
        ) : null}
        {running ? (
          <button className="btn btn-small btn-subtle" onClick={() => taskId && client?.assistCancel(taskId)}>
            {t.summaryCancel}
          </button>
        ) : null}
        <button
          className={`icon-btn${settingsOpen ? " is-on" : ""}`}
          title={t.quizSettings}
          aria-label={t.quizSettings}
          aria-pressed={settingsOpen}
          onClick={() => setSettingsOpen((o) => !o)}
        >
          <SettingsIcon size={15} />
        </button>
        {quiz ? (
          <button className={`icon-btn quiz-chevron${open ? " is-open" : ""}`} aria-label={open ? t.quizHide : t.quizShow} onClick={() => setOpen((o) => !o)}>
            <ChevronDownIcon size={16} />
          </button>
        ) : null}
      </header>

      {settingsOpen ? (
        <div className="quiz-settings">
          <div className="quiz-controls">
            <label className="inline-select">
              <span>{t.quizCount}</span>
              <select value={prefs.count} disabled={running} onChange={(e) => setPrefs((p) => ({ ...p, count: Number(e.target.value) }))}>
                {[5, 8, 10, 15, 20].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <label className="check">
              <input type="checkbox" checked={prefs.mcq} disabled={running} onChange={(e) => setPrefs((p) => ({ ...p, mcq: e.target.checked }))} />
              <span>{t.quizMcq}</span>
            </label>
            <label className="check">
              <input type="checkbox" checked={prefs.tf} disabled={running} onChange={(e) => setPrefs((p) => ({ ...p, tf: e.target.checked }))} />
              <span>{t.quizTf}</span>
            </label>
            <span className="batch-spacer" />
            {quiz ? (
              <>
                <button className="btn btn-small btn-subtle" onClick={copy}>
                  <CopyIcon size={14} /> {copied ? t.copied : t.copyAll}
                </button>
                <button className="btn btn-small btn-subtle" onClick={() => onQuiz(null)}>
                  <TrashIcon size={14} /> {t.quizDelete}
                </button>
              </>
            ) : null}
            <button className="btn btn-small" disabled={running || !canGenerate || (!prefs.mcq && !prefs.tf)} onClick={generate}>
              <RefreshIcon size={14} /> {quiz ? t.quizRegenerate : t.quizGenerate}
            </button>
          </div>
          <p className="hint">{t.quizHint.replace("{provider}", providerName)}</p>
        </div>
      ) : null}

      {error ? (
        <div className="notice error quiz-error">
          <AlertIcon size={16} /> {error.code === "cloud_auth" ? t.quizNeedsKey : errorMessage(lang, error.code)}
        </div>
      ) : null}

      {open && q ? (
        <div className="quiz-stage">
          <div className="quiz-progress">
            <span className="quiz-step">{t.quizStep.replace("{i}", String(qi + 1)).replace("{n}", String(total))}</span>
            <div className="quiz-dots" role="tablist">
              {quiz!.questions.map((qq, k) => (
                <button
                  key={k}
                  role="tab"
                  aria-selected={k === qi}
                  aria-label={t.quizStep.replace("{i}", String(k + 1)).replace("{n}", String(total))}
                  className={`quiz-dot${k === qi ? " is-current" : ""}${picked[k] === undefined ? "" : picked[k] === qq.answer ? " is-right" : " is-wrong"}`}
                  onClick={() => setIndex(k)}
                />
              ))}
            </div>
            {q.start != null ? (
              <button className="chapter-time quiz-time" dir="ltr" onClick={() => onJump(q.start!)} title={t.quizJump}>
                {formatTimestamp(q.start)}
              </button>
            ) : null}
          </div>

          <p className="quiz-question" dir={textDir}>
            {q.question}
          </p>
          <div className={`quiz-options${q.type === "tf" ? " is-tf" : ""}`}>
            {q.options.map((o, k) => {
              const state = !revealed ? "" : k === q.answer ? " is-right" : k === choice ? " is-wrong" : " is-dim";
              return (
                <button
                  key={k}
                  className={`quiz-option${state}`}
                  disabled={choice !== undefined}
                  onClick={() => setPicked((p) => ({ ...p, [qi]: k }))}
                >
                  <span className="quiz-letter">{String.fromCharCode(65 + k)}</span>
                  <span dir={q.type === "tf" ? textDir : "auto"}>{o}</span>
                </button>
              );
            })}
          </div>
          {revealed && q.explanation ? (
            <p className="quiz-why" dir={textDir}>
              {q.explanation}
            </p>
          ) : null}

          <div className="quiz-nav">
            <button className="btn btn-small btn-subtle" disabled={qi === 0} onClick={() => setIndex(qi - 1)}>
              {t.quizPrev}
            </button>
            {finished ? (
              <span className="quiz-final">
                {t.quizFinal.replace("{score}", String(score)).replace("{n}", String(total))}
                <button className="link-btn" onClick={() => { setPicked({}); setIndex(0); setShowAll(false); }}>
                  {t.quizRetry}
                </button>
              </span>
            ) : (
              <label className="check small">
                <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
                <span>{t.quizShowAnswers}</span>
              </label>
            )}
            <button className="btn btn-small btn-accent" disabled={qi >= total - 1} onClick={() => setIndex(qi + 1)}>
              {t.quizNext}
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
