import { prisma, alive } from '../../../lib/prisma.js'

/**
 * DERIVED BALANCES — every report in the Tally module is built on this
 * file, and this file is built on nothing but TallyLedger opening
 * balances plus TallyVoucherEntry rows of ACTIVE vouchers.
 *
 * There is no cached balance column anywhere. A number on a screen can
 * therefore always be walked back to the vouchers that produced it,
 * which is the whole point of putting an accounting system inside an
 * audit product.
 *
 * SIGN CONVENTION: every signed paise figure here is DEBIT-POSITIVE.
 *   asset / expense  → normally positive
 *   liability / income / capital → normally negative
 * Presentation flips the sign; the arithmetic never does.
 */

export interface LedgerBalanceRow {
  ledgerId: string
  ledgerName: string
  groupId: string
  groupName: string
  /** The primary (root) group this ledger ultimately rolls up into. */
  primaryGroupId: string
  primaryGroupName: string
  nature: string
  affectsPL: boolean
  /** Signed, debit-positive, as at the start of the period. */
  openingPaise: number
  debitPaise: number
  creditPaise: number
  /** Signed, debit-positive, as at the end of the period. */
  closingPaise: number
}

export interface PeriodFilter {
  from?: string | null
  to?: string | null
  ledgerIds?: string[]
}

interface GroupRow {
  id: string
  name: string
  parentGroupId: string | null
  nature: string
  affectsPL: boolean
  isPrimary: boolean
}

/** Walk a group to its primary ancestor (cycle-safe). */
export function primaryAncestor(groups: Map<string, GroupRow>, groupId: string): GroupRow {
  let cur = groups.get(groupId)
  const seen = new Set<string>()
  while (cur && cur.parentGroupId && !seen.has(cur.id)) {
    seen.add(cur.id)
    const parent = groups.get(cur.parentGroupId)
    if (!parent) break
    cur = parent
  }
  return cur ?? groups.get(groupId)!
}

export async function loadGroups(companyId: string): Promise<Map<string, GroupRow>> {
  const rows = await prisma.bookkeepingGroup.findMany({
    where: { tallyCompanyId: companyId, ...alive },
    select: { id: true, name: true, parentGroupId: true, nature: true, affectsPL: true, isPrimary: true },
  })
  return new Map(rows.map((r) => [r.id, r]))
}

/**
 * Per-ledger opening / debit / credit / closing for a period.
 *
 * Opening = the ledger's master opening balance + the net of every active
 * voucher line dated BEFORE `from`. Closing = opening + period movement.
 */
export async function ledgerBalances(companyId: string, filter: PeriodFilter = {}): Promise<LedgerBalanceRow[]> {
  const [ledgers, groups] = await Promise.all([
    prisma.bookkeepingLedger.findMany({
      where: { tallyCompanyId: companyId, ...alive, ...(filter.ledgerIds ? { id: { in: filter.ledgerIds } } : {}) },
      select: {
        id: true, name: true, groupId: true,
        openingBalancePaise: true, openingBalanceType: true,
        group: { select: { id: true, name: true, nature: true, affectsPL: true } },
      },
      orderBy: { name: 'asc' },
    }),
    loadGroups(companyId),
  ])

  const activeVoucher = { status: 'active', ...alive }

  // Movement strictly before the period start (folds into opening).
  const priorAgg = filter.from
    ? await prisma.bookkeepingVoucherEntry.groupBy({
        by: ['ledgerId', 'entryType'],
        where: { tallyCompanyId: companyId, voucher: { ...activeVoucher, date: { lt: filter.from } } },
        _sum: { amountPaise: true },
      })
    : []

  // Movement inside the period.
  const periodAgg = await prisma.bookkeepingVoucherEntry.groupBy({
    by: ['ledgerId', 'entryType'],
    where: {
      tallyCompanyId: companyId,
      voucher: {
        ...activeVoucher,
        ...(filter.from || filter.to
          ? { date: { ...(filter.from ? { gte: filter.from } : {}), ...(filter.to ? { lte: filter.to } : {}) } }
          : {}),
      },
    },
    _sum: { amountPaise: true },
  })

  const prior = new Map<string, number>()
  for (const r of priorAgg) {
    const signed = (r.entryType === 'dr' ? 1 : -1) * (r._sum.amountPaise ?? 0)
    prior.set(r.ledgerId, (prior.get(r.ledgerId) ?? 0) + signed)
  }
  const drIn = new Map<string, number>()
  const crIn = new Map<string, number>()
  for (const r of periodAgg) {
    const m = r.entryType === 'dr' ? drIn : crIn
    m.set(r.ledgerId, (m.get(r.ledgerId) ?? 0) + (r._sum.amountPaise ?? 0))
  }

  return ledgers.map((l) => {
    const masterOpening = (l.openingBalanceType === 'cr' ? -1 : 1) * l.openingBalancePaise
    const opening = masterOpening + (prior.get(l.id) ?? 0)
    const debit = drIn.get(l.id) ?? 0
    const credit = crIn.get(l.id) ?? 0
    const primary = primaryAncestor(groups, l.groupId)
    return {
      ledgerId: l.id,
      ledgerName: l.name,
      groupId: l.groupId,
      groupName: l.group.name,
      primaryGroupId: primary?.id ?? l.groupId,
      primaryGroupName: primary?.name ?? l.group.name,
      nature: l.group.nature,
      affectsPL: l.group.affectsPL,
      openingPaise: opening,
      debitPaise: debit,
      creditPaise: credit,
      closingPaise: opening + debit - credit,
    }
  })
}

export interface TrialBalanceRow extends LedgerBalanceRow {
  closingDebitPaise: number
  closingCreditPaise: number
}

export interface TrialBalance {
  rows: TrialBalanceRow[]
  totals: {
    openingDebitPaise: number
    openingCreditPaise: number
    debitPaise: number
    creditPaise: number
    closingDebitPaise: number
    closingCreditPaise: number
    balanced: boolean
    differencePaise: number
  }
}

export async function trialBalance(companyId: string, filter: PeriodFilter = {}): Promise<TrialBalance> {
  const rows = (await ledgerBalances(companyId, filter)).map((r) => ({
    ...r,
    closingDebitPaise: r.closingPaise > 0 ? r.closingPaise : 0,
    closingCreditPaise: r.closingPaise < 0 ? -r.closingPaise : 0,
  }))
  const totals = rows.reduce(
    (acc, r) => ({
      openingDebitPaise: acc.openingDebitPaise + (r.openingPaise > 0 ? r.openingPaise : 0),
      openingCreditPaise: acc.openingCreditPaise + (r.openingPaise < 0 ? -r.openingPaise : 0),
      debitPaise: acc.debitPaise + r.debitPaise,
      creditPaise: acc.creditPaise + r.creditPaise,
      closingDebitPaise: acc.closingDebitPaise + r.closingDebitPaise,
      closingCreditPaise: acc.closingCreditPaise + r.closingCreditPaise,
    }),
    { openingDebitPaise: 0, openingCreditPaise: 0, debitPaise: 0, creditPaise: 0, closingDebitPaise: 0, closingCreditPaise: 0 },
  )
  const differencePaise = totals.closingDebitPaise - totals.closingCreditPaise
  return { rows, totals: { ...totals, balanced: differencePaise === 0, differencePaise } }
}

export interface PLSection {
  label: string
  rows: { ledgerId: string; ledgerName: string; groupName: string; amountPaise: number }[]
  totalPaise: number
}

export interface ProfitAndLoss {
  income: PLSection
  expenses: PLSection
  /** Positive = profit, negative = loss. */
  netProfitPaise: number
  grossProfitPaise: number
  from: string | null
  to: string | null
}

/**
 * P&L for a period. Income ledgers carry credit (negative signed)
 * balances and are reported positive; expense ledgers the other way.
 * Only the PERIOD movement enters the P&L — an income ledger's opening
 * balance belongs to a prior year's reserves, not to this year's profit.
 */
export async function profitAndLoss(companyId: string, filter: PeriodFilter = {}): Promise<ProfitAndLoss> {
  const rows = await ledgerBalances(companyId, filter)
  const pl = rows.filter((r) => r.affectsPL)

  const incomeRows = pl.filter((r) => r.nature === 'income')
    .map((r) => ({ ledgerId: r.ledgerId, ledgerName: r.ledgerName, groupName: r.groupName, amountPaise: r.creditPaise - r.debitPaise }))
    .filter((r) => r.amountPaise !== 0)
  const expenseRows = pl.filter((r) => r.nature === 'expenses')
    .map((r) => ({ ledgerId: r.ledgerId, ledgerName: r.ledgerName, groupName: r.groupName, amountPaise: r.debitPaise - r.creditPaise }))
    .filter((r) => r.amountPaise !== 0)

  const incomeTotal = incomeRows.reduce((s, r) => s + r.amountPaise, 0)
  const expenseTotal = expenseRows.reduce((s, r) => s + r.amountPaise, 0)

  // Gross profit = direct income + sales - direct expenses - purchases.
  const DIRECT_INCOME = new Set(['Sales Accounts', 'Direct Incomes'])
  const DIRECT_EXPENSE = new Set(['Purchase Accounts', 'Direct Expenses'])
  const directIncome = pl.filter((r) => r.nature === 'income' && DIRECT_INCOME.has(r.primaryGroupName))
    .reduce((s, r) => s + (r.creditPaise - r.debitPaise), 0)
  const directExpense = pl.filter((r) => r.nature === 'expenses' && DIRECT_EXPENSE.has(r.primaryGroupName))
    .reduce((s, r) => s + (r.debitPaise - r.creditPaise), 0)

  return {
    income: { label: 'Income', rows: incomeRows, totalPaise: incomeTotal },
    expenses: { label: 'Expenses', rows: expenseRows, totalPaise: expenseTotal },
    netProfitPaise: incomeTotal - expenseTotal,
    grossProfitPaise: directIncome - directExpense,
    from: filter.from ?? null,
    to: filter.to ?? null,
  }
}

export interface BalanceSheetGroup {
  groupId: string
  groupName: string
  amountPaise: number
  ledgers: { ledgerId: string; ledgerName: string; amountPaise: number }[]
}

export interface BalanceSheet {
  assets: { groups: BalanceSheetGroup[]; totalPaise: number }
  liabilities: { groups: BalanceSheetGroup[]; totalPaise: number }
  netProfitPaise: number
  /** assets − (liabilities + profit). Zero on a healthy set of books. */
  differencePaise: number
  balanced: boolean
  asOf: string | null
}

/**
 * Balance sheet as at a date. Current-period profit is carried to the
 * liabilities side (as it would be to Capital) so the two sides agree —
 * the difference field makes any imbalance visible instead of hiding it.
 */
export async function balanceSheet(companyId: string, opts: { asOf?: string | null; fyStart?: string | null } = {}): Promise<BalanceSheet> {
  const asOf = opts.asOf ?? null
  const rows = await ledgerBalances(companyId, { to: asOf })
  const pl = await profitAndLoss(companyId, { from: opts.fyStart ?? null, to: asOf })

  const bsRows = rows.filter((r) => !r.affectsPL)
  const byPrimary = new Map<string, BalanceSheetGroup & { nature: string }>()
  for (const r of bsRows) {
    if (r.closingPaise === 0) continue
    const key = r.primaryGroupId
    if (!byPrimary.has(key)) {
      byPrimary.set(key, { groupId: key, groupName: r.primaryGroupName, amountPaise: 0, ledgers: [], nature: r.nature })
    }
    const g = byPrimary.get(key)!
    // Assets are reported debit-positive, liabilities credit-positive.
    const presented = r.nature === 'assets' ? r.closingPaise : -r.closingPaise
    g.amountPaise += presented
    g.ledgers.push({ ledgerId: r.ledgerId, ledgerName: r.ledgerName, amountPaise: presented })
  }

  const groups = Array.from(byPrimary.values())
  const assetGroups = groups.filter((g) => g.nature === 'assets').map(stripNature)
  const liabilityGroups = groups.filter((g) => g.nature !== 'assets').map(stripNature)

  const assetsTotal = assetGroups.reduce((s, g) => s + g.amountPaise, 0)
  const liabilitiesTotal = liabilityGroups.reduce((s, g) => s + g.amountPaise, 0)
  const difference = assetsTotal - (liabilitiesTotal + pl.netProfitPaise)

  return {
    assets: { groups: assetGroups, totalPaise: assetsTotal },
    liabilities: { groups: liabilityGroups, totalPaise: liabilitiesTotal },
    netProfitPaise: pl.netProfitPaise,
    differencePaise: difference,
    balanced: difference === 0,
    asOf,
  }
}

function stripNature(g: BalanceSheetGroup & { nature: string }): BalanceSheetGroup {
  const { nature: _n, ...rest } = g
  return rest
}

export interface GroupSummaryRow {
  groupId: string
  groupName: string
  nature: string
  affectsPL: boolean
  parentGroupId: string | null
  openingPaise: number
  debitPaise: number
  creditPaise: number
  closingPaise: number
  ledgerCount: number
}

/** Group Summary — the drill-down step between a statement and a ledger. */
export async function groupSummary(companyId: string, filter: PeriodFilter = {}): Promise<GroupSummaryRow[]> {
  const [rows, groups] = await Promise.all([ledgerBalances(companyId, filter), loadGroups(companyId)])
  const byGroup = new Map<string, GroupSummaryRow>()
  for (const g of groups.values()) {
    byGroup.set(g.id, {
      groupId: g.id, groupName: g.name, nature: g.nature, affectsPL: g.affectsPL,
      parentGroupId: g.parentGroupId, openingPaise: 0, debitPaise: 0, creditPaise: 0, closingPaise: 0, ledgerCount: 0,
    })
  }
  for (const r of rows) {
    // Roll the ledger into its own group AND every ancestor.
    let cursor: string | null = r.groupId
    const seen = new Set<string>()
    let direct = true
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor)
      const row = byGroup.get(cursor)
      if (!row) break
      row.openingPaise += r.openingPaise
      row.debitPaise += r.debitPaise
      row.creditPaise += r.creditPaise
      row.closingPaise += r.closingPaise
      if (direct) { row.ledgerCount += 1; direct = false }
      cursor = groups.get(cursor)?.parentGroupId ?? null
    }
  }
  return Array.from(byGroup.values())
}
