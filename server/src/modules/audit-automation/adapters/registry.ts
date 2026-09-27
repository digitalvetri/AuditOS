import type { InspectionResult } from '../lib/pdfInspect.js'
import { tableHeaderY } from '../lib/statementParser.js'

/**
 * BANK ADAPTER REGISTRY — the seam future format handlers plug into.
 *
 * The auditor picks the bank from a searchable list before upload
 * (AMENDMENT-02 §1-Gap2). That selection chooses the adapter here;
 * `detect()` still runs, but as VALIDATION rather than routing:
 *
 *   score >= 0.7   proceed silently
 *   score 0.3–0.7  proceed, flag the job ADAPTER_UNCERTAIN
 *   score < 0.3    block and ask the auditor to confirm or pick another
 *                  bank; if they Continue anyway the job carries every
 *                  row-flag ADAPTER_MISMATCH
 *
 * `Other / not listed` maps to the synthetic `generic` adapter — jobs
 * are flagged UNKNOWN_FORMAT and downstream confidence is capped at 0.6.
 *
 * Recognition runs on the letterhead only; rows come from the generic
 * table reader for every bank. Per-bank reading quirks, when real
 * statements show any, belong in lib/statementParser.ts's header aliases.
 */

export interface BankAdapter {
  /** Registry id — matches AaBank.key (e.g. 'hdfc-bank'). */
  id: string
  /** Human name — shown in error messages. */
  bankName: string
  /** Human hint on which statement format the adapter targets. */
  formatHint: string
  /** Score 0..1 for "this looks like a <bankName> statement". */
  detect(inspection: InspectionResult): number
  capabilities: {
    hasValueDate: boolean
    hasReference: boolean
    hasRunningBalance: boolean
  }
}

/**
 * The ten listed banks. Rows are read by the generic table reader
 * (lib/statementParser.ts) — it works from the statement's own header —
 * so an adapter's job here is recognition: does the letterhead say this
 * bank? The top of page 1 is searched for the bank's IFSC prefix and
 * name; transaction narrations (which mention other banks' IFSCs all the
 * time) are deliberately not.
 */
interface BankSign { id: string; bankName: string; ifsc: string; name: RegExp }
const BANK_SIGNS: BankSign[] = [
  { id: 'hdfc-bank', bankName: 'HDFC Bank', ifsc: 'HDFC', name: /\bhdfc\s*bank\b/i },
  { id: 'icici-bank', bankName: 'ICICI Bank', ifsc: 'ICIC', name: /\bicici\s*bank\b/i },
  { id: 'sbi', bankName: 'State Bank of India', ifsc: 'SBIN', name: /state\s*bank\s*of\s*india|\bsbi\b/i },
  { id: 'axis-bank', bankName: 'Axis Bank', ifsc: 'UTIB', name: /\baxis\s*bank\b/i },
  { id: 'kotak-mahindra', bankName: 'Kotak Mahindra Bank', ifsc: 'KKBK', name: /\bkotak\b/i },
  { id: 'indian-bank', bankName: 'Indian Bank', ifsc: 'IDIB', name: /(?<!south\s|overseas\s)\bindian\s*bank\b/i },
  { id: 'canara-bank', bankName: 'Canara Bank', ifsc: 'CNRB', name: /\bcanara\s*bank\b/i },
  { id: 'tmb', bankName: 'Tamilnad Mercantile Bank', ifsc: 'TMBL', name: /tamilnad\s*mercantile|\btmb\b/i },
  { id: 'karur-vysya', bankName: 'Karur Vysya Bank', ifsc: 'KVBL', name: /karur\s*vysya|\bkvb\b/i },
  { id: 'city-union', bankName: 'City Union Bank', ifsc: 'CIUB', name: /city\s*union\s*bank|\bcub\b/i },
]

/**
 * Letterhead text: everything on page 1 above the transaction table's
 * header (the top quarter when no header is found). Narrations below the
 * header name other banks constantly and must not count.
 */
function letterhead(inspection: InspectionResult): string {
  const p = inspection.pages[0]
  if (!p) return ''
  const top = tableHeaderY(p) ?? p.height * 0.75
  return p.items.filter((i) => i.y > top + 1).map((i) => i.str).join(' ')
}

const says = (text: string, b: BankSign) => new RegExp(`\\b${b.ifsc}0[A-Z0-9]{6}\\b`).test(text) ? 0.95 : b.name.test(text) ? 0.8 : 0

export const ADAPTERS: BankAdapter[] = BANK_SIGNS.map((b) => ({
  id: b.id,
  bankName: b.bankName,
  formatHint: 'Bank-generated statement (PDF with text, or the Excel/CSV download)',
  capabilities: { hasValueDate: true, hasReference: true, hasRunningBalance: true },
  detect(inspection) {
    const top = letterhead(inspection)
    const mine = says(top, b)
    if (mine) return mine
    // Another listed bank's letterhead and none of ours: most likely the wrong bank picked.
    if (BANK_SIGNS.some((o) => o.id !== b.id && says(top, o) >= 0.8)) return 0.1
    // No evidence either way (logo-only letterhead): let it through, flagged.
    return 0.5
  },
}))

const GENERIC_ADAPTER_ID = 'generic'

export function findAdapter(bankKey: string | undefined | null): BankAdapter | null {
  if (!bankKey) return null
  return ADAPTERS.find((a) => a.id === bankKey) ?? null
}

export type DetectionBand = 'ok' | 'uncertain' | 'mismatch' | 'no_adapter'

export interface DetectionResult {
  band: DetectionBand
  score: number
  adapterId: string | null
}

/**
 * Run the selected bank's adapter's detect() against the inspection
 * and classify into the score bands from AMENDMENT-02 §4-Prompt2-2.
 *
 * When the bank is the synthetic "generic" ("Other / not listed"), we
 * return `no_adapter` with score 0 — the caller flags the job
 * UNKNOWN_FORMAT and lets it through.
 *
 * When the adapter registry is empty (this slice, until adapters ship),
 * we return `ok` at score 0 so uploads for supported banks are not
 * blocked while the surrounding pipeline is being built. Once an
 * adapter is registered for a bank, this becomes a real gate.
 */
export function classifyDetection(bankKey: string, inspection: InspectionResult): DetectionResult {
  if (bankKey === GENERIC_ADAPTER_ID) {
    return { band: 'no_adapter', score: 0, adapterId: GENERIC_ADAPTER_ID }
  }
  const adapter = findAdapter(bankKey)
  if (!adapter) {
    // No adapter registered for this bank yet — treat as a pass-through
    // rather than a blocker while the pipeline is under construction.
    // Real adapters will change this.
    return { band: 'ok', score: 0, adapterId: null }
  }
  const score = Math.max(0, Math.min(1, adapter.detect(inspection)))
  if (score >= 0.7) return { band: 'ok', score, adapterId: adapter.id }
  if (score >= 0.3) return { band: 'uncertain', score, adapterId: adapter.id }
  return { band: 'mismatch', score, adapterId: adapter.id }
}
