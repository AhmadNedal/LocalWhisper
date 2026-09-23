"use client";

import { useEffect, useState } from "react";
import { ApiError, type BackendClient, type CloudProvider } from "@/lib/api";
import { errorMessage, type Strings, type UiLang } from "@/lib/i18n";
import { AlertIcon, CheckIcon, CloudIcon, KeyIcon, TrashIcon } from "./Icons";

interface Props {
  t: Strings;
  lang: UiLang;
  client: BackendClient | null;
  providers: CloudProvider[];
  providerId: string;
  modelId: string;
  language: string;
  disabled: boolean;
  onChange: (patch: { cloudProvider?: string; cloudModel?: string }) => void;
}

export const secretName = (providerId: string) => `cloud:${providerId}`;

/** Paid provider picker + the user's own API key (stored encrypted with Windows DPAPI). */
export function CloudSettings({ t, lang, client, providers, providerId, modelId, language, disabled, onChange }: Props) {
  const provider = providers.find((p) => p.id === providerId) ?? providers[0];
  const [key, setKey] = useState("");
  const [savedKey, setSavedKey] = useState("");
  const [show, setShow] = useState(false);
  const [status, setStatus] = useState<{ kind: "ok" | "saved" | "error"; text: string } | null>(null);
  const [testing, setTesting] = useState(false);

  // Load the stored key whenever the provider changes.
  useEffect(() => {
    if (!provider) return;
    setStatus(null);
    window.desktop?.getSecret(secretName(provider.id)).then((k) => {
      setKey(k);
      setSavedKey(k);
    });
  }, [provider]);

  // Keep the selected model valid for the selected provider.
  useEffect(() => {
    if (provider && !provider.models.some((m) => m.id === modelId)) {
      const preferred =
        provider.models.find((m) => m.languages?.length === 1 && m.languages[0] === language) ?? provider.models[0];
      onChange({ cloudModel: preferred.id });
    }
  }, [provider, modelId, language, onChange]);

  if (!provider) return null;

  const saveKey = async (value: string) => {
    const res = await window.desktop?.setSecret(secretName(provider.id), value.trim());
    setSavedKey(value.trim());
    setStatus(res?.ok ? { kind: "saved", text: t.cloudKeySaved } : { kind: "error", text: t.dbNotEncrypted });
  };

  const testKey = async () => {
    if (!client) return;
    setTesting(true);
    setStatus(null);
    try {
      await client.cloudTest(provider.id, key.trim());
      setStatus({ kind: "ok", text: t.cloudKeyOk });
      if (key.trim() !== savedKey) await saveKey(key);
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "internal";
      const detail = err instanceof ApiError ? err.detail : String(err);
      setStatus({ kind: "error", text: `${errorMessage(lang, code)} ${detail ? `(${detail})` : ""}` });
    } finally {
      setTesting(false);
    }
  };

  const model = provider.models.find((m) => m.id === modelId);
  const languageMissing = provider.requires_language && (!language || language === "auto");
  const allowed = model?.languages ?? provider.languages;
  const languageUnsupported = !languageMissing && allowed && !allowed.includes(language);

  return (
    <div className="cloud-settings">
      <div className="field">
        <label>{t.cloudProvider}</label>
        <div className="segmented" role="radiogroup" aria-label={t.cloudProvider}>
          {providers.map((p) => (
            <button
              key={p.id}
              role="radio"
              aria-checked={p.id === provider.id}
              className={p.id === provider.id ? "is-active" : ""}
              disabled={disabled}
              onClick={() => onChange({ cloudProvider: p.id })}
            >
              {p.name}
            </button>
          ))}
        </div>
      </div>

      <div className="field">
        <label htmlFor="cloud-model">{t.cloudModel}</label>
        <select
          id="cloud-model"
          value={model?.id ?? ""}
          disabled={disabled}
          onChange={(e) => onChange({ cloudModel: e.target.value })}
          dir="ltr"
        >
          {provider.models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <div className="field-head">
          <label htmlFor="cloud-key">
            <KeyIcon size={14} /> {t.cloudApiKey}
          </label>
          <a className="link-btn" href={provider.key_url} target="_blank" rel="noreferrer">
            {t.cloudGetKey}
          </a>
        </div>
        <div className="conn-row">
          <input
            id="cloud-key"
            type={show ? "text" : "password"}
            dir="ltr"
            className="mono"
            autoComplete="off"
            spellCheck={false}
            placeholder={t.cloudKeyPlaceholder}
            value={key}
            disabled={disabled}
            onChange={(e) => {
              setKey(e.target.value);
              setStatus(null);
            }}
          />
          <button className="btn btn-subtle" onClick={() => setShow((s) => !s)}>
            {show ? t.dbHide : t.dbShow}
          </button>
          <button className="btn" disabled={disabled || !key.trim() || key.trim() === savedKey} onClick={() => saveKey(key)}>
            {t.cloudSaveKey}
          </button>
          <button className="btn" disabled={disabled || !key.trim() || testing || !client} onClick={testKey}>
            {testing ? t.cloudTesting : t.cloudTestKey}
          </button>
          {savedKey ? (
            <button
              className="icon-btn"
              title={t.cloudDeleteKey}
              aria-label={t.cloudDeleteKey}
              disabled={disabled}
              onClick={() => {
                setKey("");
                saveKey("");
              }}
            >
              <TrashIcon size={15} />
            </button>
          ) : null}
        </div>
        {status ? (
          <p className={`hint ${status.kind === "error" ? "warn" : "ok-text"}`}>
            {status.kind === "error" ? <AlertIcon size={13} /> : <CheckIcon size={13} />} {status.text}
          </p>
        ) : null}
      </div>

      {languageMissing ? (
        <div className="notice warn">
          <AlertIcon size={16} /> {t.cloudLanguageRequired.replace("{provider}", provider.name)}
        </div>
      ) : languageUnsupported ? (
        <div className="notice warn">
          <AlertIcon size={16} /> {errorMessage(lang, "cloud_language_unsupported")}
        </div>
      ) : null}

      <div className="notice info cloud-warning">
        <CloudIcon size={16} />
        <div>
          {t.cloudWarning.replace("{provider}", provider.name)}
          <div className="muted small">{t.cloudUploadNote}</div>
        </div>
      </div>
    </div>
  );
}
