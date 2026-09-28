import ExcelJS from 'exceljs'
import { prisma } from '../../../lib/prisma.js'
import { ApiError } from '../../../lib/http.js'
import { can, type Session } from '../../../platform/auth.js'
import { ayLabel, fyLabel } from '../parsers/tdsTypes.js'
import { PART_LABEL } from '../parsers/tds26ASText.js'
import { TdsReconJobService } from './TdsReconJobService.js'

/**
 * A TDS reconciliation as a workbook — Summary, By deductor (the chase
 * list with follow-ups), Verified, Variance, Only in 26AS, Only in books
 * — or as one flat CSV. Every row carries both sides in full.
 */

const RUPEES = '#,##,##0.00'

async function scopedJob(session: Session, jobId: string) {
  const { organisationId } = await prisma.user.findUniqueOrThrow({ where: { id: session.userId }, select: { organisationId: true } })
  const where = can(session, 'tools.audit_automation.tds.view', 'organisation')
    ? { id: jobId, organisationId }
    : { id: jobId, organisationId, createdByUserId: session.userId }
  const job = await prisma.aaTdsReconJob.findFirst({ where, include: { client: true, filing26AS: true, books: true } })
  if (!job) throw ApiError.notFound('No such reconciliation.')
  return job
}

const STATUS_LABEL: Record<string, string> = { verified: 'Verified', variance: 'Variance', only_26as: 'Only in 26AS', only_books: 'Only in books' }
const ACTION_LABEL: Record<string, string> = { no_action: 'No action', chase_deductor: 'Chase deductor', revise_book: 'Revise books', credit_claimed: 'Credit claimed', written_off: 'Written off' }
const FLAG_LABEL: Record<string, string> = {
  status_u: '26AS: Unmatched (U)', status_p: '26AS: Provisional (P)', status_o: '26AS: Overbooked (O)', status_z: '26AS: Mismatched (Z)',
  short_deposit: 'Short deposit', tan_from_name: 'TAN matched by name', out_of_year: 'Outside the FY',
}

type Row = Awaited<ReturnType<typeof loadRows>>[number]
function loadRows(jobId: string) {
  return prisma.aaTdsReconRow.findMany({
    where: { jobId }, orderBy: [{ deductorKey: 'asc' }, { groupKey: 'asc' }, { createdAt: 'asc' }],
    include: { filing26ASEntry: true, booksEntry: true },
  })
}

const COLS: { header: string; key: string; width: number; money?: boolean; get: (r: Row) => string | number | null }[] = [
  { header: 'Status', key: 'status', width: 14, get: (r) => STATUS_LABEL[r.matchStatus] ?? r.matchStatus },
  { header: 'Matched by', key: 'method', width: 12, get: (r) => r.matchMethod ?? '' },
  { header: 'Group', key: 'group', width: 8, get: (r) => r.groupKey ?? '' },
  { header: 'Deductor TAN', key: 'tan', width: 14, get: (r) => r.filing26ASEntry?.deductorTan || r.booksEntry?.deductorTan || (r.deductorKey?.includes(':') ? '' : r.deductorKey) || '' },
  { header: 'Deductor', key: 'name', width: 30, get: (r) => r.filing26ASEntry?.deductorName ?? r.booksEntry?.deductorName ?? '' },
  { header: '26AS part', key: 'part', width: 16, get: (r) => (r.filing26ASEntry ? PART_LABEL[r.filing26ASEntry.part] ?? r.filing26ASEntry.part : '') },
  { header: 'Section (26AS)', key: 'sec26', width: 10, get: (r) => r.filing26ASEntry?.section ?? '' },
  { header: 'Section (books)', key: 'secbk', width: 10, get: (r) => r.booksEntry?.section ?? '' },
  { header: 'Date (26AS)', key: 'dt26', width: 12, get: (r) => r.filing26ASEntry?.tdsDate ?? '' },
  { header: 'Date (books)', key: 'dtbk', width: 12, get: (r) => r.booksEntry?.tdsDate ?? '' },
  { header: 'Quarter', key: 'qtr', width: 8, get: (r) => r.filing26ASEntry?.quarter ?? r.booksEntry?.quarter ?? '' },
  { header: 'Booking status', key: 'bst', width: 8, get: (r) => r.filing26ASEntry?.status ?? '' },
  { header: 'Booking date', key: 'bdt', width: 12, get: (r) => r.filing26ASEntry?.bookingDate ?? '' },
  { header: 'Books ref', key: 'ref', width: 14, get: (r) => r.booksEntry?.reference ?? '' },
  { header: 'Books ledger', key: 'gl', width: 22, get: (r) => r.booksEntry?.glCode ?? '' },
  { header: 'Paid (26AS)', key: 'paid26', width: 14, money: true, get: (r) => (r.filing26ASEntry ? r.filing26ASEntry.amountPaid / 100 : null) },
  { header: 'Paid (books)', key: 'paidbk', width: 14, money: true, get: (r) => (r.booksEntry ? r.booksEntry.amountPaid / 100 : null) },
  { header: 'TDS (26AS)', key: 'tds26', width: 14, money: true, get: (r) => (r.filing26ASEntry ? r.filing26ASEntry.tdsAmount / 100 : null) },
  { header: 'Deposited (26AS)', key: 'dep', width: 14, money: true, get: (r) => (r.filing26ASEntry ? r.filing26ASEntry.tdsDeposited / 100 : null) },
  { header: 'TDS (books)', key: 'tdsbk', width: 14, money: true, get: (r) => (r.booksEntry ? r.booksEntry.tdsAmount / 100 : null) },
  { header: 'Δ TDS (26AS − books)', key: 'd', width: 14, money: true, get: (r) => (r.filing26ASEntry && r.booksEntry && !r.groupKey ? (r.filing26ASEntry.tdsAmount - r.booksEntry.tdsAmount) / 100 : null) },
  { header: 'Differences', key: 'mism', width: 22, get: (r) => r.mismatchFields },
  { header: 'Flags', key: 'flags', width: 26, get: (r) => r.flags.split(',').filter(Boolean).map((f) => FLAG_LABEL[f] ?? f).join('; ') },
  { header: 'Action', key: 'act', width: 16, get: (r) => ACTION_LABEL[r.actionStatus] ?? r.actionStatus },
  { header: 'Note', key: 'note', width: 36, get: (r) => r.auditorNote ?? '' },
]

function sheet(wb: ExcelJS.Workbook, name: string, rows: Row[]) {
  const ws = wb.addWorksheet(name)
  ws.columns = COLS.map((c) => ({ header: c.header, key: c.key, width: c.width, ...(c.money ? { style: { numFmt: RUPEES } } : {}) }))
  ws.getRow(1).font = { bold: true }
  ws.views = [{ state: 'frozen', ySplit: 1 }]
  for (const r of rows) ws.addRow(Object.fromEntries(COLS.map((c) => [c.key, c.get(r)])))
}

export const TdsReconExportService = {
  async workbook(session: Session, jobId: string): Promise<Buffer> {
    const job = await scopedJob(session, jobId)
    const rows = await loadRows(jobId)
    const ded = await TdsReconJobService.deductors(session, jobId)
    const ay = job.filing26AS.assessmentYear
    const wb = new ExcelJS.Workbook()
    wb.creator = 'Audit OS · Repotic'
    wb.created = new Date()

    const summary = wb.addWorksheet('Summary')
    summary.columns = [{ header: 'Field', key: 'a', width: 34 }, { header: 'Value', key: 'b', width: 22 }, { header: '', key: 'c', width: 18 }, { header: '', key: 'd', width: 18 }]
    summary.getRow(1).font = { bold: true }
    const put = (a: string, b: string | number = '', c: string | number = '', d: string | number = '') => summary.addRow({ a, b, c, d })
    put('Client', job.client.companyName)
    put('PAN', job.filing26AS.pan ?? '')
    put('Assessment year', `AY ${ayLabel(ay)} (FY ${fyLabel(ay)})`)
    put('26AS file', job.filing26AS.originalFilename)
    put('Books file', job.books.originalFilename)
    put('Reconciled on', job.completedAt?.toISOString().slice(0, 19).replace('T', ' ') ?? '')
    put('Warnings', job.flags.split(',').filter(Boolean).join(', ') || 'none')
    put('')
    const hdr = put('Result', 'Rows', 'TDS in 26AS (₹)', 'TDS in books (₹)'); hdr.font = { bold: true }
    const totals = job.totalsJson ? JSON.parse(job.totalsJson) as Record<string, Record<string, number>> : {}
    for (const s of ['verified', 'variance', 'only_26as', 'only_books']) {
      const t = totals[s] ?? {}
      const row = put(STATUS_LABEL[s], t.count ?? 0, (t.tds_26as ?? 0) / 100, (t.tds_books ?? 0) / 100)
      row.getCell(3).numFmt = RUPEES; row.getCell(4).numFmt = RUPEES
    }
    const tot26 = ded.items.reduce((n, d) => n + d.tds_26as, 0), totBk = ded.items.reduce((n, d) => n + d.tds_books, 0)
    const all = put('Total', rows.length, tot26 / 100, totBk / 100); all.font = { bold: true }; all.getCell(3).numFmt = RUPEES; all.getCell(4).numFmt = RUPEES

    const dws = wb.addWorksheet('By deductor')
    dws.columns = [
      { header: 'Deductor TAN', key: 'tan', width: 14 }, { header: 'Deductor', key: 'name', width: 32 },
      { header: 'TDS in 26AS', key: 't26', width: 14, style: { numFmt: RUPEES } }, { header: 'TDS in books', key: 'tbk', width: 14, style: { numFmt: RUPEES } },
      { header: 'Shortfall in 26AS', key: 'short', width: 16, style: { numFmt: RUPEES } }, { header: 'Rows', key: 'rows', width: 7 }, { header: 'Open', key: 'open', width: 7 },
      { header: 'Issues', key: 'issues', width: 30 }, { header: 'Follow-up', key: 'fu', width: 12 }, { header: 'Due', key: 'due', width: 12 },
      { header: 'Last contacted', key: 'last', width: 18 }, { header: 'Contact', key: 'contact', width: 26 }, { header: 'Note', key: 'note', width: 36 },
    ]
    dws.getRow(1).font = { bold: true }
    dws.views = [{ state: 'frozen', ySplit: 1 }]
    for (const d of ded.items) {
      dws.addRow({
        tan: d.tan ?? '', name: d.name ?? '', t26: d.tds_26as / 100, tbk: d.tds_books / 100, short: d.shortfall / 100, rows: d.rows, open: d.open,
        issues: [...Object.entries(d.status_counts).filter(([k]) => k !== 'verified').map(([k, n]) => `${STATUS_LABEL[k]} ${n}`), ...Object.entries(d.flags).map(([k, n]) => `${FLAG_LABEL[k] ?? k} ${n}`)].join('; '),
        fu: d.follow_up?.status ?? '', due: d.follow_up?.due_date ?? '', last: d.follow_up?.last_contacted_at?.slice(0, 10) ?? '',
        contact: [d.follow_up?.contact_email, d.follow_up?.contact_phone].filter(Boolean).join(' · '), note: d.follow_up?.note ?? '',
      })
    }

    sheet(wb, 'Verified', rows.filter((r) => r.matchStatus === 'verified'))
    sheet(wb, 'Variance', rows.filter((r) => r.matchStatus === 'variance'))
    sheet(wb, 'Only in 26AS', rows.filter((r) => r.matchStatus === 'only_26as'))
    sheet(wb, 'Only in books', rows.filter((r) => r.matchStatus === 'only_books'))
    return Buffer.from(await wb.xlsx.writeBuffer())
  },

  async csv(session: Session, jobId: string): Promise<string> {
    await scopedJob(session, jobId)
    const rows = await loadRows(jobId)
    const esc = (v: unknown) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
    return '﻿' + [COLS.map((c) => esc(c.header)).join(','), ...rows.map((r) => COLS.map((c) => esc(c.get(r))).join(','))].join('\r\n')
  },
}
