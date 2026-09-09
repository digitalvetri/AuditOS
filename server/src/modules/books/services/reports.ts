import type { PrismaClient } from '@prisma/client'
import { ApiError } from '../../../lib/http.js'
import type { BooksContext } from '../engine/context.js'
import type { Minor } from '../engine/money.js'

/**
 * REPORTS — every figure is computed live from journal lines. There is no
 * summary table to drift. Voided journals stay in with their reversals
 * (they cancel), so history and totals agree.
 *
 * Sign convention inside this file: `net` = debit − credit. Asset and
 * expense ledgers are naturally positive, liability / equity / income
 * naturally negative; the report shapes flip the sign where a reader
 * expects a positive figure.
 */
const LIVE = { in: ['posted', 'void'] }

interface LedgerNet { ledger_id: string; name: string; root: string; tally_group: string; group_id: string; debit: Minor; credit: Minor; net: Minor }

async function ledgerNets(prisma: PrismaClient, ctx: BooksContext, f: { from?: string; to?: string; roots?: string[] }): Promise<LedgerNet[]> {
  const ledgers = await prisma.booksLedger.findMany({ where: { booksOrgId: ctx.booksOrgId, deletedAt: null, ...(f.roots ? { rootCategory: { in: f.roots } } : {}) }, orderBy: [{ rootCategory: 'asc' }, { tallyGroup: 'asc' }, { name: 'asc' }] })
  const sums = await prisma.booksJournalLine.groupBy({
    by: ['ledgerId', 'side'],
    where: { booksOrgId: ctx.booksOrgId, journal: { status: LIVE, ...(f.from || f.to ? { date: { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lte: f.to } : {}) } } : {}) } },
    _sum: { amount: true },
  })
  return ledgers.map((l) => {
    const debit = sums.find((s) => s.ledgerId === l.id && s.side === 'debit')?._sum.amount ?? 0n
    const credit = sums.find((s) => s.ledgerId === l.id && s.side === 'credit')?._sum.amount ?? 0n
    return { ledger_id: l.id, name: l.name, root: l.rootCategory, tally_group: l.tallyGroup, group_id: l.groupId, debit, credit, net: debit - credit }
  })
}

function fyStart(date: string, startMonth: number): string {
  const [y, m] = date.split('-').map(Number)
  const year = m >= startMonth ? y : y - 1
  return `${year}-${String(startMonth).padStart(2, '0')}-01`
}

export const Reports = {
  trialBalance: async (prisma: PrismaClient, ctx: BooksContext, asOf: string) => {
    const rows = (await ledgerNets(prisma, ctx, { to: asOf })).filter((r) => r.debit !== 0n || r.credit !== 0n)
    const out = rows.map((r) => ({ ...r, closing_debit: r.net > 0n ? r.net : 0n, closing_credit: r.net < 0n ? -r.net : 0n }))
    return {
      as_of: asOf, rows: out,
      totals: { debit: out.reduce((t, r) => t + r.debit, 0n), credit: out.reduce((t, r) => t + r.credit, 0n), closing_debit: out.reduce((t, r) => t + r.closing_debit, 0n), closing_credit: out.reduce((t, r) => t + r.closing_credit, 0n) },
    }
  },

  profitAndLoss: async (prisma: PrismaClient, ctx: BooksContext, from: string, to: string) => {
    const rows = await ledgerNets(prisma, ctx, { from, to, roots: ['income', 'expense'] })
    const income = rows.filter((r) => r.root === 'income' && r.net !== 0n).map((r) => ({ ...r, amount: -r.net }))
    const expense = rows.filter((r) => r.root === 'expense' && r.net !== 0n).map((r) => ({ ...r, amount: r.net }))
    const group = (xs: typeof income) => { const m = new Map<string, Minor>(); for (const x of xs) m.set(x.tally_group, (m.get(x.tally_group) ?? 0n) + x.amount); return [...m].map(([g, a]) => ({ tally_group: g, amount: a })) }
    const totalIncome = income.reduce((t, r) => t + r.amount, 0n)
    const totalExpense = expense.reduce((t, r) => t + r.amount, 0n)
    return { from, to, income, expense, income_by_group: group(income), expense_by_group: group(expense), total_income: totalIncome, total_expense: totalExpense, net_profit: totalIncome - totalExpense }
  },

  balanceSheet: async (prisma: PrismaClient, ctx: BooksContext, asOf: string) => {
    const org = await prisma.booksOrganisation.findUniqueOrThrow({ where: { id: ctx.booksOrgId } })
    const rows = await ledgerNets(prisma, ctx, { to: asOf, roots: ['asset', 'liability', 'equity'] })
    const assets = rows.filter((r) => r.root === 'asset' && r.net !== 0n).map((r) => ({ ...r, amount: r.net }))
    const liabilities = rows.filter((r) => r.root === 'liability' && r.net !== 0n).map((r) => ({ ...r, amount: -r.net }))
    const equity = rows.filter((r) => r.root === 'equity' && r.net !== 0n).map((r) => ({ ...r, amount: -r.net }))
    // Earnings: everything income/expense up to the date (prior years + current year) — retained earnings are
    // whatever the books carry in equity plus the accumulated P&L, so the sheet always balances.
    const pl = await ledgerNets(prisma, ctx, { to: asOf, roots: ['income', 'expense'] })
    const accumulated = pl.reduce((t, r) => t - r.net, 0n)
    const fy = fyStart(asOf, org.fiscalYearStartMonth)
    const current = (await ledgerNets(prisma, ctx, { from: fy, to: asOf, roots: ['income', 'expense'] })).reduce((t, r) => t - r.net, 0n)
    const totalAssets = assets.reduce((t, r) => t + r.amount, 0n)
    const totalLiabilities = liabilities.reduce((t, r) => t + r.amount, 0n)
    const totalEquity = equity.reduce((t, r) => t + r.amount, 0n) + accumulated
    return {
      as_of: asOf, assets, liabilities, equity, current_year_earnings: current, prior_years_earnings: accumulated - current,
      total_assets: totalAssets, total_liabilities: totalLiabilities, total_equity: totalEquity,
      difference: totalAssets - totalLiabilities - totalEquity,
    }
  },

  /** Direct-method cash flow: movements on bank/cash ledgers, classified by the counter-ledger's root. */
  cashFlow: async (prisma: PrismaClient, ctx: BooksContext, from: string, to: string) => {
    const cashLedgers = await prisma.booksLedger.findMany({ where: { booksOrgId: ctx.booksOrgId, deletedAt: null, OR: [{ isBank: true }, { isCash: true }] } })
    const cashIds = new Set(cashLedgers.map((l) => l.id))
    const journals = await prisma.booksJournal.findMany({ where: { booksOrgId: ctx.booksOrgId, status: LIVE, date: { gte: from, lte: to }, lines: { some: { ledgerId: { in: [...cashIds] } } } }, include: { lines: { include: { ledger: true } } } })
    const buckets = { operating: 0n, investing: 0n, financing: 0n }
    const detail: { journal: string; date: string; narration: string | null; amount: Minor; category: keyof typeof buckets }[] = []
    for (const j of journals) {
      const cashDelta = j.lines.filter((l) => cashIds.has(l.ledgerId)).reduce((t, l) => t + (l.side === 'debit' ? l.amount : -l.amount), 0n)
      const others = j.lines.filter((l) => !cashIds.has(l.ledgerId))
      if (cashDelta === 0n || others.length === 0) continue   // pure bank-to-bank transfer
      const dominant = others.sort((a, b) => (b.amount > a.amount ? 1 : -1))[0].ledger
      const category: keyof typeof buckets = dominant.tallyGroup === 'Fixed Assets' ? 'investing'
        : ['Capital Account', 'Reserves & Surplus', 'Loans (Liability)'].includes(dominant.tallyGroup) ? 'financing' : 'operating'
      buckets[category] += cashDelta
      detail.push({ journal: j.number, date: j.date, narration: j.narration, amount: cashDelta, category })
    }
    const opening = (await ledgerNets(prisma, ctx, { to: addDays(from, -1) })).filter((r) => cashIds.has(r.ledger_id)).reduce((t, r) => t + r.net, 0n)
    const net = buckets.operating + buckets.investing + buckets.financing
    return { from, to, ...buckets, net_change: net, opening_cash: opening, closing_cash: opening + net, detail }
  },

  generalLedger: async (prisma: PrismaClient, ctx: BooksContext, ledgerId: string, from: string, to: string) => {
    const ledger = await prisma.booksLedger.findFirst({ where: { id: ledgerId, booksOrgId: ctx.booksOrgId, deletedAt: null } })
    if (!ledger) throw ApiError.notFound('Ledger not found.')
    const opening = (await ledgerNets(prisma, ctx, { to: addDays(from, -1) })).find((r) => r.ledger_id === ledgerId)?.net ?? 0n
    const lines = await prisma.booksJournalLine.findMany({
      where: { booksOrgId: ctx.booksOrgId, ledgerId, journal: { status: LIVE, date: { gte: from, lte: to } } },
      include: { journal: { select: { id: true, number: true, date: true, narration: true, voucherType: true, status: true, sourceModule: true, sourceId: true } } },
      orderBy: [{ journal: { date: 'asc' } }, { journal: { createdAt: 'asc' } }, { lineNo: 'asc' }],
    })
    let running = opening
    const rows = lines.map((l) => { running += l.side === 'debit' ? l.amount : -l.amount; return { ...l, running } })
    return { ledger, from, to, opening, rows, closing: running, total_debit: lines.filter((l) => l.side === 'debit').reduce((t, l) => t + l.amount, 0n), total_credit: lines.filter((l) => l.side === 'credit').reduce((t, l) => t + l.amount, 0n) }
  },

  ageing: async (prisma: PrismaClient, ctx: BooksContext, kind: 'receivable' | 'payable', asOf: string) => {
    const side = kind === 'receivable' ? 'debit' : 'credit'
    const bills = await prisma.booksBill.findMany({ where: { booksOrgId: ctx.booksOrgId, side, status: 'open', balance: { gt: 0n }, date: { lte: asOf } } })
    const contacts = new Map((await prisma.booksContact.findMany({ where: { booksOrgId: ctx.booksOrgId } })).map((c) => [c.id, c.displayName]))
    const bucketOf = (days: number) => (days <= 0 ? 'current' : days <= 30 ? 'd1_30' : days <= 60 ? 'd31_60' : days <= 90 ? 'd61_90' : 'd90_plus')
    const empty = () => ({ current: 0n, d1_30: 0n, d31_60: 0n, d61_90: 0n, d90_plus: 0n, total: 0n })
    const byContact = new Map<string, ReturnType<typeof empty> & { contact_id: string | null; contact: string; items: { bill_no: string; date: string; due_date: string | null; days_overdue: number; balance: Minor; currency: string; fx_balance: Minor }[] }>()
    for (const b of bills) {
      const due = b.dueDate ?? b.date
      const days = Math.floor((Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${due}T00:00:00Z`)) / 86_400_000)
      const key = b.contactId ?? 'none'
      const row = byContact.get(key) ?? { ...empty(), contact_id: b.contactId, contact: b.contactId ? contacts.get(b.contactId) ?? '—' : '—', items: [] }
      row[bucketOf(days)] += b.balance
      row.total += b.balance
      row.items.push({ bill_no: b.billNo, date: b.date, due_date: b.dueDate, days_overdue: Math.max(days, 0), balance: b.balance, currency: b.currency, fx_balance: b.fxBalance })
      byContact.set(key, row)
    }
    const rows = [...byContact.values()].sort((a, b) => (b.total > a.total ? 1 : -1))
    const totals = empty()
    for (const r of rows) for (const k of Object.keys(totals) as (keyof typeof totals)[]) totals[k] += r[k]
    return { kind, as_of: asOf, rows, totals }
  },

  // ── GST returns, computed from posted documents ─────────────────────────
  gstr1: async (prisma: PrismaClient, ctx: BooksContext, from: string, to: string) => {
    const docs = await prisma.booksDocument.findMany({ where: { booksOrgId: ctx.booksOrgId, kind: { in: ['invoice', 'credit_note'] }, status: { notIn: ['draft', 'sent', 'void'] }, date: { gte: from, lte: to } }, include: { lines: true } })
    const contacts = new Map((await prisma.booksContact.findMany({ where: { booksOrgId: ctx.booksOrgId } })).map((c) => [c.id, c]))
    const byRate = (d: (typeof docs)[number]) => {
      const m = new Map<number, { rate_bp: number; taxable: Minor; cgst: Minor; sgst: Minor; igst: Minor }>()
      for (const l of d.lines) { const r = m.get(l.taxPercentBp) ?? { rate_bp: l.taxPercentBp, taxable: 0n, cgst: 0n, sgst: 0n, igst: 0n }; r.taxable += l.taxable; r.cgst += l.cgst; r.sgst += l.sgst; r.igst += l.igst; m.set(l.taxPercentBp, r) }
      return [...m.values()]
    }
    const row = (d: (typeof docs)[number]) => { const c = contacts.get(d.contactId); return { number: d.number, date: d.date, contact: c?.displayName ?? '', gstin: c?.gstin ?? null, place_of_supply: d.placeOfSupply, inter_state: d.isInterState, value: d.total, taxable: d.taxableTotal, cgst: d.cgstTotal, sgst: d.sgstTotal, igst: d.igstTotal, rates: byRate(d) } }
    const invoices = docs.filter((d) => d.kind === 'invoice')
    const notes = docs.filter((d) => d.kind === 'credit_note')
    const isB2B = (d: (typeof docs)[number]) => Boolean(contacts.get(d.contactId)?.gstin)
    const hsn = new Map<string, { hsn_sac: string; description: string; quantity: number; taxable: Minor; cgst: Minor; sgst: Minor; igst: Minor }>()
    for (const d of invoices) for (const l of d.lines) { const k = l.hsnSac ?? 'NA'; const r = hsn.get(k) ?? { hsn_sac: k, description: l.description, quantity: 0, taxable: 0n, cgst: 0n, sgst: 0n, igst: 0n }; r.quantity += l.quantity; r.taxable += l.taxable; r.cgst += l.cgst; r.sgst += l.sgst; r.igst += l.igst; hsn.set(k, r) }
    const sumOf = (xs: ReturnType<typeof row>[]) => ({ count: xs.length, taxable: xs.reduce((t, x) => t + x.taxable, 0n), cgst: xs.reduce((t, x) => t + x.cgst, 0n), sgst: xs.reduce((t, x) => t + x.sgst, 0n), igst: xs.reduce((t, x) => t + x.igst, 0n), value: xs.reduce((t, x) => t + x.value, 0n) })
    const b2b = invoices.filter(isB2B).map(row), b2c = invoices.filter((d) => !isB2B(d)).map(row), cdnr = notes.filter(isB2B).map(row), cdnur = notes.filter((d) => !isB2B(d)).map(row)
    return { period: { from, to }, gstin: (await prisma.booksOrganisation.findUniqueOrThrow({ where: { id: ctx.booksOrgId } })).gstin, b2b, b2c, cdnr, cdnur, hsn: [...hsn.values()], summary: { b2b: sumOf(b2b), b2c: sumOf(b2c), cdnr: sumOf(cdnr), cdnur: sumOf(cdnur) } }
  },

  gstr3b: async (prisma: PrismaClient, ctx: BooksContext, from: string, to: string) => {
    const docs = await prisma.booksDocument.findMany({ where: { booksOrgId: ctx.booksOrgId, kind: { in: ['invoice', 'credit_note', 'bill', 'vendor_credit'] }, status: { notIn: ['draft', 'sent', 'void'] }, date: { gte: from, lte: to } } })
    const agg = (kinds: string[], sign: 1n | -1n) => docs.filter((d) => kinds.includes(d.kind)).reduce((t, d) => ({ taxable: t.taxable + sign * d.taxableTotal, igst: t.igst + sign * d.igstTotal, cgst: t.cgst + sign * d.cgstTotal, sgst: t.sgst + sign * d.sgstTotal }), { taxable: 0n, igst: 0n, cgst: 0n, sgst: 0n })
    const add = (a: ReturnType<typeof agg>, b: ReturnType<typeof agg>) => ({ taxable: a.taxable + b.taxable, igst: a.igst + b.igst, cgst: a.cgst + b.cgst, sgst: a.sgst + b.sgst })
    const outward = add(agg(['invoice'], 1n), agg(['credit_note'], -1n))
    const itc = add(agg(['bill'], 1n), agg(['vendor_credit'], -1n))
    return {
      period: { from, to },
      '3_1_outward_supplies': outward,
      '4_eligible_itc': itc,
      net_payable: { igst: outward.igst - itc.igst, cgst: outward.cgst - itc.cgst, sgst: outward.sgst - itc.sgst },
    }
  },

  /** TDS deducted on bills in the period, by section — for 26Q preparation. */
  tdsSummary: async (prisma: PrismaClient, ctx: BooksContext, from: string, to: string) => {
    const bills = await prisma.booksDocument.findMany({ where: { booksOrgId: ctx.booksOrgId, kind: 'bill', status: { notIn: ['draft', 'void'] }, tdsTotal: { gt: 0n }, date: { gte: from, lte: to } } })
    const rates = new Map((await prisma.booksTaxRate.findMany({ where: { booksOrgId: ctx.booksOrgId, type: 'tds' } })).map((t) => [t.id, t]))
    const contacts = new Map((await prisma.booksContact.findMany({ where: { booksOrgId: ctx.booksOrgId } })).map((c) => [c.id, c]))
    return bills.map((b) => { const r = b.tdsRateId ? rates.get(b.tdsRateId) : undefined; const c = contacts.get(b.contactId); return { bill: b.number, date: b.date, vendor: c?.displayName ?? '', pan: c?.pan ?? null, section: r?.section ?? null, rate_bp: r?.percentageBp ?? null, taxable: b.taxableTotal, tds: b.tdsTotal } })
  },
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10)
}
