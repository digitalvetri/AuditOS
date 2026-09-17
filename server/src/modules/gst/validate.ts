/**
 * GST status vocabularies and transition rules (§13 / §15 / §20).
 *
 * TWO VOCABULARIES EXIST. GstFiling predates this module and its 45 rows
 * carry the older words (not_started | documents_pending | data_preparation |
 * failed | completed). Reads normalise those to the spec's vocabulary; writes
 * only ever emit the new one. Same approach the Task module took, and for the
 * same reason: the table is shared, so rewriting history was not an option.
 */
import { ApiError } from '../../lib/http.js'

export const GSTR1_STATUSES = [
  'pending', 'data_collection', 'in_preparation', 'under_review',
  'ready_to_file', 'filed', 'rework_required',
] as const

export const GSTR3B_STATUSES = [
  'pending', 'preparation', 'under_review', 'ready_to_file',
  'filed', 'payment_pending', 'completed', 'rework_required',
] as const

/** §15 — no `filed`, ever. 2B is auto-drafted; it is processed, not filed. */
export const GSTR2B_STATUSES = [
  'pending', 'expected', 'available', 'downloaded',
  'reconciliation_pending', 'reconciliation_in_progress',
  'reconciliation_completed', 'exceptions_found',
] as const

export const PAYMENT_STATUSES = ['not_applicable', 'pending', 'completed'] as const

/** Legacy → spec vocabulary, applied on READ only. */
const LEGACY: Record<string, string> = {
  not_started: 'pending',
  documents_pending: 'data_collection',
  data_preparation: 'in_preparation',
  failed: 'rework_required',
}

export function normaliseFilingStatus(status: string, returnType: string): string {
  const mapped = LEGACY[status] ?? status
  // `completed` means different things: a finished GSTR-1 is simply filed,
  // while a GSTR-3B is only complete once payment is done.
  if (mapped === 'completed' && returnType === 'GSTR-1') return 'filed'
  return mapped
}

/**
 * Allowed moves. Deliberately permissive forwards and backwards within the
 * workflow — an auditing firm reworks returns constantly — but a status that
 * is not in the vocabulary at all is rejected, and nothing may jump straight
 * to a filed state without passing through the review gate.
 */
const GSTR1_AFTER_FILED = ['rework_required']
const GSTR3B_AFTER_FILED = ['payment_pending', 'completed', 'rework_required']

export function assertGstr1Transition(from: string, to: string) {
  assertIn(to, GSTR1_STATUSES as readonly string[], 'GSTR-1')
  const current = normaliseFilingStatus(from, 'GSTR-1')
  if (current === 'filed' && !GSTR1_AFTER_FILED.includes(to) && to !== 'filed') {
    throw ApiError.badRequest(
      'This GSTR-1 is already filed. Raise a rework first if it has to change.',
    )
  }
  if (to === 'filed' && !['under_review', 'ready_to_file', 'filed'].includes(current)) {
    throw ApiError.badRequest('A return must be reviewed and ready before it can be recorded as filed.')
  }
}

export function assertGstr3bTransition(from: string, to: string) {
  assertIn(to, GSTR3B_STATUSES as readonly string[], 'GSTR-3B')
  const current = normaliseFilingStatus(from, 'GSTR-3B')
  if (['filed', 'payment_pending', 'completed'].includes(current) &&
      !GSTR3B_AFTER_FILED.includes(to) && to !== current) {
    throw ApiError.badRequest(
      'This GSTR-3B is already filed. Record the payment, or raise a rework.',
    )
  }
  if (to === 'filed' && !['under_review', 'ready_to_file', 'filed'].includes(current)) {
    throw ApiError.badRequest('A return must be reviewed and ready before it can be recorded as filed.')
  }
  if (to === 'completed' && !['payment_pending', 'filed', 'completed'].includes(current)) {
    throw ApiError.badRequest('A GSTR-3B is only complete once it has been filed and paid.')
  }
}

export function assertGstr2bTransition(_from: string, to: string) {
  assertIn(to, GSTR2B_STATUSES as readonly string[], 'GSTR-2B')
  // Explicit belt and braces: §15 says this word must never reach the table.
  if (to === 'filed') {
    throw ApiError.badRequest('GSTR-2B is an auto-drafted statement and is never filed.')
  }
}

function assertIn(value: string, allowed: readonly string[], label: string) {
  if (!allowed.includes(value)) {
    throw ApiError.badRequest(`"${value}" is not a ${label} status.`)
  }
}

/** Filing details required before a return may be recorded as filed (§42). */
export function assertFilingRecord(arn: string | null | undefined, filedDate: string | null | undefined) {
  if (!arn || !arn.trim()) {
    throw ApiError.badRequest('An ARN is required to record a return as filed.')
  }
  if (!filedDate || !/^\d{4}-\d{2}-\d{2}$/.test(filedDate)) {
    throw ApiError.badRequest('A filing date (YYYY-MM-DD) is required.')
  }
}

/** Rupee input → integer paise. Rejects anything that is not a number. */
export function toPaise(value: unknown, field: string): bigint | null {
  if (value === null || value === undefined || value === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n < 0) throw ApiError.badRequest(`${field} must be a positive amount.`)
  return BigInt(Math.round(n * 100))
}

/** GSTIN: 2-digit state code, the holder's PAN, entity digit, 'Z', checksum. */
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/
const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/

export const REGISTRATION_TYPES = ['regular', 'composition', 'casual', 'isd', 'sez', 'non_resident'] as const
export const REGISTRATION_STATUSES = ['active', 'cancelled', 'suspended', 'not_registered'] as const
export const FILING_FREQUENCIES = ['monthly', 'quarterly'] as const

export function assertGstin(gstin: string) {
  if (!GSTIN_RE.test(gstin.toUpperCase())) {
    throw ApiError.badRequest('That is not a valid GSTIN. It is 15 characters: state code, PAN, entity digit, Z, checksum.')
  }
}

export function assertPan(pan: string) {
  if (!PAN_RE.test(pan.toUpperCase())) {
    throw ApiError.badRequest('That is not a valid PAN. It is 10 characters, e.g. AAACK1234F.')
  }
}

/**
 * The PAN inside a GSTIN is characters 3–12. When both are given they must
 * agree — a mismatch means one of them was mistyped, and every return filed
 * afterwards would carry it.
 */
export function assertGstinMatchesPan(gstin: string, pan: string) {
  if (gstin.slice(2, 12).toUpperCase() !== pan.toUpperCase()) {
    throw ApiError.badRequest('The PAN does not match the one inside the GSTIN.')
  }
}

export function assertOneOf(value: string, allowed: readonly string[], label: string) {
  if (!allowed.includes(value)) throw ApiError.badRequest(`"${value}" is not a valid ${label}.`)
}

/** 'YYYY-MM-DD' or null. */
export function assertDate(value: string | null, label: string) {
  if (value !== null && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw ApiError.badRequest(`${label} must be a date.`)
  }
}
