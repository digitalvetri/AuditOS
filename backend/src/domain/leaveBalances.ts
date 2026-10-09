import type { Prisma } from '@prisma/client'
import { prisma } from '../lib/prisma.js'
import { fiscalYearStartOf, nextFiscalYearStart } from '../lib/dates.js'

type Db = Prisma.TransactionClient | typeof prisma

/**
 * Give employees their LeaveBalance row for a fiscal year, once.
 *
 * Nothing else creates these rows, and without one the apply check sees zero
 * available days. Called when an employee is created and again whenever a
 * balance is read or used, which also covers people who existed before this
 * and the first touch of each new fiscal year.
 *
 * `entitled` is the type's full annual entitlement. The `accrual` field says
 * 'monthly', but nothing accrues month by month today, so the year's quota
 * is available from day one. Carry-forward stays 0: no year-end close
 * computes it yet. Existing rows are never overwritten (skipDuplicates), so
 * a later Settings change to the entitlement only affects new rows.
 *
 * LOP (null entitlement) is unlimited and gets no row.
 */
export async function ensureLeaveBalances(
  db: Db,
  employees: { id: string; organisationId: string }[],
  fiscalYearStart: string,
): Promise<void> {
  if (employees.length === 0) return
  const orgIds = [...new Set(employees.map((e) => e.organisationId))]
  const types = await db.leaveType.findMany({
    where: { organisationId: { in: orgIds }, deletedAt: null, annualEntitlement: { not: null } },
    select: { id: true, organisationId: true, annualEntitlement: true },
  })
  const data = employees.flatMap((e) =>
    types
      .filter((t) => t.organisationId === e.organisationId)
      .map((t) => ({
        employeeId: e.id, leaveTypeId: t.id, fiscalYearStart, entitled: t.annualEntitlement ?? 0,
      })),
  )
  if (data.length > 0) await db.leaveBalance.createMany({ data, skipDuplicates: true })
}

/**
 * A leave is charged to the fiscal year its start date falls in; this is the
 * startDate window of requests that share that year's balance.
 */
export function fiscalYearWindow(isoDate: string) {
  const fiscalYearStart = fiscalYearStartOf(isoDate)
  return { fiscalYearStart, startDate: { gte: fiscalYearStart, lt: nextFiscalYearStart(fiscalYearStart) } }
}
