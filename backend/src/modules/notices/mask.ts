/**
 * Mask personal identifiers before any text leaves for an outside AI service
 * (DPDP Act 2023; ICAI confidentiality). Nothing is unmasked in the reply —
 * the draft keeps the placeholders and the practitioner fills them in.
 *
 * Order matters: emails first (they can hold digits), then GSTIN (which
 * contains a PAN), then PAN, Aadhaar and mobile numbers. Word boundaries keep
 * reference numbers such as `ZD290323001234` and comma-grouped amounts
 * (`12,34,56,789`) intact.
 */

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
/** 2-digit state code, PAN, entity, Z (usually), check character. */
const GSTIN_RE = /\b(\d{2})[A-Z]{5}\d{4}[A-Z][1-9A-Z][A-Z]([0-9A-Z])\b/gi
const PAN_RE = /\b([A-Z]{5})\d{4}([A-Z])\b/gi
/** 12 digits, first digit 2–9, optionally grouped 4-4-4 by a space or hyphen. */
const AADHAAR_RE = /(?<!\w|\d[,.])[2-9]\d{3}([ -]?)\d{4}\1(\d{4})(?!\w|[,.]\d)/g
/** Indian mobile: optional +91 / 91 / 0, then 10 digits starting 6–9 (a 5-5 split allowed). */
const MOBILE_RE = /(?<![\w+]|\d[,.])(?:\+91[ -]?|91[ -]|0)?[6-9]\d{4}[ -]?\d{5}(?!\w|[,.]\d)/g

export function maskPan(pan: string): string {
  return pan.replace(PAN_RE, (_m, head: string, tail: string) => `${head}****${tail}`)
}

export function maskPersonalData(text: string): string {
  if (!text) return text
  return text
    .replace(EMAIL_RE, '[email]')
    .replace(GSTIN_RE, (m: string, state: string) => `${state}${'*'.repeat(10)}${m.slice(-3)}`)
    .replace(PAN_RE, (_m, head: string, tail: string) => `${head}****${tail}`)
    .replace(AADHAAR_RE, (_m, _sep: string, last4: string) => `XXXX XXXX ${last4}`)
    .replace(MOBILE_RE, '[phone]')
}
