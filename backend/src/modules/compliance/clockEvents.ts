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
  skipped?: 'exempt' | 'already_exists' | 'form_missing' | 'no_anchor' | 'client_inactive'
  itemId?: string
}

/**
 * Client is inactive (POST-DELIVERY-CHANGES §B3) → no new clocks. Guards
 * the auto-create hooks so a straggler event (e.g. a delayed GST registration
 * for a client the firm has already parted ways with) never resurrects a
 * client into the firm's active workload.
 */
async function isClientInactive(prisma: PrismaClient, clientId: string): Promise<boolean> {
  const c = await prisma.client.findUnique({ where: { id: clientId }, select: { status: true, deletedAt: true } })
  if (!c) return true
  if (c.deletedAt) return true
  return c.status === 'inactive'
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
  // POST-DELIVERY-CHANGES §B3 — inactive or deleted clients don't accept new clocks.
  if (await isClientInactive(prisma, p.clientId)) return { created: false, skipped: 'client_inactive' }
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
    select: { organisationId: true, status: true, deletedAt: true },
  })
  if (!client || client.deletedAt) return { created: false, skipped: 'no_anchor' }
  // POST-DELIVERY-CHANGES §B3 — inactive clients don't get new clocks.
  if (client.status === 'inactive') return { created: false, skipped: 'client_inactive' }

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

/**
 * INC-20A WRITE-THROUGH (POST-DELIVERY-CHANGES §A — PostRegistrationCompliance
 * follow-up). Partnership keeps writing to its per-case tracker today; this
 * helper mirrors the latest state to the unified ComplianceItem so the two
 * tables don't drift on edits. Create path uses onPrivateLimitedIncorporated
 * (above); this UPDATE path syncs fields the partnership UI can move:
 *
 *   triggerDate / dueDate   → anchorDate / dueDate (plus internalDueDate
 *                             recomputed from the form's internalTargetDays)
 *   completedOn / completedBy → status (filed / not_started) + filedOn + filedBy
 *   assignedEmployeeId       → assignedEmployeeId
 *   notes                    → notes
 *
 * Deliberately NOT mirrored: evidenceRef / evidenceDocId. Those live on the
 * unified engine; the partnership UI doesn't read or write them, and the
 * firm's "mark completed" on the old UI predates the evidence gate — the
 * seed-level migration captured whatever historical data existed.
 *
 * Idempotent: a re-run with the same PostRegistrationCompliance state leaves
 * ComplianceItem identical (Prisma update is a no-op when every value matches).
 * If the ComplianceItem doesn't yet exist (edit on a row that predates
 * onPrivateLimitedIncorporated firing), delegate to the create path.
 *
 * Only runs when the row's code is INC_20A. ADTC and LLP_FORM_3_INITIAL stay
 * entirely on the partnership path (not in §A scope).
 */
export async function syncPrivateLimitedCompliance(prisma: PrismaClient, p: {
  rowId: string
}): Promise<ClockEventResult> {
  const row = await prisma.postRegistrationCompliance.findUnique({
    where: { id: p.rowId },
    select: {
      code: true, clientId: true, triggerDate: true, dueDate: true,
      completedOn: true, completedBy: true, assignedEmployeeId: true, notes: true,
    },
  })
  if (!row || row.code !== 'INC_20A') return { created: false, skipped: 'no_anchor' }
  const client = await prisma.client.findUnique({
    where: { id: row.clientId },
    select: { organisationId: true, status: true, deletedAt: true },
  })
  if (!client || client.deletedAt) return { created: false, skipped: 'no_anchor' }
  if (client.status === 'inactive') return { created: false, skipped: 'client_inactive' }

  const form = await prisma.complianceForm.findUnique({
    where: { code: 'INC_20A' },
    select: { offsetDays: true, internalTargetDays: true, isActive: true },
  })
  if (!form || !form.isActive) return { created: false, skipped: 'form_missing' }

  const yearSource = row.triggerDate ?? row.dueDate ?? row.completedOn
  if (!yearSource) return { created: false, skipped: 'no_anchor' }
  const periodKey = `${yearSource.slice(0, 4)}-INC_20A`
  const anchor = row.triggerDate ?? null
  const dueDate = anchor
    ? applyRule(anchor, { offsetMonths: 0, dueDay: null, offsetDays: form.offsetDays })
    : row.dueDate ?? applyRule(yearSource, { offsetMonths: 0, dueDay: null, offsetDays: form.offsetDays })
  const internalDueDate = anchor && form.internalTargetDays != null
    ? applyRule(anchor, { offsetMonths: 0, dueDay: null, offsetDays: form.internalTargetDays })
    : null

  const existing = await prisma.complianceItem.findUnique({
    where: { clientId_formCode_periodKey: { clientId: row.clientId, formCode: 'INC_20A', periodKey } },
    select: { id: true, status: true },
  })
  // The partnership row is the authority; the mirror follows. If the mirror
  // is missing (an edit on a row from before onPrivateLimitedIncorporated
  // existed) fall back to create via findFirst-by-caseId.
  if (!existing) {
    // Need the caseId to reuse the create path. The row carries it.
    const withCase = await prisma.postRegistrationCompliance.findUnique({
      where: { id: p.rowId }, select: { caseId: true },
    })
    if (!withCase) return { created: false, skipped: 'no_anchor' }
    return onPrivateLimitedIncorporated(prisma, { caseId: withCase.caseId })
  }

  await prisma.complianceItem.update({
    where: { id: existing.id },
    data: {
      anchorDate: anchor,
      dueDate,
      internalDueDate,
      status: row.completedOn ? 'filed' : (existing.status === 'filed' ? 'not_started' : existing.status),
      filedOn: row.completedOn,
      filedBy: row.completedBy,
      assignedEmployeeId: row.assignedEmployeeId,
      notes: row.notes,
    },
  })
  return { created: false, itemId: existing.id }
}
