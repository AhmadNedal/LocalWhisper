"use client";

import type { JobSnapshot, Stage } from "@/lib/api";
import { formatBytes, formatDuration } from "@/lib/format";
import { errorMessage, type Strings, type UiLang } from "@/lib/i18n";
import { languageName } from "@/lib/languages";
import { AlertIcon, CheckIcon, PlayIcon, StopIcon } from "./Icons";

interface Props {
  t: Strings;
  lang: UiLang;
  job: JobSnapshot | null;
  canStart: boolean;
  cancelling: boolean;
  generatingPdf: boolean;
  isYoutube: boolean;
  /** Status shown when no job has run (e.g. captions were loaded from YouTube). */
  readyNote?: string | null;
  onStart: () => void;
  onCancel: () => void;
}

const STEPS: Stage[] = ["downloading_media", "extracting_audio", "downloading_model", "loading_model", "transcribing", "finalizing"];

function stepState(step: Stage, job: JobSnapshot, isYoutube: boolean): "done" | "active" | "pending" | "skipped" {
  if (step === "downloading_media" && !isYoutube) return "skipped";
  if (job.status === "completed") return step === "downloading_model" && !job.download ? "skipped" : "done";
  // YouTube jobs download first, then probe the downloaded file.
  const order: Stage[] = isYoutube
    ? ["queued", "downloading_media", "probing", ...STEPS.slice(1)]
    : ["queued", "probing", ...STEPS];
  const current = order.indexOf(job.stage);
  const index = order.indexOf(step);
  if (index < current) return step === "downloading_model" && !job.download ? "skipped" : "done";
  if (index === current) return "active";
  return "pending";
}

export function ProgressPanel({
  t,
  lang,
  job,
  canStart,
  cancelling,
  generatingPdf,
  isYoutube,
  readyNote,
  onStart,
  onCancel,
}: Props) {
  const running = job?.status === "running";
  const pct = Math.round((job?.progress ?? 0) * 100);
  const stageLabel = generatingPdf
    ? t.stage_generating_pdf
    : job
      ? (t[`stage_${job.stage}` as keyof Strings] ?? job.stage)
      : (readyNote ?? t.idle);
  const gpuFallback = job?.warnings.some((w) => w.startsWith("gpu_fallback"));
  const gpuTooSmall = job?.warnings.includes("gpu_too_small");
  const lowMemory = job?.warnings.includes("low_memory");

  return (
    <section className="card progress-card">
      <div className="progress-actions">
        {running ? (
          <button className="btn btn-danger btn-large" onClick={onCancel} disabled={cancelling}>
            <StopIcon size={16} /> {cancelling ? t.cancelling : t.cancel}
          </button>
        ) : (
          <button className="btn btn-accent btn-large" onClick={onStart} disabled={!canStart}>
            <PlayIcon size={16} /> {t.start}
          </button>
        )}
      </div>

      <div className="status-line" aria-live="polite">
        <span className={`status-dot ${job?.status ?? (readyNote ? "completed" : "idle")} ${generatingPdf ? "running" : ""}`} />
        <span className="status-text">{stageLabel}</span>
        {job ? (
          <span className="status-pct" dir="ltr">
            {pct}%
          </span>
        ) : null}
      </div>

      <div
        className={`progress-bar ${running ? "is-running" : ""} ${job?.status ?? ""}`}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-label={t.progress}
      >
        <div style={{ width: `${job ? Math.max(pct, running ? 2 : 0) : 0}%` }} />
      </div>

      {job ? (
        <>
          {job.status === "running" || job.status === "completed" ? (
          <ol className="steps">
            {STEPS.map((step) => {
              const state = stepState(step, job, isYoutube);
              if (state === "skipped") return null;
              const active = state === "active";
              return (
                <li key={step} className={`step ${state}`}>
                  <span className="step-mark">{state === "done" ? <CheckIcon size={12} /> : null}</span>
                  <span className="step-label">{t[`stage_${step}` as keyof Strings]}</span>
                  {active && (step === "downloading_model" || step === "downloading_media") && job.download ? (
                    <span className="step-extra" dir="ltr">
                      {formatBytes(job.download.done)} / {formatBytes(job.download.total)}
                    </span>
                  ) : active && step !== "loading_model" ? (
                    <span className="step-extra" dir="ltr">
                      {Math.round(job.stageProgress * 100)}%
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ol>
          ) : null}

          <dl className="facts">
            {job.etaSeconds != null && running ? (
              <div>
                <dt>{t.remaining}</dt>
                <dd>{formatDuration(job.etaSeconds, lang)}</dd>
              </div>
            ) : null}
            <div>
              <dt>{t.elapsed}</dt>
              <dd>{formatDuration(job.elapsedSeconds, lang)}</dd>
            </div>
            {job.language ? (
              <div>
                <dt>{t.detectedLanguage}</dt>
                <dd>
                  {languageName(job.language, lang)}
                  {job.languageProbability != null && job.languageProbability < 1 ? (
                    <span className="muted" dir="ltr">
                      {" "}
                      ({Math.round(job.languageProbability * 100)}%)
                    </span>
                  ) : null}
                </dd>
              </div>
            ) : null}
            {job.device ? (
              <div className="wide">
                <dt>{t.runningOn}</dt>
                <dd dir="ltr">
                  {job.device === "cuda" ? "GPU" : "CPU"} · {job.computeType} · {job.model}
                </dd>
              </div>
            ) : null}
          </dl>

          {lowMemory && job.status === "running" ? (
            <div className="notice info">
              <AlertIcon size={16} /> {lowMemory ? t.lowMemory : null}
            </div>
          ) : null}
          {gpuTooSmall ? (
            <div className="notice warn">
              <AlertIcon size={16} /> {t.gpuTooSmall}
            </div>
          ) : null}
          {gpuFallback ? (
            <div className="notice warn">
              <AlertIcon size={16} /> {t.gpuFallback}
            </div>
          ) : null}
          {job.error && job.status !== "running" ? (
            <div className={`notice ${job.status === "cancelled" ? "info" : "error"}`}>
              <AlertIcon size={16} />
              <div>
                <div>{errorMessage(lang, job.error.code)}</div>
                {job.error.detail && job.status === "error" ? (
                  <details>
                    <summary>{t.details}</summary>
                    <code dir="ltr">{job.error.detail}</code>
                  </details>
                ) : null}
              </div>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
