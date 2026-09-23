"use client";

import type { Strings, UiLang } from "@/lib/i18n";
import { errorMessage } from "@/lib/i18n";
import {
  AlertIcon,
  CheckIcon,
  CodeIcon,
  DatabaseIcon,
  FileTextIcon,
  FilmIcon,
  FolderIcon,
  PdfIcon,
  SubtitleIcon,
  WordIcon,
} from "./Icons";

export type DocFormat = "pdf" | "docx" | "txt" | "json";
export type ExportFormat = DocFormat | "subtitles" | "video";

export interface ExportOptions {
  includeTimestamps: boolean;
  includeModel: boolean;
  includeSummary?: boolean;
  content?: "original" | "translation" | "both";
  subtitleFormat?: "srt" | "vtt";
  subtitleText?: "original" | "translation";
  format?: ExportFormat;
  pdfLang: UiLang;
}

interface Props {
  t: Strings;
  lang: UiLang;
  options: ExportOptions;
  onOptions: (patch: Partial<ExportOptions>) => void;
  canExport: boolean;
  generating: boolean;
  savedPath: string | null;
  error: { code: string; detail: string } | null;
  /** PDF, Word, plain text or JSON. */
  onExport: (format: DocFormat, saveAs: boolean) => void;
  onOpenDatabase: () => void;
  hasSummary?: boolean;
  hasTranslation?: boolean;
  onExportSubtitles: (which: "original" | "translation", saveAs: boolean) => void;
  /** "Video with subtitles" (only for a local video file). */
  onBurn?: (() => void) | null;
  savedLabel?: string;
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/** Tiny page previews for the two layouts. */
function LayoutGlyph({ timed }: { timed: boolean }) {
  return (
    <span className={`layout-glyph${timed ? " timed" : ""}`} aria-hidden="true">
      {timed
        ? [70, 90, 60].map((w, i) => (
            <span key={i} className="row">
              <i className="badge" />
              <i className="line" style={{ width: `${w}%` }} />
            </span>
          ))
        : [100, 100, 60, 0, 100, 75].map((w, i) => (w ? <i key={i} className="line" style={{ width: `${w}%` }} /> : <i key={i} className="gap" />))}
    </span>
  );
}

/**
 * Export: pick one format, see only its options, press one button.
 * Database insert and the output folder are secondary actions in the header.
 */
export function ExportPanel({
  t,
  lang,
  options,
  onOptions,
  canExport,
  generating,
  savedPath,
  error,
  onExport,
  onOpenDatabase,
  hasSummary,
  hasTranslation,
  onExportSubtitles,
  onBurn,
  savedLabel,
}: Props) {
  const formats: { id: ExportFormat; name: string; caption: string; icon: React.ReactNode }[] = [
    { id: "pdf", name: "PDF", caption: t.fmtPdfCap, icon: <PdfIcon size={20} /> },
    { id: "docx", name: "Word", caption: t.fmtWordCap, icon: <WordIcon size={20} /> },
    { id: "txt", name: t.exportTxt, caption: t.fmtTxtCap, icon: <FileTextIcon size={20} /> },
    { id: "json", name: "JSON", caption: t.fmtJsonCap, icon: <CodeIcon size={20} /> },
    { id: "subtitles", name: t.fmtSubtitles, caption: "SRT · VTT", icon: <SubtitleIcon size={20} /> },
    ...(onBurn ? [{ id: "video" as const, name: t.fmtVideo, caption: t.fmtVideoCap, icon: <FilmIcon size={20} /> }] : []),
  ];
  const format: ExportFormat = formats.some((f) => f.id === options.format) ? (options.format as ExportFormat) : "pdf";
  const isDoc = format === "pdf" || format === "docx" || format === "txt";
  const content = hasTranslation ? (options.content ?? "original") : "original";
  const subText = hasTranslation ? (options.subtitleText ?? "original") : "original";
  const current = formats.find((f) => f.id === format)!;

  const run = (saveAs: boolean) => {
    if (format === "subtitles") onExportSubtitles(subText, saveAs);
    else if (format === "video") onBurn?.();
    else onExport(format, saveAs);
  };

  const runLabel =
    format === "subtitles"
      ? t.exportRunSubtitles
      : format === "video"
        ? t.exportRunVideo
        : t.exportRun.replace("{format}", current.name);

  return (
    <section className="card export">
      <header className="export-head">
        <div>
          <h2 className="card-title">{t.exportTitle}</h2>
          <p className="hint">{t.exportHint}</p>
        </div>
        <div className="export-head-actions">
          <button className="btn btn-subtle btn-small" disabled={!canExport} onClick={onOpenDatabase}>
            <DatabaseIcon size={15} /> {t.dbOpen}
          </button>
          <button className="btn btn-subtle btn-small" onClick={() => window.desktop?.openOutputDir()}>
            <FolderIcon size={15} /> {t.exportFolder}
          </button>
        </div>
      </header>

      <div className="format-grid" role="radiogroup" aria-label={t.exportTitle}>
        {formats.map((f) => (
          <button
            key={f.id}
            role="radio"
            aria-checked={format === f.id}
            className={`format-tile${format === f.id ? " is-active" : ""}`}
            onClick={() => onOptions({ format: f.id })}
          >
            <span className="format-icon">{f.icon}</span>
            <span className="format-name">{f.name}</span>
            <span className="format-cap">{f.caption}</span>
          </button>
        ))}
      </div>

      <div className="export-settings">
        {isDoc ? (
          <>
            <div className="opt-row">
              <span className="opt-label">{t.optLayout}</span>
              <div className="layout-choice" role="radiogroup" aria-label={t.optLayout}>
                {([false, true] as const).map((timed) => (
                  <button
                    key={String(timed)}
                    role="radio"
                    aria-checked={options.includeTimestamps === timed}
                    className={`layout-option${options.includeTimestamps === timed ? " is-active" : ""}`}
                    onClick={() => onOptions({ includeTimestamps: timed })}
                  >
                    <LayoutGlyph timed={timed} />
                    <span>
                      <strong>{timed ? t.exportModeTimed : t.exportModeReading}</strong>
                      <small>{timed ? t.exportModeTimedHint : t.exportModeReadingHint}</small>
                    </span>
                  </button>
                ))}
              </div>
            </div>
            {hasTranslation ? (
              <div className="opt-row">
                <span className="opt-label">{t.optContent}</span>
                <div className="segmented compact" role="radiogroup" aria-label={t.optContent}>
                  {(
                    [
                      ["original", t.exportContentOriginal],
                      ["both", t.exportContentBoth],
                      ["translation", t.exportContentTranslation],
                    ] as const
                  ).map(([id, label]) => (
                    <button key={id} role="radio" aria-checked={content === id} className={content === id ? "is-active" : ""} onClick={() => onOptions({ content: id })}>
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
            <div className="opt-row">
              <span className="opt-label">{t.optInclude}</span>
              <div className="opt-checks">
                {hasSummary ? (
                  <label className="check">
                    <input type="checkbox" checked={options.includeSummary !== false} onChange={(e) => onOptions({ includeSummary: e.target.checked })} />
                    <span>{t.optSummary}</span>
                  </label>
                ) : null}
                <label className="check">
                  <input type="checkbox" checked={options.includeModel} onChange={(e) => onOptions({ includeModel: e.target.checked })} />
                  <span>{t.optModel}</span>
                </label>
              </div>
            </div>
            <div className="opt-row">
              <span className="opt-label">{t.optLabels}</span>
              <div className="segmented compact" role="radiogroup" aria-label={t.optLabels}>
                {(
                  [
                    ["ar", "العربية"],
                    ["en", "English"],
                  ] as const
                ).map(([id, label]) => (
                  <button key={id} role="radio" aria-checked={options.pdfLang === id} className={options.pdfLang === id ? "is-active" : ""} onClick={() => onOptions({ pdfLang: id })}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </>
        ) : format === "subtitles" ? (
          <>
            <div className="opt-row">
              <span className="opt-label">{t.optSubFormat}</span>
              <div className="segmented compact" role="radiogroup" aria-label={t.optSubFormat}>
                {(["srt", "vtt"] as const).map((id) => (
                  <button
                    key={id}
                    role="radio"
                    aria-checked={(options.subtitleFormat ?? "srt") === id}
                    className={(options.subtitleFormat ?? "srt") === id ? "is-active" : ""}
                    onClick={() => onOptions({ subtitleFormat: id })}
                  >
                    {id.toUpperCase()}
                  </button>
                ))}
              </div>
              <span className="muted small">{t.optSubFormatHint}</span>
            </div>
            {hasTranslation ? (
              <div className="opt-row">
                <span className="opt-label">{t.optContent}</span>
                <div className="segmented compact" role="radiogroup" aria-label={t.optContent}>
                  {(
                    [
                      ["original", t.subtitlesOriginal],
                      ["translation", t.subtitlesTranslation],
                    ] as const
                  ).map(([id, label]) => (
                    <button key={id} role="radio" aria-checked={subText === id} className={subText === id ? "is-active" : ""} onClick={() => onOptions({ subtitleText: id })}>
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </>
        ) : format === "json" ? (
          <p className="export-note">{t.exportJsonHint}</p>
        ) : (
          <p className="export-note">{t.burnHint}</p>
        )}
      </div>

      <footer className="export-foot">
        <button className="btn btn-accent export-run" disabled={!canExport || generating} onClick={() => run(false)}>
          {current.icon} {generating ? t.stage_generating_pdf + "…" : runLabel}
        </button>
        {format !== "video" ? (
          <button className="btn" disabled={!canExport || generating} onClick={() => run(true)}>
            {t.exportSaveAs}
          </button>
        ) : null}
      </footer>

      {savedPath ? (
        <div className="export-result ok" role="status">
          <CheckIcon size={16} />
          <span className="export-result-text">
            {savedLabel ?? t.pdfSaved}
            <bdi className="export-file" dir="ltr" title={savedPath}>
              {baseName(savedPath)}
            </bdi>
          </span>
          <button className="link-btn" onClick={() => window.desktop?.openPath(savedPath)}>
            {t.openPdf}
          </button>
          <button className="link-btn" onClick={() => window.desktop?.showItemInFolder(savedPath)}>
            {t.showInFolder}
          </button>
        </div>
      ) : null}
      {error ? (
        <div className="export-result error" role="alert">
          <AlertIcon size={16} />
          <span className="export-result-text">
            {errorMessage(lang, error.code)}
            {error.detail ? (
              <details>
                <summary>{t.details}</summary>
                <code dir="ltr">{error.detail}</code>
              </details>
            ) : null}
          </span>
        </div>
      ) : null}
    </section>
  );
}
