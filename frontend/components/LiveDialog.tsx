"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, type BackendClient, type LiveSnapshot, type LiveStartParams } from "@/lib/api";
import { formatTimestamp } from "@/lib/format";
import { errorMessage, type Strings, type UiLang } from "@/lib/i18n";
import { CaptureError, LiveCaptureSession, listMicrophones, type LiveSource } from "@/lib/liveCapture";
import { usePersistentState } from "@/lib/useBackend";
import { AlertIcon, CheckIcon, FolderIcon, MicIcon } from "./Icons";

type Params = Omit<LiveStartParams, "title" | "course" | "source" | "save_recording" | "save_to_archive">;

interface Props {
  t: Strings;
  lang: UiLang;
  client: BackendClient;
  /** The local model and options from the transcription settings. */
  params: Params | null;
  settingsLabel: string;
  /** Open the saved transcript in the main window. */
  onOpen: (archiveId: string) => void;
  onClose: () => void;
}

type Phase = "setup" | "starting" | "running" | "finishing" | "done" | "error";

const SEND_EVERY_BLOCKS = 10; // 10 × 100 ms
const POLL_MS = 700;
const MAX_BUFFER_BLOCKS = 600; // keep up to a minute while the engine is unreachable

function defaultTitle(t: Strings): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${t.liveDefaultTitle} ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Live transcription of the microphone and/or the computer's audio. */
export function LiveDialog({ t, lang, client, params, settingsLabel, onOpen, onClose }: Props) {
  const [source, setSource] = usePersistentState<LiveSource>("live-source", "mic");
  const [micId, setMicId] = usePersistentState<string>("live-mic", "");
  const [saveRecording, setSaveRecording] = usePersistentState<boolean>("live-save-recording", true);
  const [mics, setMics] = useState<{ id: string; label: string }[]>([]);
  const [title, setTitle] = useState(() => defaultTitle(t));
  const [course, setCourse] = useState("");
  const [courses, setCourses] = useState<string[]>([]);
  const [phase, setPhase] = useState<Phase>("setup");
  const [snap, setSnap] = useState<LiveSnapshot | null>(null);
  const [segments, setSegments] = useState<LiveSnapshot["segments"]>([]);
  const [level, setLevel] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<{ text: string; detail?: string } | null>(null);
  const [orphan, setOrphan] = useState<LiveSnapshot | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [follow, setFollow] = useState(true);

  const capture = useRef<LiveCaptureSession | null>(null);
  const sessionId = useRef<string | null>(null);
  const blocks = useRef<Int16Array[]>([]);
  const sending = useRef(false);
  const startedAt = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);
  const segCount = useRef(0);

  // Microphones, courses, and a session left running (e.g. the window was reloaded).
  useEffect(() => {
    listMicrophones().then(setMics);
    client
      .archiveCourses()
      .then((c) => setCourses(c.courses.map((x) => x.course)))
      .catch(() => undefined);
    client
      .liveCurrent()
      .then((r) => r.session && setOrphan(r.session))
      .catch(() => undefined);
  }, [client]);

  const running = phase === "starting" || phase === "running" || phase === "finishing";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !running && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, running]);

  const stopCapture = useCallback(() => {
    capture.current?.stop();
    capture.current = null;
    window.desktop?.keepAwake?.(false);
  }, []);

  // Never leave the microphone open when the dialog goes away.
  useEffect(() => () => stopCapture(), [stopCapture]);

  /** Send what was captured, one request at a time, in order. */
  const flush = useCallback(
    async (all = false) => {
      const id = sessionId.current;
      if (!id || sending.current) return;
      if (!all && blocks.current.length < SEND_EVERY_BLOCKS) return;
      sending.current = true;
      try {
        while (blocks.current.length && (all || blocks.current.length >= SEND_EVERY_BLOCKS)) {
          const take = blocks.current.slice(0, 100); // at most 10 s per request
          const total = take.reduce((n, b) => n + b.length, 0);
          const pcm = new Int16Array(total);
          let o = 0;
          for (const b of take) {
            pcm.set(b, o);
            o += b.length;
          }
          await client.liveAudio(id, pcm);
          blocks.current.splice(0, take.length);
        }
      } catch (err) {
        if (err instanceof ApiError && err.code !== "backend_unreachable") {
          // The session ended on the engine's side (error / timeout): stop capturing.
          blocks.current = [];
          stopCapture();
        }
        // Unreachable: keep the audio and try again with the next block.
      } finally {
        sending.current = false;
      }
    },
    [client, stopCapture],
  );

  const start = async () => {
    if (!params?.model) {
      setError({ text: t.liveNoModel });
      return;
    }
    setError(null);
    setPhase("starting");
    setSegments([]);
    segCount.current = 0;
    blocks.current = [];
    let snapshot: LiveSnapshot;
    try {
      snapshot = await client.liveStart({
        ...params,
        title: title.trim() || defaultTitle(t),
        course: course.trim() || null,
        source,
        save_recording: saveRecording,
        save_to_archive: true,
      });
    } catch (err) {
      const e = err instanceof ApiError ? err : new ApiError("internal", String(err));
      setError({ text: e.code === "busy" ? t.liveBusy : errorMessage(lang, e.code), detail: e.detail });
      setPhase("setup");
      return;
    }
    sessionId.current = snapshot.id;
    setSnap(snapshot);
    const cap = new LiveCaptureSession();
    try {
      await cap.start({
        source,
        micDeviceId: micId || undefined,
        onBlock: (pcm, rms) => {
          blocks.current.push(pcm);
          if (blocks.current.length > MAX_BUFFER_BLOCKS) blocks.current.splice(0, blocks.current.length - MAX_BUFFER_BLOCKS);
          setLevel((prev) => Math.max(rms, prev * 0.7));
          void flush();
        },
        onEnded: () => setError({ text: t.liveSourceEnded }),
      });
    } catch (err) {
      await client.liveCancel(snapshot.id).catch(() => undefined);
      sessionId.current = null;
      const code = err instanceof CaptureError ? err.code : "capture_failed";
      const text =
        code === "mic_denied"
          ? t.liveErrMicDenied
          : code === "mic_missing"
            ? t.liveErrMicMissing
            : code === "system_unsupported"
              ? t.liveErrSystemUnsupported
              : code === "system_denied"
                ? t.liveErrSystemDenied
                : t.liveErrCapture;
      setError({ text, detail: err instanceof Error ? err.message : String(err) });
      setPhase("setup");
      return;
    }
    capture.current = cap;
    startedAt.current = Date.now();
    window.desktop?.keepAwake?.(true);
    listMicrophones().then(setMics); // names are visible now that access was given
    setPhase("running");
  };

  const stop = async () => {
    const id = sessionId.current;
    if (!id) return;
    stopCapture();
    setPhase("finishing");
    await flush(true);
    try {
      setSnap(await client.liveStop(id));
    } catch (err) {
      if (err instanceof ApiError) setError({ text: errorMessage(lang, err.code), detail: err.detail });
    }
  };

  const discard = async () => {
    if (!confirmDiscard) {
      setConfirmDiscard(true);
      setTimeout(() => setConfirmDiscard(false), 5000);
      return;
    }
    const id = sessionId.current;
    stopCapture();
    blocks.current = [];
    if (id) await client.liveCancel(id).catch(() => undefined);
    sessionId.current = null;
    setConfirmDiscard(false);
    setPhase("setup");
    setSnap(null);
    setSegments([]);
  };

  // Poll the engine for new text and the state.
  useEffect(() => {
    if (phase !== "starting" && phase !== "running" && phase !== "finishing") return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      const id = sessionId.current;
      if (id) {
        try {
          const s = await client.liveState(id, segCount.current);
          if (stopped) return;
          setSnap(s);
          if (s.segments.length) {
            segCount.current = s.segment_count;
            setSegments((prev) => [...prev, ...s.segments]);
          }
          if (s.status === "done") {
            setPhase("done");
            stopCapture();
          } else if (s.status === "error") {
            stopCapture();
            setError({ text: errorMessage(lang, s.error?.code ?? "internal"), detail: s.error?.detail });
            setPhase("error");
          } else if (s.status === "cancelled") {
            stopCapture();
            setPhase("setup");
          }
        } catch {
          /* try again */
        }
      }
      if (!stopped) timer = setTimeout(tick, POLL_MS);
    };
    tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [phase, client, lang, stopCapture]);

  // Clock and the level meter's fall-off.
  useEffect(() => {
    if (phase !== "running") return;
    const id = window.setInterval(() => {
      setElapsed((Date.now() - startedAt.current) / 1000);
      setLevel((l) => l * 0.8);
    }, 250);
    return () => window.clearInterval(id);
  }, [phase]);

  // Keep the newest line in view unless the user scrolled up.
  useEffect(() => {
    if (follow && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [segments, follow]);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (atBottom !== follow) setFollow(atBottom);
  };

  const finishOrphan = async (how: "stop" | "cancel") => {
    if (!orphan) return;
    try {
      if (how === "stop") {
        sessionId.current = orphan.id;
        segCount.current = 0;
        setSegments([]);
        setOrphan(null);
        setPhase("finishing");
        setSnap(await client.liveStop(orphan.id));
      } else {
        await client.liveCancel(orphan.id);
        setOrphan(null);
      }
    } catch (err) {
      if (err instanceof ApiError) setError({ text: errorMessage(lang, err.code), detail: err.detail });
    }
  };

  const clock = (secs: number) => {
    const s = Math.floor(secs);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const p = (n: number) => String(n).padStart(2, "0");
    return h ? `${h}:${p(m)}:${p(s % 60)}` : `${p(m)}:${p(s % 60)}`;
  };

  const backlog = snap?.backlog ?? 0;
  const status =
    phase === "starting" || snap?.status === "loading"
      ? t.liveLoading
      : phase === "finishing"
        ? t.liveFinishing
        : backlog > 4
          ? t.liveBehind.replace("{s}", String(Math.round(backlog)))
          : t.liveListening;

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && !running && onClose()}>
      <div className="modal live-modal" role="dialog" aria-modal="true" aria-labelledby="live-title">
        <header className="modal-head">
          <div>
            <h2 id="live-title">
              <MicIcon size={18} /> {t.liveTitle}
            </h2>
            <p className="hint">{t.liveHint}</p>
          </div>
          {!running ? (
            <button className="icon-btn" onClick={onClose} aria-label={t.close}>
              ✕
            </button>
          ) : null}
        </header>

        <div className="live-body">
          {orphan && phase === "setup" ? (
            <div className="notice warn live-orphan">
              <AlertIcon size={16} />
              <span>{t.liveOrphan.replace("{d}", clock(orphan.duration))}</span>
              <button className="btn btn-small btn-accent" onClick={() => finishOrphan("stop")}>
                {t.liveStopSave}
              </button>
              <button className="btn btn-small btn-subtle" onClick={() => finishOrphan("cancel")}>
                {t.liveDiscard}
              </button>
            </div>
          ) : null}

          {phase === "setup" ? (
            <div className="live-setup">
              <div className="live-sources" role="radiogroup" aria-label={t.liveSource}>
                {(["mic", "system", "both"] as LiveSource[]).map((s) => (
                  <button
                    key={s}
                    role="radio"
                    aria-checked={source === s}
                    className={`live-source${source === s ? " is-active" : ""}`}
                    onClick={() => setSource(s)}
                  >
                    <strong>{s === "mic" ? t.liveSourceMic : s === "system" ? t.liveSourceSystem : t.liveSourceBoth}</strong>
                    <span>{s === "mic" ? t.liveSourceMicHint : s === "system" ? t.liveSourceSystemHint : t.liveSourceBothHint}</span>
                  </button>
                ))}
              </div>

              {source !== "system" ? (
                <label className="live-field">
                  <span>{t.liveMic}</span>
                  <select value={micId} onChange={(e) => setMicId(e.target.value)}>
                    <option value="">{t.liveMicDefault}</option>
                    {mics
                      .filter((m) => m.id && m.id !== "default")
                      .map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.label}
                        </option>
                      ))}
                  </select>
                </label>
              ) : null}

              <div className="live-row">
                <label className="live-field">
                  <span>{t.liveName}</span>
                  <input type="text" dir="auto" value={title} maxLength={300} onChange={(e) => setTitle(e.target.value)} />
                </label>
                <label className="live-field">
                  <span>{t.liveCourse}</span>
                  <input
                    type="text"
                    dir="auto"
                    list="live-courses"
                    value={course}
                    maxLength={200}
                    placeholder={t.liveCoursePlaceholder}
                    onChange={(e) => setCourse(e.target.value)}
                  />
                  <datalist id="live-courses">
                    {courses.map((c) => (
                      <option key={c} value={c} />
                    ))}
                  </datalist>
                </label>
              </div>

              <label className="check">
                <input type="checkbox" checked={saveRecording} onChange={(e) => setSaveRecording(e.target.checked)} />
                <span>{t.liveSaveRecording}</span>
              </label>
              <p className="muted small">
                {t.batchUsing} {settingsLabel}
              </p>
              {params?.model ? null : <div className="notice error">{t.liveNoModel}</div>}
            </div>
          ) : (
            <>
              <div className={`live-status${phase === "running" ? " is-on" : ""}`} role="status">
                <span className="live-rec" aria-hidden="true" />
                <span className="live-clock" dir="ltr">
                  {clock(phase === "running" ? elapsed : (snap?.duration ?? elapsed))}
                </span>
                <span className="live-meter" aria-hidden="true">
                  <span style={{ width: `${phase === "running" ? Math.min(100, Math.round(Math.sqrt(level) * 180)) : 0}%` }} />
                </span>
                <span className="live-state">
                  {phase === "done" ? t.liveDone : phase === "error" ? t.liveFailed : status}
                  {phase === "starting" || phase === "finishing" || snap?.status === "loading" ? <span className="spinner small" /> : null}
                </span>
              </div>

              <div className="live-transcript" ref={listRef} onScroll={onScroll} aria-live="polite">
                {segments.length ? (
                  segments.map((s) => (
                    <p key={s.id} dir="auto">
                      <span className="live-time" dir="ltr">
                        {formatTimestamp(s.start)}
                      </span>{" "}
                      {s.text}
                    </p>
                  ))
                ) : (
                  <div className="live-empty">{phase === "running" ? t.liveSpeak : phase === "finishing" ? t.liveFinishing : ""}</div>
                )}
              </div>
            </>
          )}

          {error ? (
            <div className="notice error" title={error.detail}>
              <AlertIcon size={16} /> {error.text}
            </div>
          ) : null}

          {phase === "done" || (phase === "error" && snap?.archive_id) ? (
            <div className="notice ok live-saved">
              <CheckIcon size={16} />
              <div>
                <div>{snap?.archive_id ? t.liveSaved.replace("{n}", String(segments.length)) : t.liveNothing}</div>
                {snap?.recording_path ? (
                  <div className="muted small" dir="ltr" title={snap.recording_path}>
                    {snap.recording_path}
                  </div>
                ) : null}
              </div>
              {snap?.recording_path ? (
                <button className="btn btn-small btn-subtle" onClick={() => window.desktop?.showItemInFolder(snap.recording_path!)}>
                  <FolderIcon size={14} /> {t.liveShowRecording}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>

        <footer className="live-foot">
          {phase === "setup" ? (
            <>
              <button className="btn btn-subtle" onClick={onClose}>
                {t.close}
              </button>
              <button className="btn btn-accent live-start" onClick={start} disabled={!params?.model || Boolean(orphan)}>
                <MicIcon size={16} /> {t.liveStart}
              </button>
            </>
          ) : phase === "starting" || phase === "running" ? (
            <>
              <button className={`btn ${confirmDiscard ? "btn-danger" : "btn-subtle"}`} onClick={discard}>
                {confirmDiscard ? t.liveDiscardConfirm : t.liveDiscard}
              </button>
              <button className="btn btn-accent" onClick={stop} disabled={phase !== "running"}>
                <span className="live-stop-square" aria-hidden="true" /> {t.liveStopSave}
              </button>
            </>
          ) : phase === "finishing" ? (
            <span className="muted">{t.liveFinishingHint}</span>
          ) : (
            <>
              <button
                className="btn btn-subtle"
                onClick={() => {
                  setPhase("setup");
                  setSnap(null);
                  setSegments([]);
                  setError(null);
                  setTitle(defaultTitle(t));
                  sessionId.current = null;
                }}
              >
                {t.liveNew}
              </button>
              {snap?.archive_id ? (
                <button className="btn btn-accent" onClick={() => onOpen(snap.archive_id!)}>
                  {t.liveOpen}
                </button>
              ) : (
                <button className="btn btn-accent" onClick={onClose}>
                  {t.close}
                </button>
              )}
            </>
          )}
        </footer>
      </div>
    </div>
  );
}
