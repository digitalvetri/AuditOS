/**
 * BOOKKEEPING REPORTS (spec §6.5).
 *
 * Every one of the five reports is DERIVED at read time from the latest
 * imported trial balance for the period. Nothing on this file caches a
 * report row — the ledger balances are the truth, and letting reports
 * drift from imports is the failure this module has to avoid.
 *
 * Money moves on the wire as decimal strings ("1500.00") so the JSON
 * transport doesn't quietly quantise a BigInt. The frontend receives
 * numbers with two fixed decimals of rupees.
 */
import type { PrismaClient } from '@prisma/client'
import type { BookkeepingLedgerBalance } from '@prisma/client'

/** Paise as BigInt → rupees.paise as a plain decimal string. */
export function paiseToRupeeString(paise: bigint): string {
  const negative = paise < 0n
  const abs = negative ? -paise : paise
  const rupees = abs / 100n
  const remainder = abs % 100n
  const paiseStr = remainder.toString().padStart(2, '0')
  return `${negative ? '-' : ''}${rupees.toString()}.${paiseStr}`
}

export type ReportKind = 'trial_balance' | 'profit_and_loss' | 'balance_sheet' | 'debtors' | 'creditors'

export interface ReportLine {
  ledger_name: string
  parent_group: string
  category: string
  subtype: string
  opening: string
  debit: string
  credit: string
  closing: string
}

export interface ReportSection {
  label: string
  lines: ReportLine[]
  total_paise: string    // string because it can be a big number and the wire is JSON
}

export interface ReportView {
  available: true
  as_of_period_end: string | null
  imported_at: string | null
  imported_by: string | null
  sections: ReportSection[]
  totals: Record<string, string>
}

export type UnavailableReport = {
  available: false
  /** Which import the caller needs to upload before this report can render. */
  missing_import: 'trial_balance'
  /** Verbatim spec §6.5 empty-state text, with the report name substituted. */
  message: string
}

export type ReportsResponse = Record<ReportKind, ReportView | UnavailableReport>

const REPORT_LABELS: Record<ReportKind, string> = {
  trial_balance: 'Trial Balance',
  profit_and_loss: 'Profit & Loss',
  balance_sheet: 'Balance Sheet',
  debtors: 'Debtors',
  creditors: 'Creditors',
}

/**
 * Build all five reports for one period. Cheap: one query for the latest
 * successful trial-balance import, one for its ledger balances. If either
 * is missing, every report renders its "requires a trial balance import"
 * empty state — the frontend needs no branching logic of its own.
 */
export async function reportsForPeriod(
  prisma: PrismaClient,
  periodId: string,
): Promise<ReportsResponse> {
  const importRow = await prisma.bookkeepingImport.findFirst({
    where: { periodId, kind: 'trial_balance', status: 'imported' },
    orderBy: { importedAt: 'desc' },
    include: { period: { select: { periodEnd: true } } },
  })

  if (!importRow) {
    return unavailableAll()
  }

  const balances = await prisma.bookkeepingLedgerBalance.findMany({
    where: { importId: importRow.id },
    orderBy: [{ category: 'asc' }, { subtype: 'asc' }, { parentGroup: 'asc' }, { ledgerName: 'asc' }],
  })

  // Look up the employee separately — `importedByEmployeeId` is a raw FK
  // rather than a Prisma relation, so we cannot include it above.
  const importer = importRow.importedByEmployeeId
    ? await prisma.employee.findFirst({
        where: { id: importRow.importedByEmployeeId },
        select: { fullName: true },
      })
    : null

  const meta = {
    as_of_period_end: importRow.period.periodEnd ?? null,
    imported_at: importRow.importedAt.toISOString(),
    imported_by: importer?.fullName ?? null,
  }

  return {
    trial_balance: trialBalance(balances, meta),
    profit_and_loss: profitAndLoss(balances, meta),
    balance_sheet: balanceSheet(balances, meta),
    debtors: bySubtype(balances, 'receivable', 'Debtors', meta),
    creditors: bySubtype(balances, 'payable', 'Creditors', meta),
  }
}

function unavailableAll(): ReportsResponse {
  const kinds: ReportKind[] = ['trial_balance', 'profit_and_loss', 'balance_sheet', 'debtors', 'creditors']
  return Object.fromEntries(
    kinds.map((k) => [
      k,
      {
        available: false,
        missing_import: 'trial_balance',
        message: `${REPORT_LABELS[k]} requires a trial balance import for this period.`,
      },
    ]),
  ) as ReportsResponse
}

interface Meta {
  as_of_period_end: string | null
  imported_at: string
  imported_by: string | null
}

function lineFrom(b: BookkeepingLedgerBalance): ReportLine {
  return {
    ledger_name: b.ledgerName,
    parent_group: b.parentGroup,
    category: b.category,
    subtype: b.subtype,
    opening: paiseToRupeeString(b.openingPaise),
    debit: paiseToRupeeString(b.debitPaise),
    credit: paiseToRupeeString(b.creditPaise),
    closing: paiseToRupeeString(b.closingPaise),
  }
}

function sumClosing(rows: BookkeepingLedgerBalance[]): bigint {
  return rows.reduce((t, r) => t + r.closingPaise, 0n)
}

function trialBalance(balances: BookkeepingLedgerBalance[], meta: Meta): ReportView {
  const byCategory = groupBy(balances, (b) => b.category)
  return {
    available: true, ...meta,
    sections: [...byCategory.entries()].map(([category, rows]) => ({
      label: categoryLabel(category),
      lines: rows.map(lineFrom),
      total_paise: paiseToRupeeString(sumClosing(rows)),
    })),
    totals: {
      debit: paiseToRupeeString(balances.reduce((t, r) => t + r.debitPaise, 0n)),
      credit: paiseToRupeeString(balances.reduce((t, r) => t + r.creditPaise, 0n)),
    },
  }
}

function profitAndLoss(balances: BookkeepingLedgerBalance[], meta: Meta): ReportView {
  const income = balances.filter((b) => b.category === 'income')
  const expense = balances.filter((b) => b.category === 'expense')
  const netProfit = -sumClosing(income) - sumClosing(expense)
  // ^ Income carries a credit (negative) closing balance in the file
  //   convention, expenses carry a debit (positive) — the net moves
  //   Rupees toward equity. This computation deliberately assumes the
  //   file uses that convention; a parser follow-up will normalise sign
  //   before it lands in `closingPaise` and this can simplify.
  return {
    available: true, ...meta,
    sections: [
      { label: 'Income', lines: income.map(lineFrom), total_paise: paiseToRupeeString(-sumClosing(income)) },
      { label: 'Expenses', lines: expense.map(lineFrom), total_paise: paiseToRupeeString(sumClosing(expense)) },
    ],
    totals: {
      net_profit: paiseToRupeeString(netProfit),
    },
  }
}

function balanceSheet(balances: BookkeepingLedgerBalance[], meta: Meta): ReportView {
  const assets = balances.filter((b) => b.category === 'asset')
  const liabilities = balances.filter((b) => b.category === 'liability')
  const equity = balances.filter((b) => b.category === 'equity')
  return {
    available: true, ...meta,
    sections: [
      { label: 'Assets', lines: assets.map(lineFrom), total_paise: paiseToRupeeString(sumClosing(assets)) },
      { label: 'Liabilities', lines: liabilities.map(lineFrom), total_paise: paiseToRupeeString(sumClosing(liabilities)) },
      { label: 'Equity', lines: equity.map(lineFrom), total_paise: paiseToRupeeString(sumClosing(equity)) },
    ],
    totals: {
      assets: paiseToRupeeString(sumClosing(assets)),
      liabilities_and_equity: paiseToRupeeString(sumClosing(liabilities) + sumClosing(equity)),
    },
  }
}

function bySubtype(
  balances: BookkeepingLedgerBalance[],
  subtype: string,
  label: string,
  meta: Meta,
): ReportView {
  const rows = balances.filter((b) => b.subtype === subtype)
  return {
    available: true, ...meta,
    sections: [
      { label, lines: rows.map(lineFrom), total_paise: paiseToRupeeString(sumClosing(rows)) },
    ],
    totals: {
      total: paiseToRupeeString(sumClosing(rows)),
    },
  }
}

function categoryLabel(category: string): string {
  const cap = category.charAt(0).toUpperCase() + category.slice(1)
  return cap === 'Asset' ? 'Assets' : cap === 'Liability' ? 'Liabilities' : cap
}

function groupBy<T, K>(items: T[], key: (t: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>()
  for (const item of items) {
    const k = key(item)
    const arr = out.get(k) ?? []
    arr.push(item)
    out.set(k, arr)
  }
  return out
}
