/**
 * Languages supported by Whisper (large-v3 adds Cantonese). Localized names are
 * produced at runtime with Intl.DisplayNames, falling back to English.
 */
export const WHISPER_LANGUAGES: Record<string, string> = {
  ar: "Arabic", en: "English", fr: "French", tr: "Turkish", fa: "Persian", ur: "Urdu",
  de: "German", es: "Spanish", it: "Italian", pt: "Portuguese", ru: "Russian", zh: "Chinese",
  ja: "Japanese", ko: "Korean", hi: "Hindi", id: "Indonesian", ms: "Malay", he: "Hebrew",
  nl: "Dutch", pl: "Polish", sv: "Swedish", uk: "Ukrainian", ca: "Catalan", vi: "Vietnamese",
  th: "Thai", el: "Greek", cs: "Czech", ro: "Romanian", da: "Danish", hu: "Hungarian",
  ta: "Tamil", no: "Norwegian", fi: "Finnish", bn: "Bengali", sw: "Swahili", so: "Somali",
  am: "Amharic", ha: "Hausa", yo: "Yoruba", ps: "Pashto", ku: "Kurdish", sd: "Sindhi",
  az: "Azerbaijani", uz: "Uzbek", kk: "Kazakh", tg: "Tajik", tk: "Turkmen", ky: "Kyrgyz",
  bg: "Bulgarian", hr: "Croatian", sr: "Serbian", sk: "Slovak", sl: "Slovenian", bs: "Bosnian",
  mk: "Macedonian", sq: "Albanian", lt: "Lithuanian", lv: "Latvian", et: "Estonian", hy: "Armenian",
  ka: "Georgian", be: "Belarusian", is: "Icelandic", ga: "Irish", cy: "Welsh", eu: "Basque",
  gl: "Galician", mt: "Maltese", lb: "Luxembourgish", fo: "Faroese", br: "Breton", oc: "Occitan",
  la: "Latin", af: "Afrikaans", te: "Telugu", kn: "Kannada", ml: "Malayalam", mr: "Marathi",
  gu: "Gujarati", pa: "Punjabi", ne: "Nepali", si: "Sinhala", as: "Assamese", my: "Myanmar",
  km: "Khmer", lo: "Lao", mn: "Mongolian", bo: "Tibetan", tl: "Tagalog", jw: "Javanese",
  su: "Sundanese", mg: "Malagasy", mi: "Maori", haw: "Hawaiian", ln: "Lingala", sn: "Shona",
  tt: "Tatar", ba: "Bashkir", sa: "Sanskrit", yi: "Yiddish", ht: "Haitian Creole", nn: "Nynorsk",
  yue: "Cantonese",
};

// Whisper uses a few legacy codes that Intl doesn't know.
const INTL_ALIASES: Record<string, string> = { jw: "jv" };

export function languageName(code: string | null | undefined, uiLang: "ar" | "en"): string {
  if (!code) return "";
  try {
    const names = new Intl.DisplayNames([uiLang], { type: "language" });
    const name = names.of(INTL_ALIASES[code] ?? code);
    if (name && name !== code) return name;
  } catch {
    /* Intl.DisplayNames unavailable */
  }
  return WHISPER_LANGUAGES[code] ?? code;
}

/** Arabic first, then English, then the rest alphabetically by localized name. */
export function languageOptions(uiLang: "ar" | "en"): { code: string; name: string }[] {
  const pinned = ["ar", "en"];
  const rest = Object.keys(WHISPER_LANGUAGES)
    .filter((c) => !pinned.includes(c))
    .map((code) => ({ code, name: languageName(code, uiLang) }))
    .sort((a, b) => a.name.localeCompare(b.name, uiLang));
  return [...pinned.map((code) => ({ code, name: languageName(code, uiLang) })), ...rest];
}
