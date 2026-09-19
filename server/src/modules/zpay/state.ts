/**
 * Connection state machine for the Zoho Payments integration.
 *
 * `ZpayConnection.status` is the single source of truth for whether a
 * connection can be used against Zoho. Every write to that column must
 * go through `assertTransition` so an illegal move is a caught error at
 * the boundary, not silent corruption in the database.
 *
 * The states, and what triggers each:
 *
 *   not_connected     initial row, no consent yet
 *   consent_pending   authorization URL sent to Zoho, waiting on callback
 *   connected         refresh token in hand, sync may run
 *   expired           refresh flow rotated and failed at rotation
 *   revoked           refresh token invalid — user revoked in Zoho console
 *                     (docs §3: STOP RETRYING; user must re-consent)
 *   error             transient failure (rate limit, 5xx, network) captured
 *                     on the connection so the ops screen surfaces it
 *
 * Edges live below in NEXT. Notable non-edges:
 *
 *   revoked → connected   forbidden: the refresh token is gone. Recovery
 *                         is re-consent, i.e. revoked → consent_pending.
 *   connected → not_connected  forbidden: disconnect goes through error
 *                              or revoked so an audit record exists.
 */

export const ZPAY_STATUSES = [
  'not_connected',
  'consent_pending',
  'connected',
  'revoked',
  'expired',
  'error',
] as const

export type ZpayStatus = (typeof ZPAY_STATUSES)[number]

const NEXT: Record<ZpayStatus, readonly ZpayStatus[]> = {
  not_connected: ['consent_pending'],
  consent_pending: ['connected', 'error', 'not_connected'],
  connected: ['expired', 'revoked', 'error'],
  expired: ['consent_pending'],
  revoked: ['consent_pending'],
  error: ['consent_pending', 'connected'],
}

export function allowedNext(from: ZpayStatus): readonly ZpayStatus[] {
  return NEXT[from]
}

export function canTransition(from: ZpayStatus, to: ZpayStatus): boolean {
  return NEXT[from].includes(to)
}

export class ZpayIllegalTransition extends Error {
  constructor(
    public readonly from: ZpayStatus,
    public readonly to: ZpayStatus,
  ) {
    super(`Illegal Zoho Payments connection transition: ${from} → ${to}`)
    this.name = 'ZpayIllegalTransition'
  }
}

export function assertTransition(from: ZpayStatus, to: ZpayStatus): void {
  if (!canTransition(from, to)) {
    throw new ZpayIllegalTransition(from, to)
  }
}

export function isZpayStatus(value: unknown): value is ZpayStatus {
  return typeof value === 'string' && (ZPAY_STATUSES as readonly string[]).includes(value)
}
