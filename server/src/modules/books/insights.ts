/**
 * Dashboard snapshot + reports, computed from real Zoho Books records.
 *
 * Every figure here is a sum over rows Zoho returned — nothing is estimated
 * or defaulted. Where a list was capped (maxPages) the result carries
 * `truncated: true` and the UI says the figure covers the most recent rows
 * only. Financial statements Zoho does not expose through its documented
 * API (P&L, balance sheet, cash flow, GST returns) are reported as
 * unavailable rather than approximated.
 */
import { zohoListAll, type ZohoContext } from './client.js'

type Row = Record<string, unknown>
const num = (v: unknown) => (typeof v === 'number' ? v : Number(v ?? 0) || 0)
const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v))
const today = () => new Date().toISOString().slice(0, 10)
const daysBetween = (a: string, b: string) => Math.floor((Date.parse(b) - Date.parse(a)) / 86_400_000)

/** Open documents across the given status filters, de-duplicated by id. */
async function openDocs(ctx: ZohoContext, path: string, listKey: string, idField: string, filters: string[]) {
  const seen = new Map<string, Row>()
  let truncated = false
  for (const filter_by of filters) {
    const r = await zohoListAll<Row>(ctx, path, listKey, { filter_by }, { maxPages: 5 })
    truncated ||= r.truncated
    for (const row of r.rows) {
      const st = str(row.status)
      if (num(row.balance) > 0 && st !== 'void' && st !== 'draft') seen.set(str(row[idField]), row)
    }
  }
  return { rows: [...seen.values()], truncated }
}
export const openInvoices = (ctx: ZohoContext) => openDocs(ctx, 'invoices', 'invoices', 'invoice_id', ['Status.Unpaid', 'Status.PartiallyPaid', 'Status.OverDue'])
export const openBills = (ctx: ZohoContext) => openDocs(ctx, 'bills', 'bills', 'bill_id', ['Status.Open', 'Status.PartiallyPaid', 'Status.Overdue'])

/** Rows dated on/after `from`, walking a date-descending list until it passes `from`. */
async function since(ctx: ZohoContext, path: string, listKey: string, from: string, to = '9999-12-31') {
  const r = await zohoListAll<Row>(ctx, path, listKey, { sort_column: 'date', sort_order: 'D' }, { maxPages: 5, stop: (row) => str(row.date) < from })
  return { rows: r.rows.filter((x) => str(x.date) <= to), truncated: r.truncated }
}

const BUCKETS = ['Current', '1–15 days', '16–30 days', '31–45 days', 'Over 45 days'] as const
function bucketOf(dueDate: string, asOf: string): (typeof BUCKETS)[number] {
  const d = dueDate ? daysBetween(dueDate, asOf) : 0
  return d <= 0 ? BUCKETS[0] : d <= 15 ? BUCKETS[1] : d <= 30 ? BUCKETS[2] : d <= 45 ? BUCKETS[3] : BUCKETS[4]
}
function ageing(rows: Row[], asOf: string) {
  const out = BUCKETS.map((label) => ({ label, amount: 0, count: 0 }))
  for (const r of rows) {
    const b = out.find((x) => x.label === bucketOf(str(r.due_date), asOf))!
    b.amount += num(r.balance); b.count++
  }
  return out
}
function byMonth(rows: Row[], field: string, months: string[]) {
  const m = new Map(months.map((k) => [k, 0]))
  for (const r of rows) {
    const k = str(r.date).slice(0, 7)
    if (m.has(k)) m.set(k, m.get(k)! + num(r[field]))
  }
  return months.map((k) => m.get(k) ?? 0)
}
const pick = (r: Row, keys: string[]) => Object.fromEntries(keys.map((k) => [k, r[k] ?? null]))

export interface DashboardSnapshot {
  as_of: string
  currency_code: string | null
  period: { from: string; to: string }
  totals: Record<string, number>
  counts: Record<string, number>
  monthly: { month: string; revenue: number; expenses: number }[]
  receivables_ageing: { label: string; amount: number; count: number }[]
  payables_ageing: { label: string; amount: number; count: number }[]
  bank_accounts: Row[]
  recent: Record<string, Row[]>
  truncated: boolean
  mixed_currency: boolean
}

export async function computeDashboard(ctx: ZohoContext, currency: string | null): Promise<DashboardSnapshot> {
  const asOf = today()
  const start = new Date(); start.setUTCDate(1); start.setUTCMonth(start.getUTCMonth() - 5)
  const from = start.toISOString().slice(0, 10)
  const months = Array.from({ length: 6 }, (_, i) => { const d = new Date(start); d.setUTCMonth(d.getUTCMonth() + i); return d.toISOString().slice(0, 7) })

  // Sequential on purpose: Zoho's per-minute limit is per organisation.
  const inv = await openInvoices(ctx)
  const bil = await openBills(ctx)
  const sales = await since(ctx, 'invoices', 'invoices', from)
  const purchases = await since(ctx, 'bills', 'bills', from)
  const expenses = await since(ctx, 'expenses', 'expenses', from)
  const received = await since(ctx, 'customerpayments', 'customerpayments', from)
  const paid = await since(ctx, 'vendorpayments', 'vendorpayments', from)
  const banks = await zohoListAll<Row>(ctx, 'bankaccounts', 'bankaccounts', {}, { maxPages: 1 })

  const live = (rows: Row[]) => rows.filter((r) => !['void', 'draft'].includes(str(r.status)))
  const sum = (rows: Row[], f: string) => rows.reduce((t, r) => t + num(r[f]), 0)
  const overdueInv = inv.rows.filter((r) => str(r.due_date) && str(r.due_date) < asOf)
  const overdueBil = bil.rows.filter((r) => str(r.due_date) && str(r.due_date) < asOf)
  const salesLive = live(sales.rows)
  const purchasesLive = live(purchases.rows)
  const expRows = expenses.rows.map((r) => ({ ...r, amount_total: num(r.total ?? r.amount) }))
  const revenueM = byMonth(salesLive, 'total', months)
  const billsM = byMonth(purchasesLive, 'total', months)
  const expM = byMonth(expRows, 'amount_total', months)
  const bankRows = banks.rows.filter((b) => b.is_active !== false)

  const currencies = new Set([...inv.rows, ...bil.rows, ...salesLive].map((r) => str(r.currency_code)).filter(Boolean))
  return {
    as_of: asOf,
    currency_code: currency,
    period: { from, to: asOf },
    totals: {
      receivables: sum(inv.rows, 'balance'),
      payables: sum(bil.rows, 'balance'),
      overdue_receivables: sum(overdueInv, 'balance'),
      overdue_payables: sum(overdueBil, 'balance'),
      revenue: sum(salesLive, 'total'),
      expenses: sum(expRows, 'amount_total') + sum(purchasesLive, 'total'),
      payments_received: sum(received.rows, 'amount'),
      payments_made: sum(paid.rows, 'amount'),
      bank_balance: sum(bankRows, 'balance'),
    },
    counts: {
      outstanding_invoices: inv.rows.length,
      outstanding_bills: bil.rows.length,
      overdue_invoices: overdueInv.length,
      overdue_bills: overdueBil.length,
    },
    monthly: months.map((month, i) => ({ month, revenue: revenueM[i], expenses: billsM[i] + expM[i] })),
    receivables_ageing: ageing(inv.rows, asOf),
    payables_ageing: ageing(bil.rows, asOf),
    bank_accounts: bankRows.map((b) => pick(b, ['account_id', 'account_name', 'account_type', 'balance', 'currency_code', 'bank_name'])),
    recent: {
      invoices: sales.rows.slice(0, 5).map((r) => pick(r, ['invoice_id', 'invoice_number', 'customer_name', 'date', 'total', 'balance', 'status', 'currency_code'])),
      bills: purchases.rows.slice(0, 5).map((r) => pick(r, ['bill_id', 'bill_number', 'vendor_name', 'date', 'total', 'balance', 'status', 'currency_code'])),
      payments: received.rows.slice(0, 5).map((r) => pick(r, ['payment_id', 'payment_number', 'customer_name', 'date', 'amount', 'payment_mode'])),
      expenses: expRows.slice(0, 5).map((r) => pick(r, ['expense_id', 'account_name', 'vendor_name', 'date', 'amount_total', 'status'])),
    },
    truncated: [inv, bil, sales, purchases, expenses, received, paid].some((x) => x.truncated),
    mixed_currency: currency ? [...currencies].some((c) => c !== currency) : currencies.size > 1,
  }
}

// ── reports ──────────────────────────────────────────────────────────────
export interface ReportResult {
  id: string
  title: string
  source: 'computed' | 'unavailable'
  note: string
  columns: { key: string; label: string; money?: boolean }[]
  rows: Row[]
  totals?: Row
  truncated?: boolean
}

export const REPORTS: { id: string; title: string; group: string; dated: boolean; available: boolean }[] = [
  { id: 'receivables_ageing', title: 'Receivables ageing', group: 'Receivables', dated: false, available: true },
  { id: 'customer_balances', title: 'Customer balances', group: 'Receivables', dated: false, available: true },
  { id: 'payables_ageing', title: 'Payables ageing', group: 'Payables', dated: false, available: true },
  { id: 'vendor_balances', title: 'Vendor balances', group: 'Payables', dated: false, available: true },
  { id: 'sales_by_customer', title: 'Sales by customer', group: 'Sales', dated: true, available: true },
  { id: 'purchases_by_vendor', title: 'Purchases by vendor', group: 'Purchases', dated: true, available: true },
  { id: 'expenses_by_category', title: 'Expenses by category', group: 'Expenses', dated: true, available: true },
  { id: 'profit_and_loss', title: 'Profit & Loss', group: 'Financial statements', dated: true, available: false },
  { id: 'balance_sheet', title: 'Balance Sheet', group: 'Financial statements', dated: false, available: false },
  { id: 'cash_flow', title: 'Cash Flow', group: 'Financial statements', dated: true, available: false },
  { id: 'tax_summary', title: 'Tax / GST summary', group: 'Taxes', dated: true, available: false },
]

const UNAVAILABLE = 'This report is not available through the current Zoho Books API integration.'
const COMPUTED = 'Computed in Audit OS from Zoho Books records; not an official Zoho Books report.'

function group(rows: Row[], keyField: string, labelField: string, amountField: string) {
  const m = new Map<string, { name: string; count: number; amount: number }>()
  for (const r of rows) {
    const k = str(r[keyField]) || str(r[labelField]) || '—'
    const g = m.get(k) ?? { name: str(r[labelField]) || '—', count: 0, amount: 0 }
    g.count++; g.amount += num(r[amountField])
    m.set(k, g)
  }
  return [...m.values()].sort((a, b) => b.amount - a.amount)
}

export async function runReport(ctx: ZohoContext, id: string, from: string, to: string): Promise<ReportResult> {
  const def = REPORTS.find((r) => r.id === id)
  if (!def) throw new Error('unknown report')
  const base = { id, title: def.title, columns: [], rows: [] }
  if (!def.available) return { ...base, source: 'unavailable', note: UNAVAILABLE }
  const asOf = today()

  if (id === 'receivables_ageing' || id === 'payables_ageing') {
    const recv = id === 'receivables_ageing'
    const docs = recv ? await openInvoices(ctx) : await openBills(ctx)
    const nameF = recv ? 'customer_name' : 'vendor_name'
    const m = new Map<string, Row>()
    for (const r of docs.rows) {
      const k = str(r[nameF]) || '—'
      const row = m.get(k) ?? Object.fromEntries([['name', k], ...BUCKETS.map((b) => [b, 0]), ['total', 0]])
      const b = bucketOf(str(r.due_date), asOf)
      row[b] = num(row[b]) + num(r.balance); row.total = num(row.total) + num(r.balance)
      m.set(k, row)
    }
    const rows = [...m.values()].sort((a, b) => num(b.total) - num(a.total))
    const totals = Object.fromEntries([['name', 'Total'], ...[...BUCKETS, 'total'].map((b) => [b, rows.reduce((t, r) => t + num(r[b]), 0)])])
    return { ...base, source: 'computed', note: `${COMPUTED} Balances as of ${asOf}.`, columns: [{ key: 'name', label: recv ? 'Customer' : 'Vendor' }, ...BUCKETS.map((b) => ({ key: b, label: b, money: true })), { key: 'total', label: 'Total', money: true }], rows, totals, truncated: docs.truncated }
  }

  if (id === 'customer_balances' || id === 'vendor_balances') {
    const cust = id === 'customer_balances'
    const field = cust ? 'outstanding_receivable_amount' : 'outstanding_payable_amount'
    const r = await zohoListAll<Row>(ctx, 'contacts', 'contacts', { contact_type: cust ? 'customer' : 'vendor' }, { maxPages: 10 })
    const rows = r.rows.filter((c) => num(c[field]) !== 0).map((c) => ({ name: c.contact_name, company: c.company_name, balance: num(c[field]) })).sort((a, b) => b.balance - a.balance)
    return { ...base, source: 'computed', note: COMPUTED, columns: [{ key: 'name', label: cust ? 'Customer' : 'Vendor' }, { key: 'company', label: 'Company' }, { key: 'balance', label: 'Outstanding', money: true }], rows, totals: { name: 'Total', balance: rows.reduce((t, x) => t + x.balance, 0) }, truncated: r.truncated }
  }

  const spec = {
    sales_by_customer: { path: 'invoices', listKey: 'invoices', key: 'customer_id', label: 'customer_name', amount: 'total', col: 'Customer' },
    purchases_by_vendor: { path: 'bills', listKey: 'bills', key: 'vendor_id', label: 'vendor_name', amount: 'total', col: 'Vendor' },
    expenses_by_category: { path: 'expenses', listKey: 'expenses', key: 'account_id', label: 'account_name', amount: 'total', col: 'Category' },
  }[id as 'sales_by_customer']
  const r = await since(ctx, spec.path, spec.listKey, from, to)
  const liveRows = r.rows.filter((x) => !['void', 'draft'].includes(str(x.status))).map((x) => ({ ...x, total: num(x.total ?? x.amount) }))
  const rows = group(liveRows, spec.key, spec.label, spec.amount)
  return { ...base, source: 'computed', note: `${COMPUTED} ${from} to ${to}; void and draft excluded.`, columns: [{ key: 'name', label: spec.col }, { key: 'count', label: 'Documents' }, { key: 'amount', label: 'Amount', money: true }], rows, totals: { name: 'Total', count: rows.reduce((t, x) => t + x.count, 0), amount: rows.reduce((t, x) => t + x.amount, 0) }, truncated: r.truncated }
}
