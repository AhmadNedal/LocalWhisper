"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AuthFailure, AuthLoginResult, AuthOptions, AuthState, AuthUser, RegisterDetails } from "@/lib/desktop";
import { countryGroups, guessCountry } from "@/lib/countries";
import { STRINGS, type UiLang } from "@/lib/i18n";
import { usePersistentState } from "@/lib/useBackend";
import { AlertIcon, GlobeIcon, ShieldIcon, SparkIcon, WaveIcon, ArchiveIcon } from "./Icons";

export interface Account {
  user: AuthUser | null;
  siteName: string;
  onLogout: (() => void) | null;
}

/**
 * Mandatory sign-in before the app. The real lock is in Electron's main process
 * (no backend connection until signed in); this is the screen for it.
 */
export function AuthGate({ children }: { children: (account: Account) => React.ReactNode }) {
  const [state, setState] = useState<AuthState | null>(null);

  useEffect(() => {
    const d = window.desktop;
    if (!d?.authState) {
      // Browser preview / older shell: nothing to sign in to.
      setState({ required: false, authenticated: true, siteName: "", user: null });
      return;
    }
    d.authState().then(setState);
  }, []);

  const logout = useCallback(async () => {
    const next = await window.desktop?.authLogout?.();
    if (next) setState(next);
    window.location.reload(); // drop everything the signed-in session had loaded
  }, []);

  if (!state) return null;
  if (state.required && !state.authenticated) {
    return <LoginScreen siteName={state.siteName} onSignedIn={(user) => setState({ ...state, authenticated: true, user })} />;
  }
  return <>{children({ user: state.user, siteName: state.siteName, onLogout: state.required ? logout : null })}</>;
}

type Step = "form" | "code";

function LoginScreen({ siteName, onSignedIn }: { siteName: string; onSignedIn: (user: AuthUser) => void }) {
  const [lang, setLang] = usePersistentState<UiLang>("ui-lang", "ar");
  const t = STRINGS[lang];
  const [mode, setMode] = useState<"login" | "register">("login");
  const [step, setStep] = useState<Step>("form");
  const [options, setOptions] = useState<AuthOptions | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = usePersistentState<string>("login-email", "");
  const [country, setCountry] = useState<string>(() => guessCountry());
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [code, setCode] = useState("");
  const [remember, setRemember] = usePersistentState<boolean>("login-remember", false);
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [resendAt, setResendAt] = useState(0);
  const [expiresAt, setExpiresAt] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const codeRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
  }, [lang]);

  useEffect(() => {
    window.desktop?.authOptions?.().then(setOptions).catch(() => undefined);
  }, []);

  // A clock for the resend and expiry countdowns while the code step is open.
  useEffect(() => {
    if (step !== "code") return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [step]);

  useEffect(() => {
    if (step === "code") codeRef.current?.focus();
  }, [step]);

  const countries = useMemo(() => countryGroups(lang), [lang]);
  const minLength = options?.minPasswordLength ?? 8;
  const canRegister = Boolean(window.desktop?.authRegister) && options?.allowRegistration !== false;
  // Only an older service that explicitly says so skips the e-mailed code.
  const needsCode = Boolean(window.desktop?.authSendCode) && !(options?.reachable && options.requireEmailVerification === false);

  const message = (res: AuthFailure) => {
    switch (res.code) {
      case "invalid":
        return t.loginErrInvalid;
      case "network":
        return t.loginErrNetwork;
      case "missing":
        return t.loginErrMissing;
      case "locked":
        return t.loginErrLocked;
      case "disabled":
        return t.loginErrDisabled;
      case "pending":
        return t.loginErrPending;
      case "email_taken":
        return t.registerErrTaken;
      case "weak_password":
        return t.registerErrWeak.replace("{n}", String(minLength));
      case "invalid_email":
        return t.registerErrEmail;
      case "invalid_name":
        return t.registerErrName;
      case "invalid_country":
        return t.registerErrCountry;
      case "registration_closed":
        return t.registerErrClosed;
      case "too_many":
        return t.loginErrTooMany;
      case "code_required":
        return t.verifyErrRequired;
      case "invalid_code":
        return t.verifyErrInvalid;
      case "code_expired":
        return t.verifyErrExpired;
      case "resend_too_soon":
        return t.verifyErrTooSoon.replace("{s}", String(res.retryAfter ?? 60));
      case "email_send_failed":
        return t.verifyErrSend;
      default:
        return t.loginErrServer.replace("{status}", String(res.status ?? ""));
    }
  };

  const switchMode = (next: "login" | "register") => {
    setMode(next);
    setStep("form");
    setError(null);
    setNotice(null);
    setPassword("");
    setConfirm("");
    setCode("");
  };

  const details = (): RegisterDetails => ({
    name: name.trim(),
    email: email.trim(),
    password,
    country,
    lang,
    remember,
  });

  /** Signed in, or waiting for approval (back to the sign-in tab with a note). */
  const finish = (res: AuthLoginResult) => {
    if (res.ok) {
      setPassword("");
      setConfirm("");
      setCode("");
      onSignedIn(res.user);
      return true;
    }
    if (res.code === "pending") {
      setMode("login");
      setStep("form");
      setPassword("");
      setConfirm("");
      setCode("");
      setNotice(t.loginErrPending);
      return true;
    }
    return false;
  };

  const startCountdown = (resendSeconds: number, expiresSeconds?: number) => {
    const at = Date.now();
    setNow(at);
    setResendAt(at + Math.max(1, resendSeconds) * 1000);
    if (expiresSeconds) setExpiresAt(at + expiresSeconds * 1000);
  };

  const sendCode = async (again: boolean) => {
    const res = await window.desktop!.authSendCode!(details());
    if (res.ok) {
      startCountdown(res.resendAfterSeconds, res.expiresInSeconds);
      setStep("code");
      setCode("");
      if (again) setNotice(t.verifyResent);
      return;
    }
    if (res.code === "resend_too_soon") {
      // A code was already sent to this address: go (back) to entering it.
      startCountdown(res.retryAfter ?? options?.resendSeconds ?? 60);
      setStep("code");
      if (again) setError(message(res));
      return;
    }
    // A detail the service rejected: fix it in the form.
    if (step === "code" && !["too_many", "network", "server", "email_send_failed"].includes(res.code)) setStep("form");
    setError(message(res));
  };

  const run = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await work();
    } catch {
      setError(t.loginErrNetwork);
    } finally {
      setBusy(false);
    }
  };

  const submitForm = (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setNotice(null);
    if (!email.trim() || !password || (mode === "register" && !name.trim())) {
      setError(t.loginErrMissing);
      return;
    }
    if (mode === "login") {
      void run(async () => {
        const res = await window.desktop!.authLogin!(email.trim(), password, remember);
        if (res.ok) {
          setPassword("");
          onSignedIn(res.user);
        } else setError(message(res));
      });
      return;
    }
    if (!country) {
      setError(t.registerErrCountry);
      return;
    }
    if (password.length < minLength || !/[\p{L}]/u.test(password) || !/\d/.test(password)) {
      setError(t.registerErrWeak.replace("{n}", String(minLength)));
      return;
    }
    if (password !== confirm) {
      setError(t.registerErrConfirm);
      return;
    }
    void run(async () => {
      if (needsCode) {
        await sendCode(false);
        return;
      }
      const res = await window.desktop!.authRegister!(details());
      if (!finish(res) && !res.ok) setError(message(res));
    });
  };

  const verify = (value: string) => {
    if (value.length !== 6) {
      setError(t.verifyErrRequired);
      return;
    }
    void run(async () => {
      const res = await window.desktop!.authRegister!({ ...details(), code: value });
      if (finish(res) || res.ok) return;
      if (res.code === "invalid_code" || res.code === "code_expired" || res.code === "code_required") {
        setCode("");
        if (res.code === "code_expired") setExpiresAt(Date.now());
        codeRef.current?.focus();
      } else if (!["too_many", "network", "server"].includes(res.code)) {
        setStep("form"); // e.g. the e-mail was taken meanwhile
      }
      setError(message(res));
    });
  };

  const onCodeChange = (raw: string) => {
    // Accept pasted codes like "123 456" or Arabic-Indic digits.
    const digits = raw
      .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
      .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
      .replace(/\D/g, "")
      .slice(0, 6);
    setCode(digits);
    if (digits.length === 6 && !busy) verify(digits);
  };

  const register = mode === "register";
  const resendIn = Math.max(0, Math.ceil((resendAt - now) / 1000));
  const expiresIn = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  const clock = (secs: number) => `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;

  const brand = (
    <aside className="login-brand" aria-hidden="true">
      <div className="login-brand-in">
        <span className="login-logo">
          <WaveIcon size={28} />
        </span>
        <h1>{t.appName}</h1>
        <p className="login-tag">{t.loginBrandTag}</p>
        <ul className="login-points">
          <li>
            <ShieldIcon size={18} /> <span>{t.loginPoint1}</span>
          </li>
          <li>
            <SparkIcon size={18} /> <span>{t.loginPoint2}</span>
          </li>
          <li>
            <ArchiveIcon size={18} /> <span>{t.loginPoint3}</span>
          </li>
        </ul>
      </div>
    </aside>
  );

  const alerts = (
    <>
      {notice ? (
        <div className="login-notice" role="status">
          {notice}
        </div>
      ) : null}
      {error ? (
        <div className="login-error" role="alert">
          <AlertIcon size={16} /> {error}
        </div>
      ) : null}
    </>
  );

  return (
    <div className="login-page">
      {brand}

      <main className="login-main">
        <button type="button" className="btn btn-subtle login-lang" onClick={() => setLang(lang === "ar" ? "en" : "ar")}>
          <GlobeIcon size={16} /> {t.switchLang}
        </button>

        {register && step === "code" ? (
          <form
            className="login-card"
            onSubmit={(e) => {
              e.preventDefault();
              verify(code);
            }}
            noValidate
          >
            <span className="login-logo small">
              <MailIcon />
            </span>
            <h2>{t.verifyTitle}</h2>
            <p className="login-sub">
              {t.verifySubtitle}{" "}
              <bdi className="login-email-chip" dir="ltr">
                {email.trim()}
              </bdi>
            </p>

            <label className="login-field">
              <span>{t.verifyCode}</span>
              <input
                ref={codeRef}
                className="otp-input"
                type="text"
                dir="ltr"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="••••••"
                value={code}
                onChange={(e) => onCodeChange(e.target.value)}
                disabled={busy}
                aria-describedby="otp-meta"
              />
            </label>
            <div className="otp-meta" id="otp-meta">
              {expiresAt ? <span className={expiresIn === 0 ? "is-expired" : ""}>{expiresIn === 0 ? t.verifyExpired : t.verifyExpires.replace("{time}", clock(expiresIn))}</span> : <span />}
              <button type="button" className="link-btn" disabled={busy || resendIn > 0} onClick={() => void run(() => sendCode(true))}>
                {resendIn > 0 ? t.verifyResendIn.replace("{s}", String(resendIn)) : t.verifyResend}
              </button>
            </div>

            {alerts}

            <button type="submit" className="btn btn-accent login-submit" disabled={busy || code.length !== 6}>
              {busy ? <span className="spinner small" /> : null} {busy ? t.loginWorking : t.verifyButton}
            </button>
            <button
              type="button"
              className="btn btn-subtle login-back"
              disabled={busy}
              onClick={() => {
                setStep("form");
                setError(null);
                setNotice(null);
              }}
            >
              {t.verifyBack}
            </button>
            <p className="login-foot">{t.verifyHint}</p>
          </form>
        ) : (
          <form className="login-card" onSubmit={submitForm} noValidate>
            <span className="login-logo small">
              <WaveIcon size={22} />
            </span>
            <h2>{register ? t.registerTitle : t.loginTitle}</h2>
            <p className="login-sub">{(register ? t.registerSubtitle : t.loginSubtitle).replace("{site}", siteName || t.appName)}</p>

            {canRegister ? (
              <div className="login-tabs" role="tablist">
                <button type="button" role="tab" aria-selected={!register} className={!register ? "is-active" : ""} onClick={() => switchMode("login")}>
                  {t.loginTitle}
                </button>
                <button type="button" role="tab" aria-selected={register} className={register ? "is-active" : ""} onClick={() => switchMode("register")}>
                  {t.registerTitle}
                </button>
              </div>
            ) : null}

            {register ? (
              <label className="login-field">
                <span>{t.registerName}</span>
                <input type="text" dir="auto" autoComplete="name" autoFocus value={name} onChange={(e) => setName(e.target.value)} disabled={busy} />
              </label>
            ) : null}
            <label className="login-field">
              <span>{t.loginEmail}</span>
              <input
                type="email"
                dir="ltr"
                autoComplete={register ? "email" : "username"}
                autoFocus={!register && !email}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@example.com"
                disabled={busy}
              />
            </label>
            {register ? (
              <label className="login-field">
                <span>{t.registerCountry}</span>
                <select
                  className={`login-select${country ? "" : " is-empty"}`}
                  value={country}
                  onChange={(e) => setCountry(e.target.value)}
                  disabled={busy}
                  autoComplete="country"
                >
                  <option value="" disabled>
                    {t.registerCountryPick}
                  </option>
                  <optgroup label={t.registerArabCountries}>
                    {countries.arab.map((c) => (
                      <option key={c.code} value={c.code}>
                        {c.flag} {c.name}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label={t.registerOtherCountries}>
                    {countries.others.map((c) => (
                      <option key={c.code} value={c.code}>
                        {c.flag} {c.name}
                      </option>
                    ))}
                  </optgroup>
                </select>
              </label>
            ) : null}
            <label className="login-field">
              <span>{t.loginPassword}</span>
              <span className="login-pass">
                <input
                  type={show ? "text" : "password"}
                  dir="ltr"
                  autoComplete={register ? "new-password" : "current-password"}
                  autoFocus={!register && Boolean(email)}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={busy}
                />
                <button type="button" className="link-btn" onClick={() => setShow((v) => !v)} tabIndex={-1}>
                  {show ? t.dbHide : t.dbShow}
                </button>
              </span>
              {register ? <small className="login-help">{t.registerPasswordHint.replace("{n}", String(minLength))}</small> : null}
            </label>
            {register ? (
              <label className="login-field">
                <span>{t.registerConfirm}</span>
                <input
                  type={show ? "text" : "password"}
                  dir="ltr"
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  disabled={busy}
                />
              </label>
            ) : null}
            <label className="check login-remember">
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} disabled={busy} />
              <span>{t.loginRemember}</span>
            </label>

            {alerts}
            {options && !options.reachable ? <div className="login-notice">{t.loginServerDown}</div> : null}

            <button type="submit" className="btn btn-accent login-submit" disabled={busy}>
              {busy ? <span className="spinner small" /> : null}{" "}
              {busy ? t.loginWorking : register ? (needsCode ? t.registerSendCode : t.registerButton) : t.loginButton}
            </button>
            <p className="login-foot">{t.loginFoot}</p>
          </form>
        )}
      </main>
    </div>
  );
}

function MailIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="2.5" />
      <path d="m4 7 8 6 8-6" />
    </svg>
  );
}
