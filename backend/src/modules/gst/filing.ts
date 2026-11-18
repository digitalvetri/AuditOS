/**
 * GST FILING — Workstation → Services → GST Filing.
 *
 * Feeds the GST engine (GstProfile → GstCompliancePeriod → GstFiling) from
 * the "GST Filing" client service, which nothing else does:
 *   - syncGstEnrolment: a client with a live GST Filing service (not on
 *     hold, completed or failed) and a GSTIN has an active GstProfile; when
 *     that service ends the profile is deactivated (past periods are kept).
 *     Profiles added by hand for clients without the service are not
 *     touched. Edits made on the profile itself win over the sync: a profile
 *     paused by a person stays paused, and the assignee only follows the
 *     service when the service's own assignee changes.
 *   - ensurePeriodJobs: one GSTR-1 and one GSTR-3B per owed period, with
 *     due dates from the CBIC rule engine, plus a portal data request.
 *   - generateGstFilingJobs: the daily run — sync, then last month for all.
 * Every function is idempotent: the unique keys on period and filing make a
 * second run a no-op, so the scheduler can tick as often as it likes.
 */
import { Prisma, type PrismaClient } from '@prisma/client'
import { istToday } from '../../lib/dates.js'
import { createRuleResolver, dueForProfile, kindsOwed, type RuleResolver } from './dueDate.js'
import { financialYearOf, writeGstAudit } from './service.js'
import { onGstRegistrationGranted } from '../compliance/clockEvents.js'
import { normaliseFilingStatus } from './validate.js'

export const GST_FILING_SERVICE_CODE = 'GST_FILING'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export const periodName = (period: string) => `${MONTHS[Number(period.slice(5, 7)) - 1]} ${period.slice(0, 4)}`

/** `YYYY-MM` of the month before the IST date `today` (YYYY-MM-DD). */
export function previousPeriod(today: string): string {
  const y = Number(today.slice(0, 4))
  const m = Number(today.slice(5, 7))
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`
}

/** A GST Filing service row in this status still generates work. */
export const SERVICE_LIVE = (status: string) => !['on_hold', 'completed', 'failed'].includes(status)

/** Clients that should be enrolled, keyed by client id → the service row that enrols them. */
async function liveGstServices(db: PrismaClient, clientId?: string) {
  const svc = await db.service.findFirst({ where: { code: GST_FILING_SERVICE_CODE, deletedAt: null } })
  const live = new Map<string, { assignedEmployeeId: string | null; gstin: string | null }>()
  if (!svc) return { live, serviceId: null as string | null }
  const rows = await db.clientService.findMany({
    where: { serviceId: svc.id, deletedAt: null, ...(clientId ? { clientId } : {}) },
    include: { client: { select: { id: true, gstin: true, status: true, deletedAt: true } } },
    orderBy: { createdAt: 'desc' },
  })
  // Per client: the newest row still running. A row on hold, completed or
  // failed has ended the service, so it enrols nobody and the jobs stop.
  for (const r of rows) {
    if (!SERVICE_LIVE(r.status) || r.client.deletedAt || r.client.status === 'inactive') continue
    if (!live.has(r.clientId)) live.set(r.clientId, { assignedEmployeeId: r.assignedEmployeeId, gstin: r.client.gstin })
  }
  return { live, serviceId: svc.id }
}

export async function syncGstEnrolment(
  db: PrismaClient, opts: { clientId?: string; userId?: string | null; frequency?: 'monthly' | 'quarterly' } = {},
): Promise<{ enrolled: number; deactivated: number }> {
  const { live, serviceId } = await liveGstServices(db, opts.clientId)
  // No live GST Filing service row: do nothing rather than deactivating everyone.
  if (!serviceId) return { enrolled: 0, deactivated: 0 }
  let enrolled = 0
  let deactivated = 0
  for (const [clientId, s] of live) {
    const gstin = s.gstin?.trim().toUpperCase() || null
    if (!gstin) continue // Needs setup: listed on the board, never enrolled
    const existing = await db.gstProfile.findUnique({ where: { clientId } })
    if (!existing) {
      await db.gstProfile.create({
        data: {
          clientId, gstin, assignedEmployeeId: s.assignedEmployeeId, syncedAssigneeId: s.assignedEmployeeId,
          filingFrequency: opts.frequency ?? 'monthly',
          active: true, createdBy: opts.userId ?? null, updatedBy: opts.userId ?? null,
        },
      })
      enrolled++
      continue
    }
    // Paused by a person on the GST client screen: stays paused.
    if (existing.pausedByUser && !existing.deletedAt) continue
    // The assignee follows the service only when the SERVICE's assignee moved
    // since the last sync; a reassignment made on the profile is kept. An
    // unassigned service never clears the profile's assignee: services are
    // added without a person, and the GST Filing page's Assign select is
    // where a profile gets one.
    const serviceMoved = existing.syncedAssigneeId !== s.assignedEmployeeId
    const assignee = serviceMoved && s.assignedEmployeeId ? s.assignedEmployeeId : existing.assignedEmployeeId
    if (!existing.active || existing.deletedAt || existing.gstin !== gstin || existing.assignedEmployeeId !== assignee || serviceMoved) {
      await db.gstProfile.update({
        where: { id: existing.id },
        data: {
          active: true, deletedAt: null, pausedByUser: false, gstin, assignedEmployeeId: assignee,
          syncedAssigneeId: s.assignedEmployeeId, updatedBy: opts.userId ?? null,
        },
      })
      if (!existing.active || existing.deletedAt || existing.gstin !== gstin || existing.assignedEmployeeId !== assignee) enrolled++
    }
  }
  // Anyone enrolled but no longer live (service removed / on hold / client inactive or GSTIN cleared).
  const stale = await db.gstProfile.findMany({
    where: { active: true, deletedAt: null, ...(opts.clientId ? { clientId: opts.clientId } : {}) },
    select: { id: true, clientId: true },
  })
  // Only profiles this sync owns — clients that have (or had) a GST Filing
  // service row. A profile added by hand (POST /api/gst/clients) for a
  // client without the service is left alone.
  const owned = new Set(
    (await db.clientService.findMany({
      where: { serviceId, clientId: { in: stale.map((p) => p.clientId) } },
      select: { clientId: true },
    })).map((r) => r.clientId),
  )
  for (const p of stale) {
    if (!owned.has(p.clientId)) continue
    const s = live.get(p.clientId)
    if (s && s.gstin?.trim()) continue
    await db.gstProfile.update({ where: { id: p.id }, data: { active: false, updatedBy: opts.userId ?? null } })
    deactivated++
  }
  return { enrolled, deactivated }
}

export async function ensurePeriodJobs(
  db: PrismaClient, gstProfileId: string, period: string, userId: string | null = null, resolver?: RuleResolver,
  today: string = istToday(),
): Promise<{ periodId: string | null; created: number }> {
  const profile = await db.gstProfile.findUnique({ where: { id: gstProfileId } })
  if (!profile || !profile.active || profile.deletedAt) return { periodId: null, created: 0 }
  const owed = kindsOwed(profile, period)
  const wanted = (['GSTR1', 'GSTR3B'] as const).filter((k) => owed.includes(k))
  if (wanted.length === 0) return { periodId: null, created: 0 }

  const financialYear = financialYearOf(period)
  const periodType = profile.filingFrequency === 'quarterly' ? 'quarterly' : 'monthly'
  const row = await db.gstCompliancePeriod.upsert({
    where: { gstProfileId_financialYear_period: { gstProfileId, financialYear, period } },
    create: {
      gstProfileId, financialYear, period, periodType,
      assignedEmployeeId: profile.assignedEmployeeId, reviewerEmployeeId: profile.reviewerEmployeeId,
      createdBy: userId, updatedBy: userId,
    },
    update: {},
  })

  const rules = resolver ?? await createRuleResolver(db)
  let created = 0
  const dues: Partial<Record<'GSTR1' | 'GSTR3B', string | null>> = {}
  for (const kind of wanted) {
    const returnType = kind === 'GSTR1' ? 'GSTR-1' : 'GSTR-3B'
    const existing = await db.gstFiling.findUnique({
      where: { gstProfileId_period_returnType: { gstProfileId, period, returnType } },
    })
    dues[kind] = existing ? existing.dueDate : dueForProfile(rules, profile, period, returnType, periodType)
    if (existing) {
      if (!existing.compliancePeriodId) {
        await db.gstFiling.update({ where: { id: existing.id }, data: { compliancePeriodId: row.id, financialYear } })
      }
      continue
    }
    try {
      await db.gstFiling.create({
        data: {
          gstProfileId, period, returnType, status: 'pending', financialYear, compliancePeriodId: row.id,
          dueDate: dues[kind],
          // GstFiling's assignee is a plain non-null column with no FK: '' is
          // its existing "unassigned" value (see POST /stages/:stage/entries).
          assignedEmployeeId: profile.assignedEmployeeId ?? '', reviewerEmployeeId: profile.reviewerEmployeeId,
          createdBy: userId, updatedBy: userId,
        },
      })
      created++
    } catch (e) {
      // A concurrent creator won the unique key: it already exists.
      if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e
    }
  }

  // No portal request once the return it feeds is already due: the data is
  // late or already in hand, and the client must not see a stale request.
  const requestDue = 'GSTR1' in dues ? dues.GSTR1 : dues.GSTR3B
  const late = !!requestDue && requestDue < today
  if (!row.dataRequestDocId && !late) {
    const category = await db.documentCategory.findFirst({ where: { code: 'gst', deletedAt: null } })
    if (category) {
      await db.$transaction(async (tx) => {
        const doc = await tx.clientDocument.create({
          data: {
            clientId: profile.clientId, categoryId: category.id, name: `GST data — ${periodName(period)}`,
            financialYear, status: 'requested', requestedAt: new Date(), createdBy: userId, updatedBy: userId,
          },
        })
        const claimed = await tx.gstCompliancePeriod.updateMany({
          where: { id: row.id, dataRequestDocId: null }, data: { dataRequestDocId: doc.id },
        })
        // Someone else claimed the slot first: discard our never-visible copy.
        if (claimed.count === 0) await tx.clientDocument.delete({ where: { id: doc.id } })
      })
    }
  }
  return { periodId: row.id, created }
}

const FILING_DONE = ['filed', 'payment_pending', 'completed']

/**
 * After the profile's filing frequency (or registration type) changed: the
 * open GSTR-1 / GSTR-3B jobs it no longer owes are withdrawn — e.g. the
 * monthly jobs of a non-quarter-end month once a client moves to QRMP — and
 * the remaining open jobs take the new frequency's due date. Filed returns
 * (or anything with an ARN) are history and are never touched. A period left
 * with no live job and no 2B record is withdrawn too, with its untouched
 * portal data request.
 */
export async function realignOpenJobs(db: PrismaClient, gstProfileId: string, userId: string | null): Promise<{ removed: number }> {
  const profile = await db.gstProfile.findUnique({ where: { id: gstProfileId } })
  if (!profile) return { removed: 0 }
  const filings = await db.gstFiling.findMany({ where: { gstProfileId, deletedAt: null, returnType: { in: ['GSTR-1', 'GSTR-3B'] } } })
  const open = filings.filter((f) => !FILING_DONE.includes(normaliseFilingStatus(f.status, f.returnType)) && !f.arn?.trim())
  const now = new Date()
  const periodType = profile.filingFrequency === 'quarterly' ? 'quarterly' : 'monthly'
  const rules = await createRuleResolver(db)
  const touched = new Set<string>()
  let removed = 0
  for (const f of open) {
    const kind = f.returnType === 'GSTR-1' ? 'GSTR1' : 'GSTR3B'
    if (!kindsOwed(profile, f.period).includes(kind)) {
      await db.gstFiling.update({ where: { id: f.id }, data: { deletedAt: now, updatedBy: userId } })
      if (f.compliancePeriodId) touched.add(f.compliancePeriodId)
      removed++
    } else {
      const due = dueForProfile(rules, profile, f.period, f.returnType, periodType)
      if (due !== f.dueDate) await db.gstFiling.update({ where: { id: f.id }, data: { dueDate: due, updatedBy: userId } })
    }
  }
  // Periods that keep an open job follow the new frequency.
  const kept = [...new Set(open.filter((f) => f.compliancePeriodId && !touched.has(f.compliancePeriodId)).map((f) => f.compliancePeriodId!))]
  if (kept.length) {
    await db.gstCompliancePeriod.updateMany({ where: { id: { in: kept }, periodType: { not: periodType } }, data: { periodType, updatedBy: userId } })
  }
  for (const periodId of touched) {
    const period = await db.gstCompliancePeriod.findUnique({ where: { id: periodId }, include: { r2b: true, filings: { where: { deletedAt: null } } } })
    if (!period || period.deletedAt || period.filings.length > 0 || period.r2b) continue
    await db.gstCompliancePeriod.update({ where: { id: period.id }, data: { deletedAt: now, updatedBy: userId } })
    if (period.dataRequestDocId) {
      const doc = await db.clientDocument.findUnique({ where: { id: period.dataRequestDocId } })
      if (doc && !doc.deletedAt && doc.status === 'requested' && doc.currentVersion === 0) {
        await db.clientDocument.update({ where: { id: doc.id }, data: { deletedAt: now } })
      }
    }
  }
  return { removed }
}
const R2B_DONE = ['downloaded', 'reconciliation_pending', 'reconciliation_in_progress', 'reconciliation_completed', 'exceptions_found']

/**
 * What the GST Filing records say about a (profile, period, return):
 *   'done'  — the GstFiling is filed / payment pending / completed, or the 2B is downloaded or reconciled;
 *   'open'  — tracked and not done;
 *   'skip'  — GSTR-2B with no 2B record: GST Filing never tracks 2B, so it is not reminded or listed;
 *   null    — nothing recorded (GSTR-1 / 3B): the caller decides as before.
 * Shared by the bell reminders and the compliance calendar.
 */
export async function filingStateLookup(db: PrismaClient, gstProfileIds: string[], periods: string[]) {
  const [filings, r2bs] = await Promise.all([
    db.gstFiling.findMany({
      where: { gstProfileId: { in: gstProfileIds }, period: { in: periods }, returnType: { in: ['GSTR-1', 'GSTR-3B'] }, deletedAt: null },
      select: { gstProfileId: true, period: true, returnType: true, status: true },
    }),
    db.gstR2BRecord.findMany({
      where: { deletedAt: null, compliancePeriod: { gstProfileId: { in: gstProfileIds }, period: { in: periods }, deletedAt: null } },
      select: { status: true, compliancePeriod: { select: { gstProfileId: true, period: true } } },
    }),
  ])
  const map = new Map<string, 'done' | 'open'>()
  for (const f of filings) {
    const kind = f.returnType === 'GSTR-1' ? 'GSTR1' : 'GSTR3B'
    map.set(`${f.gstProfileId}::${kind}::${f.period}`, FILING_DONE.includes(normaliseFilingStatus(f.status, f.returnType)) ? 'done' : 'open')
  }
  for (const r of r2bs) {
    map.set(`${r.compliancePeriod.gstProfileId}::GSTR2B::${r.compliancePeriod.period}`, R2B_DONE.includes(r.status) ? 'done' : 'open')
  }
  return (gstProfileId: string, kind: string, period: string): 'done' | 'open' | 'skip' | null =>
    map.get(`${gstProfileId}::${kind}::${period}`) ?? (kind === 'GSTR2B' ? 'skip' : null)
}

export async function generateGstFilingJobs(db: PrismaClient, today = istToday()) {
  const sync = await syncGstEnrolment(db)
  const period = previousPeriod(today)
  const profiles = await db.gstProfile.findMany({ where: { active: true, deletedAt: null }, select: { id: true } })
  let periods = 0
  let filings = 0
  const resolver = await createRuleResolver(db)
  for (const p of profiles) {
    try {
      const r = await ensurePeriodJobs(db, p.id, period, null, resolver, today)
      if (r.periodId) periods++
      filings += r.created
    } catch (e) {
      console.error('[gst-filing] profile', p.id, e instanceof Error ? e.message : e)
    }
  }
  return { ...sync, periods, filings }
}

/** After a client's service or GSTIN changed: re-sync and make sure last month exists. Best effort. */
export async function refreshClientGst(
  db: PrismaClient, clientId: string, userId: string | null, opts: { frequency?: 'monthly' | 'quarterly' } = {},
): Promise<void> {
  try {
    await syncGstEnrolment(db, { clientId, userId, frequency: opts.frequency })
    const p = await db.gstProfile.findUnique({ where: { clientId } })
    if (p?.active && !p.deletedAt) await ensurePeriodJobs(db, p.id, previousPeriod(istToday()), userId)
  } catch (e) {
    console.error('[gst-filing] refresh failed', clientId, e instanceof Error ? e.message : e)
  }
}

export async function setDataStatus(db: PrismaClient, periodId: string, received: boolean, by: string): Promise<void> {
  const before = await db.gstCompliancePeriod.findUniqueOrThrow({ where: { id: periodId } })
  const now = new Date()
  await db.gstCompliancePeriod.update({
    where: { id: periodId },
    data: received
      ? { dataStatus: 'received', dataReceivedAt: now, dataReceivedBy: by }
      : { dataStatus: 'pending', dataReceivedAt: null, dataReceivedBy: null },
  })
  // The portal request: withdrawn while the data is in hand, back on untick.
  // Only an untouched request (still requested, nothing uploaded) is withdrawn,
  // stamped with the received time so an untick restores only our own delete.
  if (before.dataRequestDocId) {
    const doc = await db.clientDocument.findUnique({ where: { id: before.dataRequestDocId } })
    if (doc && doc.status === 'requested' && doc.currentVersion === 0) {
      if (received && !doc.deletedAt) {
        await db.clientDocument.update({ where: { id: doc.id }, data: { deletedAt: now } })
      } else if (!received && doc.deletedAt && before.dataReceivedAt && doc.deletedAt.getTime() === before.dataReceivedAt.getTime()) {
        await db.clientDocument.update({ where: { id: doc.id }, data: { deletedAt: null } })
      }
    }
  }
  await writeGstAudit({
    compliancePeriodId: periodId, action: received ? 'GST_DATA_RECEIVED' : 'GST_DATA_PENDING',
    userId: by === 'portal' ? null : by, oldValue: before.dataStatus, newValue: received ? 'received' : 'pending',
    meta: by === 'portal' ? { via: 'client_portal' } : undefined,
  })
}

/** Called after any portal upload: true when it answered a GST data request. */
export async function markDataFromPortal(db: PrismaClient, clientDocumentId: string): Promise<boolean> {
  const period = await db.gstCompliancePeriod.findFirst({ where: { dataRequestDocId: clientDocumentId, deletedAt: null } })
  if (!period || period.dataStatus === 'received') return false
  await setDataStatus(db, period.id, true, 'portal')
  return true
}

/** '2026-11-11' → '11 Nov 2026' (same as the GST reminder mail). */
function humanDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
}

export function dataReminderBody(
  clientName: string, period: string, gstr1Due: string | null, portalUrl: string | null, firmName?: string | null,
): { subject: string; body: string } {
  const month = periodName(period)
  const due = gstr1Due && /^\d{4}-\d{2}-\d{2}$/.test(gstr1Due) ? humanDate(gstr1Due) : gstr1Due
  return {
    subject: `GST data for ${month} \u2014 ${clientName}`,
    body: [
      'Dear Sir/Madam,',
      '',
      `Please send your sales and purchase details for ${month} so that we can file your GST returns${due ? ` (GSTR-1 is due on ${due})` : ''}.`,
      portalUrl ? `You can upload them here: ${portalUrl}` : 'You can reply to this email with the files.',
      '',
      'Thank you.',
      ...(firmName?.trim() ? [`\u2014 ${firmName.trim()}`] : []),
    ].join('\n'),
  }
}

/**
 * A GST registration case was completed: the registration is granted. Hand
 * it over to the GST side in one go —
 *   - the GSTIN goes on the client (the caller has already refused a
 *     different GSTIN already there);
 *   - the GST profile is created, or revived and brought up to date, with the
 *     date of grant;
 *   - the client is enrolled in GST Filing when the firm has that service
 *     and the client is not already on it (then the usual enrolment runs);
 *   - the Rule 10A clock starts from the date of grant (or moves, when the
 *     date was corrected).
 * Idempotent: completing the same case again adds nothing.
 */
export async function handOverGstRegistration(db: PrismaClient, p: {
  clientId: string; gstin: string; registrationDate: string; assigneeId: string; userId: string | null
}): Promise<void> {
  const client = await db.client.findUniqueOrThrow({ where: { id: p.clientId }, select: { organisationId: true, gstin: true } })
  if (client.gstin?.trim().toUpperCase() !== p.gstin) {
    await db.client.update({ where: { id: p.clientId }, data: { gstin: p.gstin, updatedBy: p.userId } })
  }
  const existing = await db.gstProfile.findUnique({ where: { clientId: p.clientId } })
  const profile = existing
    ? await db.gstProfile.update({
        where: { id: existing.id },
        data: { gstin: p.gstin, registrationDate: p.registrationDate, registrationStatus: 'active', active: true, pausedByUser: false, deletedAt: null, updatedBy: p.userId },
      })
    : await db.gstProfile.create({
        data: {
          clientId: p.clientId, gstin: p.gstin, registrationDate: p.registrationDate, assignedEmployeeId: p.assigneeId,
          syncedAssigneeId: p.assigneeId, active: true, createdBy: p.userId, updatedBy: p.userId,
        },
      })
  await writeGstAudit({
    gstProfileId: profile.id, action: existing ? 'GST_CLIENT_UPDATED' : 'GST_CLIENT_CREATED', stage: 'client',
    userId: p.userId, meta: { via: 'gst_registration_case', gstin: p.gstin, registrationDate: p.registrationDate },
  })
  const svc = await db.service.findFirst({ where: { code: GST_FILING_SERVICE_CODE, deletedAt: null } })
  if (svc) {
    const onIt = await db.clientService.findFirst({ where: { clientId: p.clientId, serviceId: svc.id, deletedAt: null } })
    if (!onIt) {
      await db.clientService.create({
        data: { clientId: p.clientId, serviceId: svc.id, assignedEmployeeId: p.assigneeId, status: 'not_started', createdBy: p.userId, updatedBy: p.userId },
      })
    }
    await refreshClientGst(db, p.clientId, p.userId)
  }
  await onGstRegistrationGranted(db, {
    clientId: p.clientId, organisationId: client.organisationId, registrationDate: p.registrationDate,
    registrationType: profile.registrationType, assignedEmployeeId: profile.assignedEmployeeId, isNewGrant: true,
  })
}
