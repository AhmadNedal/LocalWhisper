"use client";

import { useEffect, useState } from "react";
import { ApiError } from "@/lib/api";
import { errorMessage, type Strings, type UiLang } from "@/lib/i18n";
import { keyState } from "@/lib/keys";
import { AlertIcon, CheckIcon, KeyIcon } from "./Icons";

interface Props {
  t: Strings;
  lang: UiLang;
  /** Name under which the key is stored encrypted (Windows DPAPI). */
  secret: string;
  label: string;
  keyUrl?: string;
  disabled?: boolean;
  /** Validates the key; may return a success note (e.g. remaining quota). */
  onTest?: (key: string) => Promise<string | void>;
  onSavedChange?: (hasKey: boolean) => void;
}

/** API key input stored encrypted by the desktop shell, with Save / Test buttons. */
export function KeyField({ t, lang, secret, label, keyUrl, disabled, onTest, onSavedChange }: Props) {
  const [key, setKey] = useState("");
  const [saved, setSaved] = useState("");
  const [show, setShow] = useState(false);
  const [testing, setTesting] = useState(false);
  const [status, setStatus] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [builtin, setBuiltin] = useState(false);

  useEffect(() => {
    let alive = true;
    setStatus(null);
    keyState(secret).then(({ stored, builtin: has }) => {
      if (!alive) return;
      setKey(stored);
      setSaved(stored);
      setBuiltin(has);
      onSavedChange?.(Boolean(stored) || has);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [secret]);

  const save = async (value: string) => {
    const res = await window.desktop?.setSecret(secret, value.trim());
    setSaved(value.trim());
    onSavedChange?.(Boolean(value.trim()) || builtin);
    setStatus(res?.ok ? { kind: "ok", text: t.cloudKeySaved } : { kind: "error", text: t.dbNotEncrypted });
  };

  const test = async () => {
    if (!onTest) return;
    setTesting(true);
    setStatus(null);
    try {
      const note = await onTest(key.trim());
      if (key.trim() !== saved) await save(key);
      setStatus({ kind: "ok", text: note || t.cloudKeyOk });
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "internal";
      const detail = err instanceof ApiError ? err.detail : String(err);
      setStatus({ kind: "error", text: `${errorMessage(lang, code)}${detail ? ` (${detail})` : ""}` });
    } finally {
      setTesting(false);
    }
  };

  const id = `key-${secret.replace(/[^a-z0-9]/gi, "-")}`;
  return (
    <div className="field">
      <div className="field-head">
        <label htmlFor={id}>
          <KeyIcon size={14} /> {label}
        </label>
        {keyUrl ? (
          <a className="link-btn" href={keyUrl} target="_blank" rel="noreferrer">
            {t.cloudGetKey}
          </a>
        ) : null}
      </div>
      <div className="conn-row">
        <input
          id={id}
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
        <button className="btn btn-subtle" onClick={() => setShow((v) => !v)}>
          {show ? t.dbHide : t.dbShow}
        </button>
        <button className="btn" disabled={disabled || !key.trim() || key.trim() === saved} onClick={() => save(key)}>
          {t.cloudSaveKey}
        </button>
        {onTest ? (
          <button className="btn" disabled={disabled || !key.trim() || testing} onClick={test}>
            {testing ? t.cloudTesting : t.cloudTestKey}
          </button>
        ) : null}
      </div>
      {builtin && !saved && !status ? <p className="hint ok-text">{t.builtinKeyHint}</p> : null}
      {status ? (
        <p className={`hint ${status.kind === "error" ? "warn" : "ok-text"}`}>
          {status.kind === "error" ? <AlertIcon size={13} /> : <CheckIcon size={13} />} {status.text}
        </p>
      ) : null}
    </div>
  );
}
