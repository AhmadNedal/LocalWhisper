// @ts-check
/**
 * Electron main process: the Windows desktop shell.
 *
 * Responsibilities
 * - Create the window and serve the statically exported Next.js UI through a
 *   private `app://` protocol (production) or the Next dev server (development).
 * - Start/supervise the local Python backend (see backend.js).
 * - Provide native features to the UI through a minimal, typed preload bridge:
 *   file dialogs, drag & drop paths, "show in folder".
 */
const { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, net, Notification, powerSaveBlocker, protocol, safeStorage, shell, Tray } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { BackendProcess } = require("./backend");
const { AuthGate } = require("./auth");
const { Logger } = require("./logger");

const DEV_URL = process.env.ELECTRON_START_URL || "";
const UI_ROOT = path.join(__dirname, "..", "frontend", "out");
const APP_ORIGIN = "app://local";

const MEDIA_EXTENSIONS = ["mp4", "mkv", "avi", "mov", "webm", "mp3", "wav", "m4a", "flac", "m4v", "mpg", "mpeg", "ts", "3gp", "wmv", "ogg", "oga", "opus", "aac", "wma"];

// Must run before `ready`: lets app:// behave like a normal secure origin.
protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

app.setAppUserModelId("com.localtranscriber.app");

// ---- The app-wide log (main process + backend + UI) -------------------------
const logger = new Logger(path.join(app.getPath("userData"), "logs"));
logger.info(
  `Local Transcriber ${app.getVersion()} starting | Electron ${process.versions.electron} | ${process.platform} ${require("node:os").release()} | ${app.isPackaged ? "installed" : "development"}${process.argv.includes("--hidden") ? " | started hidden (with Windows)" : ""}`,
);
process.on("uncaughtException", (err) => logger.error(`Main process error: ${err?.stack || err}`));
process.on("unhandledRejection", (reason) => logger.error(`Main process unhandled rejection: ${/** @type {any} */ (reason)?.stack || reason}`));

const backend = new BackendProcess();
backend.on("line", (/** @type {string} */ line, /** @type {"stdout" | "stderr"} */ stream) => logger.backendLine(line, stream));
backend.on("status", (/** @type {any} */ s) => {
  if (s.state === "ready") logger.info(`Backend connection ready at ${s.url}`);
  else if (s.state === "error") logger.error(`Backend error [${s.code}]: ${s.message}`);
  else if (s.state === "starting") logger.info(`Backend ${s.message === "restarting" ? "restarting after a crash" : "starting"}…`);
  else if (s.state === "stopped") logger.info("Backend stopped");
});
// Warnings and errors wake the log button's badge in the UI.
logger.onEntry((entry) => {
  if (entry.level === "warn" || entry.level === "error") mainWindow?.webContents.send("log:alert", entry.level);
});
/** @type {AuthGate} */
let auth;
/** @type {BrowserWindow | null} */
let mainWindow = null;

// ---- Background mode: keep watching folders after the window is closed ------
// While a watched folder is on, closing the window hides it to the tray instead
// of quitting, so new videos keep being transcribed. "Quit" in the tray menu ends it.
const START_HIDDEN = process.argv.includes("--hidden"); // launched by "Start with Windows"
/** @type {Tray | null} */
let tray = null;
let quitting = false;
let hiddenNoticeShown = false;
const background = {
  enabled: false,
  tooltip: "Local Transcriber",
  openLabel: "Open",
  quitLabel: "Quit",
  hiddenTitle: "",
  hiddenBody: "",
};

function showWindow() {
  if (!mainWindow) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function updateTray() {
  const want = background.enabled || (START_HIDDEN && !mainWindow?.isVisible());
  if (!want) {
    tray?.destroy();
    tray = null;
    return;
  }
  if (!tray) {
    const icon = nativeImage.createFromPath(path.join(__dirname, "..", "build", "icon.png")).resize({ width: 16, height: 16 });
    tray = new Tray(icon);
    tray.on("click", showWindow);
    tray.on("double-click", showWindow);
  }
  tray.setToolTip(background.tooltip);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: background.openLabel, click: showWindow },
      { type: "separator" },
      {
        label: background.quitLabel,
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
}

/** Serve files from frontend/out for app://local/... with a strict CSP. */
function registerAppProtocol() {
  const csp = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'", // Next.js static export uses inline bootstrap scripts
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "img-src 'self' data: blob: https://i.ytimg.com https://*.ytimg.com", // YouTube thumbnails
    "connect-src http://127.0.0.1:*", // the local backend only — nothing on the internet
    "media-src http://127.0.0.1:* blob:", // the built-in player streams local files from the backend
    // Only for transcripts of YouTube videos, and only when the player is opened.
    "frame-src https://www.youtube-nocookie.com",
  ].join("; ");

  protocol.handle("app", async (request) => {
    const url = new URL(request.url);
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith("/")) rel += "index.html";
    let file = path.normalize(path.join(UI_ROOT, rel));
    if (!file.startsWith(UI_ROOT)) return new Response("Forbidden", { status: 403 });
    if (!fs.existsSync(file) && fs.existsSync(`${file}.html`)) file = `${file}.html`;
    if (!fs.existsSync(file)) return new Response("Not found", { status: 404 });
    const response = await net.fetch(pathToFileURL(file).toString());
    const headers = new Headers(response.headers);
    headers.set("Content-Security-Policy", csp);
    return new Response(response.body, { status: response.status, headers });
  });
}

function createWindow() {
  nativeTheme.themeSource = "system";
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: "Local Transcriber",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#1c1c1c" : "#f3f3f3",
    autoHideMenuBar: true,
    icon: path.join(__dirname, "..", "build", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      // Keep polling watched folders at full speed while the window is hidden in the tray.
      backgroundThrottling: false,
    },
  });

  mainWindow.once("ready-to-show", () => {
    // Started with Windows: stay in the tray, unless a sign-in is needed first.
    if (START_HIDDEN && (!auth.required || auth.isAuthenticated())) {
      updateTray();
      return;
    }
    mainWindow?.show();
  });

  mainWindow.webContents.on("console-message", (event) => {
    // Warnings and errors of the interface (uncaught exceptions and failed promises end up here too).
    const { level, message, lineNumber, sourceId } = event;
    if (level !== "warning" && level !== "error") return;
    if (/Download the React DevTools|Electron Security Warning/.test(message)) return;
    const where = sourceId ? ` (${String(sourceId).split("/").pop()}:${lineNumber})` : "";
    logger.write(level === "error" ? "error" : "warn", "ui", `${message}${where}`);
  });
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    logger.error(`The window crashed (${details.reason}, exit code ${details.exitCode}); reloading it.`);
    if (details.reason !== "clean-exit") mainWindow?.reload();
  });
  mainWindow.on("unresponsive", () => logger.warn("The window stopped responding"));
  mainWindow.on("responsive", () => logger.info("The window is responding again"));
  mainWindow.webContents.on("did-fail-load", (_event, code, description, url) => {
    logger.error(`The interface failed to load (${code} ${description}): ${url}`);
  });

  // Closing the window while folders are watched → keep running in the tray.
  mainWindow.on("close", (event) => {
    if (quitting || !background.enabled) return;
    event.preventDefault();
    mainWindow?.hide();
    updateTray();
    logger.info("Window closed: still running in the tray (watched folders)");
    if (!hiddenNoticeShown && background.hiddenBody && Notification.isSupported()) {
      hiddenNoticeShown = true;
      new Notification({ title: background.hiddenTitle || "Local Transcriber", body: background.hiddenBody }).show();
    }
  });

  // Never navigate away from the UI or open new windows inside the app.
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(APP_ORIGIN) && !(DEV_URL && url.startsWith(DEV_URL))) event.preventDefault();
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) shell.openExternal(url); // e.g. README links only
    return { action: "deny" };
  });

  if (DEV_URL) {
    mainWindow.loadURL(DEV_URL);
  } else {
    mainWindow.loadURL(`${APP_ORIGIN}/`);
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function registerIpc() {
  // ---- Mandatory sign-in: nothing reaches the backend before it ----------
  const LOCKED = { state: "locked" };
  ipcMain.handle("auth:state", async () => {
    await auth.verify(); // a remembered session is re-checked once per launch
    return auth.state();
  });
  ipcMain.handle("auth:options", () => auth.options());
  /** @param {string} what @param {any} res @param {string} email */
  const logAuth = (what, res, email) => {
    if (res.ok) logger.info(`${what}: ok (${email})`);
    else logger.write(res.code === "network" || res.code === "server" ? "error" : "warn", "app",
      `${what} failed (${email}): ${res.code}${res.status ? ` [HTTP ${res.status}]` : ""}${res.message ? ` — ${res.message}` : ""}`);
  };
  ipcMain.handle("auth:sendCode", async (_event, /** @type {any} */ details) => {
    const res = await auth.sendCode(details || {});
    logAuth("Sign-up: send verification code", res, String(details?.email || ""));
    return res;
  });
  ipcMain.handle("auth:register", async (_event, /** @type {any} */ details) => {
    const res = await auth.register(details || {});
    logAuth("Sign-up: create account", res, String(details?.email || ""));
    if (res.ok) mainWindow?.webContents.send("backend:status", await backend.start());
    return res;
  });
  ipcMain.handle("auth:login", async (_event, /** @type {string} */ email, /** @type {string} */ password, /** @type {boolean} */ remember) => {
    const res = await auth.login(email, password, Boolean(remember));
    logAuth("Sign-in", res, String(email || ""));
    if (res.ok) mainWindow?.webContents.send("backend:status", await backend.start());
    return res;
  });
  ipcMain.handle("auth:logout", () => {
    logger.info("Signed out");
    auth.logout();
    return auth.state();
  });

  ipcMain.handle("backend:connection", () => (auth.isAuthenticated() ? backend.start() : LOCKED));
  ipcMain.handle("backend:restart", () => (auth.isAuthenticated() ? backend.restart() : LOCKED));

  ipcMain.handle("dialog:openMedia", async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openFile"],
      filters: [
        { name: "Media", extensions: MEDIA_EXTENSIONS },
        { name: "All files", extensions: ["*"] },
      ],
    });
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
  });

  // Batch queue: pick several files or whole folders at once.
  ipcMain.handle("dialog:openMediaMany", async () => {
    if (!mainWindow) return [];
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openFile", "multiSelections"],
      filters: [
        { name: "Media", extensions: MEDIA_EXTENSIONS },
        { name: "All files", extensions: ["*"] },
      ],
    });
    return result.canceled ? [] : result.filePaths;
  });

  ipcMain.handle("dialog:openFolder", async () => {
    if (!mainWindow) return [];
    const result = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory", "multiSelections"] });
    return result.canceled ? [] : result.filePaths;
  });

  // ---- Log viewer ------------------------------------------------------------
  ipcMain.handle("log:get", (_event, /** @type {number} */ afterRev) => logger.since(Number(afterRev) || 0));
  ipcMain.handle("log:write", (_event, /** @type {string} */ level, /** @type {string} */ message) => {
    const lv = ["info", "warn", "error"].includes(level) ? /** @type {"info" | "warn" | "error"} */ (level) : "info";
    logger.write(lv, "ui", String(message ?? "").slice(0, 4000));
    return true;
  });
  ipcMain.handle("log:openFolder", () => shell.openPath(logger.dir));
  ipcMain.handle("log:save", async () => {
    if (!mainWindow) return null;
    const stampName = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: path.join(app.getPath("documents"), `local-transcriber-log-${stampName}.txt`),
      filters: [{ name: "Text", extensions: ["txt", "log"] }],
    });
    if (result.canceled || !result.filePath) return null;
    fs.writeFileSync(result.filePath, `${logger.text()}\n`, "utf8");
    logger.info(`Log saved to ${result.filePath}`);
    return result.filePath;
  });

  // Background mode (tray) while folders are watched; labels come from the UI language.
  ipcMain.handle("app:setBackground", (_event, /** @type {any} */ opts) => {
    if (Boolean(opts?.enabled) !== background.enabled) {
      logger.info(opts?.enabled ? "Background mode on: closing the window keeps watching folders" : "Background mode off");
    }
    background.enabled = Boolean(opts?.enabled);
    for (const key of ["tooltip", "openLabel", "quitLabel", "hiddenTitle", "hiddenBody"]) {
      if (typeof opts?.[key] === "string" && opts[key]) /** @type {any} */ (background)[key] = String(opts[key]).slice(0, 200);
    }
    updateTray();
    // Nothing keeps it in the background any more: bring a hidden window back.
    if (!background.enabled && mainWindow && !mainWindow.isVisible() && !START_HIDDEN) mainWindow.show();
    return true;
  });

  // "Start with Windows" (installed app only: a development run has no stable executable).
  ipcMain.handle("app:getOpenAtLogin", () => ({
    supported: app.isPackaged && process.platform === "win32",
    enabled: app.isPackaged ? app.getLoginItemSettings({ args: ["--hidden"] }).openAtLogin : false,
  }));
  ipcMain.handle("app:setOpenAtLogin", (_event, /** @type {boolean} */ on) => {
    if (!app.isPackaged) return false;
    app.setLoginItemSettings({ openAtLogin: Boolean(on), args: ["--hidden"] });
    logger.info(`Start with Windows: ${on ? "on" : "off"}`);
    return app.getLoginItemSettings({ args: ["--hidden"] }).openAtLogin;
  });

  // Keep Windows awake while the batch queue runs overnight (the screen may still turn off).
  /** @type {number | null} */
  let awakeId = null;
  ipcMain.handle("power:keepAwake", (_event, /** @type {boolean} */ on) => {
    if (on && awakeId === null) awakeId = powerSaveBlocker.start("prevent-app-suspension");
    if (!on && awakeId !== null) {
      powerSaveBlocker.stop(awakeId);
      awakeId = null;
    }
    return awakeId !== null;
  });

  ipcMain.handle("dialog:saveFile", async (_event, /** @type {string} */ defaultName, /** @type {string} */ kind) => {
    if (!mainWindow) return null;
    const filters = {
      pdf: [{ name: "PDF", extensions: ["pdf"] }],
      srt: [{ name: "SubRip subtitles", extensions: ["srt"] }],
      vtt: [{ name: "WebVTT subtitles", extensions: ["vtt"] }],
      ltbackup: [{ name: "Local Transcriber backup", extensions: ["ltbackup"] }],
      docx: [{ name: "Word", extensions: ["docx"] }],
      txt: [{ name: "Text", extensions: ["txt"] }],
      json: [{ name: "JSON", extensions: ["json"] }],
      mp4: [{ name: "MP4 video", extensions: ["mp4"] }],
    };
    const ext = kind in filters ? kind : "pdf";
    const dir = backend.outputDir();
    fs.mkdirSync(dir, { recursive: true });
    const safe = String(defaultName || "transcript").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_");
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: path.join(dir, safe.endsWith(`.${ext}`) ? safe : `${safe}.${ext}`),
      filters: /** @type {any} */ (filters)[ext],
    });
    return result.canceled || !result.filePath ? null : result.filePath;
  });

  // Restore: pick an archive backup (or a raw archive.db copied by hand).
  ipcMain.handle("dialog:openBackup", async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openFile"],
      filters: [
        { name: "Local Transcriber backup", extensions: ["ltbackup", "zip", "db"] },
        { name: "All files", extensions: ["*"] },
      ],
    });
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
  });

  ipcMain.handle("dialog:savePdf", async (_event, /** @type {string} */ defaultName) => {
    if (!mainWindow) return null;
    const dir = backend.outputDir();
    fs.mkdirSync(dir, { recursive: true });
    const safe = String(defaultName || "transcript").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_");
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: path.join(dir, safe.endsWith(".pdf") ? safe : `${safe}.pdf`),
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    return result.canceled || !result.filePath ? null : result.filePath;
  });

  ipcMain.handle("shell:showItem", (_event, /** @type {string} */ target) => {
    if (typeof target === "string" && fs.existsSync(target)) shell.showItemInFolder(target);
  });

  ipcMain.handle("shell:openOutputDir", async () => {
    const dir = backend.outputDir();
    fs.mkdirSync(dir, { recursive: true });
    await shell.openPath(dir);
  });

  ipcMain.handle("shell:openModelsDir", async () => {
    const dir = backend.modelsDir();
    fs.mkdirSync(dir, { recursive: true });
    await shell.openPath(dir);
  });

  ipcMain.handle("shell:openPath", async (_event, /** @type {string} */ target) => {
    if (typeof target === "string" && fs.existsSync(target)) await shell.openPath(target);
  });

  // ---- Saved database profiles ------------------------------------------
  // Stored in %APPDATA%\Local Transcriber\db-profiles.json. The connection
  // string (which contains the password) is encrypted with Electron's
  // safeStorage — Windows DPAPI, readable only by this Windows user account.
  const profilesFile = () => path.join(app.getPath("userData"), "db-profiles.json");

  ipcMain.handle("db:loadProfiles", () => {
    if (!auth.isAuthenticated()) return [];
    try {
      const raw = JSON.parse(fs.readFileSync(profilesFile(), "utf8"));
      const list = Array.isArray(raw.profiles) ? raw.profiles : [];
      return list.map((/** @type {any} */ p) => {
        let connectionString = "";
        if (p.connectionStringEnc && safeStorage.isEncryptionAvailable()) {
          try {
            connectionString = safeStorage.decryptString(Buffer.from(p.connectionStringEnc, "base64"));
          } catch {
            connectionString = ""; // created by another Windows user / machine
          }
        }
        const { connectionStringEnc: _omit, ...rest } = p;
        return { ...rest, connectionString };
      });
    } catch {
      return [];
    }
  });

  ipcMain.handle("db:saveProfiles", (_event, /** @type {any[]} */ profiles) => {
    const canEncrypt = safeStorage.isEncryptionAvailable();
    const stored = (Array.isArray(profiles) ? profiles : []).map((p) => {
      const { connectionString, ...rest } = p;
      return {
        ...rest,
        connectionStringEnc:
          canEncrypt && connectionString ? safeStorage.encryptString(String(connectionString)).toString("base64") : "",
      };
    });
    fs.mkdirSync(path.dirname(profilesFile()), { recursive: true });
    fs.writeFileSync(profilesFile(), JSON.stringify({ version: 1, profiles: stored }, null, 2), "utf8");
    return { ok: true, encrypted: canEncrypt };
  });

  // ---- API keys for paid providers ---------------------------------------
  // One encrypted entry per provider in %APPDATA%\Local Transcriber\secrets.json
  // (Windows DPAPI via safeStorage). Keys are only handed to the local backend
  // for the duration of a transcription.
  const secretsFile = () => path.join(app.getPath("userData"), "secrets.json");
  const readSecrets = () => {
    try {
      return JSON.parse(fs.readFileSync(secretsFile(), "utf8")) || {};
    } catch {
      return {};
    }
  };

  // Built-in keys shipped with the app (builtin-keys.json next to the app, not in git):
  // used for a provider only while the user hasn't saved a key of their own.
  /** @type {Record<string, string> | null} */
  let builtinCache = null;
  const builtinKeys = () => {
    if (builtinCache) return builtinCache;
    const file = app.isPackaged
      ? path.join(process.resourcesPath, "builtin-keys.json")
      : path.join(__dirname, "..", "builtin-keys.json");
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) || {};
      builtinCache = Object.fromEntries(
        Object.entries(raw).filter(([k, v]) => !k.startsWith("_") && typeof v === "string" && v.trim()),
      );
    } catch {
      builtinCache = {};
    }
    return builtinCache;
  };
  /** @param {string} name */
  const storedSecret = (name) => {
    const enc = readSecrets()[String(name)];
    if (!enc || !safeStorage.isEncryptionAvailable()) return "";
    try {
      return safeStorage.decryptString(Buffer.from(enc, "base64"));
    } catch {
      return "";
    }
  };

  // The key to use: the user's own, else the built-in one.
  ipcMain.handle("secrets:get", (_event, /** @type {string} */ name) =>
    auth.isAuthenticated() ? storedSecret(name) || builtinKeys()[String(name)] || "" : "",
  );
  // Only the user's own key (settings fields never show the built-in key).
  ipcMain.handle("secrets:getStored", (_event, /** @type {string} */ name) => (auth.isAuthenticated() ? storedSecret(name) : ""));
  ipcMain.handle("secrets:hasBuiltin", (_event, /** @type {string} */ name) => Boolean(builtinKeys()[String(name)]));

  ipcMain.handle("secrets:set", (_event, /** @type {string} */ name, /** @type {string} */ value) => {
    if (!safeStorage.isEncryptionAvailable()) return { ok: false, encrypted: false };
    const all = readSecrets();
    if (value) all[String(name)] = safeStorage.encryptString(String(value)).toString("base64");
    else delete all[String(name)];
    fs.mkdirSync(path.dirname(secretsFile()), { recursive: true });
    fs.writeFileSync(secretsFile(), JSON.stringify(all, null, 2), "utf8");
    return { ok: true, encrypted: true };
  });

  backend.on("status", (status) => {
    // The connection details (port + token) only go to a signed-in window.
    mainWindow?.webContents.send("backend:status", auth.isAuthenticated() ? status : LOCKED);
  });
}

app.on("second-instance", () => {
  showWindow();
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  registerAppProtocol();
  auth = new AuthGate({ app, safeStorage, net, rootDir: path.join(__dirname, "..") });
  registerIpc();
  backend.start(); // start early; the UI awaits readiness
  createWindow();
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("before-quit", () => {
  quitting = true;
  backend.stop();
});
