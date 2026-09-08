import type { Request } from 'express'
import { prisma, alive } from '../../../lib/prisma.js'
import { ApiError } from '../../../lib/http.js'
import { can, type Session } from '../../../platform/auth.js'
import { writeAudit } from '../../../platform/audit.js'
import { runMatcher, type MatchStatus, type ItcClassification } from './GstMatchingService.js'
import type { NormalizedEntry } from '../parsers/types.js'

/**
 * Orchestrates a GST reconciliation run: loads both sides, matches,
 * persists rows and rolls totals into the job record.
 *
 * `createAndRun()` is synchronous (SQLite dev + typical filing sizes make
 * this fine); it returns after all rows are persisted. A future queue
 * would only wrap this call.
 */

export type ItcClassificationApi = ItcClassification

export interface ReconJobApi {
  id: string
  client_id: string
  filing_2b_id: string
  purchase_register_id: string
  status: 'queued' | 'matching' | 'matched' | 'failed'
  progress: number
  matched_count: number
  partial_count: number
  only_2b_count: number
  only_pr_count: number
  totals: Record<MatchStatus, { taxable: number; igst: number; cgst: number; sgst: number; cess: number; count: number }> | null
  error_message: string | null
  started_at: string | null
  completed_at: string | null
  created_at: string
}

function toApi(row: {
  id: string; clientId: string; filing2BId: string; purchaseRegisterId: string;
  status: string; progress: number; matchedCount: number; partialCount: number;
  only2BCount: number; onlyPRCount: number; totalsJson: string | null;
  errorMessage: string | null; startedAt: Date | null; completedAt: Date | null;
  createdAt: Date;
}): ReconJobApi {
  let totals: ReconJobApi['totals'] = null
  if (row.totalsJson) {
    try { totals = JSON.parse(row.totalsJson) } catch { totals = null }
  }
  return {
    id: row.id,
    client_id: row.clientId,
    filing_2b_id: row.filing2BId,
    purchase_register_id: row.purchaseRegisterId,
    status: row.status as ReconJobApi['status'],
    progress: row.progress,
    matched_count: row.matchedCount,
    partial_count: row.partialCount,
    only_2b_count: row.only2BCount,
    only_pr_count: row.onlyPRCount,
    totals,
    error_message: row.errorMessage,
    started_at: row.startedAt?.toISOString() ?? null,
    completed_at: row.completedAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
  }
}

async function scopedWhere(session: Session, base: object) {
  const { organisationId } = await prisma.user.findUniqueOrThrow({
    where: { id: session.userId }, select: { organisationId: true },
  })
  if (can(session, 'tools.audit_automation.gst.view', 'organisation')) return { ...base, organisationId }
  return { ...base, organisationId, createdByUserId: session.userId }
}

export const GstReconJobService = {
  toApi,

  async createAndRun(input: {
    session: Session
    organisationId: string
    clientId: string
    filing2BId: string
    purchaseRegisterId: string
    req?: Request
  }): Promise<ReconJobApi> {
    const { session, organisationId, clientId, filing2BId, purchaseRegisterId, req } = input

    // Ownership checks
    const filing = await prisma.aaGstFiling2B.findFirst({ where: { id: filing2BId, clientId, organisationId, ...alive } })
    if (!filing) throw ApiError.notFound('No such 2B filing.')
    const pr = await prisma.aaPurchaseRegister.findFirst({ where: { id: purchaseRegisterId, clientId, organisationId, ...alive } })
    if (!pr) throw ApiError.notFound('No such purchase register.')

    // Load entries
    const filingEntries = await prisma.aaGstFiling2BEntry.findMany({ where: { filingId: filing2BId } })
    const prEntries = await prisma.aaPurchaseRegisterEntry.findMany({ where: { registerId: purchaseRegisterId } })

    // Match
    const started = new Date()
    const jobRow = await prisma.aaGstReconJob.create({
      data: {
        organisationId, clientId,
        createdByUserId: session.userId,
        filing2BId, purchaseRegisterId,
        status: 'matching', progress: 0,
        startedAt: started,
      },
    })

    try {
      const filingNorm: (NormalizedEntry & { id: string })[] = filingEntries.map((e) => ({
        id: e.id,
        section: e.section,
        supplierGstin: e.supplierGstin,
        supplierName: e.supplierName ?? undefined,
        invoiceNumber: e.invoiceNumber,
        invoiceDate: e.invoiceDate,
        taxableValue: e.taxableValue,
        igst: e.igst, cgst: e.cgst, sgst: e.sgst, cess: e.cess,
        itcAvailable: e.itcAvailable,
      }))
      const prNorm: (NormalizedEntry & { id: string })[] = prEntries.map((e) => ({
        id: e.id,
        supplierGstin: e.supplierGstin,
        supplierName: e.supplierName ?? undefined,
        invoiceNumber: e.invoiceNumber,
        invoiceDate: e.invoiceDate,
        taxableValue: e.taxableValue,
        igst: e.igst, cgst: e.cgst, sgst: e.sgst, cess: e.cess,
        glCode: e.glCode ?? undefined,
      }))
      const result = runMatcher({ filing2B: filingNorm, purchaseRegister: prNorm })

      // Persist rows in chunks
      const CHUNK = 500
      for (let i = 0; i < result.rows.length; i += CHUNK) {
        const slice = result.rows.slice(i, i + CHUNK)
        await prisma.aaGstReconRow.createMany({
          data: slice.map((r) => ({
            jobId: jobRow.id,
            matchStatus: r.matchStatus,
            filing2BEntryId: r.filing2BEntryId ?? null,
            purchaseRegisterEntryId: r.purchaseRegisterEntryId ?? null,
            mismatchFields: r.mismatchFields.join(','),
            itcClassification: r.itcClassification,
          })),
        })
      }

      // Roll up counts + totals
      const counts = {
        matched: result.rows.filter((r) => r.matchStatus === 'matched').length,
        partial: result.rows.filter((r) => r.matchStatus === 'partial').length,
        only_2b: result.rows.filter((r) => r.matchStatus === 'only_2b').length,
        only_pr: result.rows.filter((r) => r.matchStatus === 'only_pr').length,
      }
      const completed = new Date()
      const updated = await prisma.aaGstReconJob.update({
        where: { id: jobRow.id },
        data: {
          status: 'matched',
          progress: 100,
          matchedCount: counts.matched,
          partialCount: counts.partial,
          only2BCount: counts.only_2b,
          onlyPRCount: counts.only_pr,
          totalsJson: JSON.stringify(result.totals),
          completedAt: completed,
        },
      })

      await writeAudit({
        actorUserId: session.userId,
        action: 'aa.gst.recon_run',
        entityType: 'AaGstReconJob',
        entityId: jobRow.id,
        after: {
          client_id: clientId, filing_2b_id: filing2BId,
          purchase_register_id: purchaseRegisterId, ...counts,
        },
        req,
      })

      return toApi(updated)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'matching_failed'
      const failed = await prisma.aaGstReconJob.update({
        where: { id: jobRow.id },
        data: { status: 'failed', errorMessage: msg, completedAt: new Date() },
      })
      return toApi(failed)
    }
  },

  async get(session: Session, id: string): Promise<ReconJobApi> {
    const where = await scopedWhere(session, { id })
    const row = await prisma.aaGstReconJob.findFirst({ where })
    if (!row) throw ApiError.notFound('No such reconciliation.')
    return toApi(row)
  },

  async listForClient(session: Session, clientId: string): Promise<ReconJobApi[]> {
    const where = await scopedWhere(session, { clientId })
    const rows = await prisma.aaGstReconJob.findMany({ where, orderBy: { createdAt: 'desc' }, take: 100 })
    return rows.map(toApi)
  },

  async getRows(session: Session, jobId: string, filter: { status?: string; limit?: number; offset?: number }) {
    // Ownership check via job scope
    await GstReconJobService.get(session, jobId)
    const where = filter.status ? { jobId, matchStatus: filter.status } : { jobId }
    const rows = await prisma.aaGstReconRow.findMany({
      where,
      orderBy: [{ matchStatus: 'asc' }, { createdAt: 'asc' }],
      take: Math.min(filter.limit ?? 200, 500),
      skip: filter.offset ?? 0,
      include: {
        filing2BEntry: true,
        purchaseRegisterEntry: true,
      },
    })
    const total = await prisma.aaGstReconRow.count({ where })
    return {
      total,
      items: rows.map((r) => ({
        id: r.id,
        match_status: r.matchStatus,
        mismatch_fields: r.mismatchFields ? r.mismatchFields.split(',') : [],
        itc_classification: r.itcClassification,
        auditor_note: r.auditorNote,
        reviewed_at: r.reviewedAt?.toISOString() ?? null,
        filing_2b_entry: r.filing2BEntry ? {
          id: r.filing2BEntry.id,
          section: r.filing2BEntry.section,
          supplier_gstin: r.filing2BEntry.supplierGstin,
          supplier_name: r.filing2BEntry.supplierName,
          invoice_number: r.filing2BEntry.invoiceNumber,
          invoice_date: r.filing2BEntry.invoiceDate,
          taxable_value: r.filing2BEntry.taxableValue,
          igst: r.filing2BEntry.igst, cgst: r.filing2BEntry.cgst,
          sgst: r.filing2BEntry.sgst, cess: r.filing2BEntry.cess,
          itc_available: r.filing2BEntry.itcAvailable,
        } : null,
        purchase_register_entry: r.purchaseRegisterEntry ? {
          id: r.purchaseRegisterEntry.id,
          supplier_gstin: r.purchaseRegisterEntry.supplierGstin,
          supplier_name: r.purchaseRegisterEntry.supplierName,
          invoice_number: r.purchaseRegisterEntry.invoiceNumber,
          invoice_date: r.purchaseRegisterEntry.invoiceDate,
          taxable_value: r.purchaseRegisterEntry.taxableValue,
          igst: r.purchaseRegisterEntry.igst, cgst: r.purchaseRegisterEntry.cgst,
          sgst: r.purchaseRegisterEntry.sgst, cess: r.purchaseRegisterEntry.cess,
          gl_code: r.purchaseRegisterEntry.glCode,
        } : null,
      })),
    }
  },

  async updateRow(session: Session, rowId: string, patch: {
    itc_classification?: ItcClassification
    auditor_note?: string | null
    req?: Request
  }) {
    const row = await prisma.aaGstReconRow.findFirst({
      where: { id: rowId }, include: { job: true },
    })
    if (!row) throw ApiError.notFound('No such row.')
    const { organisationId } = await prisma.user.findUniqueOrThrow({
      where: { id: session.userId }, select: { organisationId: true },
    })
    if (row.job.organisationId !== organisationId) throw ApiError.notFound('No such row.')

    const updated = await prisma.aaGstReconRow.update({
      where: { id: rowId },
      data: {
        ...(patch.itc_classification ? { itcClassification: patch.itc_classification } : {}),
        ...(patch.auditor_note !== undefined ? { auditorNote: patch.auditor_note } : {}),
        reviewedByUserId: session.userId,
        reviewedAt: new Date(),
      },
    })

    await writeAudit({
      actorUserId: session.userId,
      action: 'aa.gst.row_reviewed',
      entityType: 'AaGstReconJob',
      entityId: row.jobId,
      after: {
        row_id: rowId,
        itc_classification: updated.itcClassification,
        auditor_note: updated.auditorNote,
      },
      req: patch.req,
    })

    return { id: updated.id, itc_classification: updated.itcClassification, auditor_note: updated.auditorNote }
  },
}
