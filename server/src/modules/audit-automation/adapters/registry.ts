import type { InspectionResult } from '../lib/pdfInspect.js'

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
 * This slice ships with an EMPTY adapter list. AMENDMENT-02 §7 requires
 * ten real password-protected statements from the firm before any
 * adapter is written — a test-first approach the amendment is explicit
 * about. The empty list means every upload passes the detect() step as
 * a no-op; when adapters land, they slot in without changing the route
 * or the pre-flight sequence.
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

export const ADAPTERS: BankAdapter[] = []

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
