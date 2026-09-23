"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  type JobSnapshot,
  type MediaInfo,
  type ModelInfo,
  type Segment,
  type SystemInfo,
  type YoutubeCaption,
  type YoutubeInfo,
} from "@/lib/api";
import { isRtlLanguage } from "@/lib/format";
import { STRINGS, errorMessage, type UiLang } from "@/lib/i18n";
import { languageName } from "@/lib/languages";
import { useBackend, usePersistentState } from "@/lib/useBackend";
import { DatabaseDialog } from "./DatabaseDialog";
import { ExportPanel, type ExportOptions } from "./ExportPanel";
import { AlertIcon, GlobeIcon, RefreshIcon, ShieldIcon, WaveIcon } from "./Icons";
import { MediaPicker } from "./MediaPicker";
import { ProgressPanel } from "./ProgressPanel";
import { SettingsPanel, type TranscribeSettings } from "./SettingsPanel";
import { TranscriptView } from "./TranscriptView";
import { YoutubePanel } from "./YoutubePanel";

const POLL_MS = 400;

const DEFAULT_SETTINGS: TranscribeSettings = {
  model: null, // chosen from the backend's hardware-aware default on first run
  language: "ar",
  device: "auto",
  preset: "balanced",
  arabicPunctuation: true,
};

const DEFAULT_EXPORT: ExportOptions = { includeTimestamps: true, includeModel: true, pdfLang: "ar" };

type Banner = { code: string; detail: string } | null;

function toBanner(err: unknown): Banner {
  if (err instanceof ApiError) return { code: err.code, detail: err.detail };
  return { code: "internal", detail: err instanceof Error ? err.message : String(err) };
}

export function TranscriberApp() {
  const [lang, setLang] = usePersistentState<UiLang>("ui-lang", "ar");
  const [settings, setSettings] = usePersistentState<TranscribeSettings>("transcribe-settings", DEFAULT_SETTINGS);
  const [exportOptions, setExportOptions] = usePersistentState<ExportOptions>("export-options", DEFAULT_EXPORT);
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
  const [transcriptMeta, setTranscriptMeta] = useState<{ language: string; model: string } | null>(null);
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
        const [info, list] = await Promise.all([client.system(), client.models()]);
        if (cancelled) return;
        setSystem(info);
        setModels(list);
        setSettings((s) => (s.model && list.some((m) => m.id === s.model) ? s : { ...s, model: info.defaultModel }));
        if (!info.ffmpegAvailable) setBanner({ code: "ffmpeg_missing", detail: "" });
      } catch (err) {
        if (!cancelled) setBanner(toBanner(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, setSettings]);

  // Poll model list while any download is in progress.
  const anyDownloading = models.some((m) => m.download?.status === "downloading");
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
      const res = await client.youtubeSubtitles(ytInfo.url, track.lang, track.kind);
      setJob(null);
      setSegments(res.segments);
      setUsedCaption(track);
      setTranscriptMeta({ language: res.language, model: track.kind === "manual" ? t.ytModelManual : t.ytModelAuto });
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
    if (!client || !media || !settings.model) return;
    setBanner(null);
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
        model: settings.model,
        language: settings.language === "auto" ? null : settings.language,
        device: settings.device,
        preset: settings.preset,
        arabic_punctuation: settings.arabicPunctuation,
      });
      setJob(snapshot);
    } catch (err) {
      setBanner(toBanner(err));
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

  // ---- PDF export -------------------------------------------------------------
  const exportPdf = async (saveAs: boolean) => {
    if (!client || !media || !segments.length) return;
    setPdfError(null);
    setPdfPath(null);
    let outputPath: string | null = null;
    if (saveAs) {
      const base = media.name.replace(/\.[^.]+$/, "");
      outputPath = (await window.desktop?.savePdfDialog(`${base} - transcript.pdf`)) ?? null;
      if (!outputPath) return;
    }
    setPdfGenerating(true);
    const code = transcriptMeta?.language ?? job?.language ?? (settings.language === "auto" ? "" : settings.language);
    try {
      const result = await client.exportPdf({
        output_path: outputPath,
        media_name: media.name,
        language_code: code,
        language_name: languageName(code, exportOptions.pdfLang),
        model_name: exportOptions.includeModel ? (transcriptMeta?.model ?? job?.model ?? settings.model) : null,
        duration: media.duration,
        include_timestamps: exportOptions.includeTimestamps,
        ui_language: exportOptions.pdfLang,
        segments: segments.filter((s) => s.text.trim()).map(({ start, end, text }) => ({ start, end, text })),
      });
      setPdfPath(result.path);
    } catch (err) {
      setPdfError(toBanner(err));
    } finally {
      setPdfGenerating(false);
    }
  };

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
    transcriptMeta?.language ?? job?.language ?? (settings.language === "auto" ? null : settings.language);
  const transcriptRtl = transcriptLanguage ? isRtlLanguage(transcriptLanguage) : lang === "ar";

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
          <span className="pill pill-privacy">
            <ShieldIcon size={14} /> {t.privacyBadge}
          </span>
          <button className="btn btn-subtle" onClick={() => setLang(lang === "ar" ? "en" : "ar")}>
            <GlobeIcon size={16} /> {t.switchLang}
          </button>
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
          <button className="btn btn-subtle" onClick={() => setBanner(null)}>
            {t.close}
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
          />
          <ProgressPanel
            t={t}
            lang={lang}
            job={job}
            canStart={Boolean(client && media && settings.model && !running)}
            cancelling={cancelling}
            generatingPdf={pdfGenerating}
            isYoutube={Boolean(ytInfo)}
            readyNote={usedCaption ? t.ytLoaded : null}
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
          />
        </div>
        <div className="main">
          <TranscriptView t={t} segments={segments} rtl={transcriptRtl} live={running} onEdit={editSegment} />
          <ExportPanel
            t={t}
            lang={lang}
            options={exportOptions}
            onOptions={(patch) => setExportOptions((o) => ({ ...o, ...patch }))}
            canExport={Boolean(client && media && segments.length && !running)}
            generating={pdfGenerating}
            savedPath={pdfPath}
            error={pdfError}
            onExport={exportPdf}
            onOpenDatabase={() => setDbOpen(true)}
          />
        </div>
      </main>

      {dbOpen && client && media ? (
        <DatabaseDialog
          t={t}
          lang={lang}
          client={client}
          segments={segments}
          fileName={media.name}
          filePath={media.path}
          language={transcriptMeta?.language ?? job?.language ?? (settings.language === "auto" ? "" : settings.language)}
          model={transcriptMeta?.model ?? job?.model ?? settings.model ?? ""}
          duration={media.duration}
          onClose={() => setDbOpen(false)}
        />
      ) : null}
    </div>
  );
}
