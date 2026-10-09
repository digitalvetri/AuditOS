/**
 * /api/tds-recon — Form 26AS vs the client's TDS-receivable books
 * (docs/compliance/README.md "26AS vs books"), on the AaTds26AS / AaTdsBooks /
 * AaTdsReconJob tables.
 *
 * Assessment year convention (AaTds26AS.assessmentYear): the END year of the
 * AY — FY 2025-26 → AY 2026-27 → 2027. The FY label is kept beside it.
 *
 * Access: workstation.service.read OR tools.audit_automation.access, plus the
 * client rule (assertClientVisible: every client with clients.view_all, else
 * only assigned clients). Every write → writeAudit.
 */
import { Router } from 'express'
import multer from 'multer'
import path from 'node:path'
import crypto from 'node:crypto'
import ExcelJS from 'exceljs'
import type { AaTds26ASEntry, AaTdsBooksEntry, AaTdsReconJob, AaTdsReconRow } from '@prisma/client'
import { prisma, alive } from '../../lib/prisma.js'
import { ApiError, handler, ok } from '../../lib/http.js'
import { can, requireSession } from '../../platform/auth.js'
import { writeAudit } from '../../platform/audit.js'
import { assertClientVisible } from '../../platform/workstation/scope.js'
import { LocalStorageAdapter } from '../tools/storage/LocalStorageAdapter.js'
import { orgOfUser } from '../compliance/service.js'
import { isFy, fyStartYear } from '../compliance/engine.js'
import { parse26AS, parseBooks, type ParsedEntry } from './parse.js'
import { matchTds, STATUS_LABEL, type MatchStatus } from './match.js'

export const ACTION_STATUSES = ['no_action', 'chase_deductor', 'revise_book', 'credit_claimed', 'written_off'] as const

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 2 } })
const storage = () => new LocalStorageAdapter(process.env.TDS_RECON_STORAGE_ROOT
  ? path.resolve(process.env.TDS_RECON_STORAGE_ROOT)
  : path.resolve(process.cwd(), 'uploads', 'tds-recon'))

export const tdsReconRouter = Router()

export const ayOfFy = (fy: string) => fyStartYear(fy) + 2
export const fyOfAy = (ay: number) => `${ay - 2}-${String((ay - 1) % 100).padStart(2, '0')}`
const rupees = (p: bigint | number) => Number(p) / 100

type Req = Parameters<typeof requireSession>[0]

/** workstation.service.read OR tools.audit_automation.access, else 403. */
async function caller(req: Req) {
  const session = requireSession(req)
  if (!can(session, 'workstation.service.read') && !can(session, 'tools.audit_automation.access')) throw ApiError.forbidden()
  return { session, organisationId: await orgOfUser(prisma, session.userId) }
}

async function clientFor(organisationId: string, clientId: unknown) {
  if (typeof clientId !== 'string' || !clientId) throw ApiError.badRequest('client_id is required.', { client_id: 'Required.' })
  const c = await prisma.client.findFirst({ where: { id: clientId, organisationId, ...alive }, select: { id: true, companyName: true, pan: true } })
  if (!c) throw ApiError.forbidden()
  return c
}

function entryData(e: ParsedEntry) {
  return {
    section: e.section, deductorTan: e.tan, deductorName: e.deductorName, quarter: e.quarter,
    amountPaid: e.amountPaid, tdsAmount: e.tds, tdsDate: e.date,
  }
}

type Client = Awaited<ReturnType<typeof clientFor>>

/**
 * Store one uploaded file and its parsed entries. The same bytes uploaded
 * again for the client reuse the earlier upload (the hash is unique per
 * client), reviving it if it had been deleted.
 */
async function storeUpload(kind: '26as' | 'books', file: Express.Multer.File, client: Client, fy: string, organisationId: string, userId: string): Promise<{ id: string; entries: number; skipped: number }> {
  const parsed = kind === '26as' ? await parse26AS(file.buffer, file.originalname) : await parseBooks(file.buffer, file.originalname)
  const sha = crypto.createHash('sha256').update(file.buffer).digest('hex')
  const ay = ayOfFy(fy)
  const where = { clientId_fileSha256: { clientId: client.id, fileSha256: sha } }
  const existing = kind === '26as' ? await prisma.aaTds26AS.findUnique({ where }) : await prisma.aaTdsBooks.findUnique({ where })
  if (existing) {
    if (existing.deletedAt || existing.assessmentYear !== ay) {
      const data = { deletedAt: null, assessmentYear: ay }
      if (kind === '26as') await prisma.aaTds26AS.update({ where: { id: existing.id }, data: { ...data, financialYear: fy } })
      else await prisma.aaTdsBooks.update({ where: { id: existing.id }, data })
    }
    return { id: existing.id, entries: parsed.entries.length, skipped: parsed.skipped.length }
  }
  const key = `${client.id}/${crypto.randomUUID()}${path.extname(file.originalname).slice(0, 8)}`
  await storage().put(key, file.buffer)
  const common = {
    organisationId, clientId: client.id, uploadedByUserId: userId, assessmentYear: ay,
    sourceFormat: parsed.sourceFormat, originalFilename: file.originalname.slice(0, 200), fileSize: file.size, fileSha256: sha, storagePath: key,
  }
  const id = await prisma.$transaction(async (tx) => {
    if (kind === '26as') {
      const r = await tx.aaTds26AS.create({ data: { ...common, financialYear: fy, assesseeName: client.companyName, pan: client.pan } })
      await tx.aaTds26ASEntry.createMany({
        data: parsed.entries.map((e) => ({
          filingId: r.id, ...entryData(e), part: e.section === '192' ? 'part_a' : 'part_a1',
          status: e.status, tdsDeposited: e.tdsDeposited || e.tds, rawJson: JSON.stringify(e.raw),
        })),
      })
      return r.id
    }
    const r = await tx.aaTdsBooks.create({ data: common })
    await tx.aaTdsBooksEntry.createMany({
      data: parsed.entries.map((e) => ({ booksId: r.id, ...entryData(e), reference: e.reference, rawJson: JSON.stringify(e.raw) })),
    })
    return r.id
  })
  return { id, entries: parsed.entries.length, skipped: parsed.skipped.length }
}

interface Totals { count: number; amount_paid_paise: number; tds_26as_paise: number; tds_books_paise: number }

function jobToApi(j: AaTdsReconJob & { filing26AS?: { financialYear: string | null; assessmentYear: number; originalFilename: string } | null; books?: { originalFilename: string } | null }) {
  return {
    id: j.id, client_id: j.clientId, filing_26as_id: j.filing26ASId, books_id: j.booksId,
    financial_year: j.filing26AS ? (j.filing26AS.financialYear ?? fyOfAy(j.filing26AS.assessmentYear)) : null,
    file_26as_name: j.filing26AS?.originalFilename ?? null, books_file_name: j.books?.originalFilename ?? null,
    verified_count: j.verifiedCount, variance_count: j.varianceCount, only_26as_count: j.only26ASCount, only_books_count: j.onlyBooksCount,
    status: j.status,
    counts: { matched: j.verifiedCount, difference: j.varianceCount, only_26as: j.only26ASCount, only_books: j.onlyBooksCount },
    flags: j.flags ? j.flags.split(',').filter(Boolean) : [],
    totals: j.totalsJson ? JSON.parse(j.totalsJson) as Record<string, Totals> : null,
    error_message: j.errorMessage, created_at: j.createdAt, completed_at: j.completedAt,
  }
}

type RowWith = AaTdsReconRow & { filing26ASEntry: AaTds26ASEntry | null; booksEntry: AaTdsBooksEntry | null }
const side = (e: AaTds26ASEntry | AaTdsBooksEntry | null) => e && ({
  amount_paid_paise: Number(e.amountPaid), tds_paise: Number(e.tdsAmount), date: e.tdsDate || null,
})
function rowToApi(r: RowWith) {
  const a = r.filing26ASEntry
  const b = r.booksEntry
  const any = a ?? b
  return {
    id: r.id,
    match_status: STATUS_LABEL[r.matchStatus as MatchStatus] ?? r.matchStatus,
    deductor_tan: any?.deductorTan || null,
    deductor_name: a?.deductorName ?? b?.deductorName ?? null,
    section: any?.section ?? null,
    quarter: any?.quarter || null,
    as26: side(a),
    books: side(b),
    difference_paise: Number((a?.tdsAmount ?? 0n) - (b?.tdsAmount ?? 0n)),
    mismatch_fields: r.mismatchFields ? r.mismatchFields.split(',').filter(Boolean) : [],
    flags: r.flags ? r.flags.split(',').filter(Boolean) : [],
    action_status: r.actionStatus,
    auditor_note: r.auditorNote,
    reviewed_at: r.reviewedAt,
  }
}

tdsReconRouter.get('/jobs', handler(async (req, res) => {
  const { session, organisationId } = await caller(req)
  const clientId = String(req.query.client_id ?? '')
  await clientFor(organisationId, clientId)
  await assertClientVisible(session, clientId)
  const fy = typeof req.query.financial_year === 'string' && isFy(req.query.financial_year) ? req.query.financial_year : null
  const jobs = await prisma.aaTdsReconJob.findMany({
    where: { clientId, organisationId, ...(fy ? { filing26AS: { assessmentYear: ayOfFy(fy) } } : {}) },
    include: { filing26AS: { select: { financialYear: true, assessmentYear: true, originalFilename: true } }, books: { select: { originalFilename: true } } },
    orderBy: { createdAt: 'desc' }, take: 100,
  })
  ok(res, jobs.map(jobToApi))
}))

tdsReconRouter.post('/jobs', upload.fields([{ name: 'file_26as', maxCount: 1 }, { name: 'file_books', maxCount: 1 }]), handler(async (req, res) => {
  const { session, organisationId } = await caller(req)
  const b = (req.body ?? {}) as Record<string, unknown>
  const client = await clientFor(organisationId, b.client_id)
  await assertClientVisible(session, client.id)
  if (!isFy(b.financial_year)) throw ApiError.badRequest('financial_year must look like 2025-26.', { financial_year: 'e.g. 2025-26' })
  const fy = b.financial_year as string
  const files = (req.files ?? {}) as Record<string, Express.Multer.File[]>
  const f26File = files.file_26as?.[0]
  const booksFile = files.file_books?.[0]
  if (!f26File || !booksFile) throw ApiError.badRequest('Upload both the 26AS (file_26as) and the books register (file_books).')
  let tolerance = 100n
  if (b.tolerance_paise !== undefined && b.tolerance_paise !== '') {
    const t = Number(b.tolerance_paise)
    if (!Number.isSafeInteger(t) || t < 0 || t > 10_000_00) throw ApiError.badRequest('tolerance_paise must be 0 to 1000000.')
    tolerance = BigInt(t)
  }
  const s26 = await storeUpload('26as', f26File, client, fy, organisationId, session.userId)
  const sBooks = await storeUpload('books', booksFile, client, fy, organisationId, session.userId)
  const [aEntries, bEntries] = await Promise.all([
    prisma.aaTds26ASEntry.findMany({ where: { filingId: s26.id } }),
    prisma.aaTdsBooksEntry.findMany({ where: { booksId: sBooks.id } }),
  ])
  const rows = matchTds(
    aEntries.map((e) => ({ id: e.id, tan: e.deductorTan, name: e.deductorName, section: e.section, date: e.tdsDate, quarter: e.quarter, amountPaid: e.amountPaid, tds: e.tdsAmount, tdsDeposited: e.tdsDeposited, status: e.status })),
    bEntries.map((e) => ({ id: e.id, tan: e.deductorTan, name: e.deductorName, section: e.section, date: e.tdsDate, quarter: e.quarter, amountPaid: e.amountPaid, tds: e.tdsAmount })),
    tolerance,
  )
  const aById = new Map(aEntries.map((e) => [e.id, e]))
  const bById = new Map(bEntries.map((e) => [e.id, e]))
  const totals: Record<string, Totals> = {}
  for (const r of rows) {
    const t = totals[STATUS_LABEL[r.matchStatus]] ??= { count: 0, amount_paid_paise: 0, tds_26as_paise: 0, tds_books_paise: 0 }
    const a = r.a26Id ? aById.get(r.a26Id) : null
    const bk = r.booksId ? bById.get(r.booksId) : null
    t.count += 1
    t.amount_paid_paise += Number(a?.amountPaid ?? bk?.amountPaid ?? 0n)
    t.tds_26as_paise += Number(a?.tdsAmount ?? 0n)
    t.tds_books_paise += Number(bk?.tdsAmount ?? 0n)
  }
  const flags = new Set<string>()
  if (rows.some((r) => r.flags.includes('tan_from_name'))) flags.add('TAN_FROM_NAME')
  if (rows.some((r) => r.flags.some((f) => f === 'status_u' || f === 'status_p'))) flags.add('UNBOOKED_CREDITS')
  if (rows.some((r) => r.flags.includes('short_deposit'))) flags.add('SHORT_DEPOSITS')
  const count = (st: MatchStatus) => rows.filter((r) => r.matchStatus === st).length
  const job = await prisma.$transaction(async (tx) => {
    const j = await tx.aaTdsReconJob.create({
      data: {
        organisationId, clientId: client.id, createdByUserId: session.userId, filing26ASId: s26.id, booksId: sBooks.id,
        status: 'matched', progress: 100, verifiedCount: count('verified'), varianceCount: count('variance'),
        only26ASCount: count('only_26as'), onlyBooksCount: count('only_books'), flags: [...flags].join(','),
        totalsJson: JSON.stringify(totals), startedAt: new Date(), completedAt: new Date(),
      },
      include: { filing26AS: { select: { financialYear: true, assessmentYear: true, originalFilename: true } }, books: { select: { originalFilename: true } } },
    })
    await tx.aaTdsReconRow.createMany({
      data: rows.map((r) => ({
        jobId: j.id, matchStatus: r.matchStatus, filing26ASEntryId: r.a26Id, booksEntryId: r.booksId,
        mismatchFields: r.mismatchFields.join(','), matchMethod: r.matchMethod, deductorKey: r.deductorKey, flags: r.flags.join(','),
      })),
    })
    return j
  })
  await writeAudit({
    actorUserId: session.userId, action: 'tds_recon.run', entityType: 'AaTdsReconJob', entityId: job.id,
    after: { client_id: client.id, financial_year: fy, file_26as: f26File.originalname, file_books: booksFile.originalname, entries_26as: s26.entries, entries_books: sBooks.entries, counts: jobToApi(job).counts }, req,
  })
  ok(res, { ...jobToApi(job), skipped: { as26: s26.skipped, books: sBooks.skipped } }, 201)
}))

async function loadJob(req: Req) {
  const c = await caller(req)
  const job = await prisma.aaTdsReconJob.findFirst({
    where: { id: req.params.id, organisationId: c.organisationId },
    include: { filing26AS: { select: { financialYear: true, assessmentYear: true, originalFilename: true } }, books: { select: { originalFilename: true } } },
  })
  if (!job) throw ApiError.notFound()
  await assertClientVisible(c.session, job.clientId)
  const rows = await prisma.aaTdsReconRow.findMany({ where: { jobId: job.id }, include: { filing26ASEntry: true, booksEntry: true } })
  const order: Record<string, number> = { variance: 0, only_26as: 1, only_books: 2, verified: 3 }
  rows.sort((a, b) => (order[a.matchStatus] ?? 9) - (order[b.matchStatus] ?? 9) || (a.deductorKey ?? '').localeCompare(b.deductorKey ?? ''))
  return { ...c, job, rows }
}

tdsReconRouter.get('/jobs/:id', handler(async (req, res) => {
  const { job, rows } = await loadJob(req)
  const status = typeof req.query.match_status === 'string' ? req.query.match_status : null
  ok(res, { job: jobToApi(job), rows: rows.map(rowToApi).filter((r) => !status || r.match_status === status) })
}))

tdsReconRouter.patch('/rows/:id', handler(async (req, res) => {
  const { session, organisationId } = await caller(req)
  const row = await prisma.aaTdsReconRow.findFirst({ where: { id: req.params.id, job: { organisationId } }, include: { job: true } })
  if (!row) throw ApiError.notFound()
  await assertClientVisible(session, row.job.clientId)
  const b = req.body ?? {}
  const data: { auditorNote?: string | null; actionStatus?: string; reviewedByUserId: string; reviewedAt: Date } = { reviewedByUserId: session.userId, reviewedAt: new Date() }
  if (b.auditor_note !== undefined) data.auditorNote = b.auditor_note === null ? null : String(b.auditor_note).slice(0, 4000)
  if (b.action_status !== undefined) {
    if (!ACTION_STATUSES.includes(b.action_status)) throw ApiError.badRequest(`action_status must be one of ${ACTION_STATUSES.join(', ')}.`)
    data.actionStatus = b.action_status
  }
  const after = await prisma.aaTdsReconRow.update({ where: { id: row.id }, data, include: { filing26ASEntry: true, booksEntry: true } })
  await writeAudit({
    actorUserId: session.userId, action: 'tds_recon.review_row', entityType: 'AaTdsReconRow', entityId: row.id,
    before: { auditor_note: row.auditorNote, action_status: row.actionStatus }, after: { auditor_note: after.auditorNote, action_status: after.actionStatus }, req,
  })
  ok(res, rowToApi(after))
}))

const EXPORT_COLUMNS: [string, (r: ReturnType<typeof rowToApi>) => string | number | null][] = [
  ['Status', (r) => r.match_status], ['Deductor', (r) => r.deductor_name ?? ''], ['TAN', (r) => r.deductor_tan ?? ''],
  ['Section', (r) => r.section ?? ''], ['Quarter', (r) => r.quarter ?? ''],
  ['26AS date', (r) => r.as26?.date ?? ''], ['26AS amount', (r) => (r.as26 ? rupees(r.as26.amount_paid_paise) : null)], ['26AS TDS', (r) => (r.as26 ? rupees(r.as26.tds_paise) : null)],
  ['Books date', (r) => r.books?.date ?? ''], ['Books amount', (r) => (r.books ? rupees(r.books.amount_paid_paise) : null)], ['Books TDS', (r) => (r.books ? rupees(r.books.tds_paise) : null)],
  ['TDS difference', (r) => rupees(r.difference_paise)], ['Differs in', (r) => r.mismatch_fields.join(' ')], ['Flags', (r) => r.flags.join(' ')],
  ['Action', (r) => r.action_status], ['Reviewer note', (r) => r.auditor_note ?? ''],
]

tdsReconRouter.get('/jobs/:id/export', handler(async (req, res) => {
  const { job, rows } = await loadJob(req)
  const format = req.query.format === 'csv' ? 'csv' : 'xlsx'
  const client = await prisma.client.findFirst({ where: { id: job.clientId }, select: { companyName: true } })
  const api = rows.map(rowToApi)
  const base = `26AS-recon-${(client?.companyName ?? 'client').replace(/[^A-Za-z0-9]+/g, '-')}-${job.id.slice(0, 8)}`
  res.setHeader('Cache-Control', 'private, no-store')
  if (format === 'csv') {
    const esc = (v: unknown) => { const t = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t }
    const csv = [EXPORT_COLUMNS.map(([h]) => h).join(','), ...api.map((r) => EXPORT_COLUMNS.map(([, f]) => esc(f(r))).join(','))].join('\r\n')
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="${base}.csv"`)
    res.end(`﻿${csv}`)
    return
  }
  const wb = new ExcelJS.Workbook()
  wb.creator = 'Audit OS'
  const sum = wb.addWorksheet('Summary')
  sum.columns = [{ header: 'Status', key: 's', width: 18 }, { header: 'Rows', key: 'n', width: 8 }, { header: 'TDS as per 26AS', key: 'a', width: 18 }, { header: 'TDS as per books', key: 'b', width: 18 }, { header: 'Difference', key: 'd', width: 16 }]
  const totals = job.totalsJson ? JSON.parse(job.totalsJson) as Record<string, Totals> : {}
  for (const st of ['matched', 'difference', 'only_26as', 'only_books']) {
    const t = totals[st] ?? { count: 0, tds_26as_paise: 0, tds_books_paise: 0 }
    sum.addRow({ s: st, n: t.count, a: rupees(t.tds_26as_paise), b: rupees(t.tds_books_paise), d: rupees(t.tds_26as_paise - t.tds_books_paise) })
  }
  ;['C', 'D', 'E'].forEach((c) => { sum.getColumn(c).numFmt = '#,##0.00' })
  const ws = wb.addWorksheet('Reconciliation')
  ws.columns = EXPORT_COLUMNS.map(([h]) => ({ header: h, width: h === 'Deductor' || h === 'Reviewer note' ? 36 : 14 }))
  for (const r of api) ws.addRow(EXPORT_COLUMNS.map(([, f]) => f(r)))
  ;['G', 'H', 'J', 'K', 'L'].forEach((c) => { ws.getColumn(c).numFmt = '#,##0.00' })
  ws.getRow(1).font = { bold: true }
  sum.getRow(1).font = { bold: true }
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  res.setHeader('Content-Disposition', `attachment; filename="${base}.xlsx"`)
  res.end(Buffer.from(await wb.xlsx.writeBuffer()))
}))
