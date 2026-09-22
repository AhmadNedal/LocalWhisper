export function formatTimestamp(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return [h, m, sec].map((n) => String(n).padStart(2, "0")).join(":");
}

export function formatDuration(totalSeconds: number | null | undefined, lang: "ar" | "en"): string {
  if (totalSeconds == null || !Number.isFinite(totalSeconds)) return "—";
  const s = Math.round(totalSeconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (lang === "ar") {
    const parts = [];
    if (h) parts.push(`${h} س`);
    if (h || m) parts.push(`${m} د`);
    parts.push(`${sec} ث`);
    return parts.join(" ");
  }
  const parts = [];
  if (h) parts.push(`${h}h`);
  if (h || m) parts.push(`${m}m`);
  parts.push(`${sec}s`);
  return parts.join(" ");
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function formatMegabytes(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`;
}

/** Languages written right-to-left among Whisper's languages. */
const RTL_LANGUAGES = new Set(["ar", "fa", "he", "ur", "ps", "sd", "yi", "ug"]);
export function isRtlLanguage(code: string | null | undefined): boolean {
  return !!code && RTL_LANGUAGES.has(code);
}
