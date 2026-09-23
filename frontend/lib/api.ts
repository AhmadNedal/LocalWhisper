/**
 * Typed client for the local Python backend (127.0.0.1 only, token protected).
 * Only file *paths* and transcript text are exchanged — media bytes never
 * pass through the UI and nothing is sent to the internet.
 */

export type Device = "auto" | "cpu" | "cuda";
export type Preset = "fast" | "balanced" | "accurate";
export type Stage =
  | "queued"
  | "probing"
  | "downloading_media"
  | "extracting_audio"
  | "downloading_model"
  | "loading_model"
  | "transcribing"
  | "finalizing"
  | "completed"
  | "error"
  | "cancelled";

export interface ApiErrorBody {
  code: string;
  detail: string;
}

export class ApiError extends Error {
  constructor(
    public code: string,
    public detail: string,
  ) {
    super(`${code}: ${detail}`);
  }
}

export interface DeviceReport {
  cuda_available: boolean;
  cuda_device_count: number;
  cuda_reason: string;
  cuda_compute_types: string[];
  cpu_cores_logical: number;
  cpu_cores_physical: number;
  ram_total_gb: number;
  ram_available_gb: number;
  gpu_name: string | null;
  gpu_vram_mb: number | null;
  gpu_compute_capability: number | null;
  /** True when the GPU is strong enough to be used automatically in "Auto" mode. */
  gpu_recommended: boolean;
  gpu_note: string;
}

export interface SystemInfo {
  version: string;
  devices: DeviceReport;
  ffmpegAvailable: boolean;
  defaultModel: string;
  defaultModelGpu: string;
  defaultModelCpu: string;
  modelsDir: string;
  outputDir: string;
  supportedExtensions: string[];
}

export interface DownloadState {
  model: string;
  status: "idle" | "downloading" | "done" | "error";
  downloaded_bytes: number;
  total_bytes: number;
  error: ApiErrorBody | null;
}

export interface ModelInfo {
  id: string;
  repo: string;
  download_mb: number;
  ram_cpu_mb: number;
  vram_gpu_mb: number;
  speed: number;
  arabic_accuracy: number;
  downloaded: boolean;
  download: DownloadState | null;
}

export interface MediaInfo {
  path: string;
  name: string;
  size_bytes: number;
  duration: number | null;
  has_video: boolean;
  has_audio: boolean;
  audio_codec: string | null;
  container: string | null;
}

export interface Segment {
  id: number;
  start: number;
  end: number;
  text: string;
}

export interface JobSnapshot {
  id: string;
  status: "running" | "completed" | "error" | "cancelled";
  stage: Stage;
  stageProgress: number;
  progress: number;
  etaSeconds: number | null;
  media: MediaInfo | null;
  device: "cpu" | "cuda" | "cloud" | null;
  engine: "local" | "cloud";
  cloudProvider: string | null;
  cloudChunks: number | null;
  computeType: string | null;
  model: string;
  language: string | null;
  languageProbability: number | null;
  download: { done: number; total: number } | null;
  warnings: string[];
  error: ApiErrorBody | null;
  segmentCount: number;
  segments: Segment[];
  elapsedSeconds: number;
}

export interface YoutubeCaption {
  lang: string;
  name: string;
  kind: "manual" | "auto";
}

export interface YoutubeInfo {
  id: string;
  url: string;
  title: string;
  channel: string;
  duration: number | null;
  thumbnail: string | null;
  language: string | null;
  captions: YoutubeCaption[];
}

export interface YoutubeSubtitles {
  segments: Segment[];
  language: string;
  kind: "manual" | "auto";
  title: string;
  duration: number | null;
}

export interface CloudModel {
  id: string;
  label: string;
  languages: string[] | null;
}

export interface CloudProvider {
  id: string;
  name: string;
  url: string;
  models: CloudModel[];
  requires_language: boolean;
  languages: string[] | null;
  key_url: string;
}

export interface ArchiveSummary {
  id: string;
  title: string;
  source_type: "file" | "youtube";
  source: string;
  created_at: number;
  updated_at: number;
  duration: number | null;
  language: string | null;
  engine: string | null;
  model: string | null;
  segment_count: number;
  word_count: number;
  preview: string;
}

export interface ArchiveItem extends Omit<ArchiveSummary, "preview"> {
  full_text: string;
  segments: Segment[];
}

export interface ArchiveSaveParams {
  id?: string | null;
  title: string;
  source_type: "file" | "youtube";
  source: string;
  duration: number | null;
  language: string | null;
  engine: string | null;
  model: string | null;
  segments: { start: number; end: number; text: string }[];
}

export interface StartJobParams {
  path: string;
  youtube_url?: string | null;
  engine?: "local" | "cloud";
  cloud_provider?: string | null;
  cloud_model?: string | null;
  api_key?: string;
  model: string;
  language: string | null;
  device: Device;
  preset: Preset;
  arabic_punctuation: boolean;
}

export interface ExportPdfParams {
  output_path: string | null;
  media_name: string;
  language_code: string;
  language_name: string;
  model_name: string | null;
  duration: number | null;
  include_timestamps: boolean;
  ui_language: "ar" | "en";
  segments: { start: number; end: number; text: string }[];
}

export interface DbConnectionParams {
  db_type: "sqlserver" | "oracle" | "mysql" | "postgresql";
  connection_string: string;
}

export interface DbInsertParams extends DbConnectionParams {
  sql: string;
  pre_sql: string;
  mode: "chunks" | "segments" | "full";
  chunk_seconds: number;
  variables: Record<string, string>;
  file_name: string;
  file_path: string;
  language: string;
  model: string;
  duration: number | null;
  segments: { start: number; end: number; text: string }[];
}

export interface DbTestResult {
  ok: boolean;
  driver: string;
  serverVersion: string;
  elapsedMs: number;
}

export interface DbPreviewResult {
  rowCount: number;
  sql: string;
  preSql: string;
  used: string[];
  unknown: string[];
  rowVariablesInPre: string[];
  sample: Record<string, unknown>[];
}

export interface DbExecuteResult {
  ok: boolean;
  inserted: number;
  driver: string;
  elapsedMs: number;
}

export class BackendClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          "X-Auth-Token": this.token,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new ApiError("backend_unreachable", err instanceof Error ? err.message : String(err));
    }
    const data = (await response.json().catch(() => null)) as { error?: ApiErrorBody } | null;
    if (!response.ok) {
      const error = data?.error;
      throw new ApiError(error?.code ?? "internal", error?.detail ?? `HTTP ${response.status}`);
    }
    return data as T;
  }

  system() {
    return this.request<SystemInfo>("GET", "/system");
  }
  models() {
    return this.request<{ models: ModelInfo[] }>("GET", "/models").then((r) => r.models);
  }
  downloadModel(id: string) {
    return this.request<DownloadState>("POST", `/models/${encodeURIComponent(id)}/download`);
  }
  deleteModel(id: string) {
    return this.request<{ ok: boolean }>("DELETE", `/models/${encodeURIComponent(id)}`);
  }
  probe(path: string) {
    return this.request<MediaInfo>("POST", "/probe", { path });
  }
  startJob(params: StartJobParams) {
    return this.request<JobSnapshot>("POST", "/jobs", params);
  }
  job(id: string, since: number) {
    return this.request<JobSnapshot>("GET", `/jobs/${id}?since=${since}`);
  }
  cancelJob(id: string) {
    return this.request<{ ok: boolean }>("POST", `/jobs/${id}/cancel`);
  }
  cloudProviders() {
    return this.request<{ providers: CloudProvider[] }>("GET", "/cloud/providers").then((r) => r.providers);
  }
  cloudTest(provider: string, apiKey: string) {
    return this.request<{ ok: boolean; provider: string }>("POST", "/cloud/test", { provider, api_key: apiKey });
  }
  archiveList(q: string, limit = 50, offset = 0) {
    const params = new URLSearchParams({ q, limit: String(limit), offset: String(offset) });
    return this.request<{ total: number; items: ArchiveSummary[] }>("GET", `/archive?${params}`);
  }
  archiveGet(id: string) {
    return this.request<ArchiveItem>("GET", `/archive/${encodeURIComponent(id)}`);
  }
  archiveSave(params: ArchiveSaveParams) {
    return this.request<{ id: string; updated_at: number }>("POST", "/archive", params);
  }
  archiveDelete(id: string) {
    return this.request<{ ok: boolean }>("DELETE", `/archive/${encodeURIComponent(id)}`);
  }
  youtubeInspect(url: string) {
    return this.request<YoutubeInfo>("POST", "/youtube/inspect", { url });
  }
  youtubeSubtitles(url: string, lang: string, kind: "manual" | "auto") {
    return this.request<YoutubeSubtitles>("POST", "/youtube/subtitles", { url, lang, kind });
  }
  dbTest(params: DbConnectionParams) {
    return this.request<DbTestResult>("POST", "/db/test", params);
  }
  dbPreview(params: DbInsertParams) {
    return this.request<DbPreviewResult>("POST", "/db/preview", params);
  }
  dbExecute(params: DbInsertParams) {
    return this.request<DbExecuteResult>("POST", "/db/execute", params);
  }
  exportPdf(params: ExportPdfParams) {
    return this.request<{ path: string }>("POST", "/export/pdf", params);
  }
}
