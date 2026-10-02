/**
 * Registration domain helpers — the logic that must not live in a route.
 */
import { prisma, alive } from '../../lib/prisma.js'
import type { Session } from '../../platform/auth.js'
import { addMonths, type RegistrationStatus } from './validate.js'

/** IST calendar date. Registrations are Indian filings; UTC would roll the
    date over five and a half hours early and mis-age every renewal. */
export function today(): string {
  return new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

/** Append to the per-registration trail. Never throws into the request. */
export async function writeRegistrationEvent(
  registrationId: string, session: Session, action: string, detail?: string,
): Promise<void> {
  try {
    await prisma.registrationEvent.create({
      data: {
        registrationId,
        actorUserId: session.userId,
        actorEmployeeId: session.employeeId,
        action,
        detail: detail ?? null,
      },
    })
  } catch (err) {
    console.error('[registration] event write failed', err instanceof Error ? err.message : err)
  }
}

/**
 * When a registration becomes `registered`, its next renewal follows from the
 * type's cadence. A type with no cadence never gets a renewal date — we do
 * not invent one so the board can claim a due date it has no basis for.
 */
export function renewalFrom(
  status: RegistrationStatus, registeredOn: string | null, renewalMonths: number | null,
): string | null {
  if (status !== 'registered' || !registeredOn || !renewalMonths) return null
  return addMonths(registeredOn, renewalMonths)
}

/** Counts for the board's tiles, over whatever scope the caller can see. */
export async function overview(where: Record<string, unknown>) {
  const rows = await prisma.clientRegistration.findMany({
    where: { ...alive, ...where },
    select: { status: true, nextRenewalOn: true, typeId: true },
  })
  const t = today()
  return {
    total: rows.length,
    registered: rows.filter((r) => r.status === 'registered').length,
    in_progress: rows.filter((r) => r.status === 'in_progress' || r.status === 'filed').length,
    rejected: rows.filter((r) => r.status === 'rejected').length,
    expired: rows.filter((r) => r.status === 'expired').length,
    renewal_due: rows.filter(
      (r) => r.status === 'registered' && !!r.nextRenewalOn && r.nextRenewalOn <= t).length,
    types_covered: new Set(rows.map((r) => r.typeId)).size,
  }
}
