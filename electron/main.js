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
const { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, net, protocol, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { BackendProcess } = require("./backend");

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

const backend = new BackendProcess();
/** @type {BrowserWindow | null} */
let mainWindow = null;

/** Serve files from frontend/out for app://local/... with a strict CSP. */
function registerAppProtocol() {
  const csp = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'", // Next.js static export uses inline bootstrap scripts
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "img-src 'self' data: blob:",
    "connect-src http://127.0.0.1:*", // the local backend only — nothing on the internet
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
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow?.show());

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
  ipcMain.handle("backend:connection", () => backend.start());
  ipcMain.handle("backend:restart", () => backend.restart());

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

  backend.on("status", (status) => {
    mainWindow?.webContents.send("backend:status", status);
  });
}

app.on("second-instance", () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  registerAppProtocol();
  registerIpc();
  backend.start(); // start early; the UI awaits readiness
  createWindow();
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("before-quit", () => {
  backend.stop();
});
