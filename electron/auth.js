// @ts-check
/**
 * Mandatory sign-in against the central account service (WindowsAppLoginBackend,
 * an ASP.NET Core API): sign in, create an account, and re-check a remembered
 * session at startup so a disabled account is signed out.
 *
 * The gate lives in the main process: until the user signs in, the renderer
 * gets no connection to the local backend (no URL, no token) and no stored
 * secrets, so hiding the login screen in the UI does not unlock anything.
 *
 * Settings come from built-in defaults, optionally overridden by
 * `auth-config.json` (project root in development, `resources/` when installed).
 * Only a development build may switch sign-in off.
 */
const fs = require("node:fs");
const path = require("node:path");

const DEFAULTS = {
  enabled: true,
  siteName: "",
  // The central service; set it to the deployed address (e.g. https://login.example.com).
  apiBaseUrl: "http://localhost:5080",
  // Optional overrides; by default derived from apiBaseUrl.
  loginUrl: "",
  registerUrl: "",
  sendCodeUrl: "",
  resetCodeUrl: "",
  resetUrl: "",
  meUrl: "",
  optionsUrl: "",
  usernameField: "email",
  passwordField: "password",
  // Where the token is in the JSON response (dot path); the first that exists wins.
  tokenPaths: ["accessToken", "token", "access_token", "data.accessToken", "data.token"],
  // Optional display name in the response.
  namePaths: ["user.name", "user.fullName", "name", "fullName", "data.user.name"],
  // "Remember me": how long a saved session is kept when the token carries no expiry.
  rememberDays: 7,
  timeoutMs: 20000,
};

/** @param {any} obj @param {string} dotted */
function pick(obj, dotted) {
  return dotted.split(".").reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), obj);
}

/** Expiry (ms) of a JWT, or null when it isn't a JWT / has no "exp". @param {string} token */
function jwtExpiry(token) {
  const parts = String(token).split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    return typeof payload.exp === "number" ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

/** Display name from a JWT's usual claims. @param {string} token */
function jwtName(token) {
  const parts = String(token).split(".");
  if (parts.length !== 3) return "";
  try {
    const p = JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    return (
      p.name ||
      p.fullName ||
      p["http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name"] ||
      p.unique_name ||
      ""
    );
  } catch {
    return "";
  }
}

class AuthGate {
  /**
   * @param {{ app: Electron.App, safeStorage: Electron.SafeStorage, net: Electron.Net, rootDir: string }} deps
   */
  constructor({ app, safeStorage, net, rootDir }) {
    this.app = app;
    this.safeStorage = safeStorage;
    this.net = net;
    this.rootDir = rootDir;
    /** @type {{ email: string, name: string, token: string, expiresAt: number | null } | null} */
    this.session = null;
    /** Whether the current session was checked with the service in this run. */
    this.verified = false;
    this.config = this.loadConfig();
    this.restore();
  }

  loadConfig() {
    const file = this.app.isPackaged
      ? path.join(process.resourcesPath, "auth-config.json")
      : path.join(this.rootDir, "auth-config.json");
    let custom = {};
    try {
      custom = JSON.parse(fs.readFileSync(file, "utf8")) || {};
    } catch {
      /* defaults */
    }
    const cfg = { ...DEFAULTS, ...custom };
    const base = String(cfg.apiBaseUrl || "").replace(/\/+$/, "");
    cfg.loginUrl = cfg.loginUrl || `${base}/api/auth/login`;
    cfg.registerUrl = cfg.registerUrl || `${base}/api/auth/register`;
    cfg.sendCodeUrl = cfg.sendCodeUrl || `${base}/api/auth/register/send-code`;
    cfg.resetCodeUrl = cfg.resetCodeUrl || `${base}/api/auth/password/send-code`;
    cfg.resetUrl = cfg.resetUrl || `${base}/api/auth/password/reset`;
    cfg.meUrl = cfg.meUrl || `${base}/api/auth/me`;
    cfg.optionsUrl = cfg.optionsUrl || `${base}/api/auth/options`;
    // An installed copy can't be unlocked by editing its resources.
    if (this.app.isPackaged) cfg.enabled = true;
    return cfg;
  }

  sessionFile() {
    return path.join(this.app.getPath("userData"), "session.json");
  }

  get required() {
    return Boolean(this.config.enabled);
  }

  isAuthenticated() {
    if (!this.required) return true;
    if (!this.session) return false;
    if (this.session.expiresAt && Date.now() >= this.session.expiresAt) {
      this.logout();
      return false;
    }
    return true;
  }

  state() {
    return {
      required: this.required,
      authenticated: this.isAuthenticated(),
      siteName: this.config.siteName,
      user: this.session ? { email: this.session.email, name: this.session.name } : null,
    };
  }

  restore() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.sessionFile(), "utf8"));
      if (!raw?.enc || !this.safeStorage.isEncryptionAvailable()) return;
      const data = JSON.parse(this.safeStorage.decryptString(Buffer.from(raw.enc, "base64")));
      if (!data?.token || (data.expiresAt && Date.now() >= data.expiresAt)) {
        fs.rmSync(this.sessionFile(), { force: true });
        return;
      }
      this.session = data;
    } catch {
      /* no saved session */
    }
  }

  /**
   * POST JSON to the service. Error responses carry { code, message }.
   * @param {string} url @param {any} body
   * @returns {Promise<{ status: number, body: any } | { status: 0 }>}
   */
  async post(url, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const res = await this.net.fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      let json = null;
      try {
        json = await res.json();
      } catch {
        /* no body */
      }
      return { status: res.status, body: json };
    } catch {
      return { status: 0 };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Map a failed response to a code the UI translates. @param {{status:number, body?:any}} r */
  static failure(r) {
    if (r.status === 0) return { ok: /** @type {false} */ (false), code: "network" };
    const code = r.body && typeof r.body.code === "string" ? r.body.code : "";
    const known = {
      invalid_credentials: "invalid",
      account_locked: "locked",
      account_disabled: "disabled",
      pending_approval: "pending",
      email_taken: "email_taken",
      weak_password: "weak_password",
      invalid_email: "invalid_email",
      invalid_name: "invalid_name",
      registration_closed: "registration_closed",
      too_many_requests: "too_many",
      invalid_country: "invalid_country",
      code_required: "code_required",
      invalid_code: "invalid_code",
      code_expired: "code_expired",
      resend_too_soon: "resend_too_soon",
      email_send_failed: "email_send_failed",
    };
    /** @type {Record<string, string>} */
    const map = known;
    if (map[code]) {
      const retryAfter = Number(r.body.retryAfterSeconds) || undefined;
      return { ok: /** @type {false} */ (false), code: map[code], status: r.status, message: r.body.message || "", retryAfter };
    }
    if ([400, 401, 403, 404].includes(r.status)) return { ok: /** @type {false} */ (false), code: "invalid", status: r.status };
    if (r.status === 429) return { ok: /** @type {false} */ (false), code: "too_many", status: r.status };
    return { ok: /** @type {false} */ (false), code: "server", status: r.status };
  }

  /** Keep the session from a successful response. @param {string} email @param {any} body @param {boolean} remember */
  accept(email, body, remember) {
    const cfg = this.config;
    const token = cfg.tokenPaths.map((/** @type {string} */ p) => pick(body, p)).find((v) => typeof v === "string" && v);
    if (!token) return null;
    const name = cfg.namePaths.map((/** @type {string} */ p) => pick(body, p)).find((v) => typeof v === "string" && v) || jwtName(token);
    const expiresAt = jwtExpiry(token);
    this.session = { email, name: String(name || ""), token, expiresAt };
    this.verified = true;
    if (remember && this.safeStorage.isEncryptionAvailable()) {
      const keep = expiresAt ?? Date.now() + cfg.rememberDays * 86400000;
      const enc = this.safeStorage.encryptString(JSON.stringify({ ...this.session, expiresAt: keep })).toString("base64");
      fs.mkdirSync(path.dirname(this.sessionFile()), { recursive: true });
      fs.writeFileSync(this.sessionFile(), JSON.stringify({ version: 1, enc }), "utf8");
    } else {
      fs.rmSync(this.sessionFile(), { force: true });
    }
    return { email, name: this.session.name };
  }

  /**
   * @param {string} email @param {string} password @param {boolean} remember
   * @returns {Promise<{ ok: true, user: { email: string, name: string } } | { ok: false, code: string, status?: number, message?: string }>}
   */
  async login(email, password, remember) {
    email = String(email || "").trim();
    if (!email || !password) return { ok: false, code: "missing" };
    const r = await this.post(this.config.loginUrl, { [this.config.usernameField]: email, [this.config.passwordField]: String(password) });
    if (r.status >= 200 && r.status < 300 && "body" in r) {
      const user = this.accept(email, r.body, remember);
      return user ? { ok: true, user } : { ok: false, code: "server", status: r.status };
    }
    return AuthGate.failure(r);
  }

  /**
   * The registration details, trimmed; null when something required is missing.
   * @param {any} d
   */
  static details(d) {
    const out = {
      name: String(d?.name || "").trim(),
      email: String(d?.email || "").trim(),
      password: String(d?.password || ""),
      country: String(d?.country || "").trim().toUpperCase(),
    };
    return out.name && out.email && out.password && out.country ? out : null;
  }

  /**
   * Registration step 1: the service checks the details and e-mails a 6-digit code.
   * @param {any} d
   * @returns {Promise<{ ok: true, expiresInSeconds: number, resendAfterSeconds: number } | { ok: false, code: string, status?: number, message?: string, retryAfter?: number }>}
   */
  async sendCode(d) {
    const details = AuthGate.details(d);
    if (!details) return { ok: false, code: "missing" };
    const lang = d.lang === "en" ? "en" : "ar";
    const r = await this.post(this.config.sendCodeUrl, { ...details, lang });
    if (r.status >= 200 && r.status < 300 && "body" in r) {
      return {
        ok: true,
        expiresInSeconds: Number(r.body?.expiresInSeconds) || 0,
        resendAfterSeconds: Number(r.body?.resendAfterSeconds) || 60,
      };
    }
    return AuthGate.failure(r);
  }

  /**
   * Registration step 2: create the account with the e-mailed code; signs in right
   * away unless an administrator must approve it.
   * @param {any} d
   * @returns {Promise<{ ok: true, user: { email: string, name: string } } | { ok: false, code: string, status?: number, message?: string, retryAfter?: number }>}
   */
  async register(d) {
    const details = AuthGate.details(d);
    if (!details) return { ok: false, code: "missing" };
    const code = String(d.code || "").replace(/\D/g, "");
    const r = await this.post(this.config.registerUrl, { ...details, code });
    if (r.status === 202) return { ok: false, code: "pending", status: 202 };
    if (r.status >= 200 && r.status < 300 && "body" in r) {
      const user = this.accept(details.email, r.body, Boolean(d.remember));
      return user ? { ok: true, user } : { ok: false, code: "server", status: r.status };
    }
    return AuthGate.failure(r);
  }

  /**
   * Forgot password step 1: e-mail a reset code (the service answers the same
   * whether or not the address has an account).
   * @param {any} d
   * @returns {Promise<{ ok: true, expiresInSeconds: number, resendAfterSeconds: number } | { ok: false, code: string, status?: number, message?: string, retryAfter?: number }>}
   */
  async sendResetCode(d) {
    const email = String(d?.email || "").trim();
    if (!email) return { ok: false, code: "missing" };
    const lang = d.lang === "en" ? "en" : "ar";
    const r = await this.post(this.config.resetCodeUrl, { email, lang });
    if (r.status >= 200 && r.status < 300 && "body" in r) {
      return {
        ok: true,
        expiresInSeconds: Number(r.body?.expiresInSeconds) || 0,
        resendAfterSeconds: Number(r.body?.resendAfterSeconds) || 60,
      };
    }
    if (r.status === 404) return { ok: false, code: "reset_unsupported", status: 404 };
    return AuthGate.failure(r);
  }

  /**
   * Forgot password step 2: the code and a new password; signs in on success
   * (the service signs every other device out).
   * @param {any} d
   * @returns {Promise<{ ok: true, user: { email: string, name: string } } | { ok: false, code: string, status?: number, message?: string, retryAfter?: number }>}
   */
  async resetPassword(d) {
    const email = String(d?.email || "").trim();
    const code = String(d?.code || "").replace(/\D/g, "");
    const newPassword = String(d?.password || "");
    if (!email || !newPassword) return { ok: false, code: "missing" };
    if (!code) return { ok: false, code: "code_required" };
    const r = await this.post(this.config.resetUrl, { email, code, newPassword });
    if (r.status >= 200 && r.status < 300 && "body" in r) {
      const user = this.accept(email, r.body, Boolean(d.remember));
      return user ? { ok: true, user } : { ok: false, code: "server", status: r.status };
    }
    return AuthGate.failure(r);
  }

  /** Whether the service allows creating accounts (and its password rule). */
  async options() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    try {
      const res = await this.net.fetch(this.config.optionsUrl, { signal: controller.signal });
      if (!res.ok) throw new Error(String(res.status));
      const body = await res.json();
      return {
        allowRegistration: Boolean(body.allowRegistration),
        minPasswordLength: Number(body.minPasswordLength) || 8,
        // An older service without the setting doesn't send codes.
        requireEmailVerification: body.requireEmailVerification === true,
        resendSeconds: Number(body.resendSeconds) || 60,
        passwordReset: body.passwordReset === true,
        reachable: true,
      };
    } catch {
      return { allowRegistration: true, minPasswordLength: 8, requireEmailVerification: true, resendSeconds: 60, reachable: false };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * A remembered session is re-checked once per launch: a revoked token (password
   * changed, account disabled) signs out; no network keeps it (the app works offline).
   */
  async verify() {
    if (!this.session || this.verified || !this.config.meUrl) return;
    this.verified = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    try {
      const res = await this.net.fetch(this.config.meUrl, {
        headers: { Authorization: `Bearer ${this.session.token}`, Accept: "application/json" },
        signal: controller.signal,
      });
      if (res.status === 401 || res.status === 403) this.logout();
      else if (res.ok) {
        const me = await res.json().catch(() => null);
        if (me && typeof me.name === "string" && me.name) this.session.name = me.name;
      }
    } catch {
      /* offline: keep the remembered session */
    } finally {
      clearTimeout(timer);
    }
  }

  logout() {
    this.session = null;
    this.verified = false;
    try {
      fs.rmSync(this.sessionFile(), { force: true });
    } catch {
      /* ignore */
    }
  }
}

module.exports = { AuthGate, jwtExpiry };
