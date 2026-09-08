import ExcelJS from 'exceljs'
import { prisma } from '../../../lib/prisma.js'
import { ApiError } from '../../../lib/http.js'
import { can, type Session } from '../../../platform/auth.js'

/**
 * Export a completed TDS recon to a 5-sheet XLSX:
 *   Summary · Verified · Variance · Only in 26AS · Only in Books
 */

const RUPEES = '#,##,##0.00'
function p2r(p: number): number { return p / 100 }

async function scopedJob(session: Session, jobId: string) {
  const { organisationId } = await prisma.user.findUniqueOrThrow({
    where: { id: session.userId }, select: { organisationId: true },
  })
  const where = can(session, 'tools.audit_automation.tds.view', 'organisation')
    ? { id: jobId, organisationId }
    : { id: jobId, organisationId, createdByUserId: session.userId }
  const job = await prisma.aaTdsReconJob.findFirst({
    where,
    include: { client: true, filing26AS: true, books: true },
  })
  if (!job) throw ApiError.notFound('No such reconciliation.')
  return job
}

export const TdsReconExportService = {
  async workbook(session: Session, jobId: string): Promise<Buffer> {
    const job = await scopedJob(session, jobId)
    const rows = await prisma.aaTdsReconRow.findMany({
      where: { jobId },
      include: { filing26ASEntry: true, booksEntry: true },
    })

    const wb = new ExcelJS.Workbook()
    wb.creator = 'Audit OS · Audit Automation'
    wb.created = new Date()

    const summary = wb.addWorksheet('Summary')
    summary.columns = [
      { header: 'Field', key: 'field', width: 32 },
      { header: 'Value', key: 'value', width: 40 },
    ]
    const totals = job.totalsJson ? JSON.parse(job.totalsJson) as Record<string, { amountPaid: number; tdsAmount: number; count: number }> : null
    const rowsToPush: [string, string | number][] = [
      ['Client', job.client.companyName],
      ['PAN', job.filing26AS.pan ?? ''],
      ['Assessment Year', String(job.filing26AS.assessmentYear)],
      ['26AS file', job.filing26AS.originalFilename],
      ['Books file', job.books.originalFilename],
      ['Reconciled on', job.completedAt?.toISOString().slice(0, 19).replace('T', ' ') ?? ''],
      ['', ''],
      ['Verified', job.verifiedCount],
      ['Variance', job.varianceCount],
      ['Only in 26AS', job.only26ASCount],
      ['Only in Books', job.onlyBooksCount],
    ]
    if (totals) {
      rowsToPush.push(['', ''], ['Bucket', 'Amount Paid (₹) · TDS Amount (₹)'])
      for (const bucket of ['verified', 'variance', 'only_26as', 'only_books'] as const) {
        const t = totals[bucket]
        rowsToPush.push([bucket.toUpperCase(), `${p2r(t.amountPaid).toFixed(2)} · ${p2r(t.tdsAmount).toFixed(2)}`])
      }
    }
    rowsToPush.forEach((r) => summary.addRow({ field: r[0], value: r[1] }))
    summary.getRow(1).font = { bold: true }

    addPaired(wb, 'Verified', rows.filter((r) => r.matchStatus === 'verified'))
    addPaired(wb, 'Variance', rows.filter((r) => r.matchStatus === 'variance'))
    addSingle(wb, 'Only in 26AS', rows.filter((r) => r.matchStatus === 'only_26as'), 'two')
    addSingle(wb, 'Only in Books', rows.filter((r) => r.matchStatus === 'only_books'), 'books')

    return Buffer.from(await wb.xlsx.writeBuffer())
  },
}

function addPaired(wb: ExcelJS.Workbook, name: string, rows: Array<{
  mismatchFields: string; actionStatus: string; auditorNote: string | null;
  filing26ASEntry: { section: string; deductorTan: string; deductorName: string | null; quarter: string; amountPaid: number; tdsAmount: number; tdsDate: string; status: string | null } | null;
  booksEntry: { section: string; deductorTan: string; deductorName: string | null; quarter: string; amountPaid: number; tdsAmount: number; tdsDate: string } | null;
}>) {
  const ws = wb.addWorksheet(name)
  ws.columns = [
    { header: 'Deductor TAN', key: 'tan', width: 16 },
    { header: 'Deductor', key: 'name', width: 28 },
    { header: 'Section', key: 'sec', width: 10 },
    { header: 'Quarter', key: 'qtr', width: 8 },
    { header: '26AS Paid', key: '26paid', width: 14, style: { numFmt: RUPEES } },
    { header: 'Books Paid', key: 'bpaid', width: 14, style: { numFmt: RUPEES } },
    { header: '26AS TDS', key: '26tds', width: 14, style: { numFmt: RUPEES } },
    { header: 'Books TDS', key: 'btds', width: 14, style: { numFmt: RUPEES } },
    { header: 'Δ TDS', key: 'dtds', width: 12, style: { numFmt: RUPEES } },
    { header: '26AS Date', key: '26dt', width: 12 },
    { header: 'Books Date', key: 'bdt', width: 12 },
    { header: 'Mismatches', key: 'mism', width: 24 },
    { header: 'Action', key: 'act', width: 18 },
    { header: 'Auditor Note', key: 'note', width: 36 },
  ]
  ws.getRow(1).font = { bold: true }
  for (const r of rows) {
    const two = r.filing26ASEntry
    const b = r.booksEntry
    ws.addRow({
      tan: two?.deductorTan ?? b?.deductorTan ?? '',
      name: two?.deductorName ?? b?.deductorName ?? '',
      sec: two?.section ?? b?.section ?? '',
      qtr: two?.quarter ?? b?.quarter ?? '',
      '26paid': two ? two.amountPaid / 100 : null,
      bpaid: b ? b.amountPaid / 100 : null,
      '26tds': two ? two.tdsAmount / 100 : null,
      btds: b ? b.tdsAmount / 100 : null,
      dtds: two && b ? (two.tdsAmount - b.tdsAmount) / 100 : null,
      '26dt': two?.tdsDate ?? '',
      bdt: b?.tdsDate ?? '',
      mism: r.mismatchFields,
      act: r.actionStatus,
      note: r.auditorNote ?? '',
    })
  }
}

function addSingle(wb: ExcelJS.Workbook, name: string, rows: Array<{
  actionStatus: string; auditorNote: string | null;
  filing26ASEntry: { section: string; deductorTan: string; deductorName: string | null; quarter: string; amountPaid: number; tdsAmount: number; tdsDate: string; status: string | null } | null;
  booksEntry: { section: string; deductorTan: string; deductorName: string | null; quarter: string; amountPaid: number; tdsAmount: number; tdsDate: string } | null;
}>, side: 'two' | 'books') {
  const ws = wb.addWorksheet(name)
  ws.columns = [
    { header: 'Deductor TAN', key: 'tan', width: 16 },
    { header: 'Deductor', key: 'name', width: 28 },
    { header: 'Section', key: 'sec', width: 10 },
    { header: 'Quarter', key: 'qtr', width: 8 },
    { header: 'Amount Paid', key: 'paid', width: 14, style: { numFmt: RUPEES } },
    { header: 'TDS', key: 'tds', width: 14, style: { numFmt: RUPEES } },
    { header: 'TDS Date', key: 'dt', width: 12 },
    { header: 'Action', key: 'act', width: 18 },
    { header: 'Auditor Note', key: 'note', width: 36 },
  ]
  ws.getRow(1).font = { bold: true }
  for (const r of rows) {
    const e = side === 'two' ? r.filing26ASEntry : r.booksEntry
    if (!e) continue
    ws.addRow({
      tan: e.deductorTan,
      name: e.deductorName ?? '',
      sec: e.section, qtr: e.quarter,
      paid: e.amountPaid / 100, tds: e.tdsAmount / 100, dt: e.tdsDate,
      act: r.actionStatus, note: r.auditorNote ?? '',
    })
  }
}
