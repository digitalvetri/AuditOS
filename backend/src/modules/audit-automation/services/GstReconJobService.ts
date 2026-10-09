import type { Request } from 'express'
import { prisma, alive } from '../../../lib/prisma.js'
import { ApiError } from '../../../lib/http.js'
import { can, type Session } from '../../../platform/auth.js'
import { writeAudit } from '../../../platform/audit.js'
import { runMatcher, compare, itcFor, type MatchStatus, type ItcClassification, type Entry } from './GstMatchingService.js'
import { isValidGstin } from '../parsers/types.js'
import { toNum } from '../../../lib/money.js'

/**
 * A GST reconciliation run: load both sides, match, persist rows and
 * totals — all or nothing (a failed run leaves the job `failed` with no
 * rows). Then review: ITC class + reason, notes, manual pair / unpair,
 * each re-rolling the job's counts and totals.
 */

export type ItcClassificationApi = ItcClassification
const STATUSES: MatchStatus[] = ['matched', 'partial', 'variance', 'only_2b', 'only_pr', 'duplicate']
const ITC_CLASSES: ItcClassification[] = ['eligible', 'ineligible', 'blocked', 'reversal', 'rcm']

type Totals = Record<MatchStatus, { taxable: number; igst: number; cgst: number; sgst: number; cess: number; count: number }>
export interface ReconJobApi {
  id: string
  client_id: string
  filing_2b_id: string
  purchase_register_id: string
  status: 'queued' | 'matching' | 'matched' | 'failed'
  progress: number
  matched_count: number
  partial_count: number
  variance_count: number
  only_2b_count: number
  only_pr_count: number
  duplicate_count: number
  flags: string[]
  totals: Partial<Totals> | null
  error_message: string | null
  started_at: string | null
  completed_at: string | null
  created_at: string
}

type JobRow = Awaited<ReturnType<typeof prisma.aaGstReconJob.findFirstOrThrow>>
function toApi(row: JobRow): ReconJobApi {
  let totals: ReconJobApi['totals'] = null
  if (row.totalsJson) { try { totals = JSON.parse(row.totalsJson) } catch { totals = null } }
  return {
    id: row.id, client_id: row.clientId, filing_2b_id: row.filing2BId, purchase_register_id: row.purchaseRegisterId,
    status: row.status as ReconJobApi['status'], progress: row.progress,
    matched_count: row.matchedCount, partial_count: row.partialCount, variance_count: row.varianceCount,
    only_2b_count: row.only2BCount, only_pr_count: row.onlyPRCount, duplicate_count: row.duplicateCount,
    flags: row.flags ? row.flags.split(',').filter(Boolean) : [],
    totals, error_message: row.errorMessage,
    started_at: row.startedAt?.toISOString() ?? null, completed_at: row.completedAt?.toISOString() ?? null, created_at: row.createdAt.toISOString(),
  }
}

async function orgOf(session: Session) {
  return (await prisma.user.findUniqueOrThrow({ where: { id: session.userId }, select: { organisationId: true } })).organisationId
}
async function scopedWhere(session: Session, base: object) {
  const organisationId = await orgOf(session)
  if (can(session, 'tools.audit_automation.gst.view', 'organisation')) return { ...base, organisationId }
  return { ...base, organisationId, createdByUserId: session.userId }
}

type E2B = Awaited<ReturnType<typeof prisma.aaGstFiling2BEntry.findMany>>[number]
type EPR = Awaited<ReturnType<typeof prisma.aaPurchaseRegisterEntry.findMany>>[number]
const from2B = (e: E2B): Entry => ({
  id: e.id, section: e.section, docType: e.docType as Entry['docType'], supplierGstin: e.supplierGstin, supplierName: e.supplierName ?? undefined,
  invoiceNumber: e.invoiceNumber, invoiceDate: e.invoiceDate, taxableValue: toNum(e.taxableValue), igst: toNum(e.igst), cgst: toNum(e.cgst), sgst: toNum(e.sgst), cess: toNum(e.cess),
  invoiceValue: toNum(e.invoiceValue) ?? undefined, reverseCharge: e.reverseCharge, originalInvoiceNumber: e.originalInvoiceNumber ?? undefined,
  itcAvailable: e.itcAvailable, itcReason: e.itcReason ?? undefined,
})
const fromPR = (e: EPR): Entry => ({
  id: e.id, docType: e.docType as Entry['docType'], supplierGstin: e.supplierGstin, supplierName: e.supplierName ?? undefined,
  invoiceNumber: e.invoiceNumber, invoiceDate: e.invoiceDate, taxableValue: toNum(e.taxableValue), igst: toNum(e.igst), cgst: toNum(e.cgst), sgst: toNum(e.sgst), cess: toNum(e.cess),
  invoiceValue: toNum(e.invoiceValue) ?? undefined, reverseCharge: e.reverseCharge, glCode: e.glCode ?? undefined,
})
const periodOf = (m: number, y: number) => `${y}-${String(m).padStart(2, '0')}`

/** Counts and totals from the rows as they now stand. */
async function reroll(jobId: string) {
  const rows = await prisma.aaGstReconRow.findMany({ where: { jobId }, include: { filing2BEntry: true, purchaseRegisterEntry: true } })
  const totals = Object.fromEntries(STATUSES.map((s) => [s, { taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0, count: 0 }])) as Totals
  for (const r of rows) {
    const e = r.filing2BEntry ?? r.purchaseRegisterEntry
    const t = totals[r.matchStatus as MatchStatus]
    if (!e || !t) continue
    t.taxable += toNum(e.taxableValue); t.igst += toNum(e.igst); t.cgst += toNum(e.cgst); t.sgst += toNum(e.sgst); t.cess += toNum(e.cess); t.count += 1
  }
  await prisma.aaGstReconJob.update({
    where: { id: jobId },
    data: {
      matchedCount: totals.matched.count, partialCount: totals.partial.count, varianceCount: totals.variance.count,
      only2BCount: totals.only_2b.count, onlyPRCount: totals.only_pr.count, duplicateCount: totals.duplicate.count,
      totalsJson: JSON.stringify(totals),
    },
  })
}

export const GstReconJobService = {
  toApi,

  async createAndRun(input: { session: Session; organisationId: string; clientId: string; filing2BId: string; purchaseRegisterId: string; req?: Request }): Promise<ReconJobApi> {
    const { session, organisationId, clientId, filing2BId, purchaseRegisterId, req } = input
    const filing = await prisma.aaGstFiling2B.findFirst({ where: { id: filing2BId, clientId, organisationId, ...alive } })
    if (!filing) throw ApiError.notFound('No such 2B filing.')
    const pr = await prisma.aaPurchaseRegister.findFirst({ where: { id: purchaseRegisterId, clientId, organisationId, ...alive } })
    if (!pr) throw ApiError.notFound('No such purchase register.')

    const [filingEntries, prEntries] = await Promise.all([
      prisma.aaGstFiling2BEntry.findMany({ where: { filingId: filing2BId } }),
      prisma.aaPurchaseRegisterEntry.findMany({ where: { registerId: purchaseRegisterId } }),
    ])
    const jobRow = await prisma.aaGstReconJob.create({
      data: { organisationId, clientId, createdByUserId: session.userId, filing2BId, purchaseRegisterId, status: 'matching', progress: 0, startedAt: new Date() },
    })
    try {
      const period = periodOf(filing.periodMonth, filing.periodYear)
      const result = runMatcher({ filing2B: filingEntries.map(from2B), purchaseRegister: prEntries.map(fromPR), period })
      const flags: string[] = []
      if (filing.periodMonth !== pr.periodMonth || filing.periodYear !== pr.periodYear) flags.push('PERIOD_MISMATCH')
      const badGstins = new Set([...filingEntries, ...prEntries].map((e) => e.supplierGstin).filter((g) => g && g !== 'IMPORT' && !isValidGstin(g)))
      if (badGstins.size) flags.push('INVALID_GSTINS')
      if (result.superseded) flags.push('AMENDMENTS_APPLIED')

      await prisma.$transaction(async (tx) => {
        for (let i = 0; i < result.rows.length; i += 500) {
          await tx.aaGstReconRow.createMany({
            data: result.rows.slice(i, i + 500).map((r) => ({
              jobId: jobRow.id, matchStatus: r.matchStatus, filing2BEntryId: r.filing2BEntryId ?? null, purchaseRegisterEntryId: r.purchaseRegisterEntryId ?? null,
              mismatchFields: r.mismatchFields.join(','), itcClassification: r.itcClassification, itcReason: r.itcReason, matchMethod: r.matchMethod ?? null,
            })),
          })
        }
        await tx.aaGstReconJob.update({
          where: { id: jobRow.id },
          data: {
            status: 'matched', progress: 100, completedAt: new Date(), flags: flags.join(','),
            matchedCount: result.totals.matched.count, partialCount: result.totals.partial.count, varianceCount: result.totals.variance.count,
            only2BCount: result.totals.only_2b.count, onlyPRCount: result.totals.only_pr.count, duplicateCount: result.totals.duplicate.count,
            totalsJson: JSON.stringify(result.totals),
          },
        })
      }, { timeout: 120_000 })
      const counts = Object.fromEntries(STATUSES.map((s) => [s, result.totals[s].count]))
      await writeAudit({ actorUserId: session.userId, action: 'aa.gst.recon_run', entityType: 'AaGstReconJob', entityId: jobRow.id, after: { client_id: clientId, filing_2b_id: filing2BId, purchase_register_id: purchaseRegisterId, ...counts, flags }, req })
      return toApi(await prisma.aaGstReconJob.findUniqueOrThrow({ where: { id: jobRow.id } }))
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'matching_failed'
      await prisma.aaGstReconRow.deleteMany({ where: { jobId: jobRow.id } }).catch(() => undefined)
      const failed = await prisma.aaGstReconJob.update({ where: { id: jobRow.id }, data: { status: 'failed', errorMessage: msg.slice(0, 500), completedAt: new Date() } })
      await writeAudit({ actorUserId: session.userId, action: 'aa.gst.recon_failed', entityType: 'AaGstReconJob', entityId: jobRow.id, after: { error: msg.slice(0, 200) }, req })
      return toApi(failed)
    }
  },

  async get(session: Session, id: string): Promise<ReconJobApi> {
    const row = await prisma.aaGstReconJob.findFirst({ where: await scopedWhere(session, { id }) })
    if (!row) throw ApiError.notFound('No such reconciliation.')
    return toApi(row)
  },

  async listForClient(session: Session, clientId: string): Promise<ReconJobApi[]> {
    const rows = await prisma.aaGstReconJob.findMany({ where: await scopedWhere(session, { clientId }), orderBy: { createdAt: 'desc' }, take: 100 })
    return rows.map(toApi)
  },

  async getRows(session: Session, jobId: string, filter: { status?: string; search?: string; itc?: string; limit?: number; offset?: number }) {
    await GstReconJobService.get(session, jobId)
    const q = filter.search?.trim()
    const text = q ? { contains: q, mode: 'insensitive' as const } : undefined
    const where = {
      jobId,
      ...(filter.status && filter.status !== 'all' ? { matchStatus: filter.status } : {}),
      ...(filter.itc ? { itcClassification: filter.itc } : {}),
      ...(text ? { OR: [
        { filing2BEntry: { OR: [{ supplierGstin: text }, { supplierName: text }, { invoiceNumber: text }] } },
        { purchaseRegisterEntry: { OR: [{ supplierGstin: text }, { supplierName: text }, { invoiceNumber: text }] } },
      ] } : {}),
    }
    const [rows, total, byStatus] = await Promise.all([
      prisma.aaGstReconRow.findMany({
        where, orderBy: [{ matchStatus: 'asc' }, { createdAt: 'asc' }],
        take: Math.min(Math.max(filter.limit ?? 100, 1), 500), skip: Math.max(filter.offset ?? 0, 0),
        include: { filing2BEntry: true, purchaseRegisterEntry: true },
      }),
      prisma.aaGstReconRow.count({ where }),
      prisma.aaGstReconRow.groupBy({ by: ['matchStatus'], where: { jobId }, _count: { _all: true } }),
    ])
    const side = (e: E2B | EPR | null, is2B: boolean) => e ? {
      id: e.id, doc_type: e.docType, supplier_gstin: e.supplierGstin, supplier_name: e.supplierName,
      gstin_valid: e.supplierGstin === 'IMPORT' || isValidGstin(e.supplierGstin),
      invoice_number: e.invoiceNumber, invoice_date: e.invoiceDate, invoice_value: toNum(e.invoiceValue),
      taxable_value: toNum(e.taxableValue), igst: toNum(e.igst), cgst: toNum(e.cgst), sgst: toNum(e.sgst), cess: toNum(e.cess), reverse_charge: e.reverseCharge,
      ...(is2B ? { section: (e as E2B).section, itc_available: (e as E2B).itcAvailable, itc_reason: (e as E2B).itcReason, original_invoice_number: (e as E2B).originalInvoiceNumber }
        : { gl_code: (e as EPR).glCode }),
    } : null
    return {
      total,
      counts: Object.fromEntries(byStatus.map((b) => [b.matchStatus, b._count._all])),
      items: rows.map((r) => ({
        id: r.id, match_status: r.matchStatus, match_method: r.matchMethod,
        mismatch_fields: r.mismatchFields ? r.mismatchFields.split(',') : [],
        itc_classification: r.itcClassification, itc_reason: r.itcReason,
        auditor_note: r.auditorNote, reviewed_at: r.reviewedAt?.toISOString() ?? null,
        filing_2b_entry: side(r.filing2BEntry, true),
        purchase_register_entry: side(r.purchaseRegisterEntry, false),
      })),
    }
  },

  /** A row, checked through the same scope as reading its job. */
  async rowFor(session: Session, rowId: string) {
    const row = await prisma.aaGstReconRow.findUnique({ where: { id: rowId }, include: { filing2BEntry: true, purchaseRegisterEntry: true } })
    if (!row) throw ApiError.notFound('No such row.')
    await GstReconJobService.get(session, row.jobId)
    return row
  },

  async updateRow(session: Session, rowId: string, patch: { itc_classification?: ItcClassification; itc_reason?: string | null; auditor_note?: string | null; req?: Request }) {
    const row = await GstReconJobService.rowFor(session, rowId)
    if (patch.itc_classification && !ITC_CLASSES.includes(patch.itc_classification)) throw ApiError.badRequest(`ITC class is one of ${ITC_CLASSES.join(', ')}.`)
    const updated = await prisma.aaGstReconRow.update({
      where: { id: rowId },
      data: {
        ...(patch.itc_classification ? { itcClassification: patch.itc_classification, itcReason: patch.itc_reason?.trim() || `Set by reviewer (was ${row.itcClassification}).` } : {}),
        ...(patch.itc_reason !== undefined && !patch.itc_classification ? { itcReason: patch.itc_reason } : {}),
        ...(patch.auditor_note !== undefined ? { auditorNote: patch.auditor_note?.slice(0, 2000) ?? null } : {}),
        reviewedByUserId: session.userId, reviewedAt: new Date(),
      },
    })
    await writeAudit({
      actorUserId: session.userId, action: 'aa.gst.row_reviewed', entityType: 'AaGstReconJob', entityId: row.jobId,
      before: { row_id: rowId, itc_classification: row.itcClassification, itc_reason: row.itcReason, auditor_note: row.auditorNote },
      after: { row_id: rowId, itc_classification: updated.itcClassification, itc_reason: updated.itcReason, auditor_note: updated.auditorNote },
      req: patch.req,
    })
    return { id: updated.id, itc_classification: updated.itcClassification, itc_reason: updated.itcReason, auditor_note: updated.auditorNote }
  },

  /** Pair a 2B-only row with a books-only row the matcher couldn't connect. */
  async pair(session: Session, jobId: string, twoRowId: string, prRowId: string, req?: Request) {
    await GstReconJobService.get(session, jobId)
    const [a, b] = await Promise.all([GstReconJobService.rowFor(session, twoRowId), GstReconJobService.rowFor(session, prRowId)])
    if (a.jobId !== jobId || b.jobId !== jobId) throw ApiError.badRequest('Both rows must belong to this reconciliation.')
    if (a.matchStatus !== 'only_2b' || !a.filing2BEntry) throw ApiError.badRequest('The first row must be one that is only in GSTR-2B.')
    if (b.matchStatus !== 'only_pr' || !b.purchaseRegisterEntry) throw ApiError.badRequest('The second row must be one that is only in the books.')
    const job = await prisma.aaGstReconJob.findUniqueOrThrow({ where: { id: jobId }, include: { filing2B: true } })
    const two = from2B(a.filing2BEntry); const pr = fromPR(b.purchaseRegisterEntry)
    const c = compare(two, pr)
    const status: MatchStatus = c.amounts.length ? 'variance' : 'partial'
    const itc = itcFor(status, two, pr, periodOf(job.filing2B.periodMonth, job.filing2B.periodYear))
    const created = await prisma.$transaction(async (tx) => {
      await tx.aaGstReconRow.deleteMany({ where: { id: { in: [a.id, b.id] } } })
      return tx.aaGstReconRow.create({
        data: {
          jobId, matchStatus: status, filing2BEntryId: two.id, purchaseRegisterEntryId: pr.id, matchMethod: 'manual',
          mismatchFields: [...c.amounts, ...c.other, 'manual_pair'].join(','), itcClassification: itc.cls, itcReason: itc.reason,
          reviewedByUserId: session.userId, reviewedAt: new Date(),
        },
      })
    })
    await reroll(jobId)
    await writeAudit({ actorUserId: session.userId, action: 'aa.gst.rows_paired', entityType: 'AaGstReconJob', entityId: jobId, after: { row_id: created.id, filing_2b_entry_id: two.id, purchase_register_entry_id: pr.id, status }, req })
    return { id: created.id, match_status: status }
  },

  /** Split a paired row back into its 2B-only and books-only halves. */
  async unpair(session: Session, rowId: string, req?: Request) {
    const row = await GstReconJobService.rowFor(session, rowId)
    if (!row.filing2BEntry || !row.purchaseRegisterEntry) throw ApiError.badRequest('This row is not a pair.')
    const job = await prisma.aaGstReconJob.findUniqueOrThrow({ where: { id: row.jobId }, include: { filing2B: true } })
    const period = periodOf(job.filing2B.periodMonth, job.filing2B.periodYear)
    const two = from2B(row.filing2BEntry); const pr = fromPR(row.purchaseRegisterEntry)
    const i2 = itcFor('only_2b', two, undefined, period); const ip = itcFor('only_pr', undefined, pr, period)
    await prisma.$transaction([
      prisma.aaGstReconRow.delete({ where: { id: row.id } }),
      prisma.aaGstReconRow.create({ data: { jobId: row.jobId, matchStatus: 'only_2b', filing2BEntryId: two.id, itcClassification: i2.cls, itcReason: i2.reason, mismatchFields: 'unpaired' } }),
      prisma.aaGstReconRow.create({ data: { jobId: row.jobId, matchStatus: 'only_pr', purchaseRegisterEntryId: pr.id, itcClassification: ip.cls, itcReason: ip.reason, mismatchFields: 'unpaired' } }),
    ])
    await reroll(row.jobId)
    await writeAudit({ actorUserId: session.userId, action: 'aa.gst.rows_unpaired', entityType: 'AaGstReconJob', entityId: row.jobId, after: { from_row_id: row.id }, req })
    return { unpaired: true }
  },

  async remove(session: Session, jobId: string, req?: Request) {
    await GstReconJobService.get(session, jobId)
    await prisma.$transaction([
      prisma.aaGstReconRow.deleteMany({ where: { jobId } }),
      prisma.aaGstReconJob.delete({ where: { id: jobId } }),
    ])
    await writeAudit({ actorUserId: session.userId, action: 'aa.gst.recon_deleted', entityType: 'AaGstReconJob', entityId: jobId, req })
  },
}
