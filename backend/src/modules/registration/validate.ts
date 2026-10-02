/**
 * The `validate` step for Registration.
 *
 * Vocabularies live here so routes, serializer and seed all read the same
 * list, and an illegal status jump is a 422 rather than a silent write.
 */
import { ApiError } from '../../lib/http.js'

export const REGISTRATION_KINDS = ['tax', 'entity', 'licence', 'labour'] as const
export const PORTAL_SCOPES = ['india', 'tamil-nadu', 'none'] as const

/**
 * The life of a registration. `not_started` is the row existing before any
 * portal work; `filed` means an application is in with the department;
 * `registered` means the client holds the thing.
 */
export const REGISTRATION_STATUSES = [
  'not_started', 'in_progress', 'filed', 'registered', 'rejected', 'expired',
] as const
export type RegistrationStatus = (typeof REGISTRATION_STATUSES)[number]

/**
 * Adjacency. Forward moves only, with two exceptions that happen in real
 * life: a rejected application is re-worked (`rejected → in_progress`), and
 * an expired registration is renewed (`expired → in_progress`).
 *
 * `registered → expired` is reached by the renewal sweep as well as by hand.
 */
const NEXT: Record<RegistrationStatus, readonly RegistrationStatus[]> = {
  not_started: ['in_progress', 'filed'],
  in_progress: ['filed', 'registered', 'rejected'],
  filed:       ['registered', 'rejected', 'in_progress'],
  registered:  ['expired', 'in_progress'],
  rejected:    ['in_progress'],
  expired:     ['in_progress', 'registered'],
}

export function allowedNext(from: RegistrationStatus): readonly RegistrationStatus[] {
  return NEXT[from] ?? []
}

export function assertStatusTransition(from: RegistrationStatus, to: RegistrationStatus): void {
  if (from === to) return
  if (!NEXT[from]?.includes(to)) {
    throw ApiError.unprocessable(
      'invalid_transition',
      `A registration cannot go from ${from} to ${to}.`,
      { status: `Allowed from ${from}: ${NEXT[from]?.join(', ') || 'nothing'}.` },
    )
  }
}

/** Registering requires the thing the client actually ends up holding. */
export function assertRegisteredHasNumber(
  status: RegistrationStatus, registrationNumber: string | null | undefined,
): void {
  if (status === 'registered' && !registrationNumber) {
    throw ApiError.unprocessable(
      'number_required',
      'A registered registration needs its number.',
      { registration_number: 'Enter the number the client now holds (GSTIN, CIN, UDYAM, IEC).' },
    )
  }
}

/** 'YYYY-MM-DD' + n months, clamped to the end of the target month. */
export function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split('-').map(Number)
  const target = new Date(Date.UTC(y, m - 1 + months, 1))
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate()
  const day = String(Math.min(d, lastDay)).padStart(2, '0')
  return `${target.getUTCFullYear()}-${String(target.getUTCMonth() + 1).padStart(2, '0')}-${day}`
}
