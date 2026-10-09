/**
 * Indian registration identifiers — one place for the patterns the forms
 * check before the server does. They match backend/src/modules/gst/validate.ts
 * (GSTIN, PAN) and the TDS routes (TAN).
 *
 * Every check expects the value already trimmed and upper-cased; use
 * `normId` on raw input first.
 */

/** 5 letters, 4 digits, 1 letter — e.g. AAACK1234F. */
export const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
/** 4 letters, 5 digits, 1 letter — e.g. CHEK09876B. */
export const TAN_RE = /^[A-Z]{4}[0-9]{5}[A-Z]$/;
/** Listed/unlisted, industry code, state, year, ownership, serial — e.g. U74999TN2020PTC123456. */
export const CIN_RE = /^[LU][0-9]{5}[A-Z]{2}[0-9]{4}[A-Z]{3}[0-9]{6}$/;
/** 3 letters, hyphen, 4 digits — e.g. AAB-1234. */
export const LLPIN_RE = /^[A-Z]{3}-[0-9]{4}$/;
/** State code, PAN, entity (1-9/A-Z), 'Z', checksum (0-9/A-Z). */
export const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

export const normId = (s: string | null | undefined): string => (s ?? '').trim().toUpperCase();

export const isPan = (s: string): boolean => PAN_RE.test(s);
export const isTan = (s: string): boolean => TAN_RE.test(s);
export const isCin = (s: string): boolean => CIN_RE.test(s);
export const isLlpin = (s: string): boolean => LLPIN_RE.test(s);

const GSTIN_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** GSTN's mod-36 check character for the first 14 characters. */
export function gstinCheckChar(first14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = GSTIN_CHARS.indexOf(first14[i]) * (i % 2 ? 2 : 1);
    sum += Math.floor(v / 36) + (v % 36);
  }
  return GSTIN_CHARS[(36 - (sum % 36)) % 36];
}

/** Right shape AND the right check character. */
export function isGstin(s: string): boolean {
  return GSTIN_RE.test(s) && gstinCheckChar(s.slice(0, 14)) === s[14];
}

/** The PAN inside a GSTIN (characters 3–12). */
export const panOfGstin = (gstin: string): string => gstin.slice(2, 12);

/** True when either is blank, or the GSTIN carries this PAN. */
export function gstinMatchesPan(gstin: string, pan: string): boolean {
  if (!gstin || !pan) return true;
  return panOfGstin(gstin) === pan;
}

/**
 * The message to show for a GSTIN, or null when it is fine. `pan` (optional)
 * is cross-checked against characters 3–12.
 */
export function gstinError(gstin: string, pan?: string): string | null {
  if (!GSTIN_RE.test(gstin)) return 'Enter a valid 15-character GSTIN (state code, PAN, entity, Z, check character).';
  if (gstinCheckChar(gstin.slice(0, 14)) !== gstin[14]) return 'This GSTIN’s check character is wrong — one of the characters is mistyped.';
  if (pan && PAN_RE.test(pan) && !gstinMatchesPan(gstin, pan)) return 'The PAN inside this GSTIN (characters 3–12) does not match the PAN.';
  return null;
}
