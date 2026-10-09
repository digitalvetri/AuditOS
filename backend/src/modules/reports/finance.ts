import { Router } from 'express'
import { z } from 'zod'
import { ApiError, handler, ok } from '../../lib/http.js'
import { prisma } from '../../lib/prisma.js'
import { addDays, daysBetween, fiscalYearStartOf, istDateOf, istToday, nextFiscalYearStart } from '../../lib/dates.js'
import { can, requireSession } from '../../platform/auth.js'
import {
  computeDso,
  computeProfitability,
  computeUtilisation,
  costRatePerHour,
  fyLabelOf,
  fyWindow,
  minutesToHours,
  monthsBetween,
  percent,
  weightedDaysToCollect,
  type TimeEntry,
} from './finance-calc.js'
import { fileName, toCsv, toXlsx, type FinanceReport, type ReportColumn } from './finance-export.js'

export * from './finance-calc.js'

/**
 * FINANCE MIS — /api/reports/finance/:report
 *
 * Practice-management numbers for the partners: what the firm billed, what
 * it collected, what the time cost, and who owes TDS certificates.
 *
 * Organisation-scope `reports.finance` or `reports.all` only. Unlike the
 * payroll/expense reports there is no self-scope fallback: none of these
 * reports has a meaningful "my own rows" slice.
 *
 * Definitions used throughout:
 *   billed invoice   deletedAt null, status not draft / cancelled
 *   fees             invoice taxable value (ex-GST), less the taxable value
 *                    of ISSUED credit notes dated in the period
 *   time             CLOSED task sessions (durationMinutes set), by the IST
 *                    date of startedAt
 *   time cost        minutes × the employee's cost rate (see costRatePerHour)
 */
export const financeReportsRouter = Router()

export const FINANCE_REPORTS = [
  { key: 'revenue-by-month', title: 'Revenue by month', description: 'Invoices raised each month: fees ex-GST net of credit notes, GST and invoice totals.' },
  { key: 'revenue-by-service', title: 'Revenue by service', description: 'Fees ex-GST grouped by the service billed.' },
  { key: 'revenue-by-client', title: 'Revenue by client', description: 'Fees, GST, cash collected, TDS, credit notes and outstanding per client.' },
  { key: 'unbilled', title: 'Unbilled work', description: 'Time logged on engagements that have no invoice in the period, at cost.' },
  { key: 'dso', title: 'Days sales outstanding', description: 'Receivable days for the firm and per client, with average days to collect.' },
  { key: 'collections', title: 'Collections', description: 'Cash and TDS received month by month.' },
  { key: 'profitability-client', title: 'Client profitability', description: 'Fees less time cost per client, with margin.' },
  { key: 'profitability-engagement', title: 'Engagement profitability', description: 'Fees less time cost per engagement (client service) and per audit engagement.' },
  { key: 'utilisation', title: 'Staff utilisation', description: 'Task hours against attendance hours, per employee per month.' },
  { key: 'tds-receivable', title: 'TDS receivable', description: 'TDS deducted by clients for the financial year, and certificates still to collect.' },
] as const

export type FinanceReportKey = (typeof FINANCE_REPORTS)[number]['key']

export interface FinanceParams {
  from: string
  to: string
  fy?: string
  clientId?: string
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const querySchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  fy: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  format: z.enum(['json', 'csv', 'xlsx']).default('json'),
  client_id: z.string().min(1).max(64).optional(),
})

// ── Shared loaders ──────────────────────────────────────────────────────

const NOT_BILLED = ['draft', 'cancelled']

function billedWhere(from: string | null, to: string, clientId?: string) {
  return {
    deletedAt: null,
    status: { notIn: NOT_BILLED },
    invoiceDate: from ? { gte: from, lte: to } : { lte: to },
    ...(clientId ? { clientId } : {}),
  }
}

function issuedCreditNoteWhere(from: string | null, to: string, clientId?: string) {
  return {
    deletedAt: null,
    status: 'issued',
    noteDate: from ? { gte: from, lte: to } : { lte: to },
    invoice: { deletedAt: null, status: { not: 'draft' } },
    ...(clientId ? { clientId } : {}),
  }
}

/** Payments counted against billed invoices. */
function paymentWhere(from: string | null, to: string, clientId?: string) {
  return {
    deletedAt: null,
    paidOn: from ? { gte: from, lte: to } : { lte: to },
    invoice: { deletedAt: null, status: { notIn: NOT_BILLED } },
    ...(clientId ? { clientId } : {}),
  }
}

/** [from 00:00 IST, to+1 00:00 IST) as instants. */
function istRange(from: string, to: string) {
  return { gte: new Date(`${from}T00:00:00+05:30`), lt: new Date(`${addDays(to, 1)}T00:00:00+05:30`) }
}

interface SessionRow {
  employeeId: string
  minutes: number
  date: string
  clientId: string | null
  clientServiceId: string | null
  auditEngagementId: string | null
}

async function closedSessions(from: string, to: string, clientId?: string): Promise<SessionRow[]> {
  const rows = await prisma.taskTimeSession.findMany({
    where: {
      startedAt: istRange(from, to),
      endedAt: { not: null },
      durationMinutes: { not: null },
      task: { deletedAt: null, ...(clientId ? { OR: [{ clientId }, { clientId: null, clientService: { clientId } }] } : {}) },
    },
    select: {
      employeeId: true,
      startedAt: true,
      durationMinutes: true,
      task: { select: { clientId: true, clientServiceId: true, auditEngagementId: true, clientService: { select: { clientId: true } } } },
    },
  })
  return rows.map((s) => ({
    employeeId: s.employeeId,
    minutes: s.durationMinutes ?? 0,
    date: istDateOf(s.startedAt),
    clientId: s.task.clientId ?? s.task.clientService?.clientId ?? null,
    clientServiceId: s.task.clientServiceId,
    auditEngagementId: s.task.auditEngagementId,
  }))
}

/** Cost rate per employee, as at `asOf`. */
async function costRates(employeeIds: string[], asOf: string): Promise<Map<string, number>> {
  const ids = [...new Set(employeeIds)]
  if (!ids.length) return new Map()
  const [emps, structures] = await Promise.all([
    prisma.employee.findMany({ where: { id: { in: ids } }, select: { id: true, costRatePaisePerHour: true } }),
    prisma.salaryStructure.findMany({
      where: { employeeId: { in: ids }, deletedAt: null, effectiveFrom: { lte: asOf } },
      select: { employeeId: true, effectiveFrom: true, monthlyCtcPaise: true, deletedAt: true },
    }),
  ])
  const out = new Map<string, number>()
  for (const e of emps) {
    out.set(e.id, costRatePerHour(e, structures.filter((s) => s.employeeId === e.id), asOf))
  }
  return out
}

async function clientNames(ids: Iterable<string>): Promise<Map<string, { name: string; code: string }>> {
  const list = [...new Set(ids)].filter(Boolean)
  if (!list.length) return new Map()
  const rows = await prisma.client.findMany({ where: { id: { in: list } }, select: { id: true, companyName: true, clientCode: true } })
  return new Map(rows.map((c) => [c.id, { name: c.companyName, code: c.clientCode }]))
}

async function clientServiceInfo(ids: Iterable<string>) {
  const list = [...new Set(ids)].filter(Boolean)
  if (!list.length) return new Map<string, { clientId: string; serviceName: string }>()
  const rows = await prisma.clientService.findMany({
    where: { id: { in: list } },
    select: { id: true, clientId: true, service: { select: { name: true } } },
  })
  return new Map(rows.map((r) => [r.id, { clientId: r.clientId, serviceName: r.service.name }]))
}

function add(map: Map<string, number>, key: string, v: number) {
  map.set(key, (map.get(key) ?? 0) + v)
}

function sum<T>(rows: T[], f: (r: T) => number): number {
  return rows.reduce((s, r) => s + f(r), 0)
}

const gstOf = (r: { cgstPaise: number; sgstPaise: number; igstPaise: number }) => r.cgstPaise + r.sgstPaise + r.igstPaise

const COST_RATE_NOTE = 'Time cost uses each employee\'s cost rate per hour; where none is set, the latest salary structure\'s monthly CTC ÷ 200 hours; otherwise nil.'
const TIME_NOTE = 'Time is closed task sessions, dated by when the session started (IST).'

function base(key: FinanceReportKey, p: FinanceParams) {
  const meta = FINANCE_REPORTS.find((r) => r.key === key)!
  return { report: key, title: meta.title, from: p.from, to: p.to }
}

// ── Reports ─────────────────────────────────────────────────────────────

async function revenueByMonth(p: FinanceParams): Promise<FinanceReport> {
  const [invoices, notes] = await Promise.all([
    prisma.invoice.findMany({
      where: billedWhere(p.from, p.to, p.clientId),
      select: { invoiceDate: true, taxablePaise: true, cgstPaise: true, sgstPaise: true, igstPaise: true, totalPaise: true },
    }),
    prisma.creditNote.findMany({
      where: issuedCreditNoteWhere(p.from, p.to, p.clientId),
      select: { noteDate: true, taxablePaise: true, cgstPaise: true, sgstPaise: true, igstPaise: true, totalPaise: true },
    }),
  ])
  const rows = monthsBetween(p.from, p.to).map((month) => {
    const inv = invoices.filter((i) => i.invoiceDate.startsWith(month))
    const cn = notes.filter((n) => n.noteDate.startsWith(month))
    const gross = sum(inv, (i) => i.taxablePaise)
    const credited = sum(cn, (n) => n.taxablePaise)
    return {
      month,
      invoice_count: inv.length,
      gross_fees_paise: gross,
      credit_notes_paise: credited,
      fees_paise: gross - credited,
      gst_paise: sum(inv, gstOf) - sum(cn, gstOf),
      total_invoiced_paise: sum(inv, (i) => i.totalPaise),
      credit_note_total_paise: sum(cn, (n) => n.totalPaise),
    }
  })
  const columns: ReportColumn[] = [
    { key: 'month', label: 'Month', type: 'text' },
    { key: 'invoice_count', label: 'Invoices', type: 'number' },
    { key: 'gross_fees_paise', label: 'Fees invoiced (ex-GST)', type: 'money' },
    { key: 'credit_notes_paise', label: 'Credit notes (ex-GST)', type: 'money' },
    { key: 'fees_paise', label: 'Net fees (ex-GST)', type: 'money' },
    { key: 'gst_paise', label: 'Net GST', type: 'money' },
    { key: 'total_invoiced_paise', label: 'Total invoiced', type: 'money' },
    { key: 'credit_note_total_paise', label: 'Credit notes (incl. GST)', type: 'money' },
  ]
  return {
    ...base('revenue-by-month', p),
    columns,
    rows,
    totals: totalsOf(columns, rows, { month: 'Total' }),
    notes: ['Invoices count by invoice date; credit notes by note date (issued notes only). Drafts and cancelled invoices are excluded.'],
  }
}

async function revenueByService(p: FinanceParams): Promise<FinanceReport> {
  const invoices = await prisma.invoice.findMany({
    where: billedWhere(p.from, p.to, p.clientId),
    select: {
      id: true,
      taxablePaise: true,
      clientServiceId: true,
      items: { select: { serviceId: true, itemName: true, taxableAmountPaise: true } },
    },
  })
  const cs = await clientServiceInfo(invoices.map((i) => i.clientServiceId).filter((x): x is string => !!x))
  const serviceIds = [...new Set(invoices.flatMap((i) => i.items.map((it) => it.serviceId)).filter((x): x is string => !!x))]
  const services = serviceIds.length
    ? new Map((await prisma.service.findMany({ where: { id: { in: serviceIds } }, select: { id: true, name: true } })).map((s) => [s.id, s.name]))
    : new Map<string, string>()

  const fees = new Map<string, number>()
  const invoiceSets = new Map<string, Set<string>>()
  const touch = (name: string, invoiceId: string, paise: number) => {
    add(fees, name, paise)
    if (!invoiceSets.has(name)) invoiceSets.set(name, new Set())
    invoiceSets.get(name)!.add(invoiceId)
  }
  for (const inv of invoices) {
    const svc = inv.clientServiceId ? cs.get(inv.clientServiceId) : undefined
    if (svc) {
      touch(svc.serviceName, inv.id, inv.taxablePaise)
      continue
    }
    for (const it of inv.items) {
      const name = (it.serviceId && services.get(it.serviceId)) || it.itemName?.trim() || 'Unspecified'
      touch(name, inv.id, it.taxableAmountPaise)
    }
  }
  const total = sum([...fees.values()], (v) => v)
  const rows = [...fees.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([service, paise]) => ({
      service,
      invoice_count: invoiceSets.get(service)?.size ?? 0,
      fees_paise: paise,
      share_percent: percent(paise, total),
    }))
  const columns: ReportColumn[] = [
    { key: 'service', label: 'Service', type: 'text' },
    { key: 'invoice_count', label: 'Invoices', type: 'number' },
    { key: 'fees_paise', label: 'Fees (ex-GST)', type: 'money' },
    { key: 'share_percent', label: 'Share', type: 'percent' },
  ]
  return {
    ...base('revenue-by-service', p),
    columns,
    rows,
    totals: { service: 'Total', invoice_count: invoices.length, fees_paise: total, share_percent: total > 0 ? 100 : null },
    notes: [
      'An invoice linked to an engagement counts entirely under that engagement\'s service; otherwise each line counts under its catalogue service, or its item name.',
      'Gross of credit notes: credit notes are not allocated to services.',
    ],
  }
}

/** Receivable per client as at `asOf`: invoice totals less cash, TDS and issued credit notes. */
async function receivablesAsAt(asOf: string, clientId?: string): Promise<Map<string, number>> {
  const [inv, pay, cn] = await Promise.all([
    prisma.invoice.groupBy({ by: ['clientId'], where: billedWhere(null, asOf, clientId), _sum: { totalPaise: true } }),
    prisma.invoicePayment.groupBy({
      by: ['clientId'],
      where: { ...paymentWhere(null, asOf, clientId), invoice: { ...billedWhere(null, asOf, clientId) } },
      _sum: { amountPaise: true, tdsPaise: true },
    }),
    prisma.creditNote.groupBy({
      by: ['clientId'],
      where: { ...issuedCreditNoteWhere(null, asOf, clientId), invoice: { ...billedWhere(null, asOf, clientId) } },
      _sum: { totalPaise: true },
    }),
  ])
  const out = new Map<string, number>()
  for (const r of inv) add(out, r.clientId, r._sum.totalPaise ?? 0)
  for (const r of pay) add(out, r.clientId, -((r._sum.amountPaise ?? 0) + (r._sum.tdsPaise ?? 0)))
  for (const r of cn) add(out, r.clientId, -(r._sum.totalPaise ?? 0))
  return out
}

async function revenueByClient(p: FinanceParams): Promise<FinanceReport> {
  const [invoices, payments, notes, outstanding] = await Promise.all([
    prisma.invoice.findMany({
      where: billedWhere(p.from, p.to, p.clientId),
      select: { clientId: true, taxablePaise: true, cgstPaise: true, sgstPaise: true, igstPaise: true, totalPaise: true },
    }),
    prisma.invoicePayment.findMany({ where: paymentWhere(p.from, p.to, p.clientId), select: { clientId: true, amountPaise: true, tdsPaise: true } }),
    prisma.creditNote.findMany({ where: issuedCreditNoteWhere(p.from, p.to, p.clientId), select: { clientId: true, taxablePaise: true, totalPaise: true } }),
    receivablesAsAt(p.to, p.clientId),
  ])
  const ids = new Set<string>([...invoices.map((i) => i.clientId), ...payments.map((x) => x.clientId), ...notes.map((n) => n.clientId)])
  for (const [id, v] of outstanding) if (v !== 0) ids.add(id)
  const names = await clientNames(ids)
  const rows = [...ids].map((id) => {
    const inv = invoices.filter((i) => i.clientId === id)
    const pay = payments.filter((x) => x.clientId === id)
    const cn = notes.filter((n) => n.clientId === id)
    return {
      client_id: id,
      client_code: names.get(id)?.code ?? '',
      client: names.get(id)?.name ?? '(unknown client)',
      invoice_count: inv.length,
      fees_paise: sum(inv, (i) => i.taxablePaise) - sum(cn, (n) => n.taxablePaise),
      gst_paise: sum(inv, gstOf),
      total_invoiced_paise: sum(inv, (i) => i.totalPaise),
      cash_collected_paise: sum(pay, (x) => x.amountPaise),
      tds_paise: sum(pay, (x) => x.tdsPaise),
      credited_paise: sum(cn, (n) => n.totalPaise),
      outstanding_paise: outstanding.get(id) ?? 0,
    }
  }).sort((a, b) => b.fees_paise - a.fees_paise || a.client.localeCompare(b.client))
  const columns: ReportColumn[] = [
    { key: 'client_code', label: 'Code', type: 'text' },
    { key: 'client', label: 'Client', type: 'text' },
    { key: 'invoice_count', label: 'Invoices', type: 'number' },
    { key: 'fees_paise', label: 'Net fees (ex-GST)', type: 'money' },
    { key: 'gst_paise', label: 'GST invoiced', type: 'money' },
    { key: 'total_invoiced_paise', label: 'Total invoiced', type: 'money' },
    { key: 'cash_collected_paise', label: 'Cash collected', type: 'money' },
    { key: 'tds_paise', label: 'TDS deducted', type: 'money' },
    { key: 'credited_paise', label: 'Credit notes', type: 'money' },
    { key: 'outstanding_paise', label: 'Outstanding', type: 'money' },
  ]
  return {
    ...base('revenue-by-client', p),
    columns,
    rows,
    totals: totalsOf(columns, rows, { client: 'Total', client_code: '' }),
    notes: [
      'Fees are net of issued credit notes in the period. Cash and TDS are by payment date; credit notes by note date.',
      `Outstanding is the receivable as at ${p.to}: invoice totals less cash, TDS and credit notes up to that date.`,
    ],
  }
}

async function unbilled(p: FinanceParams): Promise<FinanceReport> {
  const sessions = (await closedSessions(p.from, p.to, p.clientId)).filter((s) => s.clientServiceId)
  const billed = await prisma.invoice.findMany({
    where: { ...billedWhere(p.from, p.to, p.clientId), clientServiceId: { not: null } },
    select: { clientServiceId: true },
  })
  const billedSet = new Set(billed.map((b) => b.clientServiceId!))
  const open = sessions.filter((s) => !billedSet.has(s.clientServiceId!))
  const rates = await costRates(open.map((s) => s.employeeId), p.to)
  const result = computeProfitability(new Map(), open.map((s) => ({ key: s.clientServiceId!, employeeId: s.employeeId, minutes: s.minutes })), rates)
  const cs = await clientServiceInfo(result.map((r) => r.key))
  const names = await clientNames([...cs.values()].map((c) => c.clientId))
  const rows = result.map((r) => {
    const info = cs.get(r.key)
    return {
      client_service_id: r.key,
      client_id: info?.clientId ?? null,
      client: (info && names.get(info.clientId)?.name) ?? '(unknown client)',
      service: info?.serviceName ?? '(unknown service)',
      hours: r.hours,
      time_cost_paise: r.timeCostPaise,
    }
  }).sort((a, b) => b.time_cost_paise - a.time_cost_paise || a.client.localeCompare(b.client))
  const columns: ReportColumn[] = [
    { key: 'client', label: 'Client', type: 'text' },
    { key: 'service', label: 'Service', type: 'text' },
    { key: 'hours', label: 'Hours', type: 'hours' },
    { key: 'time_cost_paise', label: 'Time cost', type: 'money' },
  ]
  return {
    ...base('unbilled', p),
    columns,
    rows,
    totals: { client: 'Total', service: '', hours: Math.round(sum(rows, (r) => r.hours) * 100) / 100, time_cost_paise: sum(rows, (r) => r.time_cost_paise) },
    notes: [
      'Engagements (client services) with time logged in the period and no billed invoice linked to them dated in the period.',
      'Time on tasks not linked to an engagement is not shown here.',
      TIME_NOTE,
      COST_RATE_NOTE,
    ],
  }
}

async function dso(p: FinanceParams): Promise<FinanceReport> {
  const [invoices, notes, closing, payments] = await Promise.all([
    prisma.invoice.findMany({ where: billedWhere(p.from, p.to, p.clientId), select: { clientId: true, totalPaise: true } }),
    prisma.creditNote.findMany({ where: issuedCreditNoteWhere(p.from, p.to, p.clientId), select: { clientId: true, totalPaise: true } }),
    receivablesAsAt(p.to, p.clientId),
    prisma.invoicePayment.findMany({
      where: paymentWhere(p.from, p.to, p.clientId),
      select: { clientId: true, amountPaise: true, tdsPaise: true, paidOn: true, invoice: { select: { invoiceDate: true } } },
    }),
  ])
  const days = daysBetween(p.from, p.to) + 1
  const revenue = new Map<string, number>()
  for (const i of invoices) add(revenue, i.clientId, i.totalPaise)
  for (const n of notes) add(revenue, n.clientId, -n.totalPaise)
  const ids = new Set<string>([...revenue.keys(), ...payments.map((x) => x.clientId)])
  for (const [id, v] of closing) if (v !== 0) ids.add(id)
  const names = await clientNames(ids)
  const collectFor = (list: typeof payments) =>
    weightedDaysToCollect(list.map((x) => ({ amountPaise: x.amountPaise + x.tdsPaise, days: Math.max(0, daysBetween(x.invoice.invoiceDate, x.paidOn)) })))
  const rows = [...ids].map((id) => {
    const rev = revenue.get(id) ?? 0
    const cl = closing.get(id) ?? 0
    return {
      client_id: id,
      client: names.get(id)?.name ?? '(unknown client)',
      revenue_paise: rev,
      closing_receivables_paise: cl,
      dso_days: computeDso(cl, rev, days),
      avg_days_to_collect: collectFor(payments.filter((x) => x.clientId === id)),
    }
  }).sort((a, b) => b.closing_receivables_paise - a.closing_receivables_paise || a.client.localeCompare(b.client))
  const totalRevenue = sum([...revenue.values()], (v) => v)
  const totalClosing = sum([...closing.values()], (v) => v)
  const columns: ReportColumn[] = [
    { key: 'client', label: 'Client', type: 'text' },
    { key: 'revenue_paise', label: 'Revenue (incl. GST)', type: 'money' },
    { key: 'closing_receivables_paise', label: 'Closing receivables', type: 'money' },
    { key: 'dso_days', label: 'DSO (days)', type: 'number' },
    { key: 'avg_days_to_collect', label: 'Avg days to collect', type: 'number' },
  ]
  return {
    ...base('dso', p),
    columns,
    rows,
    totals: {
      client: 'Firm',
      revenue_paise: totalRevenue,
      closing_receivables_paise: totalClosing,
      dso_days: computeDso(totalClosing, totalRevenue, days),
      avg_days_to_collect: collectFor(payments),
      days_in_period: days,
    },
    notes: [
      `DSO = closing receivables at ${p.to} ÷ revenue incl. GST (net of credit notes) in the period × ${days} days. Blank where there was no revenue.`,
      'Average days to collect is weighted by the amount settled (cash + TDS): payment date less invoice date, for payments received in the period.',
    ],
  }
}

async function collections(p: FinanceParams): Promise<FinanceReport> {
  const payments = await prisma.invoicePayment.findMany({
    where: paymentWhere(p.from, p.to, p.clientId),
    select: { paidOn: true, amountPaise: true, tdsPaise: true },
  })
  const rows = monthsBetween(p.from, p.to).map((month) => {
    const list = payments.filter((x) => x.paidOn.startsWith(month))
    const cash = sum(list, (x) => x.amountPaise)
    const tds = sum(list, (x) => x.tdsPaise)
    return { month, payment_count: list.length, cash_paise: cash, tds_paise: tds, settled_paise: cash + tds }
  })
  const columns: ReportColumn[] = [
    { key: 'month', label: 'Month', type: 'text' },
    { key: 'payment_count', label: 'Payments', type: 'number' },
    { key: 'cash_paise', label: 'Cash collected', type: 'money' },
    { key: 'tds_paise', label: 'TDS deducted', type: 'money' },
    { key: 'settled_paise', label: 'Total settled', type: 'money' },
  ]
  return {
    ...base('collections', p),
    columns,
    rows,
    totals: totalsOf(columns, rows, { month: 'Total' }),
    notes: ['By payment date. Total settled = cash received + TDS deducted by the client.'],
  }
}

/** Issued credit-note taxable value per client, dated in the period. */
async function creditTaxableByClient(p: FinanceParams) {
  const notes = await prisma.creditNote.findMany({ where: issuedCreditNoteWhere(p.from, p.to, p.clientId), select: { clientId: true, taxablePaise: true } })
  const out = new Map<string, number>()
  for (const n of notes) add(out, n.clientId, n.taxablePaise)
  return out
}

async function profitabilityClient(p: FinanceParams): Promise<FinanceReport> {
  const [invoices, credits, sessions] = await Promise.all([
    prisma.invoice.findMany({ where: billedWhere(p.from, p.to, p.clientId), select: { clientId: true, taxablePaise: true } }),
    creditTaxableByClient(p),
    closedSessions(p.from, p.to, p.clientId),
  ])
  const fees = new Map<string, number>()
  for (const i of invoices) add(fees, i.clientId, i.taxablePaise)
  for (const [id, v] of credits) add(fees, id, -v)
  const time: TimeEntry[] = sessions.filter((s) => s.clientId).map((s) => ({ key: s.clientId!, employeeId: s.employeeId, minutes: s.minutes }))
  const rates = await costRates(time.map((t) => t.employeeId), p.to)
  const result = computeProfitability(fees, time, rates)
  const names = await clientNames(result.map((r) => r.key))
  const rows = result.map((r) => ({
    client_id: r.key,
    client: names.get(r.key)?.name ?? '(unknown client)',
    fees_paise: r.feesPaise,
    hours: r.hours,
    time_cost_paise: r.timeCostPaise,
    margin_paise: r.marginPaise,
    margin_percent: r.marginPercent,
  })).sort((a, b) => b.margin_paise - a.margin_paise || a.client.localeCompare(b.client))
  const columns: ReportColumn[] = [
    { key: 'client', label: 'Client', type: 'text' },
    { key: 'fees_paise', label: 'Fees (ex-GST)', type: 'money' },
    { key: 'hours', label: 'Hours', type: 'hours' },
    { key: 'time_cost_paise', label: 'Time cost', type: 'money' },
    { key: 'margin_paise', label: 'Margin', type: 'money' },
    { key: 'margin_percent', label: 'Margin', type: 'percent' },
  ]
  const totalFees = sum(rows, (r) => r.fees_paise)
  const totalMargin = sum(rows, (r) => r.margin_paise)
  return {
    ...base('profitability-client', p),
    columns,
    rows,
    totals: {
      client: 'Total',
      fees_paise: totalFees,
      hours: Math.round(sum(rows, (r) => r.hours) * 100) / 100,
      time_cost_paise: sum(rows, (r) => r.time_cost_paise),
      margin_paise: totalMargin,
      margin_percent: percent(totalMargin, totalFees),
    },
    notes: [
      'Fees are billed invoices dated in the period, ex-GST, less issued credit notes dated in the period.',
      TIME_NOTE,
      COST_RATE_NOTE,
    ],
  }
}

async function profitabilityEngagement(p: FinanceParams): Promise<FinanceReport> {
  const [invoices, notes, sessions] = await Promise.all([
    prisma.invoice.findMany({
      where: { ...billedWhere(p.from, p.to, p.clientId), OR: [{ clientServiceId: { not: null } }, { auditEngagementId: { not: null } }] },
      select: { clientId: true, taxablePaise: true, clientServiceId: true, auditEngagementId: true },
    }),
    prisma.creditNote.findMany({
      where: issuedCreditNoteWhere(p.from, p.to, p.clientId),
      select: { taxablePaise: true, invoice: { select: { clientServiceId: true, auditEngagementId: true } } },
    }),
    closedSessions(p.from, p.to, p.clientId),
  ])
  // Client services (Workstation engagements).
  const csFees = new Map<string, number>()
  for (const i of invoices) if (i.clientServiceId) add(csFees, i.clientServiceId, i.taxablePaise)
  for (const n of notes) if (n.invoice.clientServiceId) add(csFees, n.invoice.clientServiceId, -n.taxablePaise)
  const time: TimeEntry[] = sessions.filter((s) => s.clientServiceId).map((s) => ({ key: s.clientServiceId!, employeeId: s.employeeId, minutes: s.minutes }))
  // Audit engagements: fees on linked invoices, time on linked tasks.
  const audFees = new Map<string, number>()
  for (const i of invoices) if (i.auditEngagementId) add(audFees, i.auditEngagementId, i.taxablePaise)
  for (const n of notes) if (n.invoice.auditEngagementId) add(audFees, n.invoice.auditEngagementId, -n.taxablePaise)
  const audTime: TimeEntry[] = sessions.filter((s) => s.auditEngagementId).map((s) => ({ key: s.auditEngagementId!, employeeId: s.employeeId, minutes: s.minutes }))

  const rates = await costRates([...time, ...audTime].map((t) => t.employeeId), p.to)
  const csRows = computeProfitability(csFees, time, rates)
  const cs = await clientServiceInfo(csRows.map((r) => r.key))
  const audRows = computeProfitability(audFees, audTime, rates)
  const audits = audRows.length
    ? await prisma.auditEngagement.findMany({ where: { id: { in: audRows.map((r) => r.key) } }, select: { id: true, auditCode: true, title: true, clientId: true } })
    : []
  const audById = new Map(audRows.map((r) => [r.key, r]))

  const names = await clientNames([...[...cs.values()].map((c) => c.clientId), ...audits.map((a) => a.clientId)])
  const rows: Record<string, unknown>[] = [
    ...csRows.map((r) => {
      const info = cs.get(r.key)
      return {
        kind: 'client_service',
        id: r.key,
        client: (info && names.get(info.clientId)?.name) ?? '(unknown client)',
        engagement: info?.serviceName ?? '(unknown service)',
        fees_paise: r.feesPaise,
        hours: r.hours,
        time_cost_paise: r.timeCostPaise,
        margin_paise: r.marginPaise,
        margin_percent: r.marginPercent,
      }
    }).sort((a, b) => (b.margin_paise - a.margin_paise) || a.client.localeCompare(b.client)),
    ...audits.map((a) => {
      const r = audById.get(a.id)!
      return {
        kind: 'audit_engagement',
        id: a.id,
        client: names.get(a.clientId)?.name ?? '(unknown client)',
        engagement: `${a.auditCode} — ${a.title}`,
        fees_paise: r.feesPaise,
        hours: r.hours,
        time_cost_paise: r.timeCostPaise,
        margin_paise: r.marginPaise,
        margin_percent: r.marginPercent,
      }
    }).sort((a, b) => (b.margin_paise - a.margin_paise) || a.client.localeCompare(b.client)),
  ]
  const columns: ReportColumn[] = [
    { key: 'kind', label: 'Type', type: 'text' },
    { key: 'client', label: 'Client', type: 'text' },
    { key: 'engagement', label: 'Engagement', type: 'text' },
    { key: 'fees_paise', label: 'Fees (ex-GST)', type: 'money' },
    { key: 'hours', label: 'Hours', type: 'hours' },
    { key: 'time_cost_paise', label: 'Time cost', type: 'money' },
    { key: 'margin_paise', label: 'Margin', type: 'money' },
    { key: 'margin_percent', label: 'Margin', type: 'percent' },
  ]
  return {
    ...base('profitability-engagement', p),
    columns,
    rows,
    totals: null,
    notes: [
      'Client-service fees are billed invoices linked to the engagement, ex-GST, less issued credit notes on those invoices dated in the period; time is its tasks\' closed sessions.',
      'Audit engagements: fees are billed invoices linked to the audit file (less credit notes on them); time is the closed sessions of tasks linked to the audit file. An invoice or task linked to both a client service and an audit file appears under both.',
      TIME_NOTE,
      COST_RATE_NOTE,
    ],
  }
}

async function utilisation(p: FinanceParams): Promise<FinanceReport> {
  const [sessions, attendance] = await Promise.all([
    closedSessions(p.from, p.to),
    prisma.attendance.findMany({
      where: { deletedAt: null, date: { gte: p.from, lte: p.to }, workedMinutes: { not: null } },
      select: { employeeId: true, date: true, workedMinutes: true },
    }),
  ])
  const result = computeUtilisation(
    sessions.map((s) => ({ employeeId: s.employeeId, month: s.date.slice(0, 7), minutes: s.minutes })),
    attendance.map((a) => ({ employeeId: a.employeeId, month: a.date.slice(0, 7), minutes: a.workedMinutes ?? 0 })),
  )
  const empIds = [...new Set(result.map((r) => r.employeeId))]
  const emps = empIds.length
    ? await prisma.employee.findMany({ where: { id: { in: empIds } }, select: { id: true, employeeCode: true, fullName: true } })
    : []
  const byId = new Map(emps.map((e) => [e.id, e]))
  const rows = result.map((r) => ({
    employee_id: r.employeeId,
    employee_code: byId.get(r.employeeId)?.employeeCode ?? '',
    employee: byId.get(r.employeeId)?.fullName ?? '(unknown)',
    month: r.month,
    task_hours: r.taskHours,
    attendance_hours: r.attendanceHours,
    utilisation_percent: r.utilisationPercent,
  })).sort((a, b) => a.employee.localeCompare(b.employee) || a.month.localeCompare(b.month))
  const taskMin = sum(result, (r) => r.taskMinutes)
  const attMin = sum(result, (r) => r.attendanceMinutes)
  const columns: ReportColumn[] = [
    { key: 'employee_code', label: 'Code', type: 'text' },
    { key: 'employee', label: 'Employee', type: 'text' },
    { key: 'month', label: 'Month', type: 'text' },
    { key: 'task_hours', label: 'Task hours', type: 'hours' },
    { key: 'attendance_hours', label: 'Attendance hours', type: 'hours' },
    { key: 'utilisation_percent', label: 'Utilisation', type: 'percent' },
  ]
  return {
    ...base('utilisation', p),
    columns,
    rows,
    totals: {
      employee_code: '',
      employee: 'Total',
      month: '',
      task_hours: minutesToHours(taskMin),
      attendance_hours: minutesToHours(attMin),
      utilisation_percent: percent(taskMin, attMin),
    },
    notes: [
      'Utilisation = task hours (closed task sessions) ÷ attendance hours (worked minutes on attendance). Blank where no attendance was recorded.',
    ],
  }
}

async function tdsReceivable(p: FinanceParams): Promise<FinanceReport> {
  const fy = p.fy ?? fyLabelOf(p.from)
  const win = fyWindow(fy)
  if (!win) throw ApiError.unprocessable('invalid_filters', 'Financial year must look like 2026-27.')
  const payments = await prisma.invoicePayment.findMany({
    where: { ...paymentWhere(win.from, win.to, p.clientId), tdsPaise: { gt: 0 } },
    select: { clientId: true, tdsPaise: true, tdsSection: true, tdsCertificateReceived: true },
  })
  const names = await clientNames(payments.map((x) => x.clientId))
  const ids = [...new Set(payments.map((x) => x.clientId))]
  const rows = ids.map((id) => {
    const list = payments.filter((x) => x.clientId === id)
    const pending = list.filter((x) => !x.tdsCertificateReceived)
    return {
      client_id: id,
      client_code: names.get(id)?.code ?? '',
      client: names.get(id)?.name ?? '(unknown client)',
      fy,
      tds_paise: sum(list, (x) => x.tdsPaise),
      payment_count: list.length,
      certificates_received: list.length - pending.length,
      certificates_pending: pending.length,
      pending_amount_paise: sum(pending, (x) => x.tdsPaise),
      sections: [...new Set(list.map((x) => x.tdsSection?.trim()).filter(Boolean))].sort().join(', '),
      reconciled_26as: false,
    }
  }).sort((a, b) => b.pending_amount_paise - a.pending_amount_paise || a.client.localeCompare(b.client))
  const columns: ReportColumn[] = [
    { key: 'client_code', label: 'Code', type: 'text' },
    { key: 'client', label: 'Client', type: 'text' },
    { key: 'fy', label: 'FY', type: 'text' },
    { key: 'tds_paise', label: 'TDS deducted', type: 'money' },
    { key: 'payment_count', label: 'Payments', type: 'number' },
    { key: 'certificates_received', label: 'Certificates received', type: 'number' },
    { key: 'certificates_pending', label: 'Certificates pending', type: 'number' },
    { key: 'pending_amount_paise', label: 'Amount with certificate pending', type: 'money' },
    { key: 'sections', label: 'Sections', type: 'text' },
    { key: 'reconciled_26as', label: 'Reconciled with 26AS', type: 'boolean' },
  ]
  return {
    report: 'tds-receivable',
    title: 'TDS receivable',
    from: win.from,
    to: win.to,
    columns,
    rows,
    totals: {
      client_code: '',
      client: 'Total',
      fy,
      tds_paise: sum(rows, (r) => r.tds_paise),
      payment_count: sum(rows, (r) => r.payment_count),
      certificates_received: sum(rows, (r) => r.certificates_received),
      certificates_pending: sum(rows, (r) => r.certificates_pending),
      pending_amount_paise: sum(rows, (r) => r.pending_amount_paise),
      sections: '',
      reconciled_26as: false,
    },
    notes: [
      `FY ${fy}: TDS deducted by clients on payments received ${win.from} to ${win.to}.`,
      'Not yet reconciled: to be matched against the 26AS reconciliation module.',
    ],
  }
}

/** Sums every money/number/hours column; `labels` fills the text columns. */
function totalsOf(columns: ReportColumn[], rows: Record<string, unknown>[], labels: Record<string, string>) {
  const t: Record<string, unknown> = { ...labels }
  for (const c of columns) {
    if (c.type === 'money' || c.type === 'number' || c.type === 'hours') {
      const v = rows.reduce<number>((s, r) => s + (typeof r[c.key] === 'number' ? (r[c.key] as number) : 0), 0)
      t[c.key] = c.type === 'hours' ? Math.round(v * 100) / 100 : v
    }
  }
  return t
}

const BUILDERS: Record<FinanceReportKey, (p: FinanceParams) => Promise<FinanceReport>> = {
  'revenue-by-month': revenueByMonth,
  'revenue-by-service': revenueByService,
  'revenue-by-client': revenueByClient,
  unbilled,
  dso,
  collections,
  'profitability-client': profitabilityClient,
  'profitability-engagement': profitabilityEngagement,
  utilisation,
  'tds-receivable': tdsReceivable,
}

export function isFinanceReportKey(k: string): k is FinanceReportKey {
  return Object.prototype.hasOwnProperty.call(BUILDERS, k)
}

export function buildFinanceReport(key: FinanceReportKey, p: FinanceParams): Promise<FinanceReport> {
  return BUILDERS[key](p)
}

/** Default window: the current Indian FY, or the FY named by `fy`. */
export function resolvePeriod(q: { from?: string; to?: string; fy?: string }, today = istToday()): { from: string; to: string } {
  const fyWin = q.fy ? fyWindow(q.fy) : null
  if (q.fy && !fyWin) throw ApiError.unprocessable('invalid_filters', 'Financial year must look like 2026-27.')
  const fyStart = fiscalYearStartOf(today)
  const from = q.from ?? fyWin?.from ?? fyStart
  const to = q.to ?? fyWin?.to ?? addDays(nextFiscalYearStart(fyStart), -1)
  if (from > to) throw ApiError.unprocessable('invalid_filters', 'The start date must be on or before the end date.')
  if (daysBetween(from, to) > 366 * 5) throw ApiError.unprocessable('invalid_filters', 'Choose a period of five years or less.')
  return { from, to }
}

// ── Routes ──────────────────────────────────────────────────────────────

function requireFinanceMis(req: Parameters<typeof requireSession>[0]) {
  const session = requireSession(req)
  if (!can(session, 'reports.finance', 'organisation') && !can(session, 'reports.all', 'organisation')) {
    throw ApiError.forbidden()
  }
  return session
}

financeReportsRouter.get('/', handler(async (req, res) => {
  requireFinanceMis(req)
  return ok(res, { items: FINANCE_REPORTS.map(({ key, title, description }) => ({ key, title, description })) })
}))

financeReportsRouter.get('/:report', handler(async (req, res) => {
  requireFinanceMis(req)
  const key = req.params.report
  if (!isFinanceReportKey(key)) throw ApiError.notFound('No such finance report.')
  const parsed = querySchema.safeParse(req.query)
  if (!parsed.success) {
    throw ApiError.unprocessable('invalid_filters', 'Check the report filters.', parsed.error.flatten().fieldErrors)
  }
  const q = parsed.data
  const period = resolvePeriod(q)
  const report = await buildFinanceReport(key, { ...period, fy: q.fy, clientId: q.client_id })

  if (q.format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="${fileName(report, 'csv')}"`)
    res.setHeader('Cache-Control', 'no-store')
    res.status(200).send(toCsv(report))
    return
  }
  if (q.format === 'xlsx') {
    const buf = await toXlsx(report)
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="${fileName(report, 'xlsx')}"`)
    res.setHeader('Cache-Control', 'no-store')
    res.status(200).send(buf)
    return
  }
  return ok(res, report)
}))

