/**
 * Countries for the sign-up form: ISO 3166-1 alpha-2 codes (what the account
 * service stores), with names in the interface language from the browser's
 * own Intl data, so no name list has to be kept up to date here.
 */

const ALL = (
  "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ " +
  "CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR " +
  "GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP " +
  "KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ " +
  "NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ " +
  "TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS XK YE YT ZA ZM ZW"
).split(" ");

/** Arab League members, listed first. */
const ARAB = "JO SA AE EG PS SY LB IQ KW QA BH OM YE LY TN DZ MA SD MR SO DJ KM".split(" ");

export interface Country {
  code: string;
  name: string;
  flag: string;
}

export interface CountryGroups {
  arab: Country[];
  others: Country[];
}

function flag(code: string): string {
  return String.fromCodePoint(...[...code].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

function namer(lang: string): (code: string) => string {
  try {
    const names = new Intl.DisplayNames([lang], { type: "region" });
    return (code) => (code === "XK" && lang === "ar" ? "كوسوفو" : names.of(code) || code);
  } catch {
    return (code) => code;
  }
}

const cache = new Map<string, CountryGroups>();

export function countryGroups(lang: "ar" | "en"): CountryGroups {
  const hit = cache.get(lang);
  if (hit) return hit;
  const name = namer(lang);
  const collator = new Intl.Collator(lang);
  const make = (code: string): Country => ({ code, name: name(code), flag: flag(code) });
  const byName = (a: Country, b: Country) => collator.compare(a.name, b.name);
  const arabSet = new Set(ARAB);
  const groups = {
    arab: ARAB.map(make).sort(byName),
    others: ALL.filter((c) => !arabSet.has(c)).map(make).sort(byName),
  };
  cache.set(lang, groups);
  return groups;
}

export function isCountry(code: string): boolean {
  return ALL.includes(code);
}

/** A starting guess from the system language (e.g. "ar-JO" → "JO"); "" when unknown. */
export function guessCountry(): string {
  if (typeof navigator === "undefined") return "";
  for (const tag of navigator.languages || [navigator.language]) {
    try {
      const region = new Intl.Locale(tag).maximize().region;
      // A bare "ar" maximizes to Egypt, which is a guess, not a signal.
      if (region && isCountry(region) && tag.includes("-")) return region;
    } catch {
      /* ignore */
    }
  }
  return "";
}
