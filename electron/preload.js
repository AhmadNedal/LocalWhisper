// @ts-check
/**
 * Preload bridge: the only native capabilities the UI can use.
 * Exposed as `window.desktop` (typed in frontend/lib/desktop.d.ts).
 */
const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("desktop", {
  isDesktop: true,
  platform: process.platform,

  /** Resolves when the local backend is ready: { state, url, token } */
  getBackend: () => ipcRenderer.invoke("backend:connection"),
  /** Mandatory sign-in against the platform. */
  authState: () => ipcRenderer.invoke("auth:state"),
  /** @param {string} email @param {string} password @param {boolean} remember */
  authLogin: (email, password, remember) => ipcRenderer.invoke("auth:login", email, password, remember),
  authLogout: () => ipcRenderer.invoke("auth:logout"),
  authOptions: () => ipcRenderer.invoke("auth:options"),
  /** Registration step 1: e-mail a verification code. @param {object} details */
  authSendCode: (details) => ipcRenderer.invoke("auth:sendCode", details),
  /** Registration step 2: create the account with the code. @param {object} details */
  authRegister: (details) => ipcRenderer.invoke("auth:register", details),
  restartBackend: () => ipcRenderer.invoke("backend:restart"),
  /** Keep running in the tray after the window is closed (while folders are watched). @param {object} opts */
  setBackground: (opts) => ipcRenderer.invoke("app:setBackground", opts),
  getOpenAtLogin: () => ipcRenderer.invoke("app:getOpenAtLogin"),
  /** @param {boolean} on */
  setOpenAtLogin: (on) => ipcRenderer.invoke("app:setOpenAtLogin", on),
  /** @param {(status: unknown) => void} callback */
  onBackendStatus: (callback) => {
    /** @param {unknown} _event @param {unknown} status */
    const listener = (_event, status) => callback(status);
    ipcRenderer.on("backend:status", listener);
    return () => ipcRenderer.removeListener("backend:status", listener);
  },

  openMediaDialog: () => ipcRenderer.invoke("dialog:openMedia"),
  /** Several media files (batch queue). */
  openMediaFilesDialog: () => ipcRenderer.invoke("dialog:openMediaMany"),
  /** One or more folders (batch queue). */
  openFolderDialog: () => ipcRenderer.invoke("dialog:openFolder"),
  /** Prevent sleep while a batch runs. @param {boolean} on */
  keepAwake: (on) => ipcRenderer.invoke("power:keepAwake", on),
  /** @param {string} defaultName */
  savePdfDialog: (defaultName) => ipcRenderer.invoke("dialog:savePdf", defaultName),
  /** Pick an archive backup to restore. */
  openBackupDialog: () => ipcRenderer.invoke("dialog:openBackup"),
  /** Save dialog for exports. @param {string} defaultName @param {string} kind pdf, srt, vtt, ltbackup, docx, txt, json or mp4 */
  saveFileDialog: (defaultName, kind) => ipcRenderer.invoke("dialog:saveFile", defaultName, kind),

  /**
   * Absolute path of a file dropped onto the window. Only the path is sent to
   * the backend — file contents are never read by the UI or uploaded anywhere.
   * @param {File} file
   */
  getPathForFile: (file) => webUtils.getPathForFile(file),

  /** @param {string} target */
  showItemInFolder: (target) => ipcRenderer.invoke("shell:showItem", target),
  /** @param {string} target */
  openPath: (target) => ipcRenderer.invoke("shell:openPath", target),
  openOutputDir: () => ipcRenderer.invoke("shell:openOutputDir"),
  openModelsDir: () => ipcRenderer.invoke("shell:openModelsDir"),

  /** Encrypted API keys for paid providers. @param {string} name */
  getSecret: (name) => ipcRenderer.invoke("secrets:get", name),
  /** The user's own saved key only. @param {string} name */
  getStoredSecret: (name) => ipcRenderer.invoke("secrets:getStored", name),
  /** Whether the app ships a free built-in key for this provider. @param {string} name */
  hasBuiltinSecret: (name) => ipcRenderer.invoke("secrets:hasBuiltin", name),
  /** @param {string} name @param {string} value (empty string deletes) */
  setSecret: (name, value) => ipcRenderer.invoke("secrets:set", name, value),

  /** Saved database profiles (connection strings are encrypted with Windows DPAPI). */
  loadDbProfiles: () => ipcRenderer.invoke("db:loadProfiles"),
  /** @param {unknown[]} profiles */
  saveDbProfiles: (profiles) => ipcRenderer.invoke("db:saveProfiles", profiles),
});
