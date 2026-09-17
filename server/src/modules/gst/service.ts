/**
 * GST COMPLIANCE — the rules that are not CRUD.
 *
 * Financial year, due dates and overall status are all DERIVED here, on the
 * server. §20 forbids hardcoding statutory dates into frontend code and §29
 * forbids storing a hand-set overall status, so both are computed from the
 * stage rows every time they are asked for.
 */
import { prisma } from '../../lib/prisma.js'

/** India's financial year runs April → March. '2026-09' → '2026-27'. */
export function financialYearOf(period: string): string {
  const [y, m] = period.split('-')
  const year = Number(y)
  const month = Number(m.startsWith('Q') ? quarterStartMonth(m) : m)
  const start = month >= 4 ? year : year - 1
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`
}

function quarterStartMonth(q: string): number {
  return { Q1: 4, Q2: 7, Q3: 10, Q4: 1 }[q] ?? 4
}

/**
 * DUE-DATE CONFIGURATION (§20). Server-side and in one place, so a statutory
 * change is a single edit here and never a frontend release. Day-of-month
 * for the month AFTER the period closes.
 */
export const DUE_DAY: Record<string, Record<string, number>> = {
  monthly:   { 'GSTR-1': 11, 'GSTR-3B': 20, 'GSTR-2B': 14 },
  quarterly: { 'GSTR-1': 13, 'GSTR-3B': 22, 'GSTR-2B': 14 },
}

/** 'YYYY-MM' + a day → the ISO date in the FOLLOWING month. */
export function dueDateFor(period: string, returnType: string, periodType = 'monthly'): string | null {
  const day = DUE_DAY[periodType]?.[returnType]
  if (!day || !/^\d{4}-\d{2}$/.test(period)) return null
  const [y, m] = period.split('-').map(Number)
  const d = new Date(Date.UTC(y, m, day))          // m (1-based) == next month 0-based
  return d.toISOString().slice(0, 10)
}

export const today = () => new Date().toISOString().slice(0, 10)

/** Whole days from today to `date`. Negative = overdue. §30. */
export function daysRemaining(date: string | null, from = today()): number | null {
  if (!date) return null
  const ms = Date.parse(date + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')
  return Math.round(ms / 86_400_000)
}

/** The §30 wording, computed server-side so every screen agrees. */
export function dueLabel(days: number | null): string | null {
  if (days === null) return null
  if (days === 0) return 'Due today'
  if (days > 0) return `Due in ${days} day${days === 1 ? '' : 's'}`
  const n = Math.abs(days)
  return `${n} day${n === 1 ? '' : 's'} overdue`
}

/** Stage vocabularies. GSTR-2B deliberately has no `filed`. §4 */
export const GSTR1_DONE = ['filed', 'completed']
export const GSTR3B_DONE = ['filed', 'completed']
export const R2B_DONE = ['reconciliation_completed']
export const RECON_DONE = ['completed', 'completed_with_exceptions']

export interface StageView {
  gstr1: string
  gstr2b: string
  reconciliation: string
  gstr3b: string
}

/**
 * §29 overall status, derived — never stored as a user-set value.
 * exception > overdue > completed > in_progress > not_started.
 */
export function deriveOverall(
  stages: StageView,
  nextDue: string | null,
  openExceptions: number,
): 'not_started' | 'in_progress' | 'completed' | 'overdue' | 'exception' {
  const done =
    GSTR1_DONE.includes(stages.gstr1) &&
    R2B_DONE.includes(stages.gstr2b) &&
    RECON_DONE.includes(stages.reconciliation) &&
    GSTR3B_DONE.includes(stages.gstr3b)

  if (openExceptions > 0) return 'exception'
  if (done) return 'completed'

  const days = daysRemaining(nextDue)
  if (days !== null && days < 0) return 'overdue'

  const started =
    stages.gstr1 !== 'pending' || stages.gstr2b !== 'pending' ||
    stages.reconciliation !== 'pending' || stages.gstr3b !== 'pending'
  return started ? 'in_progress' : 'not_started'
}

/** The earliest unmet stage due date — what the calendar and lists sort on. */
export function nextDueOf(
  period: string,
  periodType: string,
  stages: StageView,
): string | null {
  const pending: string[] = []
  if (!GSTR1_DONE.includes(stages.gstr1)) pending.push('GSTR-1')
  if (!GSTR3B_DONE.includes(stages.gstr3b)) pending.push('GSTR-3B')
  const dates = pending
    .map((rt) => dueDateFor(period, rt, periodType))
    .filter((d): d is string => !!d)
    .sort()
  return dates[0] ?? null
}

/**
 * BACKFILL. 45 GstFiling rows predate this module and carry no period row.
 * This creates the missing GstCompliancePeriod rows from them and links them
 * up. Idempotent, and it never creates a second period for a profile+period
 * because the unique constraint is the source of truth.
 */
export async function backfillPeriods(): Promise<{ created: number; linked: number }> {
  const filings = await prisma.gstFiling.findMany({
    where: { deletedAt: null, compliancePeriodId: null },
    select: { id: true, gstProfileId: true, period: true, returnType: true, assignedEmployeeId: true },
  })

  let created = 0
  let linked = 0
  for (const f of filings) {
    if (!/^\d{4}-\d{2}$/.test(f.period)) continue
    const fy = financialYearOf(f.period)
    const profile = await prisma.gstProfile.findUnique({
      where: { id: f.gstProfileId },
      select: { filingFrequency: true, assignedEmployeeId: true, reviewerEmployeeId: true },
    })
    const periodType = profile?.filingFrequency === 'quarterly' ? 'quarterly' : 'monthly'

    const existing = await prisma.gstCompliancePeriod.findUnique({
      where: { gstProfileId_financialYear_period: { gstProfileId: f.gstProfileId, financialYear: fy, period: f.period } },
      select: { id: true },
    })
    let periodId = existing?.id
    if (!periodId) {
      const row = await prisma.gstCompliancePeriod.create({
        data: {
          gstProfileId: f.gstProfileId,
          financialYear: fy,
          period: f.period,
          periodType,
          assignedEmployeeId: profile?.assignedEmployeeId ?? f.assignedEmployeeId ?? null,
          reviewerEmployeeId: profile?.reviewerEmployeeId ?? null,
        },
        select: { id: true },
      })
      periodId = row.id
      created++
    }
    await prisma.gstFiling.update({
      where: { id: f.id },
      data: { compliancePeriodId: periodId, financialYear: fy },
    })
    linked++
  }
  return { created, linked }
}

/** Append-only audit row (§32). No update or delete path exists. */
export async function writeGstAudit(entry: {
  compliancePeriodId?: string | null
  gstProfileId?: string | null
  action: string
  stage?: string | null
  userId?: string | null
  employeeId?: string | null
  oldValue?: string | null
  newValue?: string | null
  meta?: unknown
}) {
  await prisma.gstAuditLog.create({
    data: {
      compliancePeriodId: entry.compliancePeriodId ?? null,
      gstProfileId: entry.gstProfileId ?? null,
      action: entry.action,
      stage: entry.stage ?? null,
      performedByUserId: entry.userId ?? null,
      performedByEmployeeId: entry.employeeId ?? null,
      oldValue: entry.oldValue ?? null,
      newValue: entry.newValue ?? null,
      metaJson: entry.meta === undefined ? null : JSON.stringify(entry.meta),
    },
  })
}
