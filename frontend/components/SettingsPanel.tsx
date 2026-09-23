"use client";

import type { BackendClient, CloudProvider, Device, ModelInfo, Preset, SystemInfo } from "@/lib/api";
import { CloudSettings } from "./CloudSettings";
import { formatBytes, formatMegabytes } from "@/lib/format";
import type { Strings, UiLang } from "@/lib/i18n";
import { languageOptions } from "@/lib/languages";
import { CheckIcon, ChipIcon, DownloadIcon, FolderIcon, TrashIcon } from "./Icons";

export interface TranscribeSettings {
  model: string | null;
  language: string; // "auto" or a Whisper code
  device: Device;
  preset: Preset;
  arabicPunctuation: boolean;
  engine: "local" | "cloud";
  cloudProvider: string;
  cloudModel: string;
  /** Names and terms to spell correctly (comma or line separated). */
  vocabulary?: string;
}

interface Props {
  t: Strings;
  lang: UiLang;
  settings: TranscribeSettings;
  onChange: (patch: Partial<TranscribeSettings>) => void;
  system: SystemInfo | null;
  models: ModelInfo[];
  disabled: boolean;
  onDownload: (id: string) => void;
  onDelete: (id: string) => void;
  client: BackendClient | null;
  cloudProviders: CloudProvider[];
}

function Dots({ value, label }: { value: number; label: string }) {
  return (
    <span className="dots" title={`${label}: ${value}/5`} aria-label={`${label}: ${value}/5`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <i key={i} className={i <= value ? "on" : ""} />
      ))}
    </span>
  );
}

export function SettingsPanel({
  t,
  lang,
  settings,
  onChange,
  system,
  models,
  disabled,
  onDownload,
  onDelete,
  client,
  cloudProviders,
}: Props) {
  const isCloud = settings.engine === "cloud" && cloudProviders.length > 0;
  const devices = system?.devices;
  const cuda = devices?.cuda_available ?? false;
  const gpuGood = devices?.gpu_recommended ?? false;
  const gpuTarget = settings.device === "cuda" || (settings.device === "auto" && gpuGood);
  const gpuLabel = devices?.gpu_name
    ? `${devices.gpu_name}${devices.gpu_vram_mb ? ` · ${(devices.gpu_vram_mb / 1024).toFixed(1)} GB` : ""}`
    : "";
  const recommended = gpuTarget ? system?.defaultModelGpu : system?.defaultModelCpu;
  const presetHint =
    settings.preset === "fast" ? t.modeHintFast : settings.preset === "accurate" ? t.modeHintAccurate : t.modeHintBalanced;

  return (
    <section className="card settings">
      <h2 className="card-title">{t.settings}</h2>

      {/* ---- Engine: local Whisper or a paid cloud provider ---------------- */}
      <div className="field">
        <label>{t.engine}</label>
        <div className="segmented" role="radiogroup" aria-label={t.engine}>
          <button
            role="radio"
            aria-checked={!isCloud}
            className={!isCloud ? "is-active" : ""}
            disabled={disabled}
            onClick={() => onChange({ engine: "local" })}
          >
            {t.engineLocal}
          </button>
          <button
            role="radio"
            aria-checked={isCloud}
            className={isCloud ? "is-active" : ""}
            disabled={disabled || cloudProviders.length === 0}
            onClick={() => onChange({ engine: "cloud" })}
          >
            {t.engineCloud}
          </button>
        </div>
        {!isCloud ? <p className="hint">{t.engineLocalHint}</p> : null}
      </div>

      {isCloud ? (
        <CloudSettings
          t={t}
          lang={lang}
          client={client}
          providers={cloudProviders}
          providerId={settings.cloudProvider}
          modelId={settings.cloudModel}
          language={settings.language}
          disabled={disabled}
          onChange={onChange}
        />
      ) : (
        <>

      {/* ---- Model ------------------------------------------------------ */}
      <div className="field">
        <div className="field-head">
          <label>{t.model}</label>
          <button className="link-btn" onClick={() => window.desktop?.openModelsDir()}>
            <FolderIcon size={14} /> {t.openModelsFolder}
          </button>
        </div>
        <div className="model-list" role="radiogroup" aria-label={t.model}>
          {models.map((m) => {
            const selected = settings.model === m.id;
            const dl = m.download;
            const downloading = dl?.status === "downloading";
            const pct = downloading && dl.total_bytes ? Math.round((dl.downloaded_bytes / dl.total_bytes) * 100) : 0;
            return (
              <div
                key={m.id}
                role="radio"
                aria-checked={selected}
                tabIndex={0}
                className={`model-row ${selected ? "is-selected" : ""} ${disabled ? "is-disabled" : ""}`}
                onClick={() => !disabled && onChange({ model: m.id })}
                onKeyDown={(e) => e.key === "Enter" && !disabled && onChange({ model: m.id })}
              >
                <span className="radio" />
                <div className="model-main">
                  <div className="model-name" dir="ltr">
                    {m.id}
                    {m.id === recommended ? <span className="pill pill-accent">{t.recommended}</span> : null}
                  </div>
                  <div className="model-meta">
                    <span>
                      {t.speed} <Dots value={m.speed} label={t.speed} />
                    </span>
                    <span>
                      {t.arabicAccuracy} <Dots value={m.arabic_accuracy} label={t.arabicAccuracy} />
                    </span>
                    <span className="muted" dir="ltr">
                      {formatMegabytes(m.download_mb)}
                    </span>
                  </div>
                  {downloading ? (
                    <div className="mini-progress" title={`${pct}%`}>
                      <div style={{ width: `${pct}%` }} />
                      <span dir="ltr">
                        {formatBytes(dl.downloaded_bytes)} / {formatBytes(dl.total_bytes)}
                      </span>
                    </div>
                  ) : null}
                </div>
                <div className="model-actions" onClick={(e) => e.stopPropagation()}>
                  {m.downloaded ? (
                    <>
                      <span className="pill pill-ok">
                        <CheckIcon size={12} /> {t.downloaded}
                      </span>
                      <button
                        className="icon-btn"
                        title={t.deleteModel}
                        aria-label={`${t.deleteModel} ${m.id}`}
                        disabled={disabled}
                        onClick={() => onDelete(m.id)}
                      >
                        <TrashIcon size={15} />
                      </button>
                    </>
                  ) : downloading ? (
                    <span className="pill">{pct}%</span>
                  ) : (
                    <button className="btn btn-small" disabled={disabled} onClick={() => onDownload(m.id)}>
                      <DownloadIcon size={14} /> {t.download}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <p className="hint">{t.modelTradeoff}</p>
        <p className="hint muted">{t.modelFirstUse}</p>
      </div>

        </>
      )}

      {/* ---- Language --------------------------------------------------- */}
      <div className="field">
        <label htmlFor="language">{t.language}</label>
        <select
          id="language"
          value={settings.language}
          disabled={disabled}
          onChange={(e) => onChange({ language: e.target.value })}
        >
          <option value="auto">{t.autoDetect}</option>
          {languageOptions(lang).map((l) => (
            <option key={l.code} value={l.code}>
              {l.name}
            </option>
          ))}
        </select>
      </div>

      {isCloud ? null : (
        <>
      {/* ---- Device ----------------------------------------------------- */}
      <div className="field">
        <label>{t.device}</label>
        <div className="segmented" role="radiogroup" aria-label={t.device}>
          {(
            [
              ["auto", t.deviceAuto],
              ["cpu", t.deviceCpu],
              ["cuda", t.deviceGpu],
            ] as [Device, string][]
          ).map(([value, label]) => (
            <button
              key={value}
              role="radio"
              aria-checked={settings.device === value}
              className={settings.device === value ? "is-active" : ""}
              disabled={disabled || (value === "cuda" && !cuda)}
              onClick={() => onChange({ device: value })}
            >
              {label}
            </button>
          ))}
        </div>
        <p className={`hint device-hint ${gpuGood ? "ok" : cuda ? "warn" : ""}`}>
          <ChipIcon size={14} />
          {gpuGood ? (
            <>
              {t.gpuReady}
              {gpuLabel ? <span dir="ltr"> · {gpuLabel}</span> : null}
            </>
          ) : cuda ? (
            t.gpuWeak.replace("{gpu}", gpuLabel ? `(${gpuLabel})` : "")
          ) : (
            t.gpuUnavailable
          )}
          {system ? (
            <span className="muted" dir="ltr">
              {" "}
              · {system.devices.cpu_cores_physical} cores · {system.devices.ram_total_gb} GB RAM
            </span>
          ) : null}
        </p>
        {!cuda && system?.devices.cuda_device_count ? (
          <p className="hint warn" dir="ltr">
            {system.devices.cuda_reason}
          </p>
        ) : null}
      </div>

      {/* ---- Preset ----------------------------------------------------- */}
      <div className="field">
        <label>{t.mode}</label>
        <div className="segmented" role="radiogroup" aria-label={t.mode}>
          {(
            [
              ["fast", t.modeFast],
              ["balanced", t.modeBalanced],
              ["accurate", t.modeAccurate],
            ] as [Preset, string][]
          ).map(([value, label]) => (
            <button
              key={value}
              role="radio"
              aria-checked={settings.preset === value}
              className={settings.preset === value ? "is-active" : ""}
              disabled={disabled}
              onClick={() => onChange({ preset: value })}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="hint">{presetHint}</p>
      </div>

      <label className="check">
        <input
          type="checkbox"
          checked={settings.arabicPunctuation}
          disabled={disabled}
          onChange={(e) => onChange({ arabicPunctuation: e.target.checked })}
        />
        <span>{t.arabicPunctuation}</span>
      </label>
        </>
      )}

      <div className="field vocab-field">
        <label htmlFor="vocabulary">{t.vocabularyTitle}</label>
        <textarea
          id="vocabulary"
          dir="auto"
          rows={2}
          spellCheck={false}
          placeholder={t.vocabularyPlaceholder}
          value={settings.vocabulary ?? ""}
          disabled={disabled}
          onChange={(e) => onChange({ vocabulary: e.target.value })}
        />
        <p className="hint">{t.vocabularyHint}</p>
      </div>
    </section>
  );
}
