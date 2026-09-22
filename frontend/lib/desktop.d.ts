/** Types for the bridge exposed by electron/preload.js as `window.desktop`. */

export type BackendStatus =
  | { state: "starting"; message?: string }
  | { state: "ready"; url: string; token: string }
  | { state: "error"; code: string; message: string }
  | { state: "stopped" };

export interface DesktopBridge {
  isDesktop: true;
  platform: string;
  getBackend(): Promise<BackendStatus>;
  restartBackend(): Promise<BackendStatus>;
  onBackendStatus(callback: (status: BackendStatus) => void): () => void;
  openMediaDialog(): Promise<string | null>;
  savePdfDialog(defaultName: string): Promise<string | null>;
  getPathForFile(file: File): string;
  showItemInFolder(path: string): Promise<void>;
  openPath(path: string): Promise<void>;
  openOutputDir(): Promise<void>;
  openModelsDir(): Promise<void>;
}

declare global {
  interface Window {
    desktop?: DesktopBridge;
  }
}
