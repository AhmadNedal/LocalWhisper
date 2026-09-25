// @ts-check
/**
 * Starts and supervises the local Python backend.
 *
 * - Development: runs `backend/.venv` Python with `-m app`.
 * - Packaged app: runs the PyInstaller executable shipped in `resources/backend`.
 *
 * The backend binds 127.0.0.1 on a random free port and prints `READY <port>`.
 * A random token generated here is required on every request, so no other
 * program (or web page) on the machine can use the backend.
 */
const { app } = require("electron");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { EventEmitter } = require("node:events");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const MAX_RESTARTS = 3;
const START_TIMEOUT_MS = 90_000; // first start can be slow (antivirus scans the .exe)

/** @typedef {{ state: "starting" | "ready" | "error" | "stopped", url?: string, token?: string, code?: string, message?: string }} BackendStatus */

class BackendProcess extends EventEmitter {
  constructor() {
    super();
    /** Account server base URL for the free AI relay (set by main.js before start). */
    this.aiProxy = "";
    this.token = crypto.randomBytes(32).toString("hex");
    /** @type {import("node:child_process").ChildProcess | null} */
    this.child = null;
    /** @type {BackendStatus} */
    this.status = { state: "stopped" };
    this.restarts = 0;
    this.stopping = false;
    /** @type {Promise<BackendStatus> | null} */
    this.readyPromise = null;
  }

  /** Resolve the command used to launch the backend. */
  resolveCommand() {
    if (app.isPackaged) {
      const exeName = process.platform === "win32" ? "transcriber-backend.exe" : "transcriber-backend";
      const exe = path.join(process.resourcesPath, "backend", "transcriber-backend", exeName);
      return { command: exe, args: [], cwd: path.dirname(exe), missing: !fs.existsSync(exe) };
    }
    const venv = path.join(PROJECT_ROOT, "backend", ".venv");
    const python =
      process.platform === "win32" ? path.join(venv, "Scripts", "python.exe") : path.join(venv, "bin", "python");
    return {
      command: python,
      args: ["-m", "app"],
      cwd: path.join(PROJECT_ROOT, "backend"),
      missing: !fs.existsSync(python),
    };
  }

  /** Path of the FFmpeg binary shipped with the app. */
  resolveFfmpeg() {
    if (app.isPackaged) {
      const exe = path.join(process.resourcesPath, "ffmpeg", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
      return fs.existsSync(exe) ? exe : "";
    }
    try {
      // devDependency: downloads a static FFmpeg build for this OS on `npm install`.
      const p = require("ffmpeg-static");
      return typeof p === "string" && fs.existsSync(p) ? p : "";
    } catch {
      return "";
    }
  }

  modelsDir() {
    if (!app.isPackaged) return path.join(PROJECT_ROOT, "models");
    // %LOCALAPPDATA% (not Roaming): models are large and machine-specific.
    const base = process.env.LOCALAPPDATA || app.getPath("userData");
    return path.join(base, "Local Transcriber", "models");
  }

  outputDir() {
    return path.join(app.getPath("documents"), "Local Transcriber");
  }

  logFile() {
    const dir = path.join(app.getPath("userData"), "logs");
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, "backend.log");
  }

  /** @param {BackendStatus} status */
  setStatus(status) {
    this.status = status;
    this.emit("status", status);
  }

  /** Start the backend (idempotent) and resolve once it is ready. */
  start() {
    if (this.readyPromise) return this.readyPromise;
    this.stopping = false;
    this.readyPromise = new Promise((resolve) => {
      const { command, args, cwd, missing } = this.resolveCommand();
      if (missing) {
        const status = /** @type {BackendStatus} */ ({
          state: "error",
          code: "python_missing",
          message: app.isPackaged
            ? `Backend executable not found: ${command}`
            : `Python environment not found (${command}). Run "npm run setup".`,
        });
        this.setStatus(status);
        this.readyPromise = null;
        resolve(status);
        return;
      }

      this.setStatus({ state: "starting" });
      const log = fs.createWriteStream(this.logFile(), { flags: "w" });
      const child = spawn(command, args, {
        cwd,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          PYTHONUNBUFFERED: "1",
          PYTHONIOENCODING: "utf-8",
          PYTHONUTF8: "1",
          TRANSCRIBER_TOKEN: this.token,
          TRANSCRIBER_PARENT_PID: String(process.pid),
          TRANSCRIBER_MODELS_DIR: this.modelsDir(),
          TRANSCRIBER_OUTPUT_DIR: this.outputDir(),
          TRANSCRIBER_DATA_DIR: app.getPath("userData"), // archive.db lives here
          FFMPEG_PATH: this.resolveFfmpeg(),
          // Account server that relays the free AI (summaries, translation, Groq cloud transcription).
          TRANSCRIBER_AI_PROXY: this.aiProxy || "",
        },
      });
      this.child = child;

      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const status = /** @type {BackendStatus} */ ({
          state: "error",
          code: "backend_timeout",
          message: `Backend did not start within ${START_TIMEOUT_MS / 1000}s. See ${this.logFile()}`,
        });
        this.setStatus(status);
        resolve(status);
      }, START_TIMEOUT_MS);

      if (child.stdout) {
        readline.createInterface({ input: child.stdout }).on("line", (line) => {
          log.write(`[stdout] ${line}\n`);
          this.emit("line", line, "stdout");
          const match = /^READY (\d+)$/.exec(line.trim());
          if (match && !settled) {
            settled = true;
            clearTimeout(timer);
            this.restarts = 0;
            const status = /** @type {BackendStatus} */ ({
              state: "ready",
              url: `http://127.0.0.1:${match[1]}`,
              token: this.token,
            });
            this.setStatus(status);
            resolve(status);
          }
        });
      }
      /** @type {string[]} */
      const recentErrors = [];
      child.stderr?.on("data", (chunk) => {
        const text = chunk.toString("utf8");
        log.write(text);
        recentErrors.push(text);
        if (recentErrors.length > 20) recentErrors.shift();
      });
      if (child.stderr) {
        readline.createInterface({ input: child.stderr }).on("line", (line) => this.emit("line", line, "stderr"));
      }

      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const status = /** @type {BackendStatus} */ ({ state: "error", code: "backend_spawn_failed", message: err.message });
        this.setStatus(status);
        resolve(status);
      });

      child.on("exit", (code) => {
        log.end();
        this.child = null;
        this.readyPromise = null;
        if (this.stopping) {
          this.setStatus({ state: "stopped" });
          return;
        }
        const tail = recentErrors.join("").split("\n").filter(Boolean).slice(-3).join(" | ");
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          const status = /** @type {BackendStatus} */ ({
            state: "error",
            code: "backend_crashed",
            message: `Backend exited with code ${code}. ${tail}`,
          });
          this.setStatus(status);
          resolve(status);
          return;
        }
        // Crashed after being ready: restart automatically a few times.
        if (this.restarts < MAX_RESTARTS) {
          this.restarts += 1;
          this.setStatus({ state: "starting", message: "restarting" });
          setTimeout(() => this.start(), 1000);
        } else {
          this.setStatus({ state: "error", code: "backend_crashed", message: `Backend stopped (code ${code}). ${tail}` });
        }
      });
    });
    return this.readyPromise;
  }

  async restart() {
    this.stop();
    this.restarts = 0;
    await new Promise((r) => setTimeout(r, 500));
    return this.start();
  }

  /**
   * Stop the engine and wait until it (and the processes it started, such as the
   * Cohere worker) has exited — e.g. before an update replaces its files.
   * @param {number} [timeoutMs]
   * @returns {Promise<void>}
   */
  stopAndWait(timeoutMs = 8000) {
    const child = this.child;
    this.stopping = true;
    this.readyPromise = null;
    this.child = null;
    if (!child || child.exitCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        setTimeout(resolve, 300);
      };
      const timer = setTimeout(resolve, timeoutMs);
      child.once("exit", done);
      if (process.platform === "win32" && child.pid) {
        // Kill the whole process tree (the engine and its worker processes).
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => child.kill());
      } else {
        child.kill();
      }
    });
  }

  stop() {
    this.stopping = true;
    this.readyPromise = null;
    if (this.child && !this.child.killed) {
      this.child.kill();
    }
    this.child = null;
  }
}

module.exports = { BackendProcess };
