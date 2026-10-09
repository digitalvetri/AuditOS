/**
 * BOOKKEEPING · CLIENT DASHBOARD DATA BUNDLE (BOOKKEEPING-REBUILD §6).
 *
 * Everything the client dashboard needs for one financial year, in a
 * compact JSON shape the dashboard's own script computes from: each
 * ledger's opening balance and its debit / credit per month, the
 * vouchers, the stock lines on sales and purchases, the bill-wise
 * allocations of debtors and creditors, and the bank entries with their
 * clearing dates. With month-level movement the dashboard can show any
 * month, quarter or the full year — and compare with the prior period —
 * without calling back to the server, so the same bundle drives the
 * in-app view and the offline file sent to the client.
 *
 * Amounts are integer paise. Ledger balances are signed debit-positive.
 */
import type { PrismaClient } from '@prisma/client'
import { ledgerBalances } from '../engine/balances.js'
import { alive } from '../../../lib/prisma.js'
import { entryNums, itemNums, voucherNums } from '../engine/paise.js'
import { numify } from '../../../lib/money.js'

/** Most vouchers carried for the Journal Entries view; the oldest are dropped past this. */
export const MAX_VOUCHERS = 3000

export interface BundleLedger {
  n: string          // name
  g: string          // immediate group
  p: string          // primary group (one of the 17)
  nat: 'assets' | 'liabilities' | 'income' | 'expenses'
  pl: boolean        // affects profit & loss
  ob: number         // opening balance at FY start, debit-positive
  dr: number[]       // debit per FY month
  cr: number[]       // credit per FY month
}

export interface BundleVoucher {
  d: string          // date
  no: string
  t: string          // type code
  tn: string         // type name
  party: string | null
  nar: string | null
  amt: number
  lines: [number, number, number][] // [ledger index, debit, credit]
}

export interface BundleItemLine { d: string; t: 'sales' | 'purchase'; item: string; unit: string | null; qty: number; amt: number }
export interface BundleBill { l: number; ref: string; d: string; due: string | null; amt: number; set: [string, number][] }
export interface BundleBankRow { d: string; no: string; part: string; dr: number; cr: number; cleared: string | null }
export interface BundleRegisterRow { t: 'sales' | 'purchase'; d: string; no: string; party: string | null; gstin: string | null; taxable: number; cgst: number; sgst: number; igst: number; total: number }

export interface ClientDashboardBundle {
  v: 1
  company: { name: string; legalName: string | null; gstin: string | null; pan: string | null; state: string | null; address: string | null }
  firm: { preparedBy: string; contact: string | null; preparedAt: string; reportRef: string | null }
  fy: { label: string; start: string; end: string }
  months: string[]  // 'YYYY-MM', one per FY month in order
  /** The period the view opens on. */
  initial: { from: string; to: string }
  ledgers: BundleLedger[]
  vouchers: BundleVoucher[]
  vouchersTruncated: boolean
  items: BundleItemLine[]
  bills: BundleBill[]
  bank: { l: number; rows: BundleBankRow[] }[]
  regs: BundleRegisterRow[]
}

export interface BundleInput {
  companyId: string
  financialYearId?: string | null
  /** Any date inside the wanted FY, used when no FY id is given. */
  from: string
  to: string
  preparedBy: string
  firmContact: string | null
  reportRef?: string | null
}

const PARTY_GROUPS = new Set(['Sundry Debtors', 'Sundry Creditors'])

function fyMonths(start: string, end: string): string[] {
  const out: string[] = []
  let [y, m] = start.slice(0, 7).split('-').map(Number)
  const stop = end.slice(0, 7)
  for (let i = 0; i < 24; i++) {
    const key = `${y}-${String(m).padStart(2, '0')}`
    out.push(key)
    if (key >= stop) break
    m += 1
    if (m > 12) { m = 1; y += 1 }
  }
  return out
}

export async function buildClientDashboardBundle(prisma: PrismaClient, input: BundleInput): Promise<ClientDashboardBundle> {
  const company = await prisma.bookkeepingCompany.findFirst({
    where: { id: input.companyId, ...alive },
    select: { id: true, name: true, mailingName: true, gstin: true, pan: true, state: true, address: true },
  })
  if (!company) throw new Error('Company not found or inactive.')

  const fy = input.financialYearId
    ? await prisma.bookkeepingFinancialYear.findFirst({ where: { id: input.financialYearId, tallyCompanyId: company.id } })
    : await prisma.bookkeepingFinancialYear.findFirst({
      where: { tallyCompanyId: company.id, startDate: { lte: input.from }, endDate: { gte: input.from } },
    })
  const fyStart = fy?.startDate ?? input.from
  const fyEnd = fy?.endDate ?? input.to
  const months = fyMonths(fyStart, fyEnd)
  const monthIndex = new Map(months.map((m, i) => [m, i]))

  // Openings at FY start (master opening + everything posted before it).
  const balances = await ledgerBalances(company.id, { from: fyStart, to: fyEnd })
  const ledgerIdx = new Map<string, number>()
  const ledgers: BundleLedger[] = balances.map((b, i) => {
    ledgerIdx.set(b.ledgerId, i)
    return {
      n: b.ledgerName, g: b.groupName, p: b.primaryGroupName, nat: b.nature as BundleLedger['nat'], pl: b.affectsPL,
      ob: b.openingPaise, dr: months.map(() => 0), cr: months.map(() => 0),
    }
  })

  const activeInFy = { tallyCompanyId: company.id, status: 'active', ...alive, date: { gte: fyStart, lte: fyEnd } }

  const voucherRows = await prisma.bookkeepingVoucher.findMany({
    where: activeInFy,
    orderBy: [{ date: 'asc' }, { voucherNumber: 'asc' }],
    select: {
      date: true, voucherNumber: true, voucherTypeCode: true, narration: true, grandTotalPaise: true, totalDebitPaise: true,
      referenceNumber: true, taxableValuePaise: true, cgstPaise: true, sgstPaise: true, igstPaise: true,
      voucherType: { select: { name: true } },
      partyLedger: { select: { name: true, gstin: true } },
      entries: { select: { ledgerId: true, entryType: true, amountPaise: true, bankDate: true }, orderBy: { position: 'asc' } },
      items: {
        select: { direction: true, qtyMilli: true, amountPaise: true, stockItem: { select: { name: true, unit: { select: { name: true } } } } },
        orderBy: { position: 'asc' },
      },
    },
  }).then((rs) => rs.map((v) => ({ ...voucherNums(v), entries: v.entries.map(entryNums), items: v.items.map(itemNums) })))

  const bankLedgers = new Set(balances.filter((b) => b.primaryGroupName === 'Bank Accounts').map((b) => b.ledgerId))
  const bankRows = new Map<number, BundleBankRow[]>()
  const vouchers: BundleVoucher[] = []
  const items: BundleItemLine[] = []
  const regs: BundleRegisterRow[] = []

  for (const v of voucherRows) {
    const mi = monthIndex.get(v.date.slice(0, 7))
    const lines: [number, number, number][] = []
    for (const e of v.entries) {
      const li = ledgerIdx.get(e.ledgerId)
      if (li === undefined) continue
      const dr = e.entryType === 'dr' ? e.amountPaise : 0
      const cr = e.entryType === 'cr' ? e.amountPaise : 0
      if (mi !== undefined) { ledgers[li].dr[mi] += dr; ledgers[li].cr[mi] += cr }
      lines.push([li, dr, cr])
      if (bankLedgers.has(e.ledgerId)) {
        const others = v.entries.filter((x) => x.ledgerId !== e.ledgerId).map((x) => ledgers[ledgerIdx.get(x.ledgerId) ?? -1]?.n).filter(Boolean)
        const list = bankRows.get(li) ?? []
        list.push({ d: v.date, no: v.voucherNumber, part: others[0] ?? (v.narration ?? ''), dr, cr, cleared: e.bankDate })
        bankRows.set(li, list)
      }
    }
    vouchers.push({
      d: v.date, no: v.voucherNumber, t: v.voucherTypeCode, tn: v.voucherType.name, party: v.partyLedger?.name ?? null,
      nar: v.narration, amt: v.grandTotalPaise || v.totalDebitPaise, lines,
    })
    if (v.voucherTypeCode === 'sales' || v.voucherTypeCode === 'purchase') {
      const t = v.voucherTypeCode
      regs.push({
        t, d: v.date, no: v.referenceNumber && t === 'purchase' ? v.referenceNumber : v.voucherNumber,
        party: v.partyLedger?.name ?? null, gstin: v.partyLedger?.gstin ?? null,
        taxable: v.taxableValuePaise, cgst: v.cgstPaise, sgst: v.sgstPaise, igst: v.igstPaise, total: v.grandTotalPaise,
      })
      for (const it of v.items) {
        items.push({ d: v.date, t, item: it.stockItem.name, unit: it.stockItem.unit?.name ?? null, qty: it.qtyMilli / 1000, amt: it.amountPaise })
      }
    }
  }

  // Bill-wise position of every debtor / creditor, up to FY end.
  const partyIds = balances.filter((b) => PARTY_GROUPS.has(b.primaryGroupName)).map((b) => b.ledgerId)
  const allocations = partyIds.length ? await prisma.bookkeepingBillAllocation.findMany({
    where: { tallyCompanyId: company.id, ledgerId: { in: partyIds }, date: { lte: fyEnd }, voucher: { status: 'active', ...alive } },
    select: { ledgerId: true, billRef: true, method: true, amountPaise: true, dueDate: true, date: true },
    orderBy: { date: 'asc' },
  }).then((rs) => rs.map((a) => numify(a, 'amountPaise'))) : []
  const billMap = new Map<string, BundleBill>()
  for (const a of allocations) {
    const li = ledgerIdx.get(a.ledgerId)
    if (li === undefined) continue
    const key = `${a.ledgerId}|${a.billRef}`
    let b = billMap.get(key)
    if (!b) { b = { l: li, ref: a.billRef, d: a.date, due: a.dueDate, amt: 0, set: [] }; billMap.set(key, b) }
    if (a.method === 'new') { b.amt += a.amountPaise; b.d = a.date; b.due = a.dueDate ?? b.due }
    else b.set.push([a.date, a.amountPaise])
  }

  const truncated = vouchers.length > MAX_VOUCHERS
  return {
    v: 1,
    company: {
      name: company.name,
      legalName: company.mailingName && company.mailingName !== company.name ? company.mailingName : null,
      gstin: company.gstin ?? null, pan: company.pan ?? null, state: company.state ?? null, address: company.address ?? null,
    },
    firm: {
      preparedBy: input.preparedBy,
      contact: input.firmContact,
      preparedAt: new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }),
      reportRef: input.reportRef ?? null,
    },
    fy: { label: fy?.label ?? `${fyStart.slice(0, 4)}-${fyEnd.slice(2, 4)}`, start: fyStart, end: fyEnd },
    months,
    initial: { from: input.from < fyStart ? fyStart : input.from, to: input.to > fyEnd ? fyEnd : input.to },
    ledgers,
    vouchers: truncated ? vouchers.slice(-MAX_VOUCHERS) : vouchers,
    vouchersTruncated: truncated,
    items,
    bills: [...billMap.values()].filter((b) => b.amt !== 0),
    bank: [...bankRows.entries()].map(([l, rows]) => ({ l, rows })),
    regs,
  }
}
