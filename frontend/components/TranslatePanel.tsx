"use client";

import { useEffect, useState } from "react";
import type { BackendClient, TranslateCatalog, TranslateEngine, TranslationData } from "@/lib/api";
import { formatBytes } from "@/lib/format";
import { errorMessage, type Strings, type UiLang } from "@/lib/i18n";
import { secretName } from "./CloudSettings";
import { AlertIcon, CheckIcon, DownloadIcon, GlobeIcon, SettingsIcon, TrashIcon } from "./Icons";
import { KeyField } from "./KeyField";

export interface TranslateSettings {
  engine: TranslateEngine;
  target: "en" | "ar";
  provider: string;
  model: string;
  region: string;
}

export const DEFAULT_TRANSLATE_SETTINGS: TranslateSettings = {
  engine: "local",
  target: "en",
  provider: "cohere",
  model: "command-a-plus-05-2026",
  region: "",
};

/** Where each engine's key is stored (LLM keys are shared with summaries and paid transcription). */
export function translateSecret(settings: Pick<TranslateSettings, "engine" | "provider">): string | null {
  if (settings.engine === "local") return null;
  if (settings.engine === "llm") return secretName(settings.provider);
  return secretName(settings.engine);
}

interface Props {
  t: Strings;
  lang: UiLang;
  client: BackendClient | null;
  catalog: TranslateCatalog | null;
  onCatalog: (c: TranslateCatalog) => void;
  settings: TranslateSettings;
  onSettings: (patch: Partial<TranslateSettings>) => void;
  translation: TranslationData | null;
  task: { stage: string; done: number; total: number } | null;
  error: { code: string; detail: string } | null;
  canTranslate: boolean;
  sourceLanguage: string | null;
  bilingualShown: boolean;
  onTranslate: () => void;
  onCancel: () => void;
  onDelete: () => void;
  onShow: () => void;
  onClose: () => void;
}

const CUSTOM = "__custom__";

export function TranslatePanel({
  t,
  lang,
  client,
  catalog,
  onCatalog,
  settings,
  onSettings,
  translation,
  task,
  error,
  canTranslate,
  sourceLanguage,
  bilingualShown,
  onTranslate,
  onCancel,
  onDelete,
  onShow,
  onClose,
}: Props) {
  const [open, setOpen] = useState(!translation);
  const [hasKey, setHasKey] = useState(false);
  const running = Boolean(task);
  const local = catalog?.local.find((m) => m.target === settings.target && (!sourceLanguage || m.source === sourceLanguage));
  const downloading = local?.download.status === "downloading";
  const llm = catalog?.llm.find((p) => p.id === settings.provider) ?? catalog?.llm[0];
  const knownModel = llm?.models.some((m) => m.id === settings.model);
  const [custom, setCustom] = useState(false);

  // Collapse the settings once a translation exists (they stay one click away).
  const translationStamp = translation?.created_at;
  useEffect(() => {
    if (translationStamp) setOpen(false);
  }, [translationStamp]);

  useEffect(() => {
    if (knownModel) setCustom(false);
    else if (settings.model) setCustom(true);
  }, [settings.model, knownModel]);

  // Follow the local model download.
  useEffect(() => {
    if (!client || !downloading) return;
    const timer = setInterval(async () => {
      try {
        onCatalog(await client.translateCatalog());
      } catch {
        /* ignore */
      }
    }, 700);
    return () => clearInterval(timer);
  }, [client, downloading, onCatalog]);

  const secret = translateSecret(settings);
  // Is a key saved for the selected engine? (checked even while the settings are collapsed)
  useEffect(() => {
    let alive = true;
    if (!secret) return;
    window.desktop?.getSecret(secret).then((k) => alive && setHasKey(Boolean(k)));
    return () => {
      alive = false;
    };
  }, [secret]);
  const localUnsupported = settings.engine === "local" && !local;
  const ready =
    settings.engine === "local"
      ? !localUnsupported
      : hasKey && (settings.engine !== "llm" || Boolean(settings.model.trim()));
  const targetName = settings.target === "en" ? t.langEnglish : t.langArabic;

  const stageText = task
    ? task.stage === "downloading"
      ? `${t.translateDownloading} ${task.total ? Math.round((task.done / task.total) * 100) : 0}%`
      : task.stage === "loading"
        ? t.translateLoading
        : t.translateProgress.replace("{done}", String(task.done)).replace("{total}", String(task.total || "…"))
    : "";

  const engines: { id: TranslateEngine; title: string; hint: string }[] = [
    { id: "local", title: t.translateEngineLocal, hint: t.translateEngineLocalHint },
    { id: "llm", title: t.translateEngineLlm, hint: t.translateEngineLlmHint },
    { id: "deepl", title: "DeepL", hint: t.translateEngineDeeplHint },
    { id: "azure", title: "Azure", hint: t.translateEngineAzureHint },
  ];

  return (
    <section className="card translate-card">
      <header className="summary-head">
        <div className="panel-title">
          <span className="panel-badge">
            <GlobeIcon size={17} />
          </span>
          <div className="summary-title">
          <h2 className="card-title">{t.translateTitle}</h2>
          <span className="muted small">
            {translation
              ? t.translateDoneBy
                  .replace("{n}", String(translation.segments.length))
                  .replace("{by}", translation.model ? `${translation.provider_name} · ${translation.model}` : translation.provider_name)
              : t.translateHint}
          </span>
          </div>
        </div>
        <div className="summary-actions">
          {translation ? (
            <>
              {!bilingualShown ? (
                <button className="btn btn-subtle" onClick={onShow}>
                  {t.translateShow}
                </button>
              ) : null}
              <button className="icon-btn" title={t.translateDelete} aria-label={t.translateDelete} onClick={onDelete} disabled={running}>
                <TrashIcon size={15} />
              </button>
            </>
          ) : null}
          <button
            className={`icon-btn${open ? " is-on" : ""}`}
            title={t.summarySettings}
            aria-label={t.summarySettings}
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
          >
            <SettingsIcon size={15} />
          </button>
          {running ? (
            <button className="btn" onClick={onCancel}>
              <span className="spinner small" /> {stageText} · {t.summaryCancel}
            </button>
          ) : (
            <button className="btn btn-accent" disabled={!canTranslate || !ready} onClick={onTranslate}>
              <GlobeIcon size={15} />{" "}
              {(translation ? t.translateAgain : t.translateTo).replace("{lang}", targetName)}
            </button>
          )}
          <button className="icon-btn" title={t.close} aria-label={t.close} onClick={onClose}>
            ✕
          </button>
        </div>
      </header>

      {running && task && task.total ? (
        <div className="progress-bar translate-bar">
          <div style={{ width: `${Math.round((task.done / task.total) * 100)}%` }} />
        </div>
      ) : null}

      {open ? (
        <div className="summary-settings">
          <div className="translate-engines" role="radiogroup" aria-label={t.translateEngine}>
            {engines.map((e) => (
              <button
                key={e.id}
                type="button"
                role="radio"
                aria-checked={settings.engine === e.id}
                className={`engine-option${settings.engine === e.id ? " is-active" : ""}`}
                disabled={running}
                onClick={() => onSettings({ engine: e.id })}
              >
                <span className="engine-title">{e.title}</span>
                <span className="engine-hint">{e.hint}</span>
              </button>
            ))}
          </div>

          <div className="summary-row">
            <div className="field">
              <label htmlFor="tr-target">{t.translateTarget}</label>
              <select
                id="tr-target"
                value={settings.target}
                disabled={running}
                onChange={(e) => onSettings({ target: e.target.value as "en" | "ar" })}
              >
                <option value="en">{t.langEnglish}</option>
                <option value="ar">{t.langArabic}</option>
              </select>
            </div>
            {settings.engine === "azure" ? (
              <div className="field">
                <label htmlFor="tr-region">{t.translateRegion}</label>
                <input
                  id="tr-region"
                  dir="ltr"
                  className="mono"
                  placeholder="westeurope"
                  value={settings.region}
                  disabled={running}
                  onChange={(e) => onSettings({ region: e.target.value.trim() })}
                />
              </div>
            ) : null}
          </div>

          {settings.engine === "local" ? (
            <div className="local-model">
              {localUnsupported ? (
                <div className="notice warn">
                  <AlertIcon size={16} /> {t.translateLocalOnlyArEn}
                </div>
              ) : local ? (
                <div className="local-model-row">
                  <div>
                    <strong dir="ltr">Opus-MT {local.source} → {local.target}</strong>
                    <div className="muted small">
                      {local.downloaded
                        ? t.translateLocalReady
                        : downloading
                          ? `${t.translateDownloading} ${formatBytes(local.download.downloaded_bytes)} / ${formatBytes(local.download.total_bytes)}`
                          : t.translateLocalNeedsDownload.replace("{mb}", String(local.size_mb))}
                    </div>
                  </div>
                  {local.downloaded ? (
                    <button
                      className="icon-btn"
                      title={t.dbDelete}
                      aria-label={t.dbDelete}
                      disabled={running}
                      onClick={async () => {
                        if (!client) return;
                        await client.translateModelDelete(local.key);
                        onCatalog(await client.translateCatalog());
                      }}
                    >
                      <TrashIcon size={15} />
                    </button>
                  ) : (
                    <button
                      className="btn btn-small"
                      disabled={downloading || !client}
                      onClick={async () => {
                        if (!client) return;
                        await client.translateModelDownload(local.key);
                        onCatalog(await client.translateCatalog());
                      }}
                    >
                      <DownloadIcon size={13} /> {downloading ? t.translateDownloading : t.download}
                    </button>
                  )}
                </div>
              ) : null}
              <p className="hint">{t.translateLocalNote}</p>
            </div>
          ) : null}

          {settings.engine === "llm" && catalog ? (
            <>
              <div className="field">
                <label>{t.summaryProvider}</label>
                <div className="segmented" role="radiogroup" aria-label={t.summaryProvider}>
                  {catalog.llm.map((p) => (
                    <button
                      key={p.id}
                      role="radio"
                      aria-checked={p.id === llm?.id}
                      className={p.id === llm?.id ? "is-active" : ""}
                      disabled={running}
                      onClick={() => onSettings({ provider: p.id, model: p.models[0].id })}
                    >
                      {p.name}
                    </button>
                  ))}
                </div>
              </div>
              {llm ? (
                <div className="field">
                  <label htmlFor="tr-model">{t.summaryModel}</label>
                  <select
                    id="tr-model"
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
                    {llm.models.map((m) => (
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
                      onChange={(e) => onSettings({ model: e.target.value.trim() })}
                    />
                  ) : null}
                </div>
              ) : null}
              {llm ? (
                <KeyField
                  t={t}
                  lang={lang}
                  secret={secretName(llm.id)}
                  label={`${t.cloudApiKey} — ${llm.name}`}
                  keyUrl={llm.key_url}
                  disabled={running}
                  onSavedChange={setHasKey}
                  onTest={async (k) => {
                    await client?.translateTest("llm", k, "", llm.id);
                  }}
                />
              ) : null}
            </>
          ) : null}

          {(settings.engine === "deepl" || settings.engine === "azure") && secret && catalog ? (
            <KeyField
              t={t}
              lang={lang}
              secret={secret}
              label={`${t.cloudApiKey} — ${catalog.services[settings.engine].name}`}
              keyUrl={catalog.services[settings.engine].key_url}
              disabled={running}
              onSavedChange={setHasKey}
              onTest={async (k) => {
                const res = await client?.translateTest(settings.engine as "deepl" | "azure", k, settings.region);
                if (res?.limit) {
                  return t.translateUsage
                    .replace("{used}", res.used?.toLocaleString() ?? "0")
                    .replace("{limit}", res.limit.toLocaleString());
                }
              }}
            />
          ) : null}

          <p className="hint">
            {settings.engine === "local" ? t.translatePrivacyLocal : t.translatePrivacyOnline}
          </p>
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

      {translation && !running && !error ? (
        <p className="hint ok-text">
          <CheckIcon size={13} /> {t.translateReadyNote}
        </p>
      ) : null}
    </section>
  );
}
