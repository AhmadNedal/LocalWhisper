"use client";

import { useEffect, useState } from "react";
import { ApiError, type ArchiveStats, type BackendClient } from "@/lib/api";
import { errorMessage, type Strings, type UiLang } from "@/lib/i18n";
import { AlertIcon, ChartIcon, FolderIcon, GlobeIcon, SparkIcon } from "./Icons";

interface Props {
  t: Strings;
  lang: UiLang;
  client: BackendClient;
  onSelectCourse: (course: string) => void;
  onClose: () => void;
}

/** "3 h 20 m" / "3س 20د" — hours with one decimal are hard to read in Arabic. */
function hoursText(seconds: number, lang: UiLang): string {
  const total = Math.round(seconds / 60);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (lang === "ar") return h ? `${h} س ${m} د` : `${m} د`;
  return h ? `${h}h ${m}m` : `${m}m`;
}

function niceMax(value: number): number {
  if (value <= 0) return 1;
  const step = 10 ** Math.floor(Math.log10(value));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * step >= value) return m * step;
  return 10 * step;
}

export function StatsDialog({ t, lang, client, onSelectCourse, onClose }: Props) {
  const [stats, setStats] = useState<ArchiveStats | null>(null);
  const [error, setError] = useState<{ code: string; detail: string } | null>(null);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    client
      .archiveStats(12)
      .then(setStats)
      .catch((err) => setError(err instanceof ApiError ? { code: err.code, detail: err.detail } : { code: "internal", detail: String(err) }));
  }, [client]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const monthFmt = new Intl.DateTimeFormat(lang === "ar" ? "ar" : "en", { month: "short" });
  const monthLong = new Intl.DateTimeFormat(lang === "ar" ? "ar" : "en", { month: "long", year: "numeric" });
  const toDate = (key: string) => new Date(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, 1);

  const total = stats?.total;
  const maxMonth = niceMax(Math.max(0, ...(stats?.months.map((m) => m.seconds / 3600) ?? [0])));
  const maxCourse = Math.max(1, ...(stats?.courses.map((c) => c.seconds) ?? [1]));
  const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);
  const engineName = (e: string) =>
    e === "cloud" ? t.archiveEngineCloud : e === "youtube" ? t.archiveEngineYoutube : t.archiveEngineLocal;

  return (
    <div className="modal-backdrop nested" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal stats-modal" role="dialog" aria-modal="true" aria-labelledby="stats-title">
        <header className="modal-head">
          <div>
            <h2 id="stats-title">
              <ChartIcon size={18} /> {t.statsTitle}
            </h2>
            <p className="hint">{t.statsHint}</p>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label={t.close}>
            ✕
          </button>
        </header>

        <div className="modal-body stats-body">
          {error ? (
            <div className="notice error">
              <AlertIcon size={16} /> {errorMessage(lang, error.code)}
            </div>
          ) : null}
          {!stats && !error ? <div className="spinner" /> : null}
          {stats && total ? (
            total.items === 0 ? (
              <div className="empty">{t.archiveEmpty}</div>
            ) : (
              <>
                <div className="stat-tiles">
                  <div className="stat-tile">
                    <span className="stat-label">{t.statsHours}</span>
                    <span className="stat-value">{hoursText(total.seconds, lang)}</span>
                  </div>
                  <div className="stat-tile">
                    <span className="stat-label">{t.statsItems}</span>
                    <span className="stat-value">{total.items.toLocaleString(lang)}</span>
                  </div>
                  <div className="stat-tile">
                    <span className="stat-label">{t.statsCourses}</span>
                    <span className="stat-value">{total.courses.toLocaleString(lang)}</span>
                  </div>
                  <div className="stat-tile">
                    <span className="stat-label">{t.statsWords}</span>
                    <span className="stat-value">{total.words.toLocaleString(lang)}</span>
                  </div>
                </div>

                <div className="stat-coverage">
                  {(
                    [
                      [t.statsWithSummary, total.with_summary, <SparkIcon key="s" size={14} />],
                      [t.statsWithTranslation, total.with_translation, <GlobeIcon key="g" size={14} />],
                    ] as const
                  ).map(([label, n, icon]) => (
                    <div key={label} className="coverage-row">
                      <span className="coverage-label">
                        {icon} {label}
                      </span>
                      <span className="meter" role="img" aria-label={`${pct(n, total.items)}%`}>
                        <span style={{ width: `${pct(n, total.items)}%` }} />
                      </span>
                      <span className="coverage-num">
                        {n} / {total.items} · {pct(n, total.items)}%
                      </span>
                    </div>
                  ))}
                </div>

                <section className="stat-section">
                  <h3>{t.statsPerMonth}</h3>
                  <div className="month-chart" onMouseLeave={() => setHover(null)}>
                    <div className="month-axis" aria-hidden="true">
                      <span>{hoursText(maxMonth * 3600, lang)}</span>
                      <span>{hoursText((maxMonth * 3600) / 2, lang)}</span>
                      <span>0</span>
                    </div>
                    <div className="month-plot" role="list">
                      {stats.months.map((m, i) => {
                        const h = (m.seconds / 3600 / maxMonth) * 100;
                        return (
                          <div
                            key={m.month}
                            role="listitem"
                            className={`month-col${hover === i ? " is-hover" : ""}`}
                            onMouseEnter={() => setHover(i)}
                            aria-label={`${monthLong.format(toDate(m.month))}: ${hoursText(m.seconds, lang)}, ${m.items}`}
                          >
                            <div className="month-bar-wrap">
                              {m.seconds > 0 ? <div className="month-bar" style={{ height: `max(${h}%, 3px)` }} /> : null}
                            </div>
                            <span className="month-label">{monthFmt.format(toDate(m.month))}</span>
                            {hover === i ? (
                              <div className="chart-tip" role="tooltip">
                                <strong>{monthLong.format(toDate(m.month))}</strong>
                                <span>{hoursText(m.seconds, lang)}</span>
                                <span className="muted">{t.statsItemsCount.replace("{n}", String(m.items))}</span>
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </section>

                <section className="stat-section">
                  <h3>{t.statsPerCourse}</h3>
                  <table className="course-stats">
                    <thead>
                      <tr>
                        <th>{t.statsCourse}</th>
                        <th>{t.statsItems}</th>
                        <th className="bar-col">{t.statsHours}</th>
                        <th>{t.statsMissingSummary}</th>
                        <th>{t.statsMissingTranslation}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stats.courses.map((c) => (
                        <tr key={c.course || "__none"}>
                          <td>
                            {c.course ? (
                              <button className="link-btn course-link" onClick={() => onSelectCourse(c.course)}>
                                <FolderIcon size={13} /> <bdi>{c.course}</bdi>
                              </button>
                            ) : (
                              <span className="muted">{t.archiveNoCourse}</span>
                            )}
                          </td>
                          <td className="num">{c.items}</td>
                          <td className="bar-col">
                            <div className="bar-cell">
                              <span className="hbar">
                                <span style={{ width: `${Math.max(2, (c.seconds / maxCourse) * 100)}%` }} />
                              </span>
                              <span className="num">{hoursText(c.seconds, lang)}</span>
                            </div>
                          </td>
                          <td className={`num${c.items - c.with_summary ? " warn-text" : " muted"}`}>
                            {c.items - c.with_summary || "—"}
                          </td>
                          <td className={`num${c.items - c.with_translation ? "" : " muted"}`}>{c.items - c.with_translation || "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </section>

                {stats.engines.length > 1 ? (
                  <p className="muted small stat-engines">
                    {stats.engines.map((e) => `${engineName(e.engine)}: ${hoursText(e.seconds, lang)} (${e.items})`).join(" · ")}
                  </p>
                ) : null}
              </>
            )
          ) : null}
        </div>
      </div>
    </div>
  );
}
