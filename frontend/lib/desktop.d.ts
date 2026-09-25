/** Types for the bridge exposed by electron/preload.js as `window.desktop`. */

export type BackendStatus =
  | { state: "starting"; message?: string }
  | { state: "ready"; url: string; token: string }
  | { state: "error"; code: string; message: string }
  | { state: "stopped" }
  /** Not signed in yet: the connection details are withheld. */
  | { state: "locked" };

export interface AuthUser {
  email: string;
  name: string;
}

export interface AuthState {
  required: boolean;
  authenticated: boolean;
  siteName: string;
  user: AuthUser | null;
}

export type AuthFailure = { ok: false; code: string; status?: number; message?: string; retryAfter?: number };

export type AuthLoginResult = { ok: true; user: AuthUser } | AuthFailure;

export /** Automatic updates of the installed app (GitHub Releases). */
export interface UpdateState {
  status: "disabled" | "idle" | "checking" | "none" | "available" | "downloading" | "ready" | "error";
  current: string;
  version: string | null;
  progress: number;
  error: string | null;
  checkedAt: number | null;
  manual: boolean;
}

export interface AuthOptions {
  allowRegistration: boolean;
  minPasswordLength: number;
  /** A 6-digit code is e-mailed before the account is created. */
  requireEmailVerification: boolean;
  resendSeconds: number;
  /** The service supports "forgot password" (e-mailed reset code). */
  passwordReset?: boolean;
  reachable: boolean;
}

export interface RegisterDetails {
  name: string;
  email: string;
  password: string;
  /** ISO 3166-1 alpha-2, e.g. "JO". */
  country: string;
  lang?: "ar" | "en";
  code?: string;
  remember?: boolean;
}

export type SendCodeResult = { ok: true; expiresInSeconds: number; resendAfterSeconds: number } | AuthFailure;

export interface LogEntry {
  id: number;
  rev: number;
  ts: number;
  level: "debug" | "info" | "warn" | "error";
  source: "app" | "backend" | "ui";
  message: string;
}

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
  authState?(): Promise<AuthState>;
  authLogin?(email: string, password: string, remember: boolean): Promise<AuthLoginResult>;
  authLogout?(): Promise<AuthState>;
  authOptions?(): Promise<AuthOptions>;
  authSendCode?(details: RegisterDetails): Promise<SendCodeResult>;
  setBackground?(opts: {
    enabled: boolean;
    tooltip?: string;
    openLabel?: string;
    quitLabel?: string;
    hiddenTitle?: string;
    hiddenBody?: string;
  }): Promise<boolean>;
  getOpenAtLogin?(): Promise<{ supported: boolean; enabled: boolean }>;
  logGet?(afterRev: number): Promise<{ entries: LogEntry[]; rev: number; file: string; dir: string }>;
  logWrite?(level: "info" | "warn" | "error", message: string): Promise<boolean>;
  logOpenFolder?(): Promise<string>;
  logSave?(): Promise<string | null>;
  onLogAlert?(callback: (level: string) => void): () => void;
  setOpenAtLogin?(on: boolean): Promise<boolean>;
  authRegister?(details: RegisterDetails): Promise<AuthLoginResult>;
  liveSystemAudio?(): Promise<boolean>;
  updateGet?(): Promise<UpdateState>;
  updateCheck?(): Promise<UpdateState>;
  updateInstall?(): Promise<boolean>;
  onUpdateState?(callback: (state: UpdateState) => void): () => void;
  authSendResetCode?(details: { email: string; lang?: string }): Promise<SendCodeResult>;
  authResetPassword?(details: { email: string; code: string; password: string; remember?: boolean }): Promise<AuthLoginResult>;
  restartBackend(): Promise<BackendStatus>;
  onBackendStatus(callback: (status: BackendStatus) => void): () => void;
  openMediaDialog(): Promise<string | null>;
  openMediaFilesDialog(): Promise<string[]>;
  openFolderDialog(): Promise<string[]>;
  keepAwake(on: boolean): Promise<boolean>;
  savePdfDialog(defaultName: string): Promise<string | null>;
  saveFileDialog(defaultName: string, kind: "pdf" | "srt" | "vtt" | "ltbackup" | "docx" | "txt" | "json" | "mp4"): Promise<string | null>;
  /** Restore: pick a backup file (``null`` when cancelled). */
  openBackupDialog(): Promise<string | null>;
  getPathForFile(file: File): string;
  showItemInFolder(path: string): Promise<void>;
  openPath(path: string): Promise<void>;
  openOutputDir(): Promise<void>;
  openModelsDir(): Promise<void>;
  /** The key to use: the user's own, else the app's built-in one. */
  getSecret(name: string): Promise<string>;
  /** Only the key the user saved (never the built-in one). */
  getStoredSecret?(name: string): Promise<string>;
  /** True when the app ships a free built-in key for this provider. */
  hasBuiltinSecret?(name: string): Promise<boolean>;
  setSecret(name: string, value: string): Promise<{ ok: boolean; encrypted: boolean }>;
  loadDbProfiles(): Promise<DbProfile[]>;
  saveDbProfiles(profiles: DbProfile[]): Promise<{ ok: boolean; encrypted: boolean }>;
}

declare global {
  interface Window {
    desktop?: DesktopBridge;
  }
}
