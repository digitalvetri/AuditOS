import ExcelJS from 'exceljs'
import { prisma, alive } from '../../../lib/prisma.js'
import { ApiError } from '../../../lib/http.js'
import { can, type Session } from '../../../platform/auth.js'
import { numify } from '../../../lib/money.js'

/**
 * Export a completed GST reconciliation to a 5-sheet XLSX workbook:
 *   Summary · Matched · Partial · Only in 2B · Only in PR
 *
 * All amounts are shown in RUPEES (paise / 100) since that's what
 * auditors read on paper. Numbers use INR grouping via cell format.
 */

const RUPEES = '#,##,##0.00'

function paiseToRupees(p: number): number { return p / 100 }

async function scopedJob(session: Session, jobId: string) {
  const { organisationId } = await prisma.user.findUniqueOrThrow({
    where: { id: session.userId }, select: { organisationId: true },
  })
  const where = can(session, 'tools.audit_automation.gst.view', 'organisation')
    ? { id: jobId, organisationId }
    : { id: jobId, organisationId, createdByUserId: session.userId }
  const job = await prisma.aaGstReconJob.findFirst({
    where,
    include: {
      client: true,
      filing2B: true,
      purchaseRegister: true,
    },
  })
  if (!job) throw ApiError.notFound('No such reconciliation.')
  return job
}

type Row = Awaited<ReturnType<typeof loadRows>>[number]
function loadRows(jobId: string) {
  return prisma.aaGstReconRow.findMany({
    where: { jobId },
    orderBy: [{ matchStatus: 'asc' }, { createdAt: 'asc' }],
    include: { filing2BEntry: true, purchaseRegisterEntry: true },
  })
}

const SHEETS: { status: string; name: string; paired: boolean }[] = [
  { status: 'matched', name: 'Matched', paired: true },
  { status: 'partial', name: 'Partial', paired: true },
  { status: 'variance', name: 'Variance', paired: true },
  { status: 'only_2b', name: 'Missing in books', paired: false },
  { status: 'only_pr', name: 'Missing in 2B', paired: false },
  { status: 'duplicate', name: 'Duplicates', paired: false },
]

/** One flat record per row — the same columns for the workbook sheets and the CSV. */
const AMOUNTS = ['taxableValue', 'igst', 'cgst', 'sgst', 'cess', 'invoiceValue'] as const
function flat(r: Row) {
  const a = r.filing2BEntry && numify(r.filing2BEntry, ...AMOUNTS)
  const b = r.purchaseRegisterEntry && numify(r.purchaseRegisterEntry, ...AMOUNTS)
  const e = a ?? b
  const d = (x: number | undefined | null, y: number | undefined | null) => (x == null || y == null ? null : paiseToRupees(x - y))
  return {
    status: r.matchStatus,
    method: r.matchMethod ?? '',
    doc_type: e?.docType ?? '',
    section: a?.section ?? '',
    gstin: e?.supplierGstin ?? '',
    supplier: e?.supplierName ?? '',
    inv_2b: a?.invoiceNumber ?? '', date_2b: a?.invoiceDate ?? '',
    inv_pr: b?.invoiceNumber ?? '', date_pr: b?.invoiceDate ?? '',
    value_2b: a?.invoiceValue != null ? paiseToRupees(a.invoiceValue) : null,
    taxable_2b: a ? paiseToRupees(a.taxableValue) : null, taxable_pr: b ? paiseToRupees(b.taxableValue) : null, taxable_diff: d(a?.taxableValue, b?.taxableValue),
    igst_2b: a ? paiseToRupees(a.igst) : null, igst_pr: b ? paiseToRupees(b.igst) : null,
    cgst_2b: a ? paiseToRupees(a.cgst) : null, cgst_pr: b ? paiseToRupees(b.cgst) : null,
    sgst_2b: a ? paiseToRupees(a.sgst) : null, sgst_pr: b ? paiseToRupees(b.sgst) : null,
    cess_2b: a ? paiseToRupees(a.cess) : null, cess_pr: b ? paiseToRupees(b.cess) : null,
    tax_diff: a && b ? paiseToRupees((a.igst + a.cgst + a.sgst + a.cess) - (b.igst + b.cgst + b.sgst + b.cess)) : null,
    reverse_charge: (a?.reverseCharge || b?.reverseCharge) ? 'Y' : '',
    itc_in_2b: a ? (a.itcAvailable ? 'Y' : 'N') : '',
    gl: b?.glCode ?? '',
    differences: r.mismatchFields.replace(/,/g, ', '),
    itc_class: r.itcClassification,
    itc_reason: r.itcReason ?? '',
    note: r.auditorNote ?? '',
  }
}
const COLS: [keyof ReturnType<typeof flat>, string, number, boolean?][] = [
  ['status', 'Status', 11], ['method', 'Matched by', 12], ['doc_type', 'Doc', 6], ['section', 'Section', 8],
  ['gstin', 'Supplier GSTIN', 18], ['supplier', 'Supplier', 28],
  ['inv_2b', 'Invoice (2B)', 16], ['date_2b', 'Date (2B)', 11], ['inv_pr', 'Invoice (books)', 16], ['date_pr', 'Date (books)', 11],
  ['value_2b', 'Invoice value (2B)', 14, true],
  ['taxable_2b', 'Taxable (2B)', 14, true], ['taxable_pr', 'Taxable (books)', 14, true], ['taxable_diff', 'Taxable Δ', 12, true],
  ['igst_2b', 'IGST (2B)', 12, true], ['igst_pr', 'IGST (books)', 12, true], ['cgst_2b', 'CGST (2B)', 12, true], ['cgst_pr', 'CGST (books)', 12, true],
  ['sgst_2b', 'SGST (2B)', 12, true], ['sgst_pr', 'SGST (books)', 12, true], ['cess_2b', 'Cess (2B)', 11, true], ['cess_pr', 'Cess (books)', 11, true],
  ['tax_diff', 'Tax Δ', 12, true], ['reverse_charge', 'RCM', 5], ['itc_in_2b', 'ITC in 2B', 8], ['gl', 'GL / ledger', 18],
  ['differences', 'Differences', 26], ['itc_class', 'ITC class', 11], ['itc_reason', 'ITC reason', 48], ['note', 'Reviewer note', 36],
]

export const GstReconExportService = {
  async workbook(session: Session, jobId: string): Promise<Buffer> {
    const job = await scopedJob(session, jobId)
    const rows = await loadRows(job.id)
    const wb = new ExcelJS.Workbook()
    const sum = wb.addWorksheet('Summary')
    sum.columns = [{ header: 'Bucket', key: 'b', width: 22 }, { header: 'Count', key: 'c', width: 10 }, { header: 'Taxable', key: 't', width: 16 }, { header: 'IGST', key: 'i', width: 14 }, { header: 'CGST', key: 'cg', width: 14 }, { header: 'SGST', key: 's', width: 14 }, { header: 'Cess', key: 'ce', width: 12 }]
    sum.addRow({ b: `Client: ${job.client.companyName}` })
    sum.addRow({ b: `2B period: ${String(job.filing2B.periodMonth).padStart(2, '0')}/${job.filing2B.periodYear}` })
    sum.addRow({ b: `Flags: ${job.flags || 'none'}` })
    sum.addRow({})
    const totals = job.totalsJson ? JSON.parse(job.totalsJson) as Record<string, { taxable: number; igst: number; cgst: number; sgst: number; cess: number; count: number }> : {}
    for (const s of SHEETS) {
      const t = totals[s.status]
      if (t) sum.addRow({ b: s.name, c: t.count, t: paiseToRupees(t.taxable), i: paiseToRupees(t.igst), cg: paiseToRupees(t.cgst), s: paiseToRupees(t.sgst), ce: paiseToRupees(t.cess) })
    }
    const byItc = new Map<string, number>()
    for (const r of rows) byItc.set(r.itcClassification, (byItc.get(r.itcClassification) ?? 0) + 1)
    sum.addRow({})
    sum.addRow({ b: 'ITC class', c: 'Rows' })
    for (const [k, v] of byItc) sum.addRow({ b: k, c: v })
    for (const k of ['t', 'i', 'cg', 's', 'ce']) sum.getColumn(k).numFmt = RUPEES
    for (const s of SHEETS) {
      const ws = wb.addWorksheet(s.name)
      const cols = COLS.filter(([k]) => s.paired || !['taxable_diff', 'tax_diff'].includes(k))
      ws.columns = cols.map(([key, header, width, money]) => ({ key, header, width, ...(money ? { style: { numFmt: RUPEES } } : {}) }))
      ws.getRow(1).font = { bold: true }
      ws.views = [{ state: 'frozen', ySplit: 1 }]
      for (const r of rows.filter((x) => x.matchStatus === s.status)) ws.addRow(flat(r))
    }
    return Buffer.from(await wb.xlsx.writeBuffer())
  },

  /** Every row in one CSV, for other tools. */
  async csv(session: Session, jobId: string): Promise<string> {
    const job = await scopedJob(session, jobId)
    const rows = await loadRows(job.id)
    const q = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
    const lines = [COLS.map(([, h]) => q(h)).join(',')]
    for (const r of rows) { const f = flat(r); lines.push(COLS.map(([k]) => q(f[k])).join(',')) }
    return lines.join('\r\n') + '\r\n'
  },
}
