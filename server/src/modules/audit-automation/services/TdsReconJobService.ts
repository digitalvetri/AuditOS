import type { Request } from 'express'
import { prisma, alive } from '../../../lib/prisma.js'
import { ApiError } from '../../../lib/http.js'
import { can, type Session } from '../../../platform/auth.js'
import { writeAudit } from '../../../platform/audit.js'
import { runTdsMatcher, type TdsActionStatus, type TdsMatchStatus } from './TdsMatchingService.js'
import type { NormalizedTdsEntry } from '../parsers/tdsTypes.js'

export interface TdsReconJobApi {
  id: string
  client_id: string
  filing_26as_id: string
  books_id: string
  status: 'queued' | 'matching' | 'matched' | 'failed'
  progress: number
  verified_count: number
  variance_count: number
  only_26as_count: number
  only_books_count: number
  totals: Record<TdsMatchStatus, { amount_paid: number; tds_amount: number; count: number }> | null
  error_message: string | null
  started_at: string | null
  completed_at: string | null
  created_at: string
}

function toApi(row: {
  id: string; clientId: string; filing26ASId: string; booksId: string;
  status: string; progress: number; verifiedCount: number; varianceCount: number;
  only26ASCount: number; onlyBooksCount: number; totalsJson: string | null;
  errorMessage: string | null; startedAt: Date | null; completedAt: Date | null;
  createdAt: Date;
}): TdsReconJobApi {
  let totals: TdsReconJobApi['totals'] = null
  if (row.totalsJson) {
    try {
      const t = JSON.parse(row.totalsJson) as Record<string, { amountPaid: number; tdsAmount: number; count: number }>
      totals = Object.fromEntries(Object.entries(t).map(([k, v]) => [k, {
        amount_paid: v.amountPaid, tds_amount: v.tdsAmount, count: v.count,
      }])) as TdsReconJobApi['totals']
    } catch { totals = null }
  }
  return {
    id: row.id,
    client_id: row.clientId,
    filing_26as_id: row.filing26ASId,
    books_id: row.booksId,
    status: row.status as TdsReconJobApi['status'],
    progress: row.progress,
    verified_count: row.verifiedCount,
    variance_count: row.varianceCount,
    only_26as_count: row.only26ASCount,
    only_books_count: row.onlyBooksCount,
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
  if (can(session, 'tools.audit_automation.tds.view', 'organisation')) return { ...base, organisationId }
  return { ...base, organisationId, createdByUserId: session.userId }
}

export const TdsReconJobService = {
  toApi,

  async createAndRun(input: {
    session: Session
    organisationId: string
    clientId: string
    filing26ASId: string
    booksId: string
    req?: Request
  }): Promise<TdsReconJobApi> {
    const { session, organisationId, clientId, filing26ASId, booksId, req } = input

    const filing = await prisma.aaTds26AS.findFirst({ where: { id: filing26ASId, clientId, organisationId, ...alive } })
    if (!filing) throw ApiError.notFound('No such 26AS.')
    const books = await prisma.aaTdsBooks.findFirst({ where: { id: booksId, clientId, organisationId, ...alive } })
    if (!books) throw ApiError.notFound('No such TDS book.')

    const filingEntries = await prisma.aaTds26ASEntry.findMany({ where: { filingId: filing26ASId } })
    const booksEntries = await prisma.aaTdsBooksEntry.findMany({ where: { booksId } })

    const started = new Date()
    const jobRow = await prisma.aaTdsReconJob.create({
      data: {
        organisationId, clientId,
        createdByUserId: session.userId,
        filing26ASId, booksId,
        status: 'matching', progress: 0, startedAt: started,
      },
    })

    try {
      const filingNorm: (NormalizedTdsEntry & { id: string })[] = filingEntries.map((e) => ({
        id: e.id, part: e.part, section: e.section,
        deductorTan: e.deductorTan, deductorName: e.deductorName ?? undefined,
        quarter: e.quarter, amountPaid: e.amountPaid, tdsAmount: e.tdsAmount, tdsDate: e.tdsDate,
        status: e.status ?? undefined,
      }))
      const booksNorm: (NormalizedTdsEntry & { id: string })[] = booksEntries.map((e) => ({
        id: e.id, section: e.section,
        deductorTan: e.deductorTan, deductorName: e.deductorName ?? undefined,
        quarter: e.quarter, amountPaid: e.amountPaid, tdsAmount: e.tdsAmount, tdsDate: e.tdsDate,
        glCode: e.glCode ?? undefined,
      }))
      const result = runTdsMatcher({ filing26AS: filingNorm, books: booksNorm })

      const CHUNK = 500
      for (let i = 0; i < result.rows.length; i += CHUNK) {
        const slice = result.rows.slice(i, i + CHUNK)
        await prisma.aaTdsReconRow.createMany({
          data: slice.map((r) => ({
            jobId: jobRow.id,
            matchStatus: r.matchStatus,
            filing26ASEntryId: r.filing26ASEntryId ?? null,
            booksEntryId: r.booksEntryId ?? null,
            mismatchFields: r.mismatchFields.join(','),
            actionStatus: r.actionStatus,
          })),
        })
      }

      const counts = {
        verified: result.rows.filter((r) => r.matchStatus === 'verified').length,
        variance: result.rows.filter((r) => r.matchStatus === 'variance').length,
        only_26as: result.rows.filter((r) => r.matchStatus === 'only_26as').length,
        only_books: result.rows.filter((r) => r.matchStatus === 'only_books').length,
      }
      const completed = new Date()
      const updated = await prisma.aaTdsReconJob.update({
        where: { id: jobRow.id },
        data: {
          status: 'matched', progress: 100,
          verifiedCount: counts.verified,
          varianceCount: counts.variance,
          only26ASCount: counts.only_26as,
          onlyBooksCount: counts.only_books,
          totalsJson: JSON.stringify(result.totals),
          completedAt: completed,
        },
      })

      await writeAudit({
        actorUserId: session.userId,
        action: 'aa.tds.recon_run',
        entityType: 'AaTdsReconJob',
        entityId: jobRow.id,
        after: { client_id: clientId, filing_26as_id: filing26ASId, books_id: booksId, ...counts },
        req,
      })

      return toApi(updated)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'matching_failed'
      const failed = await prisma.aaTdsReconJob.update({
        where: { id: jobRow.id },
        data: { status: 'failed', errorMessage: msg, completedAt: new Date() },
      })
      return toApi(failed)
    }
  },

  async get(session: Session, id: string): Promise<TdsReconJobApi> {
    const where = await scopedWhere(session, { id })
    const row = await prisma.aaTdsReconJob.findFirst({ where })
    if (!row) throw ApiError.notFound('No such reconciliation.')
    return toApi(row)
  },

  async listForClient(session: Session, clientId: string): Promise<TdsReconJobApi[]> {
    const where = await scopedWhere(session, { clientId })
    const rows = await prisma.aaTdsReconJob.findMany({ where, orderBy: { createdAt: 'desc' }, take: 100 })
    return rows.map(toApi)
  },

  async getRows(session: Session, jobId: string, filter: { status?: string; limit?: number; offset?: number }) {
    await TdsReconJobService.get(session, jobId)
    const where = filter.status ? { jobId, matchStatus: filter.status } : { jobId }
    const rows = await prisma.aaTdsReconRow.findMany({
      where,
      orderBy: [{ matchStatus: 'asc' }, { createdAt: 'asc' }],
      take: Math.min(filter.limit ?? 200, 500),
      skip: filter.offset ?? 0,
      include: { filing26ASEntry: true, booksEntry: true },
    })
    const total = await prisma.aaTdsReconRow.count({ where })
    return {
      total,
      items: rows.map((r) => ({
        id: r.id,
        match_status: r.matchStatus,
        mismatch_fields: r.mismatchFields ? r.mismatchFields.split(',') : [],
        action_status: r.actionStatus,
        auditor_note: r.auditorNote,
        reviewed_at: r.reviewedAt?.toISOString() ?? null,
        filing_26as_entry: r.filing26ASEntry ? {
          id: r.filing26ASEntry.id,
          part: r.filing26ASEntry.part,
          section: r.filing26ASEntry.section,
          deductor_tan: r.filing26ASEntry.deductorTan,
          deductor_name: r.filing26ASEntry.deductorName,
          quarter: r.filing26ASEntry.quarter,
          amount_paid: r.filing26ASEntry.amountPaid,
          tds_amount: r.filing26ASEntry.tdsAmount,
          tds_date: r.filing26ASEntry.tdsDate,
          status: r.filing26ASEntry.status,
        } : null,
        books_entry: r.booksEntry ? {
          id: r.booksEntry.id,
          section: r.booksEntry.section,
          deductor_tan: r.booksEntry.deductorTan,
          deductor_name: r.booksEntry.deductorName,
          quarter: r.booksEntry.quarter,
          amount_paid: r.booksEntry.amountPaid,
          tds_amount: r.booksEntry.tdsAmount,
          tds_date: r.booksEntry.tdsDate,
          gl_code: r.booksEntry.glCode,
        } : null,
      })),
    }
  },

  async updateRow(session: Session, rowId: string, patch: {
    action_status?: TdsActionStatus
    auditor_note?: string | null
    req?: Request
  }) {
    const row = await prisma.aaTdsReconRow.findFirst({
      where: { id: rowId }, include: { job: true },
    })
    if (!row) throw ApiError.notFound('No such row.')
    const { organisationId } = await prisma.user.findUniqueOrThrow({
      where: { id: session.userId }, select: { organisationId: true },
    })
    if (row.job.organisationId !== organisationId) throw ApiError.notFound('No such row.')

    const updated = await prisma.aaTdsReconRow.update({
      where: { id: rowId },
      data: {
        ...(patch.action_status ? { actionStatus: patch.action_status } : {}),
        ...(patch.auditor_note !== undefined ? { auditorNote: patch.auditor_note } : {}),
        reviewedByUserId: session.userId,
        reviewedAt: new Date(),
      },
    })

    await writeAudit({
      actorUserId: session.userId,
      action: 'aa.tds.row_reviewed',
      entityType: 'AaTdsReconJob',
      entityId: row.jobId,
      after: { row_id: rowId, action_status: updated.actionStatus, auditor_note: updated.auditorNote },
      req: patch.req,
    })

    return { id: updated.id, action_status: updated.actionStatus, auditor_note: updated.auditorNote }
  },
}
