import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PrismaClient } from '@prisma/client'
import { monthlyPayrollPeriod } from '../../../lib/dates.js'

/**
 * Apply the Payroll module's database invariants — the CHECK constraint
 * that keeps a PayrollRun's period to a single calendar month.
 *
 * Idempotent, so it runs at API start-up next to the Task and Books
 * invariants. Malformed pre-existing Draft rows are repaired in place
 * before the constraint is added, so the constraint apply does not fail
 * on legacy data.
 */
export async function applyPayrollInvariants(prisma: PrismaClient): Promise<number> {
  // 1. Repair any Draft row whose period is not (day 1 → last-of-same-month).
  //    Only Draft rows are safe to rewrite: they have no items, payslips
  //    or ledger entries. A malformed Processed row is a real incident and
  //    must be handled manually (the constraint apply will then refuse and
  //    make the incident visible).
  const drafts = await prisma.payrollRun.findMany({
    where: { stage: 'draft', deletedAt: null },
  })
  for (const run of drafts) {
    const [y, m, d] = run.periodStart.split('-').map(Number)
    if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) continue
    const canonical = monthlyPayrollPeriod(y, m)
    if (run.periodStart === canonical.start && run.periodEnd === canonical.end) continue

    // Refuse to repair when the canonical (start, end) is already taken by
    // a different run — the unique constraint would abort the update and
    // block boot with an error users cannot self-fix. Log loudly and skip;
    // an operator can pick the winner by hand. The subsequent constraint
    // apply will fail in that case, which is the correct signal.
    const collision = await prisma.payrollRun.findFirst({
      where: { periodStart: canonical.start, periodEnd: canonical.end, NOT: { id: run.id } },
    })
    if (collision) {
      console.warn(`[payroll] cannot repair Draft run ${run.id} (${run.periodStart} → ${run.periodEnd}): canonical (${canonical.start} → ${canonical.end}) is already used by run ${collision.id}. Manual intervention needed.`)
      continue
    }
    await prisma.payrollRun.update({
      where: { id: run.id },
      data: {
        periodStart: canonical.start,
        periodEnd: canonical.end,
        notes: [run.notes, `Period repaired ${new Date().toISOString().slice(0, 10)}: (${run.periodStart} → ${run.periodEnd}) → (${canonical.start} → ${canonical.end}).`]
          .filter(Boolean).join(' '),
      },
    })
    console.log(`[payroll] repaired Draft run ${run.id}: ${run.periodStart} → ${run.periodEnd} became ${canonical.start} → ${canonical.end}`)
  }

  // 2. Apply the constraint.
  const here = path.dirname(fileURLToPath(import.meta.url))
  const file = path.resolve(here, '../../../../prisma/sql', 'payroll-invariants.postgresql.sql')
  const sql = fs.readFileSync(file, 'utf8')
  const statements = sql
    .split(/^\s*-- @@\s*$/m)
    .map((s) => s.replace(/^\s*--.*$/gm, '').trim())
    .filter(Boolean)
  for (const statement of statements) {
    await prisma.$executeRawUnsafe(statement)
  }
  return statements.length
}
