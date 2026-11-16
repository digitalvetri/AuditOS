/**
 * GSTIN / PAN sanity checks for OCR output. OCR can misread one character
 * of an identifier at high confidence (1 ↔ I, Z ↔ 2, an extra digit), and
 * a wrong GSTIN fed into a reconciliation is worse than a blank. These
 * checks never correct anything — they only name tokens to verify by eye.
 */

const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const GSTIN_SHAPE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/
const PAN_SHAPE = /^[A-Z]{5}\d{4}[A-Z]$/

/** The GSTIN check digit (15th character), per the GSTN mod-36 scheme. */
export function gstinCheckChar(first14: string): string {
  let sum = 0
  for (let i = 0; i < 14; i++) {
    const v = CHARS.indexOf(first14[i])
    const p = v * (i % 2 === 0 ? 1 : 2)
    sum += Math.floor(p / 36) + (p % 36)
  }
  return CHARS[(36 - (sum % 36)) % 36]
}

export function isValidGstin(s: string): boolean {
  return GSTIN_SHAPE.test(s) && gstinCheckChar(s.slice(0, 14)) === s[14]
}

/**
 * Tokens that look like a GSTIN (two digits + five letters, 13–17 long) or
 * a PAN (five letters then digits, 8–12 long) but fail the shape or the
 * GSTIN check digit.
 */
export function suspectIdentifiers(text: string): string[] {
  const out = new Set<string>()
  for (const raw of text.toUpperCase().match(/[A-Z0-9]{8,17}/g) ?? []) {
    if (/^\d{2}[A-Z]{4,5}[A-Z0-9]{6,10}$/.test(raw) && raw.length >= 13) {
      if (!isValidGstin(raw)) out.add(raw)
    } else if (/^[A-Z]{3,6}\d{3,5}[A-Z]?$/.test(raw) && raw.length >= 8 && raw.length <= 12 && /[A-Z]{3}/.test(raw)) {
      if (!PAN_SHAPE.test(raw)) out.add(raw)
    }
  }
  return [...out]
}
