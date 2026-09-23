"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError,
  type AiSummary,
  type QuizData,
  type BatchState,
  type LlmProvider,
  type TranslateCatalog,
  type TranslationData,
  type JobSnapshot,
  type MediaInfo,
  type ModelInfo,
  type Segment,
  type SystemInfo,
  type CloudProvider,
  type YoutubeCaption,
  type YoutubeInfo,
  type WatchState,
} from "@/lib/api";
import { isRtlLanguage } from "@/lib/format";
import { STRINGS, errorMessage, type UiLang } from "@/lib/i18n";
import { languageName } from "@/lib/languages";
import { useBackend, usePersistentState } from "@/lib/useBackend";
import { ArchiveDialog } from "./ArchiveDialog";
import { loadUsableProfiles, profileToDb } from "@/lib/dbProfiles";
import { WatchDialog } from "./WatchDialog";
import { LogsDialog } from "./LogsDialog";
import { BatchDialog, type BatchPrefs } from "./BatchDialog";
import {
  DEFAULT_SUMMARY_SETTINGS,
  SummaryPanel,
  type SummarySettings,
} from "./SummaryPanel";
import {
  DEFAULT_TRANSLATE_SETTINGS,
  TranslatePanel,
  translateSecret,
  type TranslateSettings,
} from "./TranslatePanel";
import { secretName } from "./CloudSettings";
import { DatabaseDialog } from "./DatabaseDialog";
import { ExportPanel, type ExportOptions } from "./ExportPanel";

type DocFormat = "pdf" | "docx" | "txt" | "json";
import {
  AlertIcon,
  ArchiveIcon,
  CloudIcon,
  GlobeIcon,
  PlayIcon,
  QueueIcon,
  RefreshIcon,
  ShieldIcon,
  WaveIcon,
  WatchFolderIcon,
  LogIcon,
} from "./Icons";
import { MediaPicker } from "./MediaPicker";
import { ProgressPanel } from "./ProgressPanel";
import { SettingsPanel, type TranscribeSettings } from "./SettingsPanel";
import { TranscriptView } from "./TranscriptView";
import { MediaPlayer, type SeekRequest } from "./MediaPlayer";
import { BurnDialog } from "./BurnDialog";
import type { Account } from "./AuthGate";
import { QuizPanel } from "./QuizPanel";
import { PlayerClock, youtubeIdFrom } from "@/lib/playerClock";
import { YoutubePanel } from "./YoutubePanel";

const POLL_MS = 400;

const DEFAULT_SETTINGS: TranscribeSettings = {
  model: null, // chosen from the backend's hardware-aware default on first run
  language: "ar",
  device: "auto",
  preset: "balanced",
  arabicPunctuation: true,
  engine: "local",
  cloudProvider: "cohere",
  cloudModel: "cohere-transcribe-arabic-07-2026",
};

const pdfEngine = (e: string): "local" | "cloud" | "youtube" =>
  e === "cloud" || e === "youtube" ? e : "local";

/** What the archive needs to know about the transcript currently shown. */
type ArchiveMeta = {
  sourceType: "file" | "youtube";
  engine: string;
  model: string | null;
  language: string | null;
};

const archiveKey = (
  title: string,
  segs: Segment[],
  summary?: AiSummary | null,
  translation?: TranslationData | null,
) =>
  `${title}\u0000${summary?.created_at ?? ""}\u0000${translation ? translation.created_at + translation.segments.map((s) => s.text).join("|") : ""}\u0000${segs.map((s) => `${s.start}|${s.end}|${s.text}`).join("\n")}`;

const DEFAULT_EXPORT: ExportOptions = {
  includeTimestamps: true,
  includeModel: true,
  includeSummary: true,
  pdfLang: "ar",
};
const DEFAULT_BATCH_PREFS: BatchPrefs = {
  skipArchived: true,
  summarize: false,
  keepAwake: true,
};
const BATCH_POLL_MS = 1200;
const WATCH_POLL_MS = 4000;

type Banner = { code: string; detail: string } | null;

function toBanner(err: unknown): Banner {
  if (err instanceof ApiError) return { code: err.code, detail: err.detail };
  return {
    code: "internal",
    detail: err instanceof Error ? err.message : String(err),
  };
}

export function TranscriberApp({ account }: { account?: Account } = {}) {
  const [lang, setLang] = usePersistentState<UiLang>("ui-lang", "ar");
  const [settings, setSettings] = usePersistentState<TranscribeSettings>(
    "transcribe-settings",
    DEFAULT_SETTINGS,
  );
  const [exportOptions, setExportOptions] = usePersistentState<ExportOptions>(
    "export-options",
    DEFAULT_EXPORT,
  );
  const [summarySettings, setSummarySettings] =
    usePersistentState<SummarySettings>(
      "summary-settings",
      DEFAULT_SUMMARY_SETTINGS,
    );
  const [batchPrefs, setBatchPrefs] = usePersistentState<BatchPrefs>(
    "batch-prefs",
    DEFAULT_BATCH_PREFS,
  );
  const [translateSettings, setTranslateSettings] =
    usePersistentState<TranslateSettings>(
      "translate-settings",
      DEFAULT_TRANSLATE_SETTINGS,
    );
  const t = STRINGS[lang];

  const { state: backend, retry } = useBackend();
  const client = backend.kind === "ready" ? backend.client : null;

  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [media, setMedia] = useState<MediaInfo | null>(null);
  const [mediaLoading, setMediaLoading] = useState(false);
  const [job, setJob] = useState<JobSnapshot | null>(null);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [cancelling, setCancelling] = useState(false);
  const [banner, setBanner] = useState<Banner>(null);
  const [pdfGenerating, setPdfGenerating] = useState(false);
  const [pdfPath, setPdfPath] = useState<string | null>(null);
  const [pdfError, setPdfError] = useState<Banner>(null);
  const [dbOpen, setDbOpen] = useState(false);
  // YouTube source (when set, `media` describes the video, not a local file)
  const [ytInfo, setYtInfo] = useState<YoutubeInfo | null>(null);
  const [ytLoading, setYtLoading] = useState(false);
  const [captionLoading, setCaptionLoading] = useState<string | null>(null);
  const [usedCaption, setUsedCaption] = useState<YoutubeCaption | null>(null);
  // Language/model of a transcript that didn't come from a job (YouTube captions)
  const [transcriptMeta, setTranscriptMeta] = useState<{
    language: string;
    model: string;
  } | null>(null);
  // Paid providers + archive
  const [cloudProviders, setCloudProviders] = useState<CloudProvider[]>([]);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archiveId, setArchiveId] = useState<string | null>(null);
  const [archiveMeta, setArchiveMeta] = useState<ArchiveMeta | null>(null);
  const [openedFromArchive, setOpenedFromArchive] = useState(false);
  const archiveIdRef = useRef<string | null>(null);
  const lastArchived = useRef("");
  const saveChain = useRef<Promise<void>>(Promise.resolve());
  // AI summary of the transcript on screen
  const [llmProviders, setLlmProviders] = useState<LlmProvider[]>([]);
  const [summary, setSummary] = useState<AiSummary | null>(null);
  const [summaryTask, setSummaryTask] = useState<{
    id: string;
    step: number;
    steps: number;
  } | null>(null);
  const [summaryError, setSummaryError] = useState<Banner>(null);
  const [focus, setFocus] = useState<{ time: number; nonce: number } | null>(
    null,
  );
  // ---- Built-in player ----
  const [playerOpen, setPlayerOpen] = usePersistentState<boolean>(
    "player-open",
    false,
  );
  const [playerFollow, setPlayerFollow] = usePersistentState<boolean>(
    "player-follow",
    true,
  );
  const clock = useMemo(() => new PlayerClock(), []);
  const [seekRequest, setSeekRequest] = useState<SeekRequest | null>(null);
  const [burnOpen, setBurnOpen] = useState(false);
  const [quiz, setQuiz] = useState<QuizData | null>(null);
  const onQuiz = useCallback(
    (next: QuizData | null) => {
      setQuiz(next);
      if (!next && client && archiveIdRef.current) {
        client.archiveSetQuiz(archiveIdRef.current, null).catch(() => undefined);
      }
    },
    [client],
  );
  const seekTo = useCallback(
    (time: number) => {
      setPlayerOpen(true);
      setSeekRequest({ time, nonce: Date.now() + Math.random() });
    },
    [setPlayerOpen],
  );
  const transcriptGen = useRef(0); // bumps whenever a different transcript is shown
  // Translation of the transcript on screen
  const [translateCatalog, setTranslateCatalog] =
    useState<TranslateCatalog | null>(null);
  const [translation, setTranslation] = useState<TranslationData | null>(null);
  const [translateTask, setTranslateTask] = useState<{
    id: string;
    stage: string;
    done: number;
    total: number;
  } | null>(null);
  const [translateError, setTranslateError] = useState<Banner>(null);
  const [viewRequest, setViewRequest] = useState<{
    view: "segments" | "paragraphs" | "bilingual";
    nonce: number;
  } | null>(null);
  const [savedLabel, setSavedLabel] = useState<string | undefined>(undefined);
  const [translateKeyReady, setTranslateKeyReady] = useState(false);
  // The translation section stays hidden until the user asks for it.
  const [translateOpen, setTranslateOpen] = useState(false);
  // Batch queue
  const [batch, setBatch] = useState<BatchState | null>(null);
  const [watch, setWatch] = useState<WatchState | null>(null);
  const [watchOpen, setWatchOpen] = useState(false);
  const [logsOpen, setLogsOpen] = useState<null | "all" | "error">(null);
  const [logAlerts, setLogAlerts] = useState(0);
  const [batchOpen, setBatchOpen] = useState(false);
  const [playlistToAdd, setPlaylistToAdd] = useState<string | null>(null);
  const [pathsToAdd, setPathsToAdd] = useState<string[] | null>(null);
  const [archiveCourse, setArchiveCourse] = useState<string | null>(null);

  /** Several files / folders from the main screen → the batch queue. */
  const addToQueue = useCallback((paths: string[]) => {
    if (!paths.length) return;
    setPathsToAdd(paths);
    setBatchOpen(true);
  }, []);
  const [summaryKeyReady, setSummaryKeyReady] = useState(false);

  /** Forget the archive link: the next transcript becomes a new archive entry. */
  const resetArchive = useCallback(() => {
    archiveIdRef.current = null;
    lastArchived.current = "";
    transcriptGen.current += 1;
    setArchiveId(null);
    setArchiveMeta(null);
    setOpenedFromArchive(false);
    setSummary(null);
    setSummaryError(null);
    setSummaryTask(null);
    setQuiz(null);
    setTranslation(null);
    setTranslateError(null);
    setTranslateTask(null);
    setTranslateOpen(false);
    setArchiveCourse(null);
  }, []);
  const fetchedSegments = useRef(0);

  // Keep <html lang/dir> in sync with the UI language.
  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
    document.title = t.appName;
  }, [lang, t.appName]);

  // Dropping a file anywhere outside the drop zone must not navigate the window.
  useEffect(() => {
    const prevent = (e: DragEvent) => e.preventDefault();
    window.addEventListener("dragover", prevent);
    window.addEventListener("drop", prevent);
    return () => {
      window.removeEventListener("dragover", prevent);
      window.removeEventListener("drop", prevent);
    };
  }, []);

  // ---- Backend data -------------------------------------------------------
  const refreshModels = useCallback(async () => {
    if (!client) return;
    try {
      setModels(await client.models());
    } catch (err) {
      setBanner(toBanner(err));
    }
  }, [client]);

  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    (async () => {
      try {
        const [info, list, providers, llms, batchState] = await Promise.all([
          client.system(),
          client.models(),
          client.cloudProviders().catch(() => [] as CloudProvider[]),
          client.summaryProviders().catch(() => [] as LlmProvider[]),
          client.batchState().catch(() => null),
        ]);
        client
          .translateCatalog()
          .then((c) => !cancelled && setTranslateCatalog(c))
          .catch(() => undefined);
        if (cancelled) return;
        setCloudProviders(providers);
        setLlmProviders(llms);
        setBatch(batchState);
        setSystem(info);
        setModels(list);
        setSettings((s) =>
          s.model && list.some((m) => m.id === s.model)
            ? s
            : { ...s, model: info.defaultModel },
        );
        if (!info.ffmpegAvailable)
          setBanner({ code: "ffmpeg_missing", detail: "" });
      } catch (err) {
        if (!cancelled) setBanner(toBanner(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, setSettings]);

  // Poll model list while any download is in progress.
  const anyDownloading = models.some(
    (m) => m.download?.status === "downloading",
  );
  useEffect(() => {
    if (!anyDownloading) return;
    const timer = setInterval(refreshModels, 700);
    return () => clearInterval(timer);
  }, [anyDownloading, refreshModels]);

  // ---- File selection -------------------------------------------------------
  const running = job?.status === "running";

  const selectPath = useCallback(
    async (path: string) => {
      if (!client || running) return;
      setMediaLoading(true);
      setBanner(null);
      try {
        const info = await client.probe(path);
        setMedia(info);
        resetArchive();
        setYtInfo(null);
        setUsedCaption(null);
        setTranscriptMeta(null);
        setJob(null);
        setSegments([]);
        setPdfPath(null);
        setPdfError(null);
        fetchedSegments.current = 0;
      } catch (err) {
        setBanner(toBanner(err));
      } finally {
        setMediaLoading(false);
      }
    },
    [client, running],
  );

  // ---- YouTube ----------------------------------------------------------------
  const inspectYoutube = async (url: string) => {
    if (!client || running) return;
    setYtLoading(true);
    setBanner(null);
    try {
      const info = await client.youtubeInspect(url);
      setYtInfo(info);
      resetArchive();
      setMedia({
        path: info.url,
        name: info.title,
        size_bytes: 0,
        duration: info.duration,
        has_video: true,
        has_audio: true,
        audio_codec: null,
        container: "youtube",
      });
      setJob(null);
      setSegments([]);
      setPdfPath(null);
      setPdfError(null);
      setUsedCaption(null);
      setTranscriptMeta(null);
      fetchedSegments.current = 0;
    } catch (err) {
      setBanner(toBanner(err));
    } finally {
      setYtLoading(false);
    }
  };

  const applyYoutubeCaption = async (track: YoutubeCaption) => {
    if (!client || !ytInfo) return;
    setCaptionLoading(`${track.kind}:${track.lang}`);
    setBanner(null);
    try {
      const res = await client.youtubeSubtitles(
        ytInfo.url,
        track.lang,
        track.kind,
      );
      setJob(null);
      setSegments(res.segments);
      setUsedCaption(track);
      const captionModel =
        track.kind === "manual" ? t.ytModelManual : t.ytModelAuto;
      setTranscriptMeta({ language: res.language, model: captionModel });
      setOpenedFromArchive(false);
      setArchiveMeta({
        sourceType: "youtube",
        engine: "youtube",
        model: captionModel,
        language: res.language,
      });
      setPdfPath(null);
      fetchedSegments.current = 0;
    } catch (err) {
      setBanner(toBanner(err));
    } finally {
      setCaptionLoading(null);
    }
  };

  const pickFile = useCallback(async () => {
    const path = await window.desktop?.openMediaDialog();
    if (path) await selectPath(path);
  }, [selectPath]);

  // ---- Transcription --------------------------------------------------------
  const start = async () => {
    if (!client || !media) return;
    const cloud = settings.engine === "cloud";
    if (!cloud && !settings.model) return;
    let apiKey = "";
    if (cloud) {
      apiKey =
        (await window.desktop?.getSecret(secretName(settings.cloudProvider))) ??
        "";
      if (!apiKey) {
        setBanner({ code: "cloud_auth", detail: "" });
        return;
      }
    }
    setBanner(null);
    resetArchive();
    setPdfPath(null);
    setPdfError(null);
    setCancelling(false);
    setSegments([]);
    setUsedCaption(null);
    setTranscriptMeta(null);
    fetchedSegments.current = 0;
    try {
      const snapshot = await client.startJob({
        path: ytInfo ? "" : media.path,
        youtube_url: ytInfo ? ytInfo.url : null,
        model: settings.model ?? "",
        language: settings.language === "auto" ? null : settings.language,
        device: settings.device,
        preset: settings.preset,
        arabic_punctuation: settings.arabicPunctuation,
        vocabulary: settings.vocabulary ?? "",
        engine: cloud ? "cloud" : "local",
        cloud_provider: cloud ? settings.cloudProvider : null,
        cloud_model: cloud ? settings.cloudModel : null,
        api_key: apiKey,
      });
      setJob(snapshot);
    } catch (err) {
      const b = toBanner(err);
      setBanner(
        b?.code === "busy" && batch?.state !== "idle" && batch
          ? { ...b, code: "batch_busy" }
          : b,
      );
    }
  };

  const cancel = async () => {
    if (!client || !job) return;
    setCancelling(true);
    try {
      await client.cancelJob(job.id);
    } catch (err) {
      setBanner(toBanner(err));
    }
  };

  // Poll the running job; append only segments we haven't seen yet.
  const jobId = job?.id;
  useEffect(() => {
    if (!client || !jobId || !running) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const snap = await client.job(jobId, fetchedSegments.current);
        if (stopped) return;
        if (snap.segmentCount < fetchedSegments.current) {
          // Backend restarted the transcription (GPU → CPU fallback).
          fetchedSegments.current = 0;
          setSegments([]);
          timer = setTimeout(tick, 0);
          return;
        }
        if (snap.segments.length) {
          fetchedSegments.current += snap.segments.length;
          setSegments((prev) => [...prev, ...snap.segments]);
        }
        setJob(snap);
        if (snap.status !== "running") {
          setCancelling(false);
          refreshModels();
          return;
        }
      } catch (err) {
        if (stopped) return;
        setBanner(toBanner(err));
      }
      timer = setTimeout(tick, POLL_MS);
    };
    timer = setTimeout(tick, POLL_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [client, jobId, running, refreshModels]);

  const editSegment = useCallback((id: number, text: string) => {
    setSegments((prev) => prev.map((s) => (s.id === id ? { ...s, text } : s)));
    setPdfPath(null);
  }, []);

  // ---- Archive ----------------------------------------------------------------
  // A finished job becomes archivable; captions/archive entries set this directly.
  const jobStatus = job?.status;
  useEffect(() => {
    if (jobStatus !== "completed" || !job) return;
    setArchiveMeta({
      sourceType: ytInfo ? "youtube" : "file",
      engine: job.engine ?? "local",
      model: job.model,
      language: job.language,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobStatus, job?.id]);

  // Auto-save (debounced) whenever the transcript or its edits change.
  // Saves are chained so the first save's id is reused by later ones.
  useEffect(() => {
    if (!client || !media || !archiveMeta || running || !segments.length)
      return;
    const title = media.name;
    const key = archiveKey(title, segments, summary, translation);
    if (key === lastArchived.current) return;
    const snapshot = segments
      .filter((s) => s.text.trim())
      .map(({ start, end, text }) => ({ start, end, text }));
    const timer = setTimeout(() => {
      saveChain.current = saveChain.current.then(async () => {
        try {
          const res = await client.archiveSave({
            id: archiveIdRef.current,
            title,
            source_type: archiveMeta.sourceType,
            source: media.path,
            duration: media.duration,
            language: archiveMeta.language,
            engine: archiveMeta.engine,
            model: archiveMeta.model,
            segments: snapshot,
            summary,
            translation,
            quiz,
          });
          archiveIdRef.current = res.id;
          lastArchived.current = key;
          setArchiveId(res.id);
        } catch {
          /* archive is best-effort; the transcript stays on screen */
        }
      });
    }, 800);
    return () => clearTimeout(timer);
  }, [client, media, archiveMeta, running, segments, summary, translation, quiz]);

  const openArchived = async (id: string) => {
    if (!client || running) return;
    try {
      const item = await client.archiveGet(id);
      setArchiveOpen(false);
      setYtInfo(null);
      setUsedCaption(null);
      setJob(null);
      setPdfPath(null);
      setPdfError(null);
      setMedia({
        path: item.source,
        name: item.title,
        size_bytes: 0,
        duration: item.duration,
        has_video: item.source_type === "youtube",
        has_audio: true,
        audio_codec: null,
        container: "archive",
      });
      setSegments(item.segments);
      setTranscriptMeta({
        language: item.language ?? "",
        model: item.model ?? "",
      });
      transcriptGen.current += 1;
      setSummary(item.summary ?? null);
      setQuiz(item.quiz ?? null);
      setSummaryError(null);
      setSummaryTask(null);
      setTranslation(item.translation ?? null);
      setTranslateError(null);
      setTranslateTask(null);
      setArchiveCourse(item.course ?? null);
      archiveIdRef.current = item.id;
      lastArchived.current = archiveKey(
        item.title,
        item.segments,
        item.summary,
        item.translation,
      );
      setArchiveId(item.id);
      setArchiveMeta({
        sourceType: item.source_type,
        engine: item.engine ?? "local",
        model: item.model,
        language: item.language,
      });
      setOpenedFromArchive(true);
      fetchedSegments.current = 0;
    } catch (err) {
      setBanner(toBanner(err));
    }
  };

  // ---- Built-in player: what can be played ----------------------------------------
  const isWebSource = Boolean(media && /^https?:\/\//i.test(media.path));
  const youtubeId = media && isWebSource ? youtubeIdFrom(media.path) : null;
  const playable = Boolean(
    media && segments.length && (youtubeId || (media.path && !isWebSource)),
  );

  // ---- PDF export -------------------------------------------------------------
  // PDF, Word, plain text or JSON: all share the same options (layout, content, summary).
  const exportAs = async (format: DocFormat, saveAs: boolean) => {
    if (!client || !media || !segments.length) return;
    setPdfError(null);
    setPdfPath(null);
    let outputPath: string | null = null;
    if (saveAs) {
      const base = media.name.replace(/\.[^.]+$/, "");
      outputPath =
        (format === "pdf"
          ? await window.desktop?.savePdfDialog(`${base} - transcript.pdf`)
          : await window.desktop?.saveFileDialog(
              `${base} - transcript.${format}`,
              format,
            )) ?? null;
      if (!outputPath) return;
    }
    setPdfGenerating(true);
    const code =
      transcriptMeta?.language ??
      job?.language ??
      (settings.language === "auto" ? "" : settings.language);
    try {
      const params = {
        output_path: outputPath,
        media_name: media.name,
        language_code: code,
        language_name: languageName(code, exportOptions.pdfLang),
        model_name: exportOptions.includeModel
          ? (transcriptMeta?.model ?? job?.model ?? settings.model)
          : null,
        duration: media.duration,
        include_timestamps: exportOptions.includeTimestamps,
        ui_language: exportOptions.pdfLang,
        segments: segments
          .filter((s) => s.text.trim())
          .map(({ start, end, text }) => ({ start, end, text })),
        source: media.path,
        engine: pdfEngine(archiveMeta?.engine ?? settings.engine),
        summary: exportOptions.includeSummary !== false ? summary : null,
        translation: translation?.segments ?? null,
        translation_language_name: translation
          ? languageName(translation.language, exportOptions.pdfLang)
          : "",
        content: translation
          ? (exportOptions.content ?? "original")
          : "original",
      } as const;
      const result =
        format === "pdf"
          ? await client.exportPdf(params)
          : await client.exportDocument({ ...params, format });
      setSavedLabel(format === "pdf" ? undefined : t.documentSaved);
      setPdfPath(result.path);
    } catch (err) {
      setPdfError(toBanner(err));
    } finally {
      setPdfGenerating(false);
    }
  };

  // ---- Translation ----------------------------------------------------------------
  const transcriptLangCode =
    transcriptMeta?.language ||
    job?.language ||
    (settings.language === "auto" ? null : settings.language);

  const translateOptions = async () => {
    const secret = translateSecret(translateSettings);
    const apiKey = secret
      ? ((await window.desktop?.getSecret(secret)) ?? "")
      : "";
    if (secret && !apiKey) throw new ApiError("cloud_auth", "");
    return {
      engine: translateSettings.engine,
      target: translateSettings.target,
      provider: translateSettings.provider,
      model: translateSettings.model,
      api_key: apiKey,
      region: translateSettings.region,
    };
  };

  const generateTranslation = async () => {
    if (!client || !media || !segments.length) return;
    setTranslateError(null);
    try {
      const opts = await translateOptions();
      const task = await client.translateStart({
        ...opts,
        source: transcriptLangCode || null,
        title: media.name,
        archive_id: archiveIdRef.current,
        segments: segments
          .filter((s) => s.text.trim())
          .map(({ start, end, text }) => ({ start, end, text })),
      });
      setTranslateTask({
        id: task.id,
        stage: task.stage,
        done: task.done,
        total: task.total,
      });
    } catch (err) {
      setTranslateError(toBanner(err));
    }
  };

  const translateTaskId = translateTask?.id;
  useEffect(() => {
    if (!client || !translateTaskId) return;
    const gen = transcriptGen.current;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const st = await client.translateStatus(translateTaskId);
        if (stopped || gen !== transcriptGen.current) return;
        if (st.status === "running") {
          setTranslateTask({
            id: st.id,
            stage: st.stage,
            done: st.done,
            total: st.total,
          });
          timer = setTimeout(tick, 600);
          return;
        }
        setTranslateTask(null);
        if (st.status === "completed" && st.result) {
          setTranslation(st.result);
          setPdfPath(null);
          setViewRequest({ view: "bilingual", nonce: Date.now() });
          if (st.result.engine === "local")
            client
              .translateCatalog()
              .then(setTranslateCatalog)
              .catch(() => undefined);
        } else if (st.status === "error" && st.error)
          setTranslateError(st.error);
      } catch (err) {
        if (!stopped) {
          setTranslateTask(null);
          setTranslateError(toBanner(err));
        }
      }
    };
    timer = setTimeout(tick, 400);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [client, translateTaskId]);

  const cancelTranslation = async () => {
    if (!client || !translateTask) return;
    try {
      await client.translateCancel(translateTask.id);
    } catch {
      /* already finished */
    }
    setTranslateTask(null);
  };

  const deleteTranslation = async () => {
    setTranslation(null);
    setPdfPath(null);
    if (client && archiveIdRef.current) {
      try {
        await client.archiveSetTranslation(archiveIdRef.current, null);
        lastArchived.current = archiveKey(
          media?.name ?? "",
          segments,
          summary,
          null,
        );
      } catch {
        /* best effort */
      }
    }
  };

  const editTranslation = useCallback((index: number, text: string) => {
    setTranslation((tr) =>
      tr
        ? {
            ...tr,
            segments: tr.segments.map((s, i) =>
              i === index ? { ...s, text } : s,
            ),
          }
        : tr,
    );
    setPdfPath(null);
  }, []);

  const exportSubtitles = async (
    which: "original" | "translation",
    saveAs: boolean,
  ) => {
    if (!client || !media) return;
    const source =
      which === "translation"
        ? (translation?.segments ?? [])
        : segments
            .filter((s) => s.text.trim())
            .map(({ start, end, text }) => ({ start, end, text }));
    if (!source.length) return;
    const langCode =
      which === "translation"
        ? (translation?.language ?? "")
        : (transcriptLangCode ?? "");
    const format = exportOptions.subtitleFormat ?? "srt";
    let outputPath: string | null = null;
    if (saveAs) {
      const base = media.name.replace(/\.[^.]+$/, "");
      outputPath =
        (await window.desktop?.saveFileDialog(
          `${base}${langCode ? `.${langCode}` : ""}.${format}`,
          format,
        )) ?? null;
      if (!outputPath) return;
    }
    setPdfError(null);
    try {
      const res = await client.exportSubtitles({
        output_path: outputPath,
        media_name: media.name,
        format,
        language: langCode,
        segments: source,
      });
      setSavedLabel(t.subtitlesSaved);
      setPdfPath(res.path);
    } catch (err) {
      setPdfError(toBanner(err));
    }
  };

  // Is the translation method ready for a batch? (offline: always; online: key saved)
  useEffect(() => {
    let alive = true;
    const secret = translateSecret(translateSettings);
    if (!secret) {
      setTranslateKeyReady(true);
      return;
    }
    window.desktop
      ?.getSecret(secret)
      .then((k) => alive && setTranslateKeyReady(Boolean(k)));
    return () => {
      alive = false;
    };
  }, [translateSettings, batchOpen]);

  // ---- AI summary -------------------------------------------------------------
  const generateSummary = async () => {
    if (!client || !media || !segments.length) return;
    const apiKey =
      (await window.desktop?.getSecret(secretName(summarySettings.provider))) ??
      "";
    if (!apiKey) {
      setSummaryError({ code: "cloud_auth", detail: "" });
      return;
    }
    setSummaryError(null);
    try {
      const task = await client.summaryStart({
        provider: summarySettings.provider,
        model: summarySettings.model,
        api_key: apiKey,
        language: summarySettings.language,
        title: media.name,
        duration: media.duration,
        transcript_language: transcriptMeta?.language || job?.language || null,
        archive_id: archiveIdRef.current,
        segments: segments
          .filter((s) => s.text.trim())
          .map(({ start, end, text }) => ({ start, end, text })),
      });
      setSummaryTask({ id: task.id, step: task.step, steps: task.steps });
    } catch (err) {
      setSummaryError(toBanner(err));
    }
  };

  const summaryTaskId = summaryTask?.id;
  useEffect(() => {
    if (!client || !summaryTaskId) return;
    const gen = transcriptGen.current;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const st = await client.summaryStatus(summaryTaskId);
        if (stopped) return;
        if (gen !== transcriptGen.current) return; // another transcript is on screen now
        if (st.status === "running") {
          setSummaryTask({ id: st.id, step: st.step, steps: st.steps });
          timer = setTimeout(tick, 800);
          return;
        }
        setSummaryTask(null);
        if (st.status === "completed" && st.result) setSummary(st.result);
        else if (st.status === "error" && st.error) setSummaryError(st.error);
      } catch (err) {
        if (!stopped) {
          setSummaryTask(null);
          setSummaryError(toBanner(err));
        }
      }
    };
    timer = setTimeout(tick, 600);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [client, summaryTaskId]);

  const cancelSummary = async () => {
    if (!client || !summaryTask) return;
    try {
      await client.summaryCancel(summaryTask.id);
    } catch {
      /* already finished */
    }
    setSummaryTask(null);
  };

  const deleteSummary = async () => {
    setSummary(null);
    setPdfPath(null);
    if (client && archiveIdRef.current) {
      try {
        await client.archiveSetSummary(archiveIdRef.current, null);
        lastArchived.current = archiveKey(media?.name ?? "", segments, null);
      } catch {
        /* best effort */
      }
    }
  };

  // Is there a saved key for the chosen summary provider? (needed to summarize a batch)
  useEffect(() => {
    let alive = true;
    window.desktop
      ?.getSecret(secretName(summarySettings.provider))
      .then((k) => alive && setSummaryKeyReady(Boolean(k)));
    return () => {
      alive = false;
    };
  }, [summarySettings.provider, batchOpen]);

  // ---- Batch queue -------------------------------------------------------------
  const batchState = batch?.state ?? "idle";
  useEffect(() => {
    if (!client || (!batchOpen && batchState === "idle")) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const st = await client.batchState();
        if (!stopped) setBatch(st);
      } catch {
        /* keep last state */
      }
      if (!stopped) timer = setTimeout(tick, BATCH_POLL_MS);
    };
    timer = setTimeout(tick, BATCH_POLL_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [client, batchOpen, batchState]);

  // Keep Windows awake while the queue works through the night.
  const keepAwake = batchState !== "idle" && batchPrefs.keepAwake;
  useEffect(() => {
    window.desktop?.keepAwake?.(keepAwake);
  }, [keepAwake]);

  const startBatch = async () => {
    if (!client) return;
    const cloud = settings.engine === "cloud";
    let apiKey = "";
    if (cloud) {
      apiKey =
        (await window.desktop?.getSecret(secretName(settings.cloudProvider))) ??
        "";
      if (!apiKey) throw new ApiError("cloud_auth", "");
    }
    let summaryOpt = null;
    if (batchPrefs.summarize) {
      const key =
        (await window.desktop?.getSecret(
          secretName(summarySettings.provider),
        )) ?? "";
      if (key) summaryOpt = { ...summarySettings, api_key: key };
    }
    const translationOpt =
      batchPrefs.translate && translateKeyReady
        ? await translateOptions()
        : null;
    let dbOpt = null;
    if (batchPrefs.dbInsert) {
      const usable = await loadUsableProfiles();
      const chosen = usable.find((p) => p.id === batchPrefs.dbProfileId) ?? usable[0];
      if (chosen) dbOpt = profileToDb(chosen);
    }
    const res = await client.batchStart({
      model: settings.model ?? "",
      language: settings.language === "auto" ? null : settings.language,
      device: settings.device,
      preset: settings.preset,
      arabic_punctuation: settings.arabicPunctuation,
        vocabulary: settings.vocabulary ?? "",
      engine: cloud ? "cloud" : "local",
      cloud_provider: cloud ? settings.cloudProvider : null,
      cloud_model: cloud ? settings.cloudModel : null,
      api_key: apiKey,
      summary: summaryOpt,
      translation: translationOpt,
      youtube_captions: batchPrefs.youtubeCaptions !== false,
      db: dbOpt,
    });
    setBatch(res);
  };

  // ---- System log: count new errors for the title-bar badge; record what the user saw
  useEffect(() => {
    return window.desktop?.onLogAlert?.((level) => {
      if (level === "error") setLogAlerts((n) => n + 1);
    });
  }, []);
  useEffect(() => {
    if (banner) {
      window.desktop?.logWrite?.("error", `Shown to the user: ${banner.code}${banner.detail ? ` — ${banner.detail}` : ""}`);
    }
  }, [banner]);

  // ---- Watched folders: new videos are queued by the backend; start the queue here
  // with the current settings (the keys live in this app, never in the backend).
  const startBatchRef = useRef(startBatch);
  startBatchRef.current = startBatch;
  const watchSeen = useRef(0);
  const seededRef = useRef(false);
  const tRef = useRef(t);
  tRef.current = t;
  const autoStart = batchPrefs.watchAutoStart !== false;
  useEffect(() => {
    if (!client) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const w = await client.watchState();
        if (stopped) return;
        setWatch(w);
        if (w.seq > watchSeen.current) {
          const first = watchSeen.current === 0 && seededRef.current === false;
          watchSeen.current = w.seq;
          seededRef.current = true;
          // Tell the user (also when the window is hidden in the tray).
          const latest = [...w.folders].sort((a, b) => (b.last_added_at ?? 0) - (a.last_added_at ?? 0))[0];
          if (!first && latest?.last_added_name && typeof Notification !== "undefined") {
            try {
              new Notification(tRef.current.watchNotifyTitle, {
                body: tRef.current.watchNotifyBody.replace("{name}", latest.last_added_name).replace("{folder}", latest.name),
                silent: true,
              });
            } catch {
              /* notifications blocked */
            }
          }
          const st = await client.batchState();
          if (stopped) return;
          setBatch(st);
          if (autoStart && st.state === "idle" && !st.pauseReason && st.counts.queued) {
            await startBatchRef.current().catch((err) => setBanner(toBanner(err)));
          }
        }
      } catch {
        /* backend busy / restarting: try again next time */
      }
      if (!stopped) timer = setTimeout(tick, WATCH_POLL_MS);
    };
    tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [client, autoStart]);
  const watching = (watch?.folders ?? []).filter((f) => f.enabled).length;
  // While folders are watched, closing the window keeps the app running in the tray.
  const keepInBackground = watching > 0 && batchPrefs.watchBackground !== false;
  useEffect(() => {
    window.desktop?.setBackground?.({
      enabled: keepInBackground,
      tooltip: `${t.appName} — ${t.watchIndicator.replace("{n}", String(watching))}`,
      openLabel: t.trayOpen,
      quitLabel: t.trayQuit,
      hiddenTitle: t.appName,
      hiddenBody: t.trayHiddenBody,
    });
  }, [keepInBackground, watching, t]);

  const batchSettingsLabel = [
    settings.engine === "cloud"
      ? `${cloudProviders.find((p) => p.id === settings.cloudProvider)?.name ?? settings.cloudProvider} · ${settings.cloudModel}`
      : (settings.model ?? ""),
    settings.language === "auto"
      ? t.autoDetect
      : languageName(settings.language, lang),
    settings.engine === "cloud" ? null : settings.device.toUpperCase(),
  ]
    .filter(Boolean)
    .join(" · ");
  const batchDone = batch?.counts.done ?? 0;
  const batchTotal = batch?.items.length ?? 0;

  // ---- Models ---------------------------------------------------------------
  const downloadModel = async (id: string) => {
    if (!client) return;
    try {
      await client.downloadModel(id);
      await refreshModels();
    } catch (err) {
      setBanner(toBanner(err));
    }
  };
  const deleteModel = async (id: string) => {
    if (!client) return;
    try {
      await client.deleteModel(id);
      await refreshModels();
    } catch (err) {
      setBanner(toBanner(err));
    }
  };

  // ---- Render -----------------------------------------------------------------
  const transcriptLanguage =
    transcriptMeta?.language ??
    job?.language ??
    (settings.language === "auto" ? null : settings.language);
  const transcriptRtl = transcriptLanguage
    ? isRtlLanguage(transcriptLanguage)
    : lang === "ar";

  return (
    <div className="app">
      <header className="titlebar">
        <div className="brand">
          <span className="brand-logo">
            <WaveIcon size={20} />
          </span>
          <div>
            <div className="brand-name">{t.appName}</div>
            <div className="brand-tag">{t.appTagline}</div>
          </div>
        </div>
        <div className="titlebar-actions">
          <button
            className={`btn btn-subtle logs-btn${logAlerts ? " has-alerts" : ""}`}
            onClick={() => {
              setLogsOpen(logAlerts ? "error" : "all");
              setLogAlerts(0);
            }}
            title={logAlerts ? t.logsNewErrors : t.logsTitle}
          >
            <LogIcon size={16} /> {t.logsButton}
            {logAlerts ? <span className="badge-count err">{logAlerts > 99 ? "99+" : logAlerts}</span> : null}
          </button>
          <button
            className={`btn btn-subtle watch-btn${watching ? " is-on" : ""}`}
            onClick={() => setWatchOpen(true)}
            disabled={!client}
            title={watching ? t.watchIndicator.replace("{n}", String(watching)) : t.watchTitle}
          >
            <WatchFolderIcon size={16} /> {t.watchButton}
            {watching ? <span className="watch-live-dot" aria-hidden="true" /> : null}
          </button>
          <button
            className="btn btn-subtle"
            onClick={() => setBatchOpen(true)}
            disabled={!client}
          >
            <QueueIcon size={16} /> {t.batch}
            {batchState !== "idle" ? (
              <span className="queue-running">
                <span className="spinner small" />
                <span className="badge-count">
                  {t.batchRunningBadge
                    .replace("{done}", String(batchDone))
                    .replace("{total}", String(batchTotal))}
                </span>
              </span>
            ) : batch?.counts.queued ? (
              <span className="badge-count">{batch.counts.queued}</span>
            ) : null}
          </button>
          <button
            className="btn btn-subtle"
            onClick={() => setArchiveOpen(true)}
            disabled={!client}
          >
            <ArchiveIcon size={16} /> {t.archive}
          </button>
          {settings.engine === "cloud" && cloudProviders.length ? (
            <span className="pill pill-cloud">
              <CloudIcon size={14} />{" "}
              {t.cloudBadge.replace(
                "{provider}",
                cloudProviders.find((p) => p.id === settings.cloudProvider)
                  ?.name ?? settings.cloudProvider,
              )}
            </span>
          ) : (
            <span className="pill pill-privacy">
              <ShieldIcon size={14} /> {t.privacyBadge}
            </span>
          )}
          <button
            className="btn btn-subtle"
            onClick={() => setLang(lang === "ar" ? "en" : "ar")}
          >
            <GlobeIcon size={16} /> {t.switchLang}
          </button>
          {account?.onLogout ? (
            <div className="account-chip" title={account.user?.email ?? ""}>
              <span className="account-avatar" aria-hidden="true">
                {(account.user?.name || account.user?.email || "?").trim().charAt(0).toUpperCase()}
              </span>
              <span className="account-name" dir="auto">
                {account.user?.name || account.user?.email}
              </span>
              <button className="btn btn-subtle btn-small" onClick={account.onLogout}>
                {t.logout}
              </button>
            </div>
          ) : null}
        </div>
      </header>

      {backend.kind !== "ready" ? (
        <div className="backend-state">
          {backend.kind === "starting" ? (
            <>
              <span className="spinner" /> {t.backendStarting}
            </>
          ) : backend.kind === "no-desktop" ? (
            <>
              <AlertIcon /> {t.notDesktop}
            </>
          ) : (
            <div className="notice error wide">
              <AlertIcon />
              <div>
                <strong>{t.backendError}</strong>
                <div>{errorMessage(lang, backend.code)}</div>
                <details>
                  <summary>{t.details}</summary>
                  <code dir="ltr">{backend.message}</code>
                </details>
              </div>
              <button className="btn" onClick={retry}>
                <RefreshIcon size={16} /> {t.retry}
              </button>
            </div>
          )}
        </div>
      ) : null}

      {banner ? (
        <div className="notice error banner" role="alert">
          <AlertIcon />
          <div>
            <div>{errorMessage(lang, banner.code)}</div>
            {banner.detail ? (
              <details>
                <summary>{t.details}</summary>
                <code dir="ltr">{banner.detail}</code>
              </details>
            ) : null}
          </div>
          <button
            className="btn btn-subtle"
            onClick={() => {
              setLogsOpen("error");
              setLogAlerts(0);
            }}
          >
            <LogIcon size={14} /> {t.logsShow}
          </button>
          <button className="btn btn-subtle" onClick={() => setBanner(null)}>
            {t.close}
          </button>
        </div>
      ) : null}

      {batch?.restored && batch.state === "idle" && client ? (
        <div className="notice warn banner resume-banner" role="status">
          <QueueIcon />
          <div>
            <div>
              <strong>{t.resumeTitle}</strong>{" "}
              {t.resumeText
                .replace("{queued}", String(batch.restored.queued))
                .replace("{done}", String(batch.restored.done))}
            </div>
          </div>
          <button
            className="btn btn-accent"
            onClick={async () => {
              setBatchOpen(true);
              await startBatch();
            }}
          >
            {t.resumeNow}
          </button>
          <button className="btn" onClick={() => setBatchOpen(true)}>
            {t.resumeOpen}
          </button>
          <button
            className="icon-btn"
            aria-label={t.close}
            onClick={() => {
              setBatch((b) => (b ? { ...b, restored: null } : b));
              client.batchDismissRestored().catch(() => undefined);
            }}
          >
            ✕
          </button>
        </div>
      ) : null}

      <main className="layout">
        <div className="side">
          <MediaPicker
            t={t}
            lang={lang}
            media={ytInfo ? null : media}
            loading={mediaLoading}
            disabled={!client || running}
            onPick={pickFile}
            onDropPath={selectPath}
            onAddMany={addToQueue}
            onPickFolder={async () => addToQueue((await window.desktop?.openFolderDialog()) ?? [])}
            onPickMany={async () => addToQueue((await window.desktop?.openMediaFilesDialog()) ?? [])}
          />
          <YoutubePanel
            t={t}
            lang={lang}
            info={ytInfo}
            loading={ytLoading}
            disabled={!client || running}
            usedCaption={usedCaption}
            captionLoading={captionLoading}
            onInspect={inspectYoutube}
            onUseCaption={applyYoutubeCaption}
            onPlaylist={(url) => {
              setPlaylistToAdd(url);
              setBatchOpen(true);
            }}
          />
          <ProgressPanel
            t={t}
            lang={lang}
            job={job}
            canStart={Boolean(
              client &&
              media &&
              media.container !== "archive" &&
              (settings.engine === "cloud" || settings.model) &&
              !running,
            )}
            cancelling={cancelling}
            generatingPdf={pdfGenerating}
            isYoutube={Boolean(ytInfo)}
            readyNote={
              openedFromArchive
                ? t.archiveOpened
                : usedCaption
                  ? t.ytLoaded
                  : null
            }
            archived={Boolean(archiveId)}
            onStart={start}
            onCancel={cancel}
          />
          <SettingsPanel
            t={t}
            lang={lang}
            settings={settings}
            onChange={(patch) => setSettings((s) => ({ ...s, ...patch }))}
            system={system}
            models={models}
            disabled={!client || running}
            onDownload={downloadModel}
            onDelete={deleteModel}
            client={client}
            cloudProviders={cloudProviders}
          />
        </div>
        <div className="main">
          {playerOpen && playable && client ? (
            <MediaPlayer
              t={t}
              src={youtubeId ? null : client.mediaUrl(media!.path)}
              youtubeId={youtubeId}
              clock={clock}
              seek={seekRequest}
              follow={playerFollow}
              onFollow={setPlayerFollow}
              onOpenExternal={
                youtubeId ? undefined : () => window.desktop?.openPath(media!.path)
              }
              onClose={() => setPlayerOpen(false)}
            />
          ) : null}
          <TranscriptView
            clock={playerOpen && playable ? clock : null}
            onSeek={playable ? seekTo : null}
            follow={playerFollow}
            t={t}
            segments={segments}
            rtl={transcriptRtl}
            live={running}
            onEdit={editSegment}
            chapters={summary?.chapters}
            focus={focus}
            translation={translation?.segments}
            onEditTranslation={editTranslation}
            viewRequest={viewRequest}
            tools={
              segments.length && !running ? (
                <>
                {playable ? (
                  <button
                    className={`btn btn-small${playerOpen ? " btn-accent" : ""}`}
                    aria-pressed={playerOpen}
                    onClick={() => setPlayerOpen((o) => !o)}
                    title={t.playerHint}
                  >
                    <PlayIcon size={14} /> {t.playerTitle}
                  </button>
                ) : null}
                <button
                  className={`btn btn-small${translateOpen ? " btn-accent" : ""}`}
                  aria-pressed={translateOpen}
                  onClick={() => setTranslateOpen((o) => !o)}
                >
                  {translateTask ? (
                    <span className="spinner small" />
                  ) : (
                    <GlobeIcon size={14} />
                  )}{" "}
                  {t.translateTitle}
                </button>
                </>
              ) : null
            }
          />
          {translateOpen ? (
            <TranslatePanel
              t={t}
              lang={lang}
              client={client}
              catalog={translateCatalog}
              onCatalog={setTranslateCatalog}
              settings={translateSettings}
              onSettings={(patch) =>
                setTranslateSettings((s) => ({ ...s, ...patch }))
              }
              translation={translation}
              task={translateTask}
              error={translateError}
              canTranslate={Boolean(
                client && media && segments.length && !running,
              )}
              sourceLanguage={transcriptLangCode || null}
              bilingualShown={false}
              onTranslate={generateTranslation}
              onCancel={cancelTranslation}
              onDelete={deleteTranslation}
              onShow={() =>
                setViewRequest({ view: "bilingual", nonce: Date.now() })
              }
              onClose={() => setTranslateOpen(false)}
            />
          ) : null}
          <ExportPanel
            t={t}
            lang={lang}
            options={exportOptions}
            onOptions={(patch) => setExportOptions((o) => ({ ...o, ...patch }))}
            canExport={Boolean(client && media && segments.length && !running)}
            generating={pdfGenerating}
            savedPath={pdfPath}
            error={pdfError}
            onExport={(format, saveAs) => exportAs(format, saveAs)}
            onOpenDatabase={() => setDbOpen(true)}
            hasSummary={Boolean(summary)}
            hasTranslation={Boolean(translation)}
            onExportSubtitles={exportSubtitles}
            onBurn={playable && !youtubeId ? () => setBurnOpen(true) : null}
            savedLabel={savedLabel}
          />
          {llmProviders.length ? (
            <SummaryPanel
              t={t}
              lang={lang}
              client={client}
              providers={llmProviders}
              settings={summarySettings}
              onSettings={(patch) =>
                setSummarySettings((s) => ({ ...s, ...patch }))
              }
              summary={summary}
              running={Boolean(summaryTask)}
              progress={summaryTask}
              error={summaryError}
              canSummarize={Boolean(
                client && media && segments.length && !running,
              )}
              onGenerate={generateSummary}
              onCancel={cancelSummary}
              onDelete={deleteSummary}
              onJump={(time) => {
                setFocus({ time, nonce: Date.now() });
                if (playerOpen && playable) seekTo(time);
              }}
            />
          ) : null}
          {llmProviders.length && segments.length && !running ? (
            <QuizPanel
              t={t}
              lang={lang}
              client={client}
              settings={summarySettings}
              providerName={
                llmProviders.find((p) => p.id === summarySettings.provider)?.name ?? summarySettings.provider
              }
              quiz={quiz}
              onQuiz={onQuiz}
              archiveId={archiveId}
              title={media?.name ?? ""}
              duration={media?.duration ?? null}
              segments={segments
                .filter((s) => s.text.trim())
                .map(({ start, end, text }) => ({ start, end, text }))}
              canGenerate={Boolean(client && media && segments.length && !running)}
              onJump={(time) => {
                setFocus({ time, nonce: Date.now() });
                if (playerOpen && playable) seekTo(time);
              }}
            />
          ) : null}
        </div>
      </main>

      {burnOpen && client && media ? (
        <BurnDialog
          t={t}
          lang={lang}
          client={client}
          source={media.path}
          mediaName={media.name}
          duration={media.duration}
          segments={segments
            .filter((s) => s.text.trim())
            .map(({ start, end, text }) => ({ start, end, text }))}
          translation={translation?.segments ?? null}
          translationName={
            translation ? languageName(translation.language, lang) : ""
          }
          onClose={() => setBurnOpen(false)}
        />
      ) : null}
      {archiveOpen && client ? (
        <ArchiveDialog
          t={t}
          lang={lang}
          client={client}
          activeId={archiveId}
          onOpen={openArchived}
          onOpenAt={async (id, time) => {
            await openArchived(id);
            setFocus({ time, nonce: Date.now() });
            if (playerOpen) seekTo(time);
          }}
          onDeleted={(id) => {
            if (id === archiveIdRef.current) resetArchive();
          }}
          onClose={() => setArchiveOpen(false)}
        />
      ) : null}

      {logsOpen ? (
        <LogsDialog t={t} initialFilter={logsOpen === "error" ? "problems" : "all"} onClose={() => setLogsOpen(null)} />
      ) : null}

      {watchOpen && client ? (
        <WatchDialog
          t={t}
          lang={lang}
          client={client}
          watch={watch}
          onWatch={setWatch}
          batch={batch}
          onBatch={setBatch}
          prefs={batchPrefs}
          onPrefs={(patch) => setBatchPrefs((p) => ({ ...p, ...patch }))}
          settingsLabel={batchSettingsLabel}
          onOpenQueue={() => {
            setWatchOpen(false);
            setBatchOpen(true);
          }}
          onClose={() => setWatchOpen(false)}
        />
      ) : null}

      {batchOpen && client ? (
        <BatchDialog
          t={t}
          lang={lang}
          client={client}
          batch={batch}
          prefs={batchPrefs}
          onPrefs={(patch) => setBatchPrefs((p) => ({ ...p, ...patch }))}
          settingsLabel={batchSettingsLabel}
          summaryReady={summaryKeyReady}
          translateReady={translateKeyReady}
          translateLabel={
            translateSettings.engine === "local"
              ? t.translateEngineLocal
              : translateSettings.engine === "llm"
                ? (llmProviders.find((p) => p.id === translateSettings.provider)
                    ?.name ?? translateSettings.provider)
                : translateSettings.engine === "deepl"
                  ? "DeepL"
                  : "Azure"
          }
          onState={setBatch}
          onStart={startBatch}
          onOpen={(id) => {
            setBatchOpen(false);
            openArchived(id);
          }}
          onClose={() => {
            setBatchOpen(false);
            setPlaylistToAdd(null);
            setPathsToAdd(null);
          }}
          initialYoutubeUrl={playlistToAdd}
          initialPaths={pathsToAdd}
          watch={watch}
          onOpenWatch={() => {
            setBatchOpen(false);
            setWatchOpen(true);
          }}
        />
      ) : null}

      {dbOpen && client && media ? (
        <DatabaseDialog
          t={t}
          lang={lang}
          client={client}
          segments={segments}
          fileName={media.name}
          filePath={media.path}
          language={
            transcriptMeta?.language ??
            job?.language ??
            (settings.language === "auto" ? "" : settings.language)
          }
          model={transcriptMeta?.model ?? job?.model ?? settings.model ?? ""}
          duration={media.duration}
          translation={translation?.segments ?? null}
          translationLanguage={translation?.language ?? ""}
          summary={summary}
          quiz={quiz}
          course={archiveCourse}
          onClose={() => setDbOpen(false)}
        />
      ) : null}
    </div>
  );
}
