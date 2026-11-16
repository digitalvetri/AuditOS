/**
 * GST FILING — Workstation → Services → GST Filing.
 *
 * Feeds the GST engine (GstProfile → GstCompliancePeriod → GstFiling) from
 * the "GST Filing" client service, which nothing else does:
 *   - syncGstEnrolment: a client with a live GST Filing service and a GSTIN
 *     has an active GstProfile; anyone else's profile is deactivated (past
 *     periods are kept).
 *   - ensurePeriodJobs: one GSTR-1 and one GSTR-3B per owed period, with
 *     due dates from the CBIC rule engine, plus a portal data request.
 *   - generateGstFilingJobs: the daily run — sync, then last month for all.
 * Every function is idempotent: the unique keys on period and filing make a
 * second run a no-op, so the scheduler can tick as often as it likes.
 */
import { Prisma, type PrismaClient } from '@prisma/client'
import { istToday } from '../../lib/dates.js'
import { createRuleResolver, dueForProfile, kindsOwed, type RuleResolver } from './dueDate.js'
import { financialYearOf } from './service.js'

export const GST_FILING_SERVICE_CODE = 'GST_FILING'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export const periodName = (period: string) => `${MONTHS[Number(period.slice(5, 7)) - 1]} ${period.slice(0, 4)}`

/** `YYYY-MM` of the month before the IST date `today` (YYYY-MM-DD). */
export function previousPeriod(today: string): string {
  const y = Number(today.slice(0, 4))
  const m = Number(today.slice(5, 7))
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`
}

/** Clients that should be enrolled, keyed by client id → the service row that enrols them. */
async function liveGstServices(db: PrismaClient, clientId?: string) {
  const svc = await db.service.findFirst({ where: { code: GST_FILING_SERVICE_CODE, deletedAt: null } })
  const live = new Map<string, { assignedEmployeeId: string; gstin: string | null }>()
  if (!svc) return { live, serviceId: null as string | null }
  const rows = await db.clientService.findMany({
    where: { serviceId: svc.id, deletedAt: null, ...(clientId ? { clientId } : {}) },
    include: { client: { select: { id: true, gstin: true, status: true, deletedAt: true } } },
    orderBy: { createdAt: 'asc' },
  })
  for (const r of rows) {
    if (r.status === 'on_hold' || r.client.deletedAt || r.client.status === 'inactive') continue
    if (!live.has(r.clientId)) live.set(r.clientId, { assignedEmployeeId: r.assignedEmployeeId, gstin: r.client.gstin })
  }
  return { live, serviceId: svc.id }
}

export async function syncGstEnrolment(
  db: PrismaClient, opts: { clientId?: string; userId?: string | null } = {},
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
          clientId, gstin, assignedEmployeeId: s.assignedEmployeeId, filingFrequency: 'monthly',
          active: true, createdBy: opts.userId ?? null, updatedBy: opts.userId ?? null,
        },
      })
      enrolled++
    } else if (!existing.active || existing.deletedAt || existing.gstin !== gstin || existing.assignedEmployeeId !== s.assignedEmployeeId) {
      await db.gstProfile.update({
        where: { id: existing.id },
        data: { active: true, deletedAt: null, gstin, assignedEmployeeId: s.assignedEmployeeId, updatedBy: opts.userId ?? null },
      })
      enrolled++
    }
  }
  // Anyone enrolled but no longer live (service removed / on hold / client inactive or GSTIN cleared).
  const stale = await db.gstProfile.findMany({
    where: { active: true, deletedAt: null, ...(opts.clientId ? { clientId: opts.clientId } : {}) },
    select: { id: true, clientId: true },
  })
  for (const p of stale) {
    const s = live.get(p.clientId)
    if (s && s.gstin?.trim()) continue
    await db.gstProfile.update({ where: { id: p.id }, data: { active: false, updatedBy: opts.userId ?? null } })
    deactivated++
  }
  return { enrolled, deactivated }
}

export async function ensurePeriodJobs(
  db: PrismaClient, gstProfileId: string, period: string, userId: string | null = null, resolver?: RuleResolver,
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
  for (const kind of wanted) {
    const returnType = kind === 'GSTR1' ? 'GSTR-1' : 'GSTR-3B'
    const existing = await db.gstFiling.findUnique({
      where: { gstProfileId_period_returnType: { gstProfileId, period, returnType } },
    })
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
          dueDate: dueForProfile(rules, profile, period, returnType, periodType),
          assignedEmployeeId: profile.assignedEmployeeId, reviewerEmployeeId: profile.reviewerEmployeeId,
          createdBy: userId, updatedBy: userId,
        },
      })
      created++
    } catch (e) {
      // A concurrent creator won the unique key: it already exists.
      if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e
    }
  }

  if (!row.dataRequestDocId) {
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

export async function generateGstFilingJobs(db: PrismaClient, today = istToday()) {
  const sync = await syncGstEnrolment(db)
  const period = previousPeriod(today)
  const profiles = await db.gstProfile.findMany({ where: { active: true, deletedAt: null }, select: { id: true } })
  let periods = 0
  let filings = 0
  const resolver = await createRuleResolver(db)
  for (const p of profiles) {
    try {
      const r = await ensurePeriodJobs(db, p.id, period, null, resolver)
      if (r.periodId) periods++
      filings += r.created
    } catch (e) {
      console.error('[gst-filing] profile', p.id, e instanceof Error ? e.message : e)
    }
  }
  return { ...sync, periods, filings }
}

/** After a client's service or GSTIN changed: re-sync and make sure last month exists. Best effort. */
export async function refreshClientGst(db: PrismaClient, clientId: string, userId: string | null): Promise<void> {
  try {
    await syncGstEnrolment(db, { clientId, userId })
    const p = await db.gstProfile.findUnique({ where: { clientId } })
    if (p?.active && !p.deletedAt) await ensurePeriodJobs(db, p.id, previousPeriod(istToday()), userId)
  } catch (e) {
    console.error('[gst-filing] refresh failed', clientId, e instanceof Error ? e.message : e)
  }
}
