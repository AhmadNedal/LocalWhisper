"use client";

import { keyState } from "@/lib/keys";
import { useEffect, useState } from "react";
import { ApiError, type AiSummary, type BackendClient, type LlmProvider } from "@/lib/api";
import { formatTimestamp } from "@/lib/format";
import { errorMessage, type Strings, type UiLang } from "@/lib/i18n";
import { secretName } from "./CloudSettings";
import { AlertIcon, CheckIcon, CopyIcon, KeyIcon, SettingsIcon, SparkIcon, TrashIcon } from "./Icons";

export interface SummarySettings {
  provider: string;
  model: string;
  language: "auto" | "ar" | "en";
}

export const DEFAULT_SUMMARY_SETTINGS: SummarySettings = {
  // Groq works out of the box with the app's built-in free key.
  provider: "groq",
  model: "openai/gpt-oss-120b",
  language: "auto",
};

interface Props {
  t: Strings;
  lang: UiLang;
  client: BackendClient | null;
  providers: LlmProvider[];
  settings: SummarySettings;
  onSettings: (patch: Partial<SummarySettings>) => void;
  summary: AiSummary | null;
  running: boolean;
  progress: { step: number; steps: number } | null;
  error: { code: string; detail: string } | null;
  canSummarize: boolean;
  onGenerate: () => void;
  onCancel: () => void;
  onDelete: () => void;
  onJump: (time: number) => void;
}

const CUSTOM = "__custom__";

export function SummaryPanel({
  t,
  lang,
  client,
  providers,
  settings,
  onSettings,
  summary,
  running,
  progress,
  error,
  canSummarize,
  onGenerate,
  onCancel,
  onDelete,
  onJump,
}: Props) {
  const provider = providers.find((p) => p.id === settings.provider) ?? providers[0];
  const [key, setKey] = useState("");
  const [savedKey, setSavedKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [keyStatus, setKeyStatus] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [builtin, setBuiltin] = useState(false);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const knownModel = provider?.models.some((m) => m.id === settings.model);
  const [custom, setCustom] = useState(false);

  useEffect(() => {
    if (!provider) return;
    setKeyStatus(null);
    keyState(secretName(provider.id)).then(({ stored, builtin: has }) => {
      setKey(stored);
      setSavedKey(stored);
      setBuiltin(has);
    });
  }, [provider]);

  useEffect(() => {
    // A saved model that isn't in the list is a custom one; "" means the user is typing one.
    if (knownModel) setCustom(false);
    else if (settings.model) setCustom(true);
  }, [settings.model, knownModel]);

  if (!provider) return null;
  const settingsOpen = open || (!savedKey && !builtin);

  const saveKey = async (value: string) => {
    const res = await window.desktop?.setSecret(secretName(provider.id), value.trim());
    setSavedKey(value.trim());
    setKeyStatus(res?.ok ? { kind: "ok", text: t.cloudKeySaved } : { kind: "error", text: t.dbNotEncrypted });
  };

  const testKey = async () => {
    if (!client) return;
    setTesting(true);
    setKeyStatus(null);
    try {
      await client.summaryTest(provider.id, key.trim());
      if (key.trim() !== savedKey) await saveKey(key);
      setKeyStatus({ kind: "ok", text: t.cloudKeyOk });
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "internal";
      const detail = err instanceof ApiError ? err.detail : String(err);
      setKeyStatus({ kind: "error", text: `${errorMessage(lang, code)}${detail ? ` (${detail})` : ""}` });
    } finally {
      setTesting(false);
    }
  };

  const copy = async () => {
    if (!summary) return;
    const lines = [
      summary.summary,
      "",
      `${t.summaryKeyPoints}:`,
      ...summary.key_points.map((k) => `• ${k}`),
      "",
      `${t.summaryChapters}:`,
      ...summary.chapters.map((c) => `${formatTimestamp(c.start)}  ${c.title}${c.summary ? ` — ${c.summary}` : ""}`),
    ];
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked */
    }
  };

  return (
    <section className="card summary-card">
      <header className="summary-head">
        <div className="panel-title">
          <span className="panel-badge">
            <SparkIcon size={17} />
          </span>
          <div className="summary-title">
            <h2 className="card-title">{t.summaryTitle}</h2>
            <span className="muted small">
              {summary ? t.summaryBy.replace("{model}", summary.model) : t.summaryHint}
            </span>
          </div>
        </div>
        <div className="summary-actions">
          {summary ? (
            <>
              <button className="icon-btn" title={t.summaryCopy} aria-label={t.summaryCopy} onClick={copy}>
                <CopyIcon size={16} />
              </button>
              <button className="icon-btn" title={t.summaryDelete} aria-label={t.summaryDelete} onClick={onDelete} disabled={running}>
                <TrashIcon size={15} />
              </button>
              {copied ? <span className="pill pill-ok">{t.copied}</span> : null}
            </>
          ) : null}
          <button
            className={`icon-btn${settingsOpen ? " is-on" : ""}`}
            title={t.summarySettings}
            aria-label={t.summarySettings}
            onClick={() => setOpen((o) => !o)}
            aria-expanded={settingsOpen}
          >
            <SettingsIcon size={15} />
          </button>
          {running ? (
            <button className="btn" onClick={onCancel}>
              <span className="spinner small" />{" "}
              {progress && progress.steps > 1
                ? t.summaryStep.replace("{step}", String(Math.min(progress.step + 1, progress.steps))).replace("{steps}", String(progress.steps))
                : t.summaryRunning}{" "}
              · {t.summaryCancel}
            </button>
          ) : (
            <button
              className="btn btn-accent"
              disabled={!canSummarize || !(savedKey || builtin) || !settings.model.trim()}
              title={!canSummarize ? t.summaryNeedsTranscript : undefined}
              onClick={onGenerate}
            >
              <SparkIcon size={15} /> {summary ? t.summaryRegenerate : t.summaryGenerate}
            </button>
          )}
        </div>
      </header>

      {settingsOpen ? (
        <div className="summary-settings">
          <div className="field">
            <label>{t.summaryProvider}</label>
            <div className="segmented" role="radiogroup" aria-label={t.summaryProvider}>
              {providers.map((p) => (
                <button
                  key={p.id}
                  role="radio"
                  aria-checked={p.id === provider.id}
                  className={p.id === provider.id ? "is-active" : ""}
                  disabled={running}
                  onClick={() => onSettings({ provider: p.id, model: p.models[0].id })}
                >
                  {p.name}
                </button>
              ))}
            </div>
          </div>
          <div className="summary-row">
            <div className="field">
              <label htmlFor="sum-model">{t.summaryModel}</label>
              <select
                id="sum-model"
                dir="ltr"
                value={custom ? CUSTOM : settings.model}
                disabled={running}
                onChange={(e) => {
                  if (e.target.value === CUSTOM) {
                    setCustom(true);
                    onSettings({ model: "" });
                  } else {
                    setCustom(false);
                    onSettings({ model: e.target.value });
                  }
                }}
              >
                {provider.models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
                <option value={CUSTOM}>{t.summaryCustomModel}</option>
              </select>
              {custom ? (
                <input
                  className="mono"
                  dir="ltr"
                  spellCheck={false}
                  placeholder={t.summaryCustomModelPlaceholder}
                  value={settings.model}
                  disabled={running}
                  onChange={(e) => onSettings({ model: e.target.value.trim() })}
                />
              ) : null}
            </div>
            <div className="field">
              <label htmlFor="sum-lang">{t.summaryLanguage}</label>
              <select
                id="sum-lang"
                value={settings.language}
                disabled={running}
                onChange={(e) => onSettings({ language: e.target.value as SummarySettings["language"] })}
              >
                <option value="auto">{t.summaryLangAuto}</option>
                <option value="ar">العربية</option>
                <option value="en">English</option>
              </select>
            </div>
          </div>
          <div className="field">
            <div className="field-head">
              <label htmlFor="sum-key">
                <KeyIcon size={14} /> {t.cloudApiKey} — {provider.name}
              </label>
              <a className="link-btn" href={provider.key_url} target="_blank" rel="noreferrer">
                {t.cloudGetKey}
              </a>
            </div>
            <div className="conn-row">
              <input
                id="sum-key"
                type={showKey ? "text" : "password"}
                dir="ltr"
                className="mono"
                autoComplete="off"
                spellCheck={false}
                placeholder={t.cloudKeyPlaceholder}
                value={key}
                onChange={(e) => {
                  setKey(e.target.value);
                  setKeyStatus(null);
                }}
              />
              <button className="btn btn-subtle" onClick={() => setShowKey((v) => !v)}>
                {showKey ? t.dbHide : t.dbShow}
              </button>
              <button className="btn" disabled={!key.trim() || key.trim() === savedKey} onClick={() => saveKey(key)}>
                {t.cloudSaveKey}
              </button>
              <button className="btn" disabled={!key.trim() || testing || !client} onClick={testKey}>
                {testing ? t.cloudTesting : t.cloudTestKey}
              </button>
            </div>
            {builtin && !savedKey && !keyStatus ? <p className="hint ok-text">{t.builtinKeyHint}</p> : null}
            {keyStatus ? (
              <p className={`hint ${keyStatus.kind === "error" ? "warn" : "ok-text"}`}>
                {keyStatus.kind === "error" ? <AlertIcon size={13} /> : <CheckIcon size={13} />} {keyStatus.text}
              </p>
            ) : null}
            <p className="hint">{t.summaryPrivacy.replace("{provider}", provider.name)}</p>
          </div>
        </div>
      ) : null}

      {error ? (
        <div className="notice error">
          <AlertIcon size={16} />
          <div>
            <div>{errorMessage(lang, error.code)}</div>
            {error.detail ? (
              <details>
                <summary>{t.details}</summary>
                <code dir="ltr">{error.detail}</code>
              </details>
            ) : null}
          </div>
        </div>
      ) : null}

      {summary ? (
        <div className="summary-body" dir="auto">
          <div className="summary-lead">
            {summary.summary.split("\n").filter((p) => p.trim()).map((p, i) => (
              <p key={i} className="summary-text" dir="auto">
                {p}
              </p>
            ))}
          </div>
          <div className="summary-grid">
            {summary.key_points.length ? (
              <div className="summary-block">
                <h3>{t.summaryKeyPoints}</h3>
                <ul className="key-points">
                  {summary.key_points.map((k, i) => (
                    <li key={i} dir="auto">
                      {k}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {summary.chapters.length ? (
              <div className="summary-block">
                <h3>{t.summaryChapters}</h3>
                <ol className="chapters">
                  {summary.chapters.map((c, i) => (
                    <li key={i}>
                      <button className="chapter-btn" title={t.summaryGoTo} onClick={() => onJump(c.start)}>
                        <span className="chapter-time" dir="ltr">
                          {formatTimestamp(c.start)}
                        </span>
                        <span className="chapter-text">
                          <span className="chapter-name" dir="auto">
                            {c.title}
                          </span>
                          {c.summary ? (
                            <span className="chapter-desc" dir="auto">
                              {c.summary}
                            </span>
                          ) : null}
                        </span>
                      </button>
                    </li>
                  ))}
                </ol>
              </div>
            ) : null}
          </div>
          {summary.keywords.length ? (
            <div className="keywords">
              <span className="muted small">{t.summaryKeywords}:</span>
              {summary.keywords.map((k, i) => (
                <span key={i} className="keyword" dir="auto">
                  {k}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
