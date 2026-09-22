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
  restartBackend: () => ipcRenderer.invoke("backend:restart"),
  /** @param {(status: unknown) => void} callback */
  onBackendStatus: (callback) => {
    /** @param {unknown} _event @param {unknown} status */
    const listener = (_event, status) => callback(status);
    ipcRenderer.on("backend:status", listener);
    return () => ipcRenderer.removeListener("backend:status", listener);
  },

  openMediaDialog: () => ipcRenderer.invoke("dialog:openMedia"),
  /** @param {string} defaultName */
  savePdfDialog: (defaultName) => ipcRenderer.invoke("dialog:savePdf", defaultName),

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
});
