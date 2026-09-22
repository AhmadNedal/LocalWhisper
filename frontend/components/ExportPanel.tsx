"use client";

import type { Strings, UiLang } from "@/lib/i18n";
import { errorMessage } from "@/lib/i18n";
import { AlertIcon, CheckIcon, FolderIcon, PdfIcon } from "./Icons";

export interface ExportOptions {
  includeTimestamps: boolean;
  includeModel: boolean;
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
  onExport: (saveAs: boolean) => void;
}

export function ExportPanel({ t, lang, options, onOptions, canExport, generating, savedPath, error, onExport }: Props) {
  return (
    <section className="card export">
      <div className="export-options">
        <label className="check">
          <input
            type="checkbox"
            checked={options.includeTimestamps}
            onChange={(e) => onOptions({ includeTimestamps: e.target.checked })}
          />
          <span>{t.includeTimestamps}</span>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={options.includeModel}
            onChange={(e) => onOptions({ includeModel: e.target.checked })}
          />
          <span>{t.includeModel}</span>
        </label>
        <label className="inline-select">
          <span>{t.pdfLabels}</span>
          <select value={options.pdfLang} onChange={(e) => onOptions({ pdfLang: e.target.value as UiLang })}>
            <option value="ar">العربية</option>
            <option value="en">English</option>
          </select>
        </label>
      </div>

      <div className="export-actions">
        <button className="btn btn-accent" disabled={!canExport || generating} onClick={() => onExport(false)}>
          <PdfIcon size={16} /> {generating ? t.stage_generating_pdf + "…" : t.exportPdf}
        </button>
        <button className="btn" disabled={!canExport || generating} onClick={() => onExport(true)}>
          {t.exportSaveAs}
        </button>
        <button className="btn btn-subtle" onClick={() => window.desktop?.openOutputDir()}>
          <FolderIcon size={16} /> {t.openOutputFolder}
        </button>
      </div>

      {savedPath ? (
        <div className="notice ok">
          <CheckIcon size={16} />
          <div className="saved">
            <div>{t.pdfSaved}</div>
            <code dir="ltr" title={savedPath}>
              {savedPath}
            </code>
            <div className="saved-actions">
              <button className="link-btn" onClick={() => window.desktop?.openPath(savedPath)}>
                {t.openPdf}
              </button>
              <button className="link-btn" onClick={() => window.desktop?.showItemInFolder(savedPath)}>
                {t.showInFolder}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {error ? (
        <div className="notice error">
          <AlertIcon size={16} />
          <div>
            <div>{errorMessage(lang, error.code)}</div>
            {error.detail ? (
              <details>
                <summary>{t.details}</summary>
                <code dir="ltr">{error.detail}</code>
              </details>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}
