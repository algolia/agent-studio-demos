/* ───────────────────────────────────────────────────────────────
   detect.js — structural identifiers in a chat message, and what a filter
   does with them. Pure: no DOM, no fetch, no clock. The page and
   tests/pii.test.js import the same bytes.

   Two families, kept apart on purpose:

   TOOLKIT    EMAIL, PHONE, CREDIT_CARD, IBAN, IP. A fresh JS port of the
              behaviour of the internal PII toolkit's Tier-1 detector: a broad
              regex per entity, then a checksum or range validator that rejects
              look-alikes (Luhn + issuer prefix for cards, per-country length +
              mod-97 for IBANs, octets 0..255 for IPs, 9..15 digits for phones).
   EXTRAS     US_SSN, ACCOUNT_NUMBER. Demo extras, NOT part of the toolkit.
              Neither has a checksum, so they are lower-precision heuristics:
              the SSN rule only knows which numbers were never issued, and the
              account rule needs a nearby keyword.
   PORT       FR_NIR, FR_TAX_ID, FR_SIREN, FR_SIRET, ES_DNI, ES_NIE. A demo port
              of identifiers the toolkit is gaining, written from the public
              rules (INSEE structure, mod 97 key, mod 511, Luhn, the DNI letter
              table), not from any library's code or test numbers. SIREN and
              SIRET pass Luhn one time in ten, so they need a keyword before
              them. Other countries' national ids are not covered yet.

   Names and postal addresses are not detected at all (the toolkit's Tier-2 is
   a no-op today). This reduces exposure; it is not a compliance guarantee.
   ─────────────────────────────────────────────────────────────── */

export const TOOLKIT_ENTITIES = ["EMAIL", "PHONE", "CREDIT_CARD", "IBAN", "IP"];
/** demo extras, not part of the toolkit */
export const EXTRA_ENTITIES = ["US_SSN", "ACCOUNT_NUMBER"];
/** demo port of identifiers the toolkit is gaining; also switched by `extras` */
export const PORT_ENTITIES = ["FR_NIR", "FR_TAX_ID", "FR_SIREN", "FR_SIRET", "ES_DNI", "ES_NIE"];
/** the port entities that fire only after a keyword */
export const GATED_ENTITIES = ["FR_SIREN", "FR_SIRET"];
export const ENTITIES = [...TOOLKIT_ENTITIES, ...EXTRA_ENTITIES, ...PORT_ENTITIES];

const digitsOf = (s) => String(s).replace(/\D/g, "");
const allDigits = (s) => s !== "" && /^\d+$/.test(s);

/* ── Toolkit validators ───────────────────────────────────────── */

/** Luhn checksum (ISO/IEC 7812-1) over a digit string */
export function luhn(digits) {
  let total = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    total += d;
    double = !double;
  }
  return total % 10 === 0;
}

/** issuer prefix + length: Luhn alone passes numbers no network issues */
function cardNetwork(d) {
  const n = d.length;
  const p2 = d.slice(0, 2);
  const p4 = d.slice(0, 4);
  if (d[0] === "4") return n === 13 || n === 16 || n === 19; // Visa
  if (p2 >= "51" && p2 <= "55" && n === 16) return true; // Mastercard
  if (p4 >= "2221" && p4 <= "2720" && n === 16) return true; // Mastercard 2-series
  if ((p2 === "34" || p2 === "37") && n === 15) return true; // Amex
  if (p4 === "6011" && (n === 16 || n === 19)) return true; // Discover
  if (p2 === "65" && (n === 16 || n === 19)) return true; // Discover
  if ((p2 === "36" || p2 === "38" || p2 === "30") && n >= 14 && n <= 19) return true; // Diners
  if (p4 >= "3528" && p4 <= "3589" && n >= 16 && n <= 19) return true; // JCB
  return false;
}

export function validCreditCard(match) {
  const d = digitsOf(match);
  return d.length >= 13 && d.length <= 19 && luhn(d) && cardNetwork(d);
}

/* IBAN length per country (ISO 13616 registry, public data). A country absent
   here falls back to the generic 15..34 bound rather than being dropped. */
const IBAN_LENGTHS = Object.fromEntries([
  "AD24 AE23 AL28 AT20 AZ28 BA20 BE16 BG22 BH22 BI27 BR29 BY28 CH21 CR22 CY28 CZ24",
  "DE22 DJ27 DK18 DO28 EE20 EG29 ES24 FI18 FK18 FO18 FR27 GB22 GE22 GI23 GL18 GR27",
  "GT28 HN28 HR21 HU28 IE22 IL23 IQ23 IS26 IT27 JO30 KW30 KZ20 LB28 LC32 LI21 LT20",
  "LU20 LV21 LY25 MC27 MD24 ME22 MK19 MN20 MR27 MT31 MU30 NI28 NL18 NO15 OM23 PK24",
  "PL28 PS29 PT25 QA29 RO24 RS22 RU33 SA24 SC31 SD18 SE24 SI19 SK24 SM27 SO23 ST25",
  "SV28 TL23 TN24 TR26 UA29 VA22 VG24 XK20 YE30",
].join(" ").split(" ").map((c) => [c.slice(0, 2), Number(c.slice(2))]));
export const IBAN_COUNTRIES = Object.keys(IBAN_LENGTHS).length;

/** per-country length, then ISO 7064 MOD 97-10 */
export function ibanMod97(match) {
  const s = String(match).replace(/ /g, "").toUpperCase();
  if (s.length < 15 || s.length > 34) return false;
  const expected = IBAN_LENGTHS[s.slice(0, 2)];
  if (expected !== undefined && s.length !== expected) return false;
  const rearranged = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of rearranged) {
    let n;
    if (ch >= "0" && ch <= "9") n = ch.charCodeAt(0) - 48;
    else if (ch >= "A" && ch <= "Z") n = ch.charCodeAt(0) - 55;
    else return false;
    rem = n > 9 ? (rem * 100 + n) % 97 : (rem * 10 + n) % 97;
  }
  return rem === 1;
}

export function ipv4Octets(match) {
  const parts = String(match).trim().split(".");
  return parts.length === 4 && parts.every((p) => allDigits(p) && Number(p) <= 255);
}

const ipv4Shaped = (s) => {
  const parts = s.trim().split(".");
  return parts.length === 4 && parts.every(allDigits);
};

/** arXiv ids (2506.12345) pass a digit count but are citations, not phones */
const arxivId = (s) => /^\d{4}\.\d{4,5}$/.test(s.trim());

/** 9..15 digits once separators go, and neither a dotted quad nor an arXiv id */
export function phoneDigits(match) {
  if (ipv4Shaped(match) || arxivId(match)) return false;
  const n = digitsOf(match).length;
  return n >= 9 && n <= 15;
}

/* ── Demo extras (not part of the toolkit) ────────────────────── */

/** ddd-dd-dddd that the SSA could have issued: area not 000/666/9xx, group not 00, serial not 0000 */
export function validSsn(match) {
  const m = /^(\d{3})-(\d{2})-(\d{4})$/.exec(match);
  if (!m) return false;
  const [, area, group, serial] = m;
  return area !== "000" && area !== "666" && area[0] !== "9" && group !== "00" && serial !== "0000";
}

/* An account keyword, then at most three words (none holding a digit) before the number. */
const ACCOUNT_KEYWORD = /\b(?:account\s*(?:number|num\.?|no\.?|#)|acct\.?(?:\s*(?:number|no\.?|#))?|a\/c)/gi;
const ACCOUNT_GAP = 3;

function accountKeywordBefore(text, start) {
  const before = text.slice(Math.max(0, start - 80), start);
  let last = null;
  for (const m of before.matchAll(ACCOUNT_KEYWORD)) last = m;
  if (!last) return false;
  const gap = before.slice(last.index + last[0].length);
  if (/\d/.test(gap)) return false;
  const words = gap.split(/[\s:#=]+/).filter(Boolean);
  return words.length <= ACCOUNT_GAP;
}

/* ── Demo port: French and Spanish identifiers ─────────────────── */

/**
 * NIR (French social security number): sex, year, month, department (2A and
 * 2B for Corsica), commune, order, then a 2-digit key = 97 - (first 13 mod 97),
 * where 2A counts as 19 and 2B as 18. Spaces between the groups are allowed.
 */
export function validNir(match) {
  const c = String(match).replace(/\s/g, "").toUpperCase();
  if (!/^[1-478]\d{4}(?:\d{2}|2[AB])\d{8}$/.test(c)) return false;
  const body = c.slice(0, 5) + c.slice(5, 7).replace("2A", "19").replace("2B", "18") + c.slice(7, 13);
  return 97 - (Number(body) % 97) === Number(c.slice(13));
}

/** French tax number (numéro fiscal): 13 digits, first 0 to 3, first 10 mod 511 = last 3 */
export function validFrTaxId(match) {
  const c = digitsOf(match);
  return /^[0-3]\d{12}$/.test(c) && Number(c.slice(0, 10)) % 511 === Number(c.slice(10));
}

/** SIREN: 9 digits, Luhn */
export const validSiren = (match) => { const c = digitsOf(match); return c.length === 9 && luhn(c); };

/** SIRET: SIREN + 5-digit NIC, Luhn on all 14; La Poste's (SIREN 356000000) use a digit sum divisible by 5 */
export function validSiret(match) {
  const c = digitsOf(match);
  if (c.length !== 14) return false;
  if (c.startsWith("356000000")) return [...c].reduce((t, d) => t + Number(d), 0) % 5 === 0;
  return luhn(c);
}

const DNI_LETTERS = "TRWAGMYFPDXBNJZSQVHLCKE";
/** DNI: 8 digits and the letter of their value mod 23; NIE: X, Y or Z (as 0, 1, 2), 7 digits, the same letter */
export function validDni(match) {
  const m = /^(\d{8})[- ]?([A-Z])$/.exec(String(match).toUpperCase());
  return Boolean(m) && DNI_LETTERS[Number(m[1]) % 23] === m[2];
}
export function validNie(match) {
  const m = /^([XYZ])-?(\d{7})[- ]?([A-Z])$/.exec(String(match).toUpperCase());
  return Boolean(m) && DNI_LETTERS[Number("XYZ".indexOf(m[1]) + m[2]) % 23] === m[3];
}

/** a keyword ending at most `gap` words (none holding a digit) before `start` */
function keywordBefore(text, start, re, gap = 3) {
  const before = text.slice(Math.max(0, start - 60), start);
  let last = null;
  for (const m of before.matchAll(re)) last = m;
  if (!last) return false;
  const rest = before.slice(last.index + last[0].length);
  return !/\d/.test(rest) && rest.split(/[\s:#=°.]+/).filter(Boolean).length <= gap;
}
const SIREN_KEYWORD = /\bsiren\b/gi;
const SIRET_KEYWORD = /\bsiret\b/gi;

/* ── Detectors ────────────────────────────────────────────────── */

/** score orders overlaps at equal span: checksum 1.0 > demo extras 0.9 > phone 0.85 */
const DETECTORS = [
  { entity: "EMAIL", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, score: 1 },
  {
    entity: "PHONE",
    re: /(?<!\d)(?:\+\d{1,3}[ .-]?)?(?:\(\d{1,4}\)[ .-]?)?\d{1,8}(?:[ .-]\d{1,8}){1,6}(?!\d)/g,
    check: phoneDigits,
    score: 0.85,
  },
  { entity: "CREDIT_CARD", re: /(?<!\d)(?:\d[ -]?){13,19}(?<=\d)/g, check: validCreditCard, score: 1 },
  { entity: "IBAN", re: /(?<![A-Z0-9])[A-Z]{2}\d{2}[A-Z0-9]{11,30}(?![A-Z0-9])/g, check: ibanMod97, score: 1 },
  { entity: "IP", re: /(?<![\d.])\d{1,3}(?:\.\d{1,3}){3}(?![\d.])/g, check: ipv4Octets, score: 1 },
  // demo extras, not part of the toolkit
  { entity: "US_SSN", re: /(?<![\d-])\d{3}-\d{2}-\d{4}(?![\d-])/g, check: validSsn, score: 0.9, extra: true },
  {
    entity: "ACCOUNT_NUMBER",
    re: /(?<![\w-])\d[\d-]{4,24}\d(?![\w-])/g,
    check: (value, text, start) => {
      const n = digitsOf(value).length;
      return n >= 6 && n <= 20 && !/--/.test(value) && accountKeywordBefore(text, start);
    },
    score: 0.9,
    extra: true,
  },
  // demo port of identifiers the toolkit is gaining
  { entity: "FR_NIR", re: /(?<![\w])[1-478] ?\d{2} ?\d{2} ?(?:\d{2}|2[ABab]) ?\d{3} ?\d{3} ?\d{2}(?![\w])/g, check: validNir, score: 0.95, extra: true },
  { entity: "FR_TAX_ID", re: /(?<![\w])[0-3]\d(?: ?\d{2} ?\d{3} ?\d{3} ?\d{3})(?![\w])/g, check: validFrTaxId, score: 0.9, extra: true },
  {
    entity: "FR_SIRET", re: /(?<![\w])\d{3} ?\d{3} ?\d{3} ?\d{5}(?![\w])/g,
    check: (v, text, start) => validSiret(v) && keywordBefore(text, start, SIRET_KEYWORD), score: 0.9, extra: true,
  },
  {
    entity: "FR_SIREN", re: /(?<![\w])\d{3} ?\d{3} ?\d{3}(?![\w])/g,
    check: (v, text, start) => validSiren(v) && keywordBefore(text, start, SIREN_KEYWORD), score: 0.9, extra: true,
  },
  { entity: "ES_DNI", re: /(?<![\w])\d{8}[- ]?[A-Za-z](?![\w])/g, check: validDni, score: 0.95, extra: true },
  { entity: "ES_NIE", re: /(?<![\w])[XYZxyz]-?\d{7}[- ]?[A-Za-z](?![\w])/g, check: validNie, score: 0.95, extra: true },
];

/** earliest start wins; then the longer span; then the higher score; overlaps dropped */
export function resolveOverlaps(findings) {
  const ordered = findings.slice().sort((a, b) =>
    a.start - b.start || (b.end - b.start) - (a.end - a.start) || b.score - a.score);
  const kept = [];
  let lastEnd = -1;
  for (const f of ordered) {
    if (f.start < lastEnd) continue;
    kept.push(f);
    lastEnd = f.end;
  }
  return kept;
}

/**
 * text → [{ entity, start, end, value, score, extra }], sorted, non-overlapping.
 * `extras: false` gives the toolkit's behaviour alone.
 */
export function detect(text, { extras = true } = {}) {
  const s = typeof text === "string" ? text : "";
  const raw = [];
  for (const d of DETECTORS) {
    if (d.extra && !extras) continue;
    d.re.lastIndex = 0;
    for (const m of s.matchAll(d.re)) {
      const value = m[0];
      if (d.check && !d.check(value, s, m.index)) continue;
      raw.push({ entity: d.entity, start: m.index, end: m.index + value.length, value, score: d.score, extra: !!d.extra });
    }
  }
  return resolveOverlaps(raw);
}

/** every finding replaced by its typed mask, right to left so offsets hold */
export function redact(text, findings) {
  let out = text;
  for (const f of findings.slice().sort((a, b) => b.start - a.start)) {
    out = out.slice(0, f.start) + `[${f.entity}]` + out.slice(f.end);
  }
  return out;
}

export const MODES = ["redact", "block"];

/**
 * What one message becomes under a mode.
 *   off     → the raw text goes to the model and to the log
 *   redact  → masks replace every finding; the cleaned text goes on
 *   block   → any finding refuses the message: nothing goes to the model,
 *             and the log keeps the masked text only
 * → { mode, findings, blocked, toModel (string | null), toLog }
 */
export function filterMessage(text, mode, opts = {}) {
  const findings = detect(text, opts);
  if (mode === "off") return { mode, findings, blocked: false, toModel: text, toLog: text };
  const masked = redact(text, findings);
  if (mode === "block" && findings.length) return { mode, findings, blocked: true, toModel: null, toLog: masked };
  return { mode, findings, blocked: false, toModel: masked, toLog: masked };
}

/** text → [{ text, entity|null }] runs, for painting highlights without innerHTML */
export function segments(text, findings) {
  const out = [];
  let at = 0;
  for (const f of findings) {
    if (f.start > at) out.push({ text: text.slice(at, f.start), entity: null });
    out.push({ text: text.slice(f.start, f.end), entity: f.entity });
    at = f.end;
  }
  if (at < text.length) out.push({ text: text.slice(at), entity: null });
  return out;
}

/** masks already in a text ([EMAIL], [US_SSN]…), as findings, for painting the filtered side */
export function maskFindings(text) {
  const re = new RegExp(`\\[(${ENTITIES.join("|")})\\]`, "g");
  return [...text.matchAll(re)].map((m) => ({
    entity: m[1], start: m.index, end: m.index + m[0].length, value: m[0], score: 1, extra: EXTRA_ENTITIES.includes(m[1]) || PORT_ENTITIES.includes(m[1]),
  }));
}
