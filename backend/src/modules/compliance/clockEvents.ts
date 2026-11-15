/**
 * Compliance-clock event hooks (POST-DELIVERY-CHANGES §A sub-PR b.2).
 *
 * The clock engine (sub-PRs a-d) is now complete; these are the bridges
 * from the firm's existing workflows to it. Each hook is:
 *
 *   - IDEMPOTENT. The ComplianceItem @@unique([clientId, formCode,
 *     periodKey]) means a second call for the same event is a no-op.
 *   - SAFE TO CALL ON EVERY MUTATION. Callers don't need to detect
 *     "first time only"; the hook detects internally.
 *   - NON-THROWING for recoverable mismatches. Hooks log and return a
 *     result object; they never fail the outer transaction.
 *
 * The functions share a tiny type so they can be swapped out for a
 * message-queue publisher later without touching the call sites.
 */
import type { PrismaClient } from '@prisma/client'
import { applyRule } from './engine.js'

export interface ClockEventResult {
  created: boolean
  skipped?: 'exempt' | 'already_exists' | 'form_missing' | 'no_anchor'
  itemId?: string
}

/**
 * Rule 10A. Fired when a client's GST registration is granted — i.e. a
 * GstProfile gains a registrationDate. The gst/routes.ts PATCH handler
 * calls this with the before/after so the hook knows whether this PATCH
 * was the moment of grant.
 *
 * Exemption model (matches the seed's appliesWhen):
 *   - TDS / TCS / suo-moto / OIDAR / NRTP registrations don't fire the clock.
 *   - Everything else does, including SEZ and casual (they still have to
 *     furnish the bank account, the firm just rarely acts for them).
 */
export async function onGstRegistrationGranted(prisma: PrismaClient, p: {
  clientId: string
  organisationId: string
  registrationDate: string | null
  registrationType: string
  assignedEmployeeId: string | null
  /** true when THIS mutation is what set registrationDate (previously null or different). */
  isNewGrant: boolean
}): Promise<ClockEventResult> {
  if (!p.isNewGrant || !p.registrationDate) return { created: false, skipped: 'no_anchor' }
  // Exemption. The seed's appliesWhen JSON is the source of truth; this
  // helper mirrors its registration_type_not_in list. Keep them aligned.
  const exempt = new Set(['non_resident', 'tds', 'tcs', 'suo_moto', 'oidar'])
  if (exempt.has(p.registrationType)) return { created: false, skipped: 'exempt' }

  const form = await prisma.complianceForm.findUnique({
    where: { code: 'GST_RULE_10A' },
    select: { name: true, offsetDays: true, internalTargetDays: true, isActive: true },
  })
  if (!form || !form.isActive) return { created: false, skipped: 'form_missing' }

  const anchor = p.registrationDate
  // periodKey mirrors POST /clocks: '<anchorYear>-<formCode>'. Matches the
  // migration (seed-compliance.ts migrateInc20aFromPartnership) convention.
  const periodKey = `${anchor.slice(0, 4)}-GST_RULE_10A`
  const existing = await prisma.complianceItem.findUnique({
    where: { clientId_formCode_periodKey: { clientId: p.clientId, formCode: 'GST_RULE_10A', periodKey } },
    select: { id: true },
  })
  if (existing) return { created: false, skipped: 'already_exists', itemId: existing.id }

  const created = await prisma.complianceItem.create({
    data: {
      organisationId: p.organisationId,
      clientId: p.clientId,
      formCode: 'GST_RULE_10A',
      periodKey,
      periodLabel: form.name,
      dueDate: applyRule(anchor, { offsetMonths: 0, dueDay: null, offsetDays: form.offsetDays }),
      anchorDate: anchor,
      internalDueDate: form.internalTargetDays != null
        ? applyRule(anchor, { offsetMonths: 0, dueDay: null, offsetDays: form.internalTargetDays })
        : null,
      assignedEmployeeId: p.assignedEmployeeId,
    },
  })
  return { created: true, itemId: created.id }
}

/**
 * INC-20A. Fired every time partnership/compliance.ts
 * `ensurePostRegistrationCompliances` runs — which is both backfill and
 * each case-completion. Mirrors new INC_20A rows into the unified engine
 * so the compliance calendar stops being blind to just-completed Private
 * Limited cases. Covers the gap between seed runs (which the one-time
 * `migrateInc20aFromPartnership` covers for historical data).
 *
 * Scoped to a single case so the hook does O(1) work; the one-time
 * seed-level migration is still the right tool for the historical table.
 */
export async function onPrivateLimitedIncorporated(prisma: PrismaClient, p: {
  caseId: string
}): Promise<ClockEventResult> {
  const row = await prisma.postRegistrationCompliance.findFirst({
    where: { caseId: p.caseId, code: 'INC_20A' },
    select: {
      clientId: true, triggerDate: true, dueDate: true, completedOn: true,
      completedBy: true, assignedEmployeeId: true, notes: true,
    },
  })
  if (!row) return { created: false, skipped: 'no_anchor' }
  const client = await prisma.client.findUnique({
    where: { id: row.clientId },
    select: { organisationId: true },
  })
  if (!client) return { created: false, skipped: 'no_anchor' }

  const form = await prisma.complianceForm.findUnique({
    where: { code: 'INC_20A' },
    select: { name: true, offsetDays: true, internalTargetDays: true, isActive: true },
  })
  if (!form || !form.isActive) return { created: false, skipped: 'form_missing' }

  const yearSource = row.triggerDate ?? row.dueDate ?? row.completedOn
  if (!yearSource) return { created: false, skipped: 'no_anchor' }
  const periodKey = `${yearSource.slice(0, 4)}-INC_20A`

  // Compute statutory + internal from the row's triggerDate when present;
  // otherwise preserve the row's own dueDate as a fallback — the firm may
  // have entered it before the trigger was known.
  const anchor = row.triggerDate ?? null
  const dueDate = anchor
    ? applyRule(anchor, { offsetMonths: 0, dueDay: null, offsetDays: form.offsetDays })
    : row.dueDate ?? applyRule(yearSource, { offsetMonths: 0, dueDay: null, offsetDays: form.offsetDays })
  const internalDueDate = anchor && form.internalTargetDays != null
    ? applyRule(anchor, { offsetMonths: 0, dueDay: null, offsetDays: form.internalTargetDays })
    : null

  const existing = await prisma.complianceItem.findUnique({
    where: { clientId_formCode_periodKey: { clientId: row.clientId, formCode: 'INC_20A', periodKey } },
    select: { id: true },
  })
  if (existing) return { created: false, skipped: 'already_exists', itemId: existing.id }

  const created = await prisma.complianceItem.create({
    data: {
      organisationId: client.organisationId,
      clientId: row.clientId,
      formCode: 'INC_20A',
      periodKey,
      periodLabel: form.name,
      dueDate,
      anchorDate: anchor,
      internalDueDate,
      status: row.completedOn ? 'filed' : 'not_started',
      filedOn: row.completedOn,
      filedBy: row.completedBy,
      assignedEmployeeId: row.assignedEmployeeId,
      notes: row.notes,
    },
  })
  return { created: true, itemId: created.id }
}
