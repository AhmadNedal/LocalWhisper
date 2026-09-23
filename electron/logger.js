// @ts-check
/**
 * One log for the whole app: the Electron main process, the Python backend
 * (its stdout/stderr, line by line) and the UI (console errors + explicit
 * messages). Kept in memory for the log viewer and appended to a daily file:
 *
 *   %APPDATA%\Local Transcriber\logs\local-transcriber-YYYY-MM-DD.log
 *
 * It lives in the main process on purpose: when the backend fails to start,
 * the log that explains why is still there.
 *
 * Secrets never reach the log: API keys, tokens, passwords and connection
 * strings are masked before anything is stored.
 */
const fs = require("node:fs");
const path = require("node:path");

const MAX_ENTRIES = 5000;
const KEEP_DAYS = 14;
const MAX_MESSAGE = 20000;

/** @typedef {"debug" | "info" | "warn" | "error"} Level */
/** @typedef {"app" | "backend" | "ui"} Source */
/** @typedef {{ id: number, rev: number, ts: number, level: Level, source: Source, message: string }} Entry */

const SECRET_PATTERNS = /** @type {[RegExp, string][]} */ ([
  [/\bgsk_[A-Za-z0-9]{8,}/g, "gsk_***"],
  [/\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{8,}/g, "sk-***"],
  [/\bAIza[0-9A-Za-z_-]{20,}/g, "AIza***"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "<jwt>"],
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1***"],
  [/((?:api[_-]?key|x-auth-token|token|password|passwd|pwd|secret|authorization)"?\s*[:=]\s*"?)[^"\s,;&]+/gi, "$1***"],
  [/((?:Password|Pwd)\s*=\s*)[^;"]+/gi, "$1***"],
]);

/** @param {string} text */
function redact(text) {
  let out = text;
  for (const [re, repl] of SECRET_PATTERNS) out = out.replace(re, repl);
  return out;
}

/** "2026-09-23" in local time. @param {Date} d */
function day(d) {
  const p = (/** @type {number} */ n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** "2026-09-23 21:55:03.120" in local time. @param {number} ts */
function stamp(ts) {
  const d = new Date(ts);
  const p = (/** @type {number} */ n, w = 2) => String(n).padStart(w, "0");
  return `${day(d)} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

// Python logging: "2026-09-23 21:55:03,120 WARNING app.jobs: message"
const PY_LINE = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d,\d{3} (DEBUG|INFO|WARNING|ERROR|CRITICAL) (\S+?): ([\s\S]*)$/;
const PY_LEVEL = /** @type {Record<string, Level>} */ ({ DEBUG: "debug", INFO: "info", WARNING: "warn", ERROR: "error", CRITICAL: "error" });

class Logger {
  /** @param {string} dir */
  constructor(dir) {
    this.dir = dir;
    /** @type {Entry[]} */
    this.entries = [];
    this.nextId = 1;
    /** Bumped on every new or changed entry; the viewer asks for "changes since rev N". */
    this.rev = 0;
    /** @type {((entry: Entry) => void)[]} */
    this.listeners = [];
    /** Last backend entry, to attach traceback lines to it. @type {Entry | null} */
    this.lastBackend = null;
    try {
      fs.mkdirSync(dir, { recursive: true });
      this.prune();
    } catch {
      /* logging must never break the app */
    }
  }

  file(ts = Date.now()) {
    return path.join(this.dir, `local-transcriber-${day(new Date(ts))}.log`);
  }

  /** Delete daily files older than KEEP_DAYS. */
  prune() {
    const cutoff = Date.now() - KEEP_DAYS * 86400000;
    for (const name of fs.readdirSync(this.dir)) {
      if (!/^local-transcriber-\d{4}-\d\d-\d\d\.log$/.test(name)) continue;
      const full = path.join(this.dir, name);
      try {
        if (fs.statSync(full).mtimeMs < cutoff) fs.rmSync(full, { force: true });
      } catch {
        /* ignore */
      }
    }
  }

  /** @param {(entry: Entry) => void} fn */
  onEntry(fn) {
    this.listeners.push(fn);
  }

  /**
   * @param {Level} level
   * @param {Source} source
   * @param {string} message
   * @returns {Entry}
   */
  write(level, source, message) {
    const text = redact(String(message ?? "")).slice(0, MAX_MESSAGE);
    const entry = { id: this.nextId++, rev: ++this.rev, ts: Date.now(), level, source, message: text };
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    this.append(entry);
    for (const fn of this.listeners) {
      try {
        fn(entry);
      } catch {
        /* ignore */
      }
    }
    return entry;
  }

  /** @param {Entry} entry */
  append(entry) {
    try {
      fs.appendFileSync(this.file(entry.ts), `${Logger.format(entry)}\n`, "utf8");
    } catch {
      /* disk full / no permission: keep the in-memory log */
    }
  }

  /** @param {Entry} e */
  static format(e) {
    return `${stamp(e.ts)} ${e.level.toUpperCase().padEnd(5)} [${e.source}] ${e.message}`;
  }

  info(/** @type {string} */ message) {
    return this.write("info", "app", message);
  }
  warn(/** @type {string} */ message) {
    return this.write("warn", "app", message);
  }
  error(/** @type {string} */ message) {
    return this.write("error", "app", message);
  }

  /**
   * One line of backend output. Python log lines carry their level; other lines
   * (tracebacks, native library messages) are added to the entry before them.
   * @param {string} line
   * @param {"stdout" | "stderr"} stream
   */
  backendLine(line, stream) {
    if (!line.trim()) return;
    if (stream === "stdout" && /^READY \d+$/.test(line.trim())) {
      this.write("info", "backend", `Backend ready (port ${line.trim().slice(6)})`);
      return;
    }
    const m = PY_LINE.exec(line);
    if (m) {
      this.lastBackend = this.write(PY_LEVEL[m[1]] ?? "info", "backend", `${m[2]}: ${m[3]}`);
      return;
    }
    const prev = this.lastBackend;
    const continuation = /^(\s|Traceback |During handling|The above exception|[A-Za-z_.]+(Error|Exception|Warning)\b)/.test(line);
    if (prev && continuation && Date.now() - prev.ts < 5000 && prev.message.length < MAX_MESSAGE - line.length) {
      prev.message += `\n${redact(line)}`;
      prev.rev = ++this.rev;
      if (/^[A-Za-z_.]+(Error|Exception)\b/.test(line) && prev.level !== "error") prev.level = "error";
      this.append({ ...prev, message: `  ${redact(line)}` });
      return;
    }
    const level = /error|exception|failed|fatal|traceback/i.test(line) ? "error" : stream === "stderr" ? "warn" : "info";
    this.lastBackend = this.write(level, "backend", line);
  }

  /** Entries added or changed after revision `afterRev` (all when 0). @param {number} afterRev */
  since(afterRev) {
    const out = afterRev ? this.entries.filter((e) => e.rev > afterRev) : this.entries.slice();
    return { entries: out, rev: this.rev, file: this.file(), dir: this.dir };
  }

  /** Everything in memory as plain text (for "Save" / "Copy"). */
  text() {
    return this.entries.map(Logger.format).join("\n");
  }
}

module.exports = { Logger, redact };
