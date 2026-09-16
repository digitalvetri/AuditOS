import { prisma, alive } from '../../../lib/prisma.js'
import { ApiError } from '../../../lib/http.js'
import type { Session } from '../../../platform/auth.js'
import { TallyCompanyService } from './TallyCompanyService.js'
import {
  ledgerBalances, trialBalance, profitAndLoss, balanceSheet, groupSummary,
  type PeriodFilter,
} from '../engine/balances.js'
import { ageingBucketFor, daysBetween, AGEING_BUCKETS } from '../engine/primitives.js'

/**
 * TallyReportService — every accounting, outstanding and financial report.
 *
 * Each one is a query over posted vouchers (status 'active') and ledger
 * opening balances. Nothing here stores a total, and every row carries the
 * voucher id that produced it so the UI can drill from a statement down to
 * the voucher without a second lookup table.
 */

const ACTIVE = { status: 'active', ...alive }

export interface DayBookRow {
  voucher_id: string
  date: string
  voucher_type_code: string
  voucher_type_name: string
  voucher_number: string
  party_name: string | null
  narration: string | null
  debit_paise: number
  credit_paise: number
  status: string
  ledgers: string[]
}

export const TallyReportService = {
  /** Day Book — every voucher in a date range, newest first. */
  async dayBook(session: Session, companyId: string, filter: { from?: string; to?: string; typeCodes?: string[]; limit?: number; includeCancelled?: boolean } = {}) {
    await TallyCompanyService.requireOwned(session, companyId)
    const rows = await prisma.tallyVoucher.findMany({
      where: {
        tallyCompanyId: companyId, ...alive,
        ...(filter.includeCancelled ? {} : { status: 'active' }),
        ...(filter.typeCodes?.length ? { voucherTypeCode: { in: filter.typeCodes } } : {}),
        ...(filter.from || filter.to
          ? { date: { ...(filter.from ? { gte: filter.from } : {}), ...(filter.to ? { lte: filter.to } : {}) } }
          : {}),
      },
      select: {
        id: true, date: true, voucherTypeCode: true, voucherNumber: true, narration: true, status: true,
        totalDebitPaise: true, totalCreditPaise: true, grandTotalPaise: true,
        partyLedger: { select: { name: true } },
        voucherType: { select: { name: true } },
        entries: { select: { ledger: { select: { name: true } } } },
      },
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
      take: Math.min(filter.limit ?? 200, 1000),
    })
    const items: DayBookRow[] = rows.map((v) => ({
      voucher_id: v.id,
      date: v.date,
      voucher_type_code: v.voucherTypeCode,
      voucher_type_name: v.voucherType.name,
      voucher_number: v.voucherNumber,
      party_name: v.partyLedger?.name ?? null,
      narration: v.narration,
      debit_paise: v.totalDebitPaise,
      credit_paise: v.totalCreditPaise,
      status: v.status,
      ledgers: v.entries.map((e) => e.ledger.name),
    }))
    return {
      items,
      totals: {
        debit_paise: items.reduce((s, r) => s + r.debit_paise, 0),
        credit_paise: items.reduce((s, r) => s + r.credit_paise, 0),
        count: items.length,
      },
    }
  },

  /**
   * Ledger statement — opening, every movement, running balance, closing.
   * This is the bottom of every drill-down path except the voucher itself.
   */
  async ledgerStatement(session: Session, companyId: string, ledgerId: string, filter: PeriodFilter = {}) {
    await TallyCompanyService.requireOwned(session, companyId)
    const ledger = await prisma.tallyLedger.findFirst({
      where: { id: ledgerId, tallyCompanyId: companyId, ...alive },
      select: { id: true, name: true, group: { select: { id: true, name: true, nature: true } } },
    })
    if (!ledger) throw ApiError.notFound('No such ledger.')

    const [balance] = await ledgerBalances(companyId, { ...filter, ledgerIds: [ledgerId] })
    const entries = await prisma.tallyVoucherEntry.findMany({
      where: {
        tallyCompanyId: companyId, ledgerId,
        voucher: {
          ...ACTIVE,
          ...(filter.from || filter.to
            ? { date: { ...(filter.from ? { gte: filter.from } : {}), ...(filter.to ? { lte: filter.to } : {}) } }
            : {}),
        },
      },
      select: {
        id: true, entryType: true, amountPaise: true, narration: true,
        voucher: {
          select: {
            id: true, date: true, voucherNumber: true, voucherTypeCode: true, narration: true,
            partyLedger: { select: { name: true } },
            entries: { select: { ledgerId: true, entryType: true, ledger: { select: { name: true } } } },
          },
        },
      },
      orderBy: [{ voucher: { date: 'asc' } }, { position: 'asc' }],
    })

    let running = balance.openingPaise
    const rows = entries.map((e) => {
      const signed = e.entryType === 'dr' ? e.amountPaise : -e.amountPaise
      running += signed
      // "Particulars" in a Tally-style ledger is the OTHER side of the entry.
      const contra = e.voucher.entries.filter((x) => x.ledgerId !== ledgerId).map((x) => x.ledger.name)
      return {
        voucher_id: e.voucher.id,
        date: e.voucher.date,
        voucher_number: e.voucher.voucherNumber,
        voucher_type_code: e.voucher.voucherTypeCode,
        particulars: contra.length === 1 ? contra[0] : contra.length ? `${contra[0]} + ${contra.length - 1} more` : '—',
        narration: e.narration ?? e.voucher.narration,
        debit_paise: e.entryType === 'dr' ? e.amountPaise : 0,
        credit_paise: e.entryType === 'cr' ? e.amountPaise : 0,
        running_balance_paise: running,
      }
    })

    return {
      ledger: { id: ledger.id, name: ledger.name, group_id: ledger.group.id, group_name: ledger.group.name },
      openingPaise: balance.openingPaise,
      closingPaise: balance.closingPaise,
      debitPaise: balance.debitPaise,
      creditPaise: balance.creditPaise,
      rows,
    }
  },

  /** Cash Book / Bank Book — the ledger statement for cash or bank ledgers. */
  async cashOrBankBook(session: Session, companyId: string, kind: 'cash' | 'bank', filter: PeriodFilter = {}) {
    await TallyCompanyService.requireOwned(session, companyId)
    const groupName = kind === 'cash' ? 'Cash-in-Hand' : 'Bank Accounts'
    const rows = (await ledgerBalances(companyId, filter)).filter((r) => r.primaryGroupName === groupName)
    return {
      kind,
      ledgers: rows.map((r) => ({
        ledger_id: r.ledgerId, ledger_name: r.ledgerName,
        opening_paise: r.openingPaise, debit_paise: r.debitPaise,
        credit_paise: r.creditPaise, closing_paise: r.closingPaise,
      })),
      totals: {
        opening_paise: rows.reduce((s, r) => s + r.openingPaise, 0),
        debit_paise: rows.reduce((s, r) => s + r.debitPaise, 0),
        credit_paise: rows.reduce((s, r) => s + r.creditPaise, 0),
        closing_paise: rows.reduce((s, r) => s + r.closingPaise, 0),
      },
    }
  },

  /** Sales / Purchase / Payment / Receipt / Journal / Contra register. */
  async register(session: Session, companyId: string, typeCode: string, filter: { from?: string | null; to?: string | null } = {}) {
    await TallyCompanyService.requireOwned(session, companyId)
    const rows = await prisma.tallyVoucher.findMany({
      where: {
        tallyCompanyId: companyId, ...ACTIVE, voucherTypeCode: typeCode,
        ...(filter.from || filter.to
          ? { date: { ...(filter.from ? { gte: filter.from } : {}), ...(filter.to ? { lte: filter.to } : {}) } }
          : {}),
      },
      select: {
        id: true, date: true, voucherNumber: true, referenceNumber: true, narration: true,
        taxableValuePaise: true, cgstPaise: true, sgstPaise: true, igstPaise: true, cessPaise: true,
        grandTotalPaise: true, totalDebitPaise: true,
        partyLedger: { select: { id: true, name: true, gstin: true } },
      },
      orderBy: [{ date: 'asc' }, { voucherNumber: 'asc' }],
    })
    const items = rows.map((v) => ({
      voucher_id: v.id,
      date: v.date,
      voucher_number: v.voucherNumber,
      reference_number: v.referenceNumber,
      party_id: v.partyLedger?.id ?? null,
      party_name: v.partyLedger?.name ?? null,
      party_gstin: v.partyLedger?.gstin ?? null,
      narration: v.narration,
      taxable_value_paise: v.taxableValuePaise,
      cgst_paise: v.cgstPaise,
      sgst_paise: v.sgstPaise,
      igst_paise: v.igstPaise,
      cess_paise: v.cessPaise,
      grand_total_paise: v.grandTotalPaise || v.totalDebitPaise,
    }))
    return {
      type_code: typeCode,
      items,
      totals: {
        count: items.length,
        taxableValuePaise: items.reduce((s, r) => s + r.taxable_value_paise, 0),
        cgstPaise: items.reduce((s, r) => s + r.cgst_paise, 0),
        sgstPaise: items.reduce((s, r) => s + r.sgst_paise, 0),
        igstPaise: items.reduce((s, r) => s + r.igst_paise, 0),
        grandTotalPaise: items.reduce((s, r) => s + r.grand_total_paise, 0),
      },
    }
  },

  /**
   * Outstanding receivables / payables with ageing.
   *
   * Bill-wise where the vouchers carry bill allocations; the party's own
   * ledger balance is the control total, and any difference between the
   * two is reported as "on account" rather than quietly dropped.
   */
  async outstandings(session: Session, companyId: string, opts: { side: 'receivable' | 'payable'; asOf?: string | null; ledgerId?: string }) {
    await TallyCompanyService.requireOwned(session, companyId)
    const asOf = opts.asOf ?? new Date().toISOString().slice(0, 10)
    const primaryGroup = opts.side === 'receivable' ? 'Sundry Debtors' : 'Sundry Creditors'
    const sign = opts.side === 'receivable' ? 1 : -1

    const balances = (await ledgerBalances(companyId, { to: asOf }))
      .filter((b) => b.primaryGroupName === primaryGroup)
      .filter((b) => (opts.ledgerId ? b.ledgerId === opts.ledgerId : true))
      .filter((b) => b.closingPaise !== 0)

    const allocations = await prisma.tallyBillAllocation.findMany({
      where: {
        tallyCompanyId: companyId,
        ledgerId: { in: balances.map((b) => b.ledgerId) },
        date: { lte: asOf },
        voucher: ACTIVE,
      },
      select: { ledgerId: true, billRef: true, method: true, amountPaise: true, dueDate: true, date: true, voucherId: true },
    })

    const byLedger = new Map<string, typeof allocations>()
    for (const a of allocations) {
      if (!byLedger.has(a.ledgerId)) byLedger.set(a.ledgerId, [])
      byLedger.get(a.ledgerId)!.push(a)
    }

    const parties = balances.map((b) => {
      const rows = byLedger.get(b.ledgerId) ?? []
      const bills = new Map<string, { bill_ref: string; date: string; due_date: string | null; voucher_id: string; amount_paise: number; settled_paise: number }>()
      for (const a of rows) {
        if (!bills.has(a.billRef)) {
          bills.set(a.billRef, { bill_ref: a.billRef, date: a.date, due_date: a.dueDate, voucher_id: a.voucherId, amount_paise: 0, settled_paise: 0 })
        }
        const bill = bills.get(a.billRef)!
        if (a.method === 'new') { bill.amount_paise += a.amountPaise; bill.date = a.date; bill.due_date = a.dueDate ?? bill.due_date; bill.voucher_id = a.voucherId }
        else bill.settled_paise += a.amountPaise
      }
      const openBills = Array.from(bills.values())
        .map((bill) => {
          const pending = bill.amount_paise - bill.settled_paise
          const overdueBy = bill.due_date ? daysBetween(bill.due_date, asOf) : daysBetween(bill.date, asOf)
          return {
            ...bill,
            pending_paise: pending,
            days_overdue: bill.due_date ? Math.max(overdueBy, 0) : overdueBy,
            ageing_bucket: ageingBucketFor(bill.due_date ? overdueBy : overdueBy),
          }
        })
        .filter((b2) => b2.pending_paise !== 0)
      const billTotal = openBills.reduce((s, x) => s + x.pending_paise, 0)
      const partyTotal = sign * b.closingPaise
      return {
        ledger_id: b.ledgerId,
        ledger_name: b.ledgerName,
        total_paise: partyTotal,
        bill_total_paise: billTotal,
        on_account_paise: partyTotal - billTotal,
        bills: openBills,
      }
    })

    const buckets: Record<string, number> = {}
    for (const b of AGEING_BUCKETS) buckets[b.key] = 0
    for (const p of parties) {
      for (const bill of p.bills) buckets[bill.ageing_bucket] += bill.pending_paise
      if (p.on_account_paise !== 0) buckets['not_due'] += p.on_account_paise
    }

    return {
      side: opts.side,
      as_of: asOf,
      parties: parties.sort((a, b) => b.total_paise - a.total_paise),
      totalPaise: parties.reduce((s, p) => s + p.total_paise, 0),
      ageing: AGEING_BUCKETS.map((b) => ({ key: b.key, label: b.label, amount_paise: buckets[b.key] })),
    }
  },

  async trialBalance(session: Session, companyId: string, filter: PeriodFilter = {}) {
    await TallyCompanyService.requireOwned(session, companyId)
    return trialBalance(companyId, filter)
  },

  async profitAndLoss(session: Session, companyId: string, filter: PeriodFilter = {}) {
    await TallyCompanyService.requireOwned(session, companyId)
    return profitAndLoss(companyId, filter)
  },

  async balanceSheet(session: Session, companyId: string, opts: { asOf?: string | null; fyStart?: string | null } = {}) {
    await TallyCompanyService.requireOwned(session, companyId)
    return balanceSheet(companyId, opts)
  },

  async groupSummary(session: Session, companyId: string, filter: PeriodFilter = {}) {
    await TallyCompanyService.requireOwned(session, companyId)
    return groupSummary(companyId, filter)
  },

  /**
   * Cash flow, indirect-lite: the actual movement through cash and bank
   * ledgers, classified by the primary group on the other side of each
   * entry. It reconciles to the change in cash + bank by construction.
   */
  async cashFlow(session: Session, companyId: string, filter: { from?: string | null; to?: string | null } = {}) {
    await TallyCompanyService.requireOwned(session, companyId)
    const balances = await ledgerBalances(companyId, filter)
    const cashBank = balances.filter((b) => b.primaryGroupName === 'Cash-in-Hand' || b.primaryGroupName === 'Bank Accounts')
    const cashBankIds = new Set(cashBank.map((b) => b.ledgerId))

    const entries = await prisma.tallyVoucherEntry.findMany({
      where: {
        tallyCompanyId: companyId,
        ledgerId: { in: Array.from(cashBankIds) },
        voucher: {
          ...ACTIVE,
          ...(filter.from || filter.to
            ? { date: { ...(filter.from ? { gte: filter.from } : {}), ...(filter.to ? { lte: filter.to } : {}) } }
            : {}),
        },
      },
      select: {
        entryType: true, amountPaise: true,
        voucher: { select: { id: true, entries: { select: { ledgerId: true, entryType: true, amountPaise: true } } } },
      },
    })

    const natureOf = new Map(balances.map((b) => [b.ledgerId, b.primaryGroupName]))
    const inflow = new Map<string, number>()
    const outflow = new Map<string, number>()
    for (const e of entries) {
      const counter = e.voucher.entries.filter((x) => !cashBankIds.has(x.ledgerId))
      const counterTotal = counter.reduce((s, x) => s + x.amountPaise, 0) || e.amountPaise
      for (const c of counter) {
        const share = Math.round((e.amountPaise * c.amountPaise) / counterTotal)
        const label = natureOf.get(c.ledgerId) ?? 'Other'
        const target = e.entryType === 'dr' ? inflow : outflow
        target.set(label, (target.get(label) ?? 0) + share)
      }
    }

    const opening = cashBank.reduce((s, b) => s + b.openingPaise, 0)
    const closing = cashBank.reduce((s, b) => s + b.closingPaise, 0)
    return {
      opening_paise: opening,
      closing_paise: closing,
      net_change_paise: closing - opening,
      inflows: Array.from(inflow.entries()).map(([label, amount_paise]) => ({ label, amount_paise })).sort((a, b) => b.amount_paise - a.amount_paise),
      outflows: Array.from(outflow.entries()).map(([label, amount_paise]) => ({ label, amount_paise })).sort((a, b) => b.amount_paise - a.amount_paise),
    }
  },

  /**
   * Ratio analysis. Every ratio is null when its denominator is zero —
   * a made-up "0.00" ratio is worse than an honest blank.
   */
  async ratios(session: Session, companyId: string, opts: { asOf?: string | null; fyStart?: string | null } = {}) {
    await TallyCompanyService.requireOwned(session, companyId)
    const [bs, pl, balances] = await Promise.all([
      balanceSheet(companyId, opts),
      profitAndLoss(companyId, { from: opts.fyStart ?? null, to: opts.asOf ?? null }),
      ledgerBalances(companyId, { to: opts.asOf ?? null }),
    ])
    const sumOf = (groups: string[]) => balances.filter((b) => groups.includes(b.primaryGroupName))
      .reduce((s, b) => s + Math.abs(b.closingPaise), 0)
    const currentAssets = sumOf(['Current Assets', 'Sundry Debtors', 'Cash-in-Hand', 'Bank Accounts'])
    const currentLiabilities = sumOf(['Current Liabilities', 'Sundry Creditors', 'Duties & Taxes'])
    const quickAssets = sumOf(['Sundry Debtors', 'Cash-in-Hand', 'Bank Accounts'])
    const div = (a: number, b: number) => (b === 0 ? null : Math.round((a / b) * 100) / 100)
    return {
      as_of: opts.asOf ?? null,
      working_capital_paise: currentAssets - currentLiabilities,
      current_ratio: div(currentAssets, currentLiabilities),
      quick_ratio: div(quickAssets, currentLiabilities),
      debt_equity_ratio: div(sumOf(['Loans (Liability)']), sumOf(['Capital Account'])),
      gross_profit_pct: pl.income.totalPaise ? Math.round((pl.grossProfitPaise / pl.income.totalPaise) * 10000) / 100 : null,
      net_profit_pct: pl.income.totalPaise ? Math.round((pl.netProfitPaise / pl.income.totalPaise) * 10000) / 100 : null,
      net_profit_paise: pl.netProfitPaise,
      total_assets_paise: bs.assets.totalPaise,
    }
  },
}
