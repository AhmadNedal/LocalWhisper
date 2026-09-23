/** Types for the bridge exposed by electron/preload.js as `window.desktop`. */

export type BackendStatus =
  | { state: "starting"; message?: string }
  | { state: "ready"; url: string; token: string }
  | { state: "error"; code: string; message: string }
  | { state: "stopped" };

export type DbType = "sqlserver" | "oracle" | "mysql" | "postgresql";
export type DbMode = "chunks" | "segments" | "full";

/** A saved "insert into database" configuration. */
export interface DbProfile {
  id: string;
  name: string;
  dbType: DbType;
  /** Decrypted in the main process; stored encrypted with Windows DPAPI. */
  connectionString: string;
  sql: string;
  preSql: string;
  mode: DbMode;
  chunkSeconds: number;
  variables: { name: string; value: string }[];
}

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
  getSecret(name: string): Promise<string>;
  setSecret(name: string, value: string): Promise<{ ok: boolean; encrypted: boolean }>;
  loadDbProfiles(): Promise<DbProfile[]>;
  saveDbProfiles(profiles: DbProfile[]): Promise<{ ok: boolean; encrypted: boolean }>;
}

declare global {
  interface Window {
    desktop?: DesktopBridge;
  }
}
