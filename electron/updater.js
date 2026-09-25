// @ts-check
/**
 * Automatic updates from the project's GitHub Releases.
 *
 * The installed app looks for `latest.yml` in the newest GitHub release
 * (https://github.com/AhmadNedal/LocalWhisper/releases/latest/download/, set as
 * "publish" in package.json). When it lists a newer version, the new installer
 * is downloaded in the background and checked against the sha512 in latest.yml.
 * The update is then installed when the user clicks "Restart to update" or,
 * otherwise, silently the next time the app quits.
 *
 * Only the installed app updates itself; a development run (`npm run dev`)
 * never does.
 */
const { EventEmitter } = require("node:events");

const FIRST_CHECK_MS = 20 * 1000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

/**
 * @typedef {{
 *   status: "disabled" | "idle" | "checking" | "none" | "available" | "downloading" | "ready" | "error",
 *   current: string,
 *   version: string | null,
 *   progress: number,
 *   error: string | null,
 *   checkedAt: number | null,
 *   manual: boolean,
 * }} UpdateState
 */

class Updater extends EventEmitter {
  /**
   * @param {{ app: import("electron").App, logger: { info: (m: string) => any, warn: (m: string) => any, error: (m: string) => any } }} opts
   */
  constructor({ app, logger }) {
    super();
    this.app = app;
    this.log = logger;
    /** @type {any} */
    this.au = null;
    /** @type {ReturnType<typeof setInterval> | null} */
    this.timer = null;
    this.installing = false;
    /** @type {UpdateState} */
    this.state = {
      status: "disabled",
      current: app.getVersion(),
      version: null,
      progress: 0,
      error: null,
      checkedAt: null,
      manual: false,
    };
  }

  /** @param {Partial<UpdateState>} patch */
  set(patch) {
    this.state = { ...this.state, ...patch };
    this.emit("state", this.state);
  }

  get ready() {
    return this.state.status === "ready";
  }

  start() {
    if (!this.app.isPackaged || process.env.LT_DISABLE_UPDATES === "1") return;
    try {
      this.au = require("electron-updater").autoUpdater;
    } catch (err) {
      this.log.warn(`Updates: electron-updater is missing (${err instanceof Error ? err.message : err})`);
      return;
    }
    const au = this.au;
    au.autoDownload = true;
    // Installing on quit is done by main.js (it stops the engine first, so no file is in use).
    au.autoInstallOnAppQuit = false;
    au.allowDowngrade = false;
    au.allowPrerelease = false;
    // GitHub's "latest/download" links point at the newest release only, so the
    // previous version's blockmap isn't there: always download the whole installer.
    au.disableDifferentialDownload = true;
    au.logger = {
      info: (/** @type {any} */ m) => this.log.info(`Updates: ${m}`),
      warn: (/** @type {any} */ m) => this.log.warn(`Updates: ${m}`),
      error: (/** @type {any} */ m) => this.log.error(`Updates: ${m}`),
      debug: () => undefined,
    };

    au.on("checking-for-update", () => this.set({ status: "checking", error: null }));
    au.on("update-not-available", () => this.set({ status: "none", checkedAt: Date.now() }));
    au.on("update-available", (/** @type {any} */ info) => {
      this.log.info(`Updates: version ${info?.version} is available (current ${this.state.current}); downloading`);
      this.set({ status: "available", version: String(info?.version || ""), progress: 0, checkedAt: Date.now() });
    });
    au.on("download-progress", (/** @type {any} */ p) =>
      this.set({ status: "downloading", progress: Math.max(0, Math.min(1, Number(p?.percent || 0) / 100)) }),
    );
    au.on("update-downloaded", (/** @type {any} */ info) => {
      this.log.info(`Updates: version ${info?.version} is downloaded and ready to install`);
      this.set({ status: "ready", version: String(info?.version || this.state.version || ""), progress: 1 });
    });
    au.on("error", (/** @type {any} */ err) => {
      const message = err instanceof Error ? err.message : String(err);
      // A failed background check isn't worth bothering the user about; a manual one is.
      if (this.state.status !== "ready") {
        this.set({ status: this.state.manual ? "error" : "idle", error: message.split("\n")[0].slice(0, 300) });
      }
    });

    this.set({ status: "idle" });
    setTimeout(() => this.check(false), FIRST_CHECK_MS);
    this.timer = setInterval(() => this.check(false), CHECK_EVERY_MS);
  }

  /** @param {boolean} manual */
  async check(manual) {
    if (!this.au || this.installing) return this.state;
    if (["checking", "downloading", "ready"].includes(this.state.status)) return this.state;
    this.set({ manual, error: null });
    try {
      await this.au.checkForUpdates();
    } catch {
      /* reported through the "error" event */
    }
    return this.state;
  }

  /**
   * Close the app and run the downloaded installer.
   * @param {{ silent: boolean, relaunch: boolean }} how
   */
  install({ silent, relaunch }) {
    if (!this.au || !this.ready || this.installing) return false;
    this.installing = true;
    this.log.info(`Updates: installing ${this.state.version}${relaunch ? " and restarting" : " on quit"}`);
    // Let the log line reach the disk before the process exits.
    setImmediate(() => this.au.quitAndInstall(silent, relaunch));
    return true;
  }
}

module.exports = { Updater };
