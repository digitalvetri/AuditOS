/**
 * SALES REGISTER — Official docs → Sales register.
 *
 * Every invoice the firm issued in a financial year, month by month, with the
 * GST split (taxable, CGST, SGST, IGST, total), less the credit notes issued
 * in the same month. Drafts have no number and are not sales; cancelled
 * invoices are listed (a gap in the series must be explainable) but count
 * zero. Same visibility as the Invoices list.
 *
 *   GET /api/invoices/sales-register?fy=2026-27          JSON
 *   GET /api/invoices/sales-register/export?fy=2026-27   .xlsx
 */
import ExcelJS from 'exceljs'
import { prisma } from '../../lib/prisma.js'
import { istToday } from '../../lib/dates.js'
import type { Session } from '../../platform/auth.js'
import type { Scope } from '../../platform/rbac/matrix.js'
import { fyLabel, fyOfDate } from '../compliance/engine.js'
import { visibleWhere } from './service.js'

export interface Money { taxable: number; cgst: number; sgst: number; igst: number; total: number }
export interface RegisterRow extends Money {
  kind: 'invoice' | 'credit_note'
  id: string
  number: string
  date: string
  month: string
  client_id: string
  party: string
  gstin: string | null
  place_of_supply: string | null
  inter_state: boolean
  status: string
}
export interface RegisterMonth {
  month: string
  invoices: number
  credit_notes: number
  sales: Money
  credits: Money
  net: Money
}

const zero = (): Money => ({ taxable: 0, cgst: 0, sgst: 0, igst: 0, total: 0 })
const add = (a: Money, b: Money, sign = 1) => {
  a.taxable += sign * b.taxable; a.cgst += sign * b.cgst; a.sgst += sign * b.sgst; a.igst += sign * b.igst; a.total += sign * b.total
}

/** '2026-27' → its twelve months, April first. */
export function fyMonths(fy: string): string[] {
  const start = Number(fy.slice(0, 4))
  return Array.from({ length: 12 }, (_, i) => {
    const m = ((i + 3) % 12) + 1
    const y = i < 9 ? start : start + 1
    return `${y}-${String(m).padStart(2, '0')}`
  })
}

export const isFy = (s: string) => /^\d{4}-\d{2}$/.test(s) && fyLabel(Number(s.slice(0, 4))) === s

export async function salesRegister(session: Session, scope: Scope, fy: string = fyOfDate(istToday())) {
  const months = fyMonths(fy)
  const from = `${months[0]}-01`
  const to = `${months[11]}-31`
  const where = await visibleWhere(session, scope)

  const invoices = await prisma.invoice.findMany({
    where: { ...where, invoiceNumber: { not: null }, status: { not: 'draft' }, invoiceDate: { gte: from, lte: to } },
    orderBy: [{ invoiceDate: 'asc' }, { invoiceNumber: 'asc' }],
    select: {
      id: true, invoiceNumber: true, invoiceDate: true, clientId: true, billingName: true, customerGstin: true,
      placeOfSupply: true, isInterState: true, status: true,
      taxablePaise: true, cgstPaise: true, sgstPaise: true, igstPaise: true, totalPaise: true,
    },
  })
  // A credit note follows its invoice's visibility.
  const notes = await prisma.creditNote.findMany({
    where: { status: { not: 'draft' }, creditNoteNumber: { not: null }, noteDate: { gte: from, lte: to }, invoice: where },
    orderBy: [{ noteDate: 'asc' }, { creditNoteNumber: 'asc' }],
    select: {
      id: true, creditNoteNumber: true, noteDate: true, clientId: true, status: true, isInterState: true, placeOfSupply: true,
      taxablePaise: true, cgstPaise: true, sgstPaise: true, igstPaise: true, totalPaise: true,
      invoice: { select: { billingName: true, customerGstin: true } },
    },
  })

  const money = (r: { taxablePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number; totalPaise: number }, counts: boolean): Money =>
    counts ? { taxable: r.taxablePaise, cgst: r.cgstPaise, sgst: r.sgstPaise, igst: r.igstPaise, total: r.totalPaise } : zero()

  const rows: RegisterRow[] = [
    ...invoices.map((i) => ({
      kind: 'invoice' as const, id: i.id, number: i.invoiceNumber!, date: i.invoiceDate, month: i.invoiceDate.slice(0, 7),
      client_id: i.clientId, party: i.billingName ?? '', gstin: i.customerGstin, place_of_supply: i.placeOfSupply,
      inter_state: i.isInterState, status: i.status, ...money(i, i.status !== 'cancelled'),
    })),
    ...notes.map((n) => ({
      kind: 'credit_note' as const, id: n.id, number: n.creditNoteNumber!, date: n.noteDate, month: n.noteDate.slice(0, 7),
      client_id: n.clientId, party: n.invoice.billingName ?? '', gstin: n.invoice.customerGstin, place_of_supply: n.placeOfSupply,
      inter_state: n.isInterState, status: n.status, ...money(n, n.status !== 'cancelled'),
    })),
  ].sort((a, b) => a.date.localeCompare(b.date) || a.number.localeCompare(b.number))

  const byMonth = new Map(months.map((m) => [m, { month: m, invoices: 0, credit_notes: 0, sales: zero(), credits: zero(), net: zero() } as RegisterMonth]))
  const totals: RegisterMonth = { month: fy, invoices: 0, credit_notes: 0, sales: zero(), credits: zero(), net: zero() }
  for (const r of rows) {
    const m = byMonth.get(r.month)
    if (!m) continue
    for (const t of [m, totals]) {
      if (r.kind === 'invoice') { t.invoices += 1; add(t.sales, r); add(t.net, r) } else { t.credit_notes += 1; add(t.credits, r); add(t.net, r, -1) }
    }
  }
  return { fy, months: [...byMonth.values()], totals, rows }
}

const STATUS: Record<string, string> = {
  sent: 'Sent', partially_paid: 'Part paid', paid: 'Paid', overdue: 'Overdue', cancelled: 'Cancelled', issued: 'Issued',
}

export async function salesRegisterWorkbook(reg: Awaited<ReturnType<typeof salesRegister>>, firmName = 'Sales register') {
  const wb = new ExcelJS.Workbook()
  wb.creator = firmName
  const rupees = (p: number) => Math.round(p) / 100
  const fmt = '#,##0.00;[Red]-#,##0.00'
  const monthName = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleString('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' })

  const sum = wb.addWorksheet('Month-wise')
  sum.columns = [
    { header: 'Month', key: 'm', width: 12 },
    { header: 'Invoices', key: 'n', width: 10 },
    { header: 'Taxable', key: 't', width: 16, style: { numFmt: fmt } },
    { header: 'CGST', key: 'c', width: 14, style: { numFmt: fmt } },
    { header: 'SGST', key: 's', width: 14, style: { numFmt: fmt } },
    { header: 'IGST', key: 'i', width: 14, style: { numFmt: fmt } },
    { header: 'Invoice total', key: 'v', width: 16, style: { numFmt: fmt } },
    { header: 'Credit notes', key: 'cn', width: 12 },
    { header: 'Credit note total', key: 'cv', width: 16, style: { numFmt: fmt } },
    { header: 'Net taxable', key: 'nt', width: 16, style: { numFmt: fmt } },
    { header: 'Net GST', key: 'ng', width: 14, style: { numFmt: fmt } },
    { header: 'Net total', key: 'nv', width: 16, style: { numFmt: fmt } },
  ]
  const line = (label: string, m: RegisterMonth) => ({
    m: label, n: m.invoices, t: rupees(m.sales.taxable), c: rupees(m.sales.cgst), s: rupees(m.sales.sgst), i: rupees(m.sales.igst),
    v: rupees(m.sales.total), cn: m.credit_notes, cv: rupees(m.credits.total), nt: rupees(m.net.taxable),
    ng: rupees(m.net.cgst + m.net.sgst + m.net.igst), nv: rupees(m.net.total),
  })
  for (const m of reg.months) sum.addRow(line(monthName(m.month), m))
  sum.addRow(line(`FY ${reg.fy}`, reg.totals)).font = { bold: true }
  sum.getRow(1).font = { bold: true }
  sum.views = [{ state: 'frozen', ySplit: 1 }]

  const list = wb.addWorksheet('Invoices')
  list.columns = [
    { header: 'Date', key: 'd', width: 12 },
    { header: 'Type', key: 'k', width: 12 },
    { header: 'Number', key: 'no', width: 14 },
    { header: 'Party', key: 'p', width: 32 },
    { header: 'GSTIN', key: 'g', width: 18 },
    { header: 'Place of supply', key: 'pos', width: 20 },
    { header: 'Taxable', key: 't', width: 16, style: { numFmt: fmt } },
    { header: 'CGST', key: 'c', width: 14, style: { numFmt: fmt } },
    { header: 'SGST', key: 's', width: 14, style: { numFmt: fmt } },
    { header: 'IGST', key: 'i', width: 14, style: { numFmt: fmt } },
    { header: 'Total', key: 'v', width: 16, style: { numFmt: fmt } },
    { header: 'Status', key: 'st', width: 12 },
  ]
  for (const r of reg.rows) {
    const sign = r.kind === 'credit_note' ? -1 : 1
    list.addRow({
      d: r.date, k: r.kind === 'invoice' ? 'Invoice' : 'Credit note', no: r.number, p: r.party, g: r.gstin ?? '', pos: r.place_of_supply ?? '',
      t: sign * rupees(r.taxable), c: sign * rupees(r.cgst), s: sign * rupees(r.sgst), i: sign * rupees(r.igst), v: sign * rupees(r.total),
      st: STATUS[r.status] ?? r.status,
    })
  }
  list.getRow(1).font = { bold: true }
  list.views = [{ state: 'frozen', ySplit: 1 }]
  list.autoFilter = { from: 'A1', to: 'L1' }
  return wb
}
