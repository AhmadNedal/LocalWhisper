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
  /** "whisper" (faster-whisper) or "cohere" (Cohere Transcribe Arabic via sherpa-onnx). */
  engine?: string;
  /** Supported languages; empty = every Whisper language. */
  languages?: string[];
  /** false: runs on the CPU only. */
  gpu?: boolean;
  experimental?: boolean;
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

/** Live transcription (microphone / computer audio). */
export interface LiveStartParams {
  model: string;
  language: string | null;
  device: "auto" | "cpu" | "cuda";
  preset: "fast" | "balanced" | "accurate";
  arabic_punctuation: boolean;
  vocabulary: string;
  title: string;
  course: string | null;
  source: "mic" | "system" | "both";
  save_recording: boolean;
  save_to_archive: boolean;
}
export interface LiveSnapshot {
  id: string;
  status: "loading" | "listening" | "finishing" | "done" | "error" | "cancelled";
  error: ApiErrorBody | null;
  device: string | null;
  model: string;
  language: string | null;
  title: string;
  course: string | null;
  started_at: number;
  duration: number;
  backlog: number;
  segment_count: number;
  segments: { id: number; start: number; end: number; text: string }[];
  recording_path: string | null;
  archive_id: string | null;
}

/** Find & replace across a course (or the whole archive). */
export interface ReplaceParams {
  find: string;
  replace: string;
  /** undefined/null: the whole archive, "": entries without a course. */
  course?: string | null;
  exact: boolean;
  whole_word: boolean;
  include_summary: boolean;
}
export interface ReplaceUndo {
  label: string;
  at: number;
  items: number;
}
export interface ReplaceMatch {
  segment: number;
  start: number;
  before: string;
  match: string;
  after: string;
}
export interface ReplacePreview {
  find: string;
  replace: string;
  total_matches: number;
  total_items: number;
  truncated: boolean;
  undo: ReplaceUndo | null;
  items: { id: string; title: string; course: string | null; matches: number; summary_matches: number; samples: ReplaceMatch[] }[];
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
  course?: string | null;
  has_summary?: number | boolean;
  has_translation?: number | boolean;
}

export interface AskCitation {
  lesson_index: number;
  id: string;
  title: string;
  start: number;
}

export interface AskResult {
  question: string;
  answer: string;
  found: boolean;
  citations: AskCitation[];
  lessons: Record<string, { id: string; title: string }>;
  searched: number;
  total: number;
  provider: string;
  model: string;
}

export interface AssistTask {
  id: string;
  kind: "ask";
  status: "running" | "completed" | "error" | "cancelled";
  step: number;
  steps: number;
  result: AskResult | null;
  error: { code: string; detail: string } | null;
}

export interface BurnTask {
  id: string;
  status: "running" | "completed" | "error" | "cancelled";
  progress: number;
  output: string;
  error: { code: string; detail: string } | null;
  etaSeconds: number | null;
}

export interface ArchiveStats {
  total: { items: number; seconds: number; words: number; with_summary: number; with_translation: number; courses: number };
  courses: { course: string; items: number; seconds: number; words: number; with_summary: number; with_translation: number }[];
  engines: { engine: string; items: number; seconds: number }[];
  months: { month: string; items: number; seconds: number }[];
}

export interface ArchiveItem extends Omit<ArchiveSummary, "preview"> {
  full_text: string;
  segments: Segment[];
  summary: AiSummary | null;
  translation: TranslationData | null;
}

// ---- Translation -----------------------------------------------------------------
export type TranslateEngine = "local" | "llm" | "deepl" | "azure";

export interface TranslationData {
  language: "en" | "ar";
  source_language: string | null;
  engine: TranslateEngine;
  provider: string;
  provider_name: string;
  model: string;
  created_at: number;
  segments: { start: number; end: number; text: string }[];
}

export interface TranslateCatalog {
  local: {
    key: string;
    source: string;
    target: string;
    size_mb: number;
    downloaded: boolean;
    download: { status: string; downloaded_bytes: number; total_bytes: number; error: { code: string; detail: string } | null };
  }[];
  llm: LlmProvider[];
  services: Record<"deepl" | "azure", { name: string; key_url: string }>;
}

export interface TranslateTask {
  id: string;
  status: "running" | "completed" | "error" | "cancelled";
  stage: "starting" | "downloading" | "loading" | "translating";
  done: number;
  total: number;
  result: TranslationData | null;
  error: { code: string; detail: string } | null;
}

export interface TranslateOptions {
  engine: TranslateEngine;
  target: "en" | "ar";
  provider: string;
  model: string;
  api_key: string;
  region: string;
}

export interface TranslateParams extends TranslateOptions {
  source: string | null;
  title: string;
  archive_id: string | null;
  segments: { start: number; end: number; text: string }[];
}

// ---- AI summaries --------------------------------------------------------------
export interface AiChapter {
  start: number;
  title: string;
  summary: string;
}

export interface AiSummary {
  title: string;
  summary: string;
  key_points: string[];
  chapters: AiChapter[];
  keywords: string[];
  provider: string;
  provider_name: string;
  model: string;
  language: string | null;
  created_at: number;
}

export interface LlmProvider {
  id: string;
  name: string;
  models: { id: string; label: string }[];
  key_url: string;
  max_input_chars: number;
}

export interface SummaryTask {
  id: string;
  status: "running" | "completed" | "error" | "cancelled";
  step: number;
  steps: number;
  result: AiSummary | null;
  error: { code: string; detail: string } | null;
}

export interface SummaryParams {
  provider: string;
  model: string;
  api_key: string;
  language: "auto" | "ar" | "en";
  title: string;
  duration: number | null;
  transcript_language: string | null;
  archive_id: string | null;
  segments: { start: number; end: number; text: string }[];
}

// ---- Whole-course actions ------------------------------------------------------------
/** A saved database profile as sent to the backend (connection + SQL). */
export interface DbSettings {
  db_type: "sqlserver" | "oracle" | "mysql" | "postgresql";
  connection_string: string;
  sql: string;
  pre_sql: string;
  mode: "chunks" | "segments" | "full";
  chunk_seconds: number;
  variables: Record<string, string>;
}

export interface CourseLesson {
  id: string;
  index: number;
  title: string;
  duration: number | null;
  has_translation: boolean;
  has_summary: boolean;
}

export interface CourseTaskState {
  id: string;
  kind: "db" | "export";
  status: "running" | "completed" | "error" | "cancelled";
  done: number;
  total: number;
  current: string;
  results: {
    id: string;
    title: string;
    index: number;
    ok: boolean;
    inserted?: number;
    files?: Record<string, string>;
    error?: { code: string; detail: string };
  }[];
  error: { code: string; detail: string } | null;
  outputDir: string | null;
  siteIndex?: string | null;
}

export interface CourseExportParams {
  course: string | null;
  ids: string[] | null;
  dest_dir: string | null;
  pdf: boolean;
  pdf_timestamps: boolean;
  pdf_content: "original" | "both" | "translation";
  include_summary: boolean;
  subtitles: boolean;
  subtitles_translation: boolean;
  subtitle_format: "srt" | "vtt";
  ui_language: "ar" | "en";
  documents?: ("docx" | "txt" | "json")[];
  website?: boolean;
}

// ---- Batch queue -----------------------------------------------------------------
export type BatchItemStatus = "queued" | "running" | "done" | "error" | "cancelled" | "skipped";

export interface BatchItem {
  id: string;
  path: string;
  name: string;
  kind: "file" | "youtube";
  course: string | null;
  via: "captions" | "transcribed" | null;
  status: BatchItemStatus;
  job_id: string | null;
  archive_id: string | null;
  duration: number | null;
  language: string | null;
  word_count: number | null;
  error: { code: string; detail: string } | null;
  summary_status: "running" | "done" | "error" | null;
  summary_error: { code: string; detail: string } | null;
  translation_status: "running" | "done" | "error" | "skipped" | null;
  translation_error: { code: string; detail: string } | null;
  db_status: "running" | "done" | "error" | null;
  db_error: { code: string; detail: string } | null;
  db_inserted: number | null;
  started_at: number | null;
  finished_at: number | null;
}

/** A folder whose new videos are queued automatically. */
export interface WatchFolder {
  id: string;
  path: string;
  name: string;
  enabled: boolean;
  recursive: boolean;
  added_count: number;
  last_added_at: number | null;
  last_added_name: string | null;
  /** "unreachable" when the folder or drive is gone. */
  error: string | null;
}

export interface WatchState {
  /** Increases every time watched files are queued. */
  seq: number;
  /** Files still being copied / downloaded. */
  waiting: number;
  folders: WatchFolder[];
}

export interface BatchState {
  state: "idle" | "running" | "stopping";
  items: BatchItem[];
  counts: Partial<Record<BatchItemStatus, number>>;
  current: {
    itemId: string;
    stage: string;
    progress: number;
    etaSeconds: number | null;
    segmentCount: number;
    duration: number | null;
  } | null;
  pauseReason: { code: string; detail: string } | null;
  /** The queue was interrupted (app closed, crash, power cut) and restored from disk. */
  restored?: { queued: number; interrupted: number; done: number } | null;
  summarize: boolean | null;
  translate: boolean | null;
  database: boolean | null;
}

export interface BatchStartParams {
  model: string;
  language: string | null;
  device: string;
  preset: string;
  arabic_punctuation: boolean;
  engine: "local" | "cloud";
  cloud_provider: string | null;
  cloud_model: string | null;
  api_key: string;
  summary: { provider: string; model: string; language: "auto" | "ar" | "en"; api_key: string } | null;
  translation: TranslateOptions | null;
  youtube_captions: boolean;
  db: DbSettings | null;
  vocabulary?: string;
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
  summary?: AiSummary | null;
  translation?: TranslationData | null;
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
  vocabulary?: string;
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
  /** Shown as a link in the PDF only when it is a web URL (e.g. YouTube). */
  source?: string;
  engine?: "local" | "cloud" | "youtube";
  /** AI summary: printed before the transcript; its chapters become headings. */
  summary?: AiSummary | null;
  translation?: { start: number; end: number; text: string }[] | null;
  translation_language_name?: string;
  content?: "original" | "translation" | "both";
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
  translation?: { start: number; end: number; text: string }[] | null;
  translation_language?: string;
  summary?: AiSummary | null;
  course?: string;
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

  /** URL of a local media file for the built-in player (token in the query: <video> can't send headers). */
  mediaUrl(path: string): string {
    return `${this.baseUrl}/media/stream?path=${encodeURIComponent(path)}&token=${encodeURIComponent(this.token)}`;
  }

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
  // ---- Live transcription ----
  liveStart(params: LiveStartParams) {
    return this.request<LiveSnapshot>("POST", "/live", params);
  }
  liveCurrent() {
    return this.request<{ session: LiveSnapshot | null }>("GET", "/live/current");
  }
  liveState(id: string, since: number) {
    return this.request<LiveSnapshot>("GET", `/live/${encodeURIComponent(id)}?since=${since}`);
  }
  liveStop(id: string) {
    return this.request<LiveSnapshot>("POST", `/live/${encodeURIComponent(id)}/stop`);
  }
  liveCancel(id: string) {
    return this.request<{ ok: boolean }>("POST", `/live/${encodeURIComponent(id)}/cancel`);
  }
  /** Raw 16 kHz mono 16-bit PCM (about one second per call). */
  async liveAudio(id: string, pcm: Int16Array): Promise<{ ok: boolean; backlog: number; status: string }> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/live/${encodeURIComponent(id)}/audio`, {
        method: "POST",
        headers: { "X-Auth-Token": this.token, "Content-Type": "application/octet-stream" },
        body: pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer,
      });
    } catch (err) {
      throw new ApiError("backend_unreachable", err instanceof Error ? err.message : String(err));
    }
    const data = (await response.json().catch(() => null)) as { error?: ApiErrorBody; ok?: boolean; backlog?: number; status?: string } | null;
    if (!response.ok) throw new ApiError(data?.error?.code ?? "internal", data?.error?.detail ?? `HTTP ${response.status}`);
    return { ok: Boolean(data?.ok), backlog: Number(data?.backlog ?? 0), status: String(data?.status ?? "") };
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
  archiveCourses() {
    return this.request<{ courses: { course: string; count: number; updated_at: number }[]; total: number; without_course: number }>(
      "GET",
      "/archive/courses",
    );
  }
  archiveSetCourse(id: string, course: string | null) {
    return this.request<{ ok: boolean }>("PUT", `/archive/${encodeURIComponent(id)}/course`, { course });
  }
  archiveRenameCourse(oldName: string, newName: string | null) {
    return this.request<{ changed: number }>("POST", "/archive/courses/rename", { old: oldName, new: newName });
  }
  archiveReplacePreview(params: ReplaceParams) {
    return this.request<ReplacePreview>("POST", "/archive/replace/preview", params);
  }
  archiveReplaceApply(params: ReplaceParams & { ids: string[] }) {
    return this.request<{ changed_items: number; replacements: number; undo: ReplaceUndo | null }>(
      "POST",
      "/archive/replace/apply",
      params,
    );
  }
  archiveReplaceUndo() {
    return this.request<{ restored_items: number }>("POST", "/archive/replace/undo");
  }
  archiveList(q: string, limit = 50, offset = 0, course?: string | null) {
    const params = new URLSearchParams({ q, limit: String(limit), offset: String(offset) });
    if (course !== undefined && course !== null) params.set("course", course); // "" → entries without a course
    return this.request<{ total: number; items: ArchiveSummary[] }>("GET", `/archive?${params}`);
  }
  archiveGet(id: string) {
    return this.request<ArchiveItem>("GET", `/archive/${encodeURIComponent(id)}`);
  }
  archiveSave(params: ArchiveSaveParams) {
    return this.request<{ id: string; updated_at: number }>("POST", "/archive", params);
  }
  assistAsk(params: { course: string | null; question: string; provider: string; model: string; api_key: string }) {
    return this.request<AssistTask>("POST", "/assist/ask", params);
  }
  assistStatus(id: string) {
    return this.request<AssistTask>("GET", `/assist/${encodeURIComponent(id)}`);
  }
  assistCancel(id: string) {
    return this.request<{ ok: boolean }>("POST", `/assist/${encodeURIComponent(id)}/cancel`);
  }
  burnStart(params: {
    source: string;
    output_path: string | null;
    media_name: string;
    segments: { start: number; end: number; text: string }[];
    translation: { start: number; end: number; text: string }[] | null;
    content: "original" | "translation" | "both";
    size: "small" | "medium" | "large";
    style: "box" | "outline";
    duration: number | null;
  }) {
    return this.request<BurnTask>("POST", "/export/burn", params);
  }
  burnStatus(id: string) {
    return this.request<BurnTask>("GET", `/export/burn/${encodeURIComponent(id)}`);
  }
  burnCancel(id: string) {
    return this.request<{ ok: boolean }>("POST", `/export/burn/${encodeURIComponent(id)}/cancel`);
  }
  archiveStats(months = 12) {
    return this.request<ArchiveStats>("GET", `/archive/stats?months=${months}`);
  }
  archiveBackup(path: string | null) {
    return this.request<{ path: string; transcripts: number; courses: number; size: number }>("POST", "/archive/backup", { path });
  }
  archiveRestore(path: string) {
    return this.request<{ added: number; updated: number; skipped: number; invalid: number; total: number }>(
      "POST",
      "/archive/restore",
      { path },
    );
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
  archiveSetSummary(id: string, summary: AiSummary | null) {
    return this.request<{ ok: boolean }>("PUT", `/archive/${encodeURIComponent(id)}/summary`, { summary });
  }
  summaryProviders() {
    return this.request<{ providers: LlmProvider[] }>("GET", "/summary/providers").then((r) => r.providers);
  }
  summaryTest(provider: string, apiKey: string) {
    return this.request<{ ok: boolean; provider: string }>("POST", "/summary/test", { provider, api_key: apiKey });
  }
  summaryStart(params: SummaryParams) {
    return this.request<SummaryTask>("POST", "/summary", params);
  }
  summaryStatus(id: string) {
    return this.request<SummaryTask>("GET", `/summary/${encodeURIComponent(id)}`);
  }
  summaryCancel(id: string) {
    return this.request<{ ok: boolean }>("POST", `/summary/${encodeURIComponent(id)}/cancel`);
  }
  batchDismissRestored() {
    return this.request<{ ok: boolean }>("POST", "/batch/dismiss_restored");
  }
  batchState() {
    return this.request<BatchState>("GET", "/batch");
  }
  watchState() {
    return this.request<WatchState>("GET", "/watch");
  }
  watchAdd(path: string, includeExisting: boolean) {
    return this.request<WatchState & { added: number }>("POST", "/watch/folders", {
      path,
      include_existing: includeExisting,
      recursive: true,
    });
  }
  watchUpdate(id: string, patch: { enabled?: boolean; recursive?: boolean }) {
    return this.request<WatchState>("PATCH", `/watch/folders/${encodeURIComponent(id)}`, patch);
  }
  watchRemove(id: string) {
    return this.request<WatchState>("DELETE", `/watch/folders/${encodeURIComponent(id)}`);
  }
  batchAdd(paths: string[], skipArchived: boolean, course?: string | null) {
    return this.request<BatchState & { found: number; added: number; skipped: number }>("POST", "/batch/add", {
      paths,
      skip_archived: skipArchived,
      course: course || null,
    });
  }
  courseLessons(course: string | null) {
    const params = new URLSearchParams();
    if (course !== null) params.set("course", course);
    return this.request<{ lessons: CourseLesson[] }>("GET", `/courses/lessons?${params}`).then((r) => r.lessons);
  }
  courseDbPreview(course: string | null, ids: string[] | null, db: DbSettings) {
    return this.request<DbPreviewResult & { lessonTitle: string; lessonIndex: number }>("POST", "/courses/db/preview", {
      course,
      ids,
      db,
    });
  }
  courseDbStart(course: string | null, ids: string[] | null, db: DbSettings) {
    return this.request<CourseTaskState>("POST", "/courses/db", { course, ids, db });
  }
  courseExportStart(params: CourseExportParams) {
    return this.request<CourseTaskState>("POST", "/courses/export", params);
  }
  courseTask(id: string) {
    return this.request<CourseTaskState>("GET", `/courses/tasks/${encodeURIComponent(id)}`);
  }
  courseTaskCancel(id: string) {
    return this.request<{ ok: boolean }>("POST", `/courses/tasks/${encodeURIComponent(id)}/cancel`);
  }
  batchAddYoutube(url: string, skipArchived: boolean) {
    return this.request<BatchState & { found: number; added: number; skipped: number; playlist: string }>(
      "POST",
      "/batch/add_youtube",
      { url, skip_archived: skipArchived },
    );
  }
  batchStart(params: BatchStartParams) {
    return this.request<BatchState>("POST", "/batch/start", params);
  }
  batchStop(cancelCurrent: boolean) {
    return this.request<BatchState>("POST", "/batch/stop", { cancel_current: cancelCurrent });
  }
  batchRetry(id: string) {
    return this.request<BatchState>("POST", `/batch/items/${encodeURIComponent(id)}/retry`);
  }
  batchMove(id: string, delta: number) {
    return this.request<BatchState>("POST", `/batch/items/${encodeURIComponent(id)}/move?delta=${delta}`);
  }
  batchRemove(id: string) {
    return this.request<BatchState>("DELETE", `/batch/items/${encodeURIComponent(id)}`);
  }
  batchClear(which: "finished" | "all") {
    return this.request<BatchState>("POST", `/batch/clear?which=${which}`);
  }
  archiveSetTranslation(id: string, translation: TranslationData | null) {
    return this.request<{ ok: boolean }>("PUT", `/archive/${encodeURIComponent(id)}/translation`, { translation });
  }
  translateCatalog() {
    return this.request<TranslateCatalog>("GET", "/translate/catalog");
  }
  translateModelDownload(key: string) {
    return this.request<unknown>("POST", `/translate/models/${encodeURIComponent(key)}/download`);
  }
  translateModelDelete(key: string) {
    return this.request<{ ok: boolean }>("DELETE", `/translate/models/${encodeURIComponent(key)}`);
  }
  translateTest(engine: "llm" | "deepl" | "azure", apiKey: string, region = "", provider = "") {
    return this.request<{ ok: boolean; used?: number; limit?: number }>("POST", "/translate/test", {
      engine,
      api_key: apiKey,
      region,
      provider,
    });
  }
  translateStart(params: TranslateParams) {
    return this.request<TranslateTask>("POST", "/translate", params);
  }
  translateStatus(id: string) {
    return this.request<TranslateTask>("GET", `/translate/${encodeURIComponent(id)}`);
  }
  translateCancel(id: string) {
    return this.request<{ ok: boolean }>("POST", `/translate/${encodeURIComponent(id)}/cancel`);
  }
  exportSubtitles(params: {
    output_path: string | null;
    media_name: string;
    format: "srt" | "vtt";
    language: string;
    segments: { start: number; end: number; text: string }[];
  }) {
    return this.request<{ path: string }>("POST", "/export/subtitles", params);
  }
  exportDocument(params: ExportPdfParams & { format: "docx" | "txt" | "json" }) {
    return this.request<{ path: string }>("POST", "/export/document", params);
  }
  exportPdf(params: ExportPdfParams) {
    return this.request<{ path: string }>("POST", "/export/pdf", params);
  }
}
