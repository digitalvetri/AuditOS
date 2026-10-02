/**
 * ONE-SHOT MIGRATION — re-post legacy single-leg rows as balanced journals.
 *
 * Ledger rows before the double-entry fix carried only the debit side
 * (Payroll at NET; expense reimbursements at amount; manual payments at
 * amount). This script walks every such row, writes a contra reversal that
 * marks the original as reversed, and re-posts the correct multi-leg
 * journal.
 *
 * The ledger is append-only, so migration is not an UPDATE — it is a pair
 * of appends per legacy row (contra + fresh posting). The identity
 *
 *     Σ debits = Σ credits
 *
 * must hold at the end. The script asserts this and refuses to commit if
 * it does not.
 *
 * SAFE TO RE-RUN: only rows with status='posted' AND creditPaise=0 AND
 * referenceType in ('PayrollItem','Expense') are candidates, and once
 * migrated they carry status='reversed', so a second pass finds no work.
 *
 * USAGE (from server/):
 *
 *     tsx scripts/migrate-ledger-both-legs.ts --dry-run
 *     tsx scripts/migrate-ledger-both-legs.ts --run
 *
 * --dry-run reports what would change and asserts the identity would hold.
 * --run commits.
 */
import '../src/lib/env.js'
import { PrismaClient } from '@prisma/client'
import { CATEGORIES } from '../src/platform/constants.js'
import { postJournal, postLedger } from '../src/modules/accounts/ledger.js'
import type { PayrollDeductions } from '../src/domain/payroll/calc.js'

const prisma = new PrismaClient()

interface LegSet {
  legs: {
    category: string
    debitPaise?: number
    creditPaise?: number
  }[]
  description: string
}

function payrollLegs(gross: number, net: number, deductions: PayrollDeductions): LegSet {
  const other = (deductions.advance_paise ?? 0) +
    (deductions.other ?? []).reduce((s, o) => s + o.amount_paise, 0)
  return {
    description: 'Payroll re-posting',
    legs: [
      { category: CATEGORIES.SALARIES, debitPaise: gross },
      { category: CATEGORIES.BANK, creditPaise: net },
      { category: CATEGORIES.PF_PAYABLE, creditPaise: deductions.pf_employee_paise ?? 0 },
      { category: CATEGORIES.ESI_PAYABLE, creditPaise: deductions.esi_employee_paise ?? 0 },
      { category: CATEGORIES.PT_PAYABLE, creditPaise: deductions.pt_paise ?? 0 },
      { category: CATEGORIES.TDS_PAYABLE, creditPaise: deductions.tds_paise ?? 0 },
      { category: CATEGORIES.OTHER_DEDUCTION, creditPaise: other },
    ],
  }
}

function expenseLegs(amount: number): LegSet {
  return {
    description: 'Reimbursement re-posting',
    legs: [
      { category: CATEGORIES.REIMBURSEMENT, debitPaise: amount },
      { category: CATEGORIES.BANK, creditPaise: amount },
    ],
  }
}

async function main() {
  const mode = process.argv.includes('--run')
    ? 'run'
    : process.argv.includes('--dry-run')
      ? 'dry-run'
      : null
  if (!mode) {
    console.error('Missing mode. Pass --dry-run or --run.')
    process.exit(2)
  }

  const legacy = await prisma.ledgerTransaction.findMany({
    where: {
      status: 'posted',
      creditPaise: 0,
      referenceType: { in: ['PayrollItem', 'Expense'] },
    },
    orderBy: { sequence: 'asc' },
  })

  console.log(`Legacy single-leg rows found: ${legacy.length}`)
  if (!legacy.length) {
    console.log('Nothing to migrate.')
    return
  }

  let plannedContras = 0
  let plannedNewLegs = 0
  let plannedDebit = 0
  let plannedCredit = 0

  for (const row of legacy) {
    plannedContras += 1
    plannedDebit += row.creditPaise
    plannedCredit += row.debitPaise
  }

  for (const row of legacy) {
    if (row.referenceType === 'PayrollItem') {
      const item = await prisma.payrollItem.findUnique({ where: { id: row.referenceId } })
      if (!item) {
        console.error(`ABORT: PayrollItem ${row.referenceId} missing for ledger row ${row.transactionRef}.`)
        process.exit(1)
      }
      const legs = payrollLegs(item.grossPaise, item.netPaise, JSON.parse(item.deductionsJson))
      for (const l of legs.legs) {
        plannedDebit += l.debitPaise ?? 0
        plannedCredit += l.creditPaise ?? 0
        if ((l.debitPaise ?? 0) > 0 || (l.creditPaise ?? 0) > 0) plannedNewLegs += 1
      }
    } else if (row.referenceType === 'Expense') {
      const exp = await prisma.expense.findUnique({ where: { id: row.referenceId } })
      if (!exp) {
        console.error(`ABORT: Expense ${row.referenceId} missing for ledger row ${row.transactionRef}.`)
        process.exit(1)
      }
      const legs = expenseLegs(exp.amountPaise)
      for (const l of legs.legs) {
        plannedDebit += l.debitPaise ?? 0
        plannedCredit += l.creditPaise ?? 0
        if ((l.debitPaise ?? 0) > 0 || (l.creditPaise ?? 0) > 0) plannedNewLegs += 1
      }
    }
  }

  const currentTotals = await prisma.ledgerTransaction.aggregate({
    where: { status: 'posted' },
    _sum: { debitPaise: true, creditPaise: true },
  })
  const currentDr = currentTotals._sum.debitPaise ?? 0
  const currentCr = currentTotals._sum.creditPaise ?? 0
  const projectedDr = currentDr + plannedDebit
  const projectedCr = currentCr + plannedCredit

  console.log('')
  console.log('Plan:')
  console.log(`  Contras to write:   ${plannedContras}`)
  console.log(`  New journal legs:   ${plannedNewLegs}`)
  console.log(`  Current Dr:         ${currentDr}`)
  console.log(`  Current Cr:         ${currentCr}`)
  console.log(`  Projected Dr:       ${projectedDr}`)
  console.log(`  Projected Cr:       ${projectedCr}`)
  console.log(`  Projected variance: ${projectedDr - projectedCr} (must be 0)`)

  if (projectedDr !== projectedCr) {
    console.error('ABORT: projected totals do not balance.')
    process.exit(1)
  }

  if (mode === 'dry-run') {
    console.log('\nDry run — no writes.')
    return
  }

  console.log('\nApplying…')
  const today = new Date().toISOString().slice(0, 10)

  for (const row of legacy) {
    await prisma.$transaction(async (tx) => {
      // Contra reversal (append + mark original reversed).
      const contra = await postLedger(tx, {
        date: today,
        type: row.type as 'Payroll' | 'Expense Reimbursement',
        description: `Migration reversal — ${row.description}`,
        employeeId: row.employeeId,
        category: row.category,
        debitPaise: row.creditPaise,
        creditPaise: row.debitPaise,
        referenceId: row.id,
        referenceType: 'LedgerReversal',
        reversesId: row.id,
        createdBy: null,
      })
      await tx.ledgerTransaction.update({
        where: { id: row.id }, data: { status: 'reversed' },
      })

      // Fresh correct posting on the original date.
      if (row.referenceType === 'PayrollItem') {
        const item = await tx.payrollItem.findUnique({ where: { id: row.referenceId } })
        if (!item) throw new Error(`Missing PayrollItem ${row.referenceId}`)
        const legs = payrollLegs(item.grossPaise, item.netPaise, JSON.parse(item.deductionsJson))
        await postJournal(tx, {
          date: row.date,
          type: 'Payroll',
          description: `Salary — re-posted (was ${row.transactionRef})`,
          employeeId: row.employeeId,
          referenceId: item.id,
          referenceType: 'PayrollItem',
          paymentId: row.paymentId,
          createdBy: null,
          legs: legs.legs,
        })
      } else {
        const exp = await tx.expense.findUnique({ where: { id: row.referenceId } })
        if (!exp) throw new Error(`Missing Expense ${row.referenceId}`)
        const legs = expenseLegs(exp.amountPaise)
        await postJournal(tx, {
          date: row.date,
          type: 'Expense Reimbursement',
          description: `Reimbursement — re-posted (was ${row.transactionRef})`,
          employeeId: row.employeeId,
          referenceId: exp.id,
          referenceType: 'Expense',
          paymentId: row.paymentId,
          createdBy: null,
          legs: legs.legs,
        })
      }
      return contra
    })
  }

  const after = await prisma.ledgerTransaction.aggregate({
    where: { status: 'posted' },
    _sum: { debitPaise: true, creditPaise: true },
  })
  const afterDr = after._sum.debitPaise ?? 0
  const afterCr = after._sum.creditPaise ?? 0
  console.log('\nAfter:')
  console.log(`  Posted Dr: ${afterDr}`)
  console.log(`  Posted Cr: ${afterCr}`)
  console.log(`  Variance:  ${afterDr - afterCr}`)
  if (afterDr !== afterCr) {
    console.error('ABORT: ledger did not balance after migration.')
    process.exit(1)
  }
  console.log('\nMigration complete.')
}

main()
  .catch((err) => { console.error(err); process.exit(1) })
  .finally(() => prisma.$disconnect())
