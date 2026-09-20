import type { PrismaClient } from '@prisma/client'
import { classify, loadLedgerGroups } from '../src/modules/bookkeeping/ledgerGroups.js'
import { periodLabel } from '../src/modules/bookkeeping/validate.js'

/**
 * Seed a demo trial balance for the CLOSED month of every engagement — the
 * "one-back" period the demo data closes in status=completed. This gives
 * Reports something to render on `docker compose up` without a real Tally
 * export. Idempotent: skips a period that already has a trial-balance
 * import row.
 *
 * The rows below are illustrative and total in a way that keeps the
 * balance sheet in balance (assets − (liabilities + equity) = 0) and the
 * P&L consistent (net profit = income − expenses).
 */
export interface DemoTrialBalanceReport {
  imports: number
  ledgerRows: number
}

const DEMO_ROWS: readonly {
  ledger: string; group: string;
  opening: bigint; debit: bigint; credit: bigint; closing: bigint;
}[] = [
  // Assets
  { ledger: 'Kotak Bank A/c',   group: 'Bank Accounts',    opening: 5_00_000_00n, debit: 12_00_000_00n, credit: 9_00_000_00n, closing: 8_00_000_00n },
  { ledger: 'Cash on Hand',     group: 'Cash-in-Hand',     opening: 25_000_00n,   debit: 50_000_00n,    credit: 30_000_00n,   closing: 45_000_00n },
  { ledger: 'Kumar Traders',    group: 'Sundry Debtors',   opening: 1_50_000_00n, debit: 3_00_000_00n,  credit: 2_50_000_00n, closing: 2_00_000_00n },
  { ledger: 'Vasan & Co.',      group: 'Sundry Debtors',   opening: 80_000_00n,   debit: 1_20_000_00n,  credit: 1_00_000_00n, closing: 1_00_000_00n },
  // Liabilities
  { ledger: 'Sri Suppliers',    group: 'Sundry Creditors', opening: -1_20_000_00n, debit: 40_000_00n,   credit: 60_000_00n,   closing: -1_40_000_00n },
  { ledger: 'CGST Payable',     group: 'Duties & Taxes',   opening: -18_000_00n,   debit: 5_000_00n,    credit: 12_000_00n,   closing: -25_000_00n },
  { ledger: 'SGST Payable',     group: 'Duties & Taxes',   opening: -18_000_00n,   debit: 5_000_00n,    credit: 12_000_00n,   closing: -25_000_00n },
  // Equity
  { ledger: 'Proprietor Capital', group: 'Capital Account', opening: -5_00_000_00n, debit: 0n, credit: 0n, closing: -5_00_000_00n },
  // Income
  { ledger: 'Product Sales',    group: 'Sales Accounts',   opening: 0n,           debit: 0n,            credit: 15_00_000_00n, closing: -15_00_000_00n },
  // Expenses
  { ledger: 'Cost of Goods',    group: 'Purchase Accounts',opening: 0n,           debit: 10_00_000_00n, credit: 0n,            closing: 10_00_000_00n },
  { ledger: 'Rent',             group: 'Direct Expenses',  opening: 0n,           debit: 50_000_00n,    credit: 0n,            closing: 50_000_00n },
  { ledger: 'Salaries',         group: 'Indirect Expenses',opening: 0n,           debit: 2_00_000_00n,  credit: 0n,            closing: 2_00_000_00n },
  { ledger: 'Bank Charges',     group: 'Indirect Expenses',opening: 0n,           debit: 5_000_00n,     credit: 0n,            closing: 5_000_00n },
]

export async function seedDemoTrialBalance(prisma: PrismaClient): Promise<DemoTrialBalanceReport> {
  const groups = await loadLedgerGroups(prisma)
  // For every engagement, use the closed period two months back (the demo
  // status = 'completed' one) as the target. It already has periodStart/
  // periodEnd from the PR-2 backfill.
  const engagements = await prisma.bookkeepingEngagement.findMany({
    where: { deletedAt: null },
    include: {
      client: { select: { companyName: true } },
      periods: {
        where: { status: 'completed', deletedAt: null },
        orderBy: [{ year: 'desc' }, { month: 'desc' }],
        take: 1,
      },
    },
  })

  let imports = 0
  let ledgerRows = 0

  for (const eng of engagements) {
    const period = eng.periods[0]
    if (!period || !period.periodStart || !period.periodEnd) continue

    const already = await prisma.bookkeepingImport.findFirst({
      where: { periodId: period.id, kind: 'trial_balance' },
    })
    if (already) continue

    const importRow = await prisma.bookkeepingImport.create({
      data: {
        periodId: period.id,
        clientId: eng.clientId,
        kind: 'trial_balance',
        source: 'agent',
        originalFilename: `trial-balance-${period.year}-${String(period.month).padStart(2, '0')}.csv`,
        // We seed a placeholder path — the demo does not write a real file
        // to disk. A future re-import through the API will overwrite this
        // and store an actual file.
        storagePath: `demo/${period.id}-trial-balance.csv`,
        fileSize: 0,
        mimeType: 'text/csv',
        companyNameInFile: eng.client?.companyName ?? '',
        periodFromInFile: period.periodStart,
        periodToInFile: period.periodEnd,
        rowCount: DEMO_ROWS.length,
        status: 'imported',
        importedByEmployeeId: eng.assignedEmployeeId,
      },
    })
    imports++

    await prisma.bookkeepingLedgerBalance.createMany({
      data: DEMO_ROWS.map((r) => {
        const cls = classify(groups, r.group)
        return {
          importId: importRow.id,
          ledgerName: r.ledger,
          parentGroup: r.group,
          category: cls.category,
          subtype: cls.subtype,
          openingPaise: r.opening,
          debitPaise: r.debit,
          creditPaise: r.credit,
          closingPaise: r.closing,
          raw: {
            ledger_name: r.ledger,
            parent_group: r.group,
            note: `Seeded for ${periodLabel(period.year, period.month)}`,
          },
        }
      }),
    })
    ledgerRows += DEMO_ROWS.length
  }

  return { imports, ledgerRows }
}
