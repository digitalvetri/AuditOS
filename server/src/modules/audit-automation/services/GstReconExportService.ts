import ExcelJS from 'exceljs'
import { prisma, alive } from '../../../lib/prisma.js'
import { ApiError } from '../../../lib/http.js'
import { can, type Session } from '../../../platform/auth.js'

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

export const GstReconExportService = {
  async workbook(session: Session, jobId: string): Promise<Buffer> {
    const job = await scopedJob(session, jobId)
    const rows = await prisma.aaGstReconRow.findMany({
      where: { jobId },
      include: { filing2BEntry: true, purchaseRegisterEntry: true },
    })

    const wb = new ExcelJS.Workbook()
    wb.creator = 'Audit OS · Audit Automation'
    wb.created = new Date()

    // ── Summary ─────────────────────────────────────────────────────────
    const summary = wb.addWorksheet('Summary')
    summary.columns = [
      { header: 'Field', key: 'field', width: 32 },
      { header: 'Value', key: 'value', width: 40 },
    ]
    const totals = job.totalsJson ? JSON.parse(job.totalsJson) as Record<string, { taxable: number; igst: number; cgst: number; sgst: number; cess: number; count: number }> : null
    const summaryRows: [string, string | number][] = [
      ['Client', job.client.companyName],
      ['Period', `${String(job.filing2B.periodMonth).padStart(2, '0')}-${job.filing2B.periodYear}`],
      ['GSTR-2B file', job.filing2B.originalFilename],
      ['Purchase Register file', job.purchaseRegister.originalFilename],
      ['Reconciled on', job.completedAt?.toISOString().slice(0, 19).replace('T', ' ') ?? ''],
      ['', ''],
      ['Matched', job.matchedCount],
      ['Partial', job.partialCount],
      ['Only in 2B', job.only2BCount],
      ['Only in PR', job.onlyPRCount],
    ]
    if (totals) {
      summaryRows.push(['', ''])
      summaryRows.push(['Bucket', 'Taxable (₹) · IGST · CGST · SGST · Cess'])
      for (const bucket of ['matched', 'partial', 'only_2b', 'only_pr'] as const) {
        const t = totals[bucket]
        summaryRows.push([
          bucket.toUpperCase(),
          `${paiseToRupees(t.taxable).toFixed(2)} · ${paiseToRupees(t.igst).toFixed(2)} · ${paiseToRupees(t.cgst).toFixed(2)} · ${paiseToRupees(t.sgst).toFixed(2)} · ${paiseToRupees(t.cess).toFixed(2)}`,
        ])
      }
    }
    summaryRows.forEach((r) => summary.addRow({ field: r[0], value: r[1] }))
    summary.getRow(1).font = { bold: true }

    // ── Matched / Partial / Only 2B / Only PR sheets ────────────────────
    addPairedSheet(wb, 'Matched', rows.filter((r) => r.matchStatus === 'matched'))
    addPairedSheet(wb, 'Partial', rows.filter((r) => r.matchStatus === 'partial'))
    addSingleSideSheet(wb, 'Only in 2B', rows.filter((r) => r.matchStatus === 'only_2b'), 'two')
    addSingleSideSheet(wb, 'Only in PR', rows.filter((r) => r.matchStatus === 'only_pr'), 'pr')

    return Buffer.from(await wb.xlsx.writeBuffer())
  },
}

function addPairedSheet(wb: ExcelJS.Workbook, name: string, rows: Array<{
  matchStatus: string; mismatchFields: string; itcClassification: string; auditorNote: string | null;
  filing2BEntry: { supplierGstin: string; supplierName: string | null; invoiceNumber: string; invoiceDate: string; taxableValue: number; igst: number; cgst: number; sgst: number; cess: number; itcAvailable: boolean } | null;
  purchaseRegisterEntry: { supplierGstin: string; supplierName: string | null; invoiceNumber: string; invoiceDate: string; taxableValue: number; igst: number; cgst: number; sgst: number; cess: number } | null;
}>) {
  const ws = wb.addWorksheet(name)
  ws.columns = [
    { header: 'Supplier GSTIN', key: 'gstin', width: 20 },
    { header: 'Supplier Name', key: 'name', width: 28 },
    { header: 'Invoice #', key: 'inv', width: 18 },
    { header: 'Invoice Date', key: 'date', width: 12 },
    { header: '2B Taxable', key: '2bTax', width: 14, style: { numFmt: RUPEES } },
    { header: 'PR Taxable', key: 'prTax', width: 14, style: { numFmt: RUPEES } },
    { header: 'Δ Taxable', key: 'dTax', width: 14, style: { numFmt: RUPEES } },
    { header: '2B IGST', key: '2bIgst', width: 12, style: { numFmt: RUPEES } },
    { header: 'PR IGST', key: 'prIgst', width: 12, style: { numFmt: RUPEES } },
    { header: '2B CGST', key: '2bCgst', width: 12, style: { numFmt: RUPEES } },
    { header: 'PR CGST', key: 'prCgst', width: 12, style: { numFmt: RUPEES } },
    { header: '2B SGST', key: '2bSgst', width: 12, style: { numFmt: RUPEES } },
    { header: 'PR SGST', key: 'prSgst', width: 12, style: { numFmt: RUPEES } },
    { header: 'ITC in 2B', key: 'itc2b', width: 10 },
    { header: 'Mismatches', key: 'mism', width: 24 },
    { header: 'ITC Classification', key: 'itc', width: 18 },
    { header: 'Auditor Note', key: 'note', width: 36 },
  ]
  ws.getRow(1).font = { bold: true }
  for (const r of rows) {
    const two = r.filing2BEntry
    const pr = r.purchaseRegisterEntry
    ws.addRow({
      gstin: two?.supplierGstin ?? pr?.supplierGstin ?? '',
      name: two?.supplierName ?? pr?.supplierName ?? '',
      inv: two?.invoiceNumber ?? pr?.invoiceNumber ?? '',
      date: two?.invoiceDate ?? pr?.invoiceDate ?? '',
      '2bTax': two ? two.taxableValue / 100 : null,
      prTax: pr ? pr.taxableValue / 100 : null,
      dTax: two && pr ? (two.taxableValue - pr.taxableValue) / 100 : null,
      '2bIgst': two ? two.igst / 100 : null, prIgst: pr ? pr.igst / 100 : null,
      '2bCgst': two ? two.cgst / 100 : null, prCgst: pr ? pr.cgst / 100 : null,
      '2bSgst': two ? two.sgst / 100 : null, prSgst: pr ? pr.sgst / 100 : null,
      itc2b: two ? (two.itcAvailable ? 'Y' : 'N') : '',
      mism: r.mismatchFields,
      itc: r.itcClassification,
      note: r.auditorNote ?? '',
    })
  }
}

function addSingleSideSheet(wb: ExcelJS.Workbook, name: string, rows: Array<{
  itcClassification: string; auditorNote: string | null;
  filing2BEntry: { supplierGstin: string; supplierName: string | null; invoiceNumber: string; invoiceDate: string; taxableValue: number; igst: number; cgst: number; sgst: number; cess: number; itcAvailable: boolean } | null;
  purchaseRegisterEntry: { supplierGstin: string; supplierName: string | null; invoiceNumber: string; invoiceDate: string; taxableValue: number; igst: number; cgst: number; sgst: number; cess: number } | null;
}>, side: 'two' | 'pr') {
  const ws = wb.addWorksheet(name)
  ws.columns = [
    { header: 'Supplier GSTIN', key: 'gstin', width: 20 },
    { header: 'Supplier Name', key: 'name', width: 28 },
    { header: 'Invoice #', key: 'inv', width: 18 },
    { header: 'Invoice Date', key: 'date', width: 12 },
    { header: 'Taxable', key: 'tax', width: 14, style: { numFmt: RUPEES } },
    { header: 'IGST', key: 'igst', width: 12, style: { numFmt: RUPEES } },
    { header: 'CGST', key: 'cgst', width: 12, style: { numFmt: RUPEES } },
    { header: 'SGST', key: 'sgst', width: 12, style: { numFmt: RUPEES } },
    { header: 'ITC in 2B', key: 'itc2b', width: 10 },
    { header: 'ITC Classification', key: 'itc', width: 18 },
    { header: 'Auditor Note', key: 'note', width: 36 },
  ]
  ws.getRow(1).font = { bold: true }
  for (const r of rows) {
    const e = side === 'two' ? r.filing2BEntry : r.purchaseRegisterEntry
    if (!e) continue
    ws.addRow({
      gstin: e.supplierGstin, name: e.supplierName ?? '',
      inv: e.invoiceNumber, date: e.invoiceDate,
      tax: e.taxableValue / 100,
      igst: e.igst / 100, cgst: e.cgst / 100, sgst: e.sgst / 100,
      itc2b: side === 'two' && r.filing2BEntry ? (r.filing2BEntry.itcAvailable ? 'Y' : 'N') : '',
      itc: r.itcClassification,
      note: r.auditorNote ?? '',
    })
  }
}
