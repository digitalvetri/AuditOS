import type { Request } from 'express'
import { prisma, alive } from '../../../lib/prisma.js'
import { ApiError } from '../../../lib/http.js'
import { can, type Session } from '../../../platform/auth.js'
import { writeAudit } from '../../../platform/audit.js'
import {
  runTdsMatcher, totalsOf, rowFlags, defaultAction, withinTolerance,
  TDS_STATUSES, TDS_ACTIONS,
  type TdsActionStatus, type TdsMatchStatus, type TdsEntry, type TdsTotalsByBucket,
} from './TdsMatchingService.js'
import { ayLabel, fyLabel } from '../parsers/tdsTypes.js'

/**
 * A TDS reconciliation (26AS vs books) and its review: filters, actions
 * and notes per row, manual pair / unpair, re-run, and the deductor chase
 * list — one line per deductor with the shortfall, and a follow-up
 * (status, due date, contact, history) that outlives the run.
 */

export const FOLLOW_UP_STATUSES = ['open', 'contacted', 'promised', 'resolved', 'written_off'] as const
export type FollowUpStatus = typeof FOLLOW_UP_STATUSES[number]

type Totals = Record<TdsMatchStatus, { count: number; amount_paid: number; tds_amount: number; tds_26as: number; tds_books: number }>
export interface TdsReconJobApi {
  id: string
  client_id: string
  filing_26as_id: string
  books_id: string
  assessment_year: number
  status: 'queued' | 'matching' | 'matched' | 'failed'
  progress: number
  verified_count: number
  variance_count: number
  only_26as_count: number
  only_books_count: number
  flags: string[]
  totals: Totals | null
  error_message: string | null
  started_at: string | null
  completed_at: string | null
  created_at: string
}

type JobRow = Awaited<ReturnType<typeof prisma.aaTdsReconJob.findFirstOrThrow>>
function apiTotals(t: TdsTotalsByBucket): Totals {
  return Object.fromEntries(TDS_STATUSES.map((s) => [s, {
    count: t[s].count, amount_paid: t[s].amountPaid, tds_amount: t[s].tdsAmount, tds_26as: t[s].tds26as, tds_books: t[s].tdsBooks,
  }])) as Totals
}
function toApi(row: JobRow, ay: number): TdsReconJobApi {
  let totals: Totals | null = null
  if (row.totalsJson) {
    try {
      const t = JSON.parse(row.totalsJson) as Record<string, Record<string, number>>
      // Older runs stored { amountPaid, tdsAmount, count } only.
      totals = Object.fromEntries(TDS_STATUSES.map((s) => {
        const v = t[s] ?? {}
        return [s, { count: v.count ?? 0, amount_paid: v.amount_paid ?? v.amountPaid ?? 0, tds_amount: v.tds_amount ?? v.tdsAmount ?? 0, tds_26as: v.tds_26as ?? v.tds26as ?? 0, tds_books: v.tds_books ?? v.tdsBooks ?? 0 }]
      })) as Totals
    } catch { totals = null }
  }
  return {
    id: row.id, client_id: row.clientId, filing_26as_id: row.filing26ASId, books_id: row.booksId, assessment_year: ay,
    status: row.status as TdsReconJobApi['status'], progress: row.progress,
    verified_count: row.verifiedCount, variance_count: row.varianceCount, only_26as_count: row.only26ASCount, only_books_count: row.onlyBooksCount,
    flags: row.flags ? row.flags.split(',').filter(Boolean) : [], totals, error_message: row.errorMessage,
    started_at: row.startedAt?.toISOString() ?? null, completed_at: row.completedAt?.toISOString() ?? null, created_at: row.createdAt.toISOString(),
  }
}

async function orgOf(session: Session) {
  return (await prisma.user.findUniqueOrThrow({ where: { id: session.userId }, select: { organisationId: true } })).organisationId
}
async function scopedWhere(session: Session, base: object) {
  const organisationId = await orgOf(session)
  if (can(session, 'tools.audit_automation.tds.view', 'organisation')) return { ...base, organisationId }
  return { ...base, organisationId, createdByUserId: session.userId }
}

type E26 = Awaited<ReturnType<typeof prisma.aaTds26ASEntry.findMany>>[number]
type EBk = Awaited<ReturnType<typeof prisma.aaTdsBooksEntry.findMany>>[number]
const from26 = (e: E26): TdsEntry => ({
  id: e.id, part: e.part, section: e.section, deductorTan: e.deductorTan, deductorName: e.deductorName ?? undefined, quarter: e.quarter,
  amountPaid: e.amountPaid, tdsAmount: e.tdsAmount, tdsDeposited: e.tdsDeposited, tdsDate: e.tdsDate, status: e.status ?? undefined,
})
const fromBk = (e: EBk): TdsEntry => ({
  id: e.id, section: e.section, deductorTan: e.deductorTan, deductorName: e.deductorName ?? undefined, quarter: e.quarter,
  amountPaid: e.amountPaid, tdsAmount: e.tdsAmount, tdsDate: e.tdsDate, glCode: e.glCode ?? undefined,
})

function jobFlags(r: { rows: { flags: string[] }[]; tanFromName: number; outOfYear: number }, ayMismatch: boolean): string[] {
  const f: string[] = []
  if (ayMismatch) f.push('AY_MISMATCH')
  if (r.outOfYear) f.push('BOOKS_OUT_OF_YEAR')
  if (r.tanFromName) f.push('TAN_FROM_NAME')
  if (r.rows.some((x) => x.flags.includes('status_u'))) f.push('UNBOOKED_CREDITS')
  if (r.rows.some((x) => x.flags.includes('short_deposit'))) f.push('SHORT_DEPOSITS')
  return f
}

/** Counts and totals from the rows as they now stand. */
async function reroll(jobId: string) {
  const rows = await prisma.aaTdsReconRow.findMany({ where: { jobId }, include: { filing26ASEntry: true, booksEntry: true } })
  const two = new Map(rows.filter((r) => r.filing26ASEntry).map((r) => [r.filing26ASEntryId!, r.filing26ASEntry!]))
  const bk = new Map(rows.filter((r) => r.booksEntry).map((r) => [r.booksEntryId!, r.booksEntry!]))
  const t = totalsOf(rows.map((r) => ({ matchStatus: r.matchStatus as TdsMatchStatus, filing26ASEntryId: r.filing26ASEntryId ?? undefined, booksEntryId: r.booksEntryId ?? undefined })), two, bk)
  await prisma.aaTdsReconJob.update({
    where: { id: jobId },
    data: {
      verifiedCount: t.verified.count, varianceCount: t.variance.count, only26ASCount: t.only_26as.count, onlyBooksCount: t.only_books.count,
      totalsJson: JSON.stringify(apiTotals(t)),
    },
  })
}

type RowWithEntries = Awaited<ReturnType<typeof prisma.aaTdsReconRow.findMany<{ include: { filing26ASEntry: true; booksEntry: true } }>>>[number]
function rowApi(r: RowWithEntries) {
  const a = r.filing26ASEntry, b = r.booksEntry
  return {
    id: r.id, match_status: r.matchStatus as TdsMatchStatus, match_method: r.matchMethod, group_key: r.groupKey,
    deductor_key: r.deductorKey, mismatch_fields: r.mismatchFields ? r.mismatchFields.split(',').filter(Boolean) : [],
    flags: r.flags ? r.flags.split(',').filter(Boolean) : [], action_status: r.actionStatus as TdsActionStatus,
    auditor_note: r.auditorNote, reviewed_at: r.reviewedAt?.toISOString() ?? null,
    filing_26as_entry: a ? {
      id: a.id, part: a.part, section: a.section, deductor_tan: a.deductorTan, deductor_name: a.deductorName, quarter: a.quarter,
      amount_paid: a.amountPaid, tds_amount: a.tdsAmount, tds_deposited: a.tdsDeposited, tds_date: a.tdsDate,
      status: a.status, booking_date: a.bookingDate, remarks: a.remarks,
    } : null,
    books_entry: b ? {
      id: b.id, section: b.section, deductor_tan: b.deductorTan, deductor_name: b.deductorName, quarter: b.quarter,
      amount_paid: b.amountPaid, tds_amount: b.tdsAmount, tds_date: b.tdsDate, gl_code: b.glCode, reference: b.reference, voucher_type: b.voucherType,
    } : null,
  }
}

async function jobRecord(session: Session, id: string) {
  const row = await prisma.aaTdsReconJob.findFirst({ where: await scopedWhere(session, { id }), include: { filing26AS: true, books: true } })
  if (!row) throw ApiError.notFound('No such reconciliation.')
  return row
}

/** Match both sides and write the rows (inside a transaction), keeping reviewer work on pairs that survive. */
async function matchInto(jobId: string, filing26ASId: string, booksId: string, ay: number, booksAy: number, keep?: Map<string, { actionStatus: string; auditorNote: string | null; reviewedByUserId: string | null; reviewedAt: Date | null }>) {
  const [a, b] = await Promise.all([
    prisma.aaTds26ASEntry.findMany({ where: { filingId: filing26ASId } }),
    prisma.aaTdsBooksEntry.findMany({ where: { booksId } }),
  ])
  const result = runTdsMatcher({ filing26AS: a.map(from26), books: b.map(fromBk), assessmentYear: ay })
  const flags = jobFlags(result, ay !== booksAy)
  const t = apiTotals(result.totals)
  await prisma.$transaction(async (tx) => {
    await tx.aaTdsReconRow.deleteMany({ where: { jobId } })
    for (let i = 0; i < result.rows.length; i += 500) {
      await tx.aaTdsReconRow.createMany({
        data: result.rows.slice(i, i + 500).map((r) => {
          const kept = keep?.get(`${r.filing26ASEntryId ?? ''}|${r.booksEntryId ?? ''}`)
          return {
            jobId, matchStatus: r.matchStatus, filing26ASEntryId: r.filing26ASEntryId ?? null, booksEntryId: r.booksEntryId ?? null,
            mismatchFields: r.mismatchFields.join(','), matchMethod: r.matchMethod ?? null, groupKey: r.groupKey ?? null,
            deductorKey: r.deductorKey, flags: r.flags.join(','),
            actionStatus: kept?.actionStatus ?? r.actionStatus, auditorNote: kept?.auditorNote ?? null,
            reviewedByUserId: kept?.reviewedByUserId ?? null, reviewedAt: kept?.reviewedAt ?? null,
          }
        }),
      })
    }
    await tx.aaTdsReconJob.update({
      where: { id: jobId },
      data: {
        status: 'matched', progress: 100, completedAt: new Date(), errorMessage: null, flags: flags.join(','),
        verifiedCount: t.verified.count, varianceCount: t.variance.count, only26ASCount: t.only_26as.count, onlyBooksCount: t.only_books.count,
        totalsJson: JSON.stringify(t),
      },
    })
  }, { timeout: 120_000 })
  return { counts: Object.fromEntries(TDS_STATUSES.map((s) => [s, t[s].count])), flags }
}

export const TdsReconJobService = {
  async createAndRun(input: { session: Session; organisationId: string; clientId: string; filing26ASId: string; booksId: string; req?: Request }): Promise<TdsReconJobApi> {
    const { session, organisationId, clientId, filing26ASId, booksId, req } = input
    const filing = await prisma.aaTds26AS.findFirst({ where: { id: filing26ASId, clientId, organisationId, ...alive } })
    if (!filing) throw ApiError.notFound('No such 26AS.')
    const books = await prisma.aaTdsBooks.findFirst({ where: { id: booksId, clientId, organisationId, ...alive } })
    if (!books) throw ApiError.notFound('No such TDS book.')
    if (filing.assessmentYear !== books.assessmentYear) {
      throw ApiError.unprocessable('ay_mismatch', `The 26AS is for AY ${ayLabel(filing.assessmentYear)} but the books are for AY ${ayLabel(books.assessmentYear)}. Use the same year on both sides.`)
    }

    const job = await prisma.aaTdsReconJob.create({
      data: { organisationId, clientId, createdByUserId: session.userId, filing26ASId, booksId, status: 'matching', progress: 0, startedAt: new Date() },
    })
    try {
      const r = await matchInto(job.id, filing26ASId, booksId, filing.assessmentYear, books.assessmentYear)
      await writeAudit({ actorUserId: session.userId, action: 'aa.tds.recon_run', entityType: 'AaTdsReconJob', entityId: job.id, after: { client_id: clientId, filing_26as_id: filing26ASId, books_id: booksId, ...r.counts, flags: r.flags }, req })
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'matching_failed'
      await prisma.aaTdsReconRow.deleteMany({ where: { jobId: job.id } }).catch(() => undefined)
      await prisma.aaTdsReconJob.update({ where: { id: job.id }, data: { status: 'failed', errorMessage: msg.slice(0, 500), completedAt: new Date() } })
      await writeAudit({ actorUserId: session.userId, action: 'aa.tds.recon_failed', entityType: 'AaTdsReconJob', entityId: job.id, after: { error: msg.slice(0, 200) }, req })
    }
    return toApi(await prisma.aaTdsReconJob.findUniqueOrThrow({ where: { id: job.id } }), filing.assessmentYear)
  },

  /** Match again (after a parser or rule change); actions and notes stay on pairs that come out the same. */
  async rerun(session: Session, jobId: string, req?: Request): Promise<TdsReconJobApi> {
    const job = await jobRecord(session, jobId)
    const old = await prisma.aaTdsReconRow.findMany({ where: { jobId } })
    const keep = new Map(old.filter((r) => r.reviewedAt).map((r) => [`${r.filing26ASEntryId ?? ''}|${r.booksEntryId ?? ''}`, r]))
    await prisma.aaTdsReconJob.update({ where: { id: jobId }, data: { status: 'matching', startedAt: new Date() } })
    try {
      const r = await matchInto(jobId, job.filing26ASId, job.booksId, job.filing26AS.assessmentYear, job.books.assessmentYear, keep)
      await writeAudit({ actorUserId: session.userId, action: 'aa.tds.recon_rerun', entityType: 'AaTdsReconJob', entityId: jobId, after: { ...r.counts, flags: r.flags, kept_reviews: keep.size }, req })
    } catch (err) {
      await prisma.aaTdsReconJob.update({ where: { id: jobId }, data: { status: 'failed', errorMessage: (err as Error).message.slice(0, 500) } })
    }
    return TdsReconJobService.get(session, jobId)
  },

  async get(session: Session, id: string): Promise<TdsReconJobApi> {
    const row = await jobRecord(session, id)
    return toApi(row, row.filing26AS.assessmentYear)
  },

  async listForClient(session: Session, clientId: string) {
    const rows = await prisma.aaTdsReconJob.findMany({
      where: await scopedWhere(session, { clientId }), orderBy: { createdAt: 'desc' }, take: 100,
      include: { filing26AS: { select: { assessmentYear: true, originalFilename: true } }, books: { select: { originalFilename: true } } },
    })
    return rows.map((r) => ({ ...toApi(r, r.filing26AS.assessmentYear), filing_26as_name: r.filing26AS.originalFilename, books_name: r.books.originalFilename }))
  },

  async getRows(session: Session, jobId: string, filter: { status?: string; action?: string; flag?: string; deductor?: string; search?: string; limit?: number; offset?: number }) {
    await jobRecord(session, jobId)
    const q = filter.search?.trim()
    const text = q ? { contains: q, mode: 'insensitive' as const } : undefined
    const where = {
      jobId,
      ...(filter.status && filter.status !== 'all' ? { matchStatus: filter.status } : {}),
      ...(filter.action ? { actionStatus: filter.action } : {}),
      ...(filter.flag ? { flags: { contains: filter.flag } } : {}),
      ...(filter.deductor ? { deductorKey: filter.deductor } : {}),
      ...(text ? { OR: [
        { filing26ASEntry: { OR: [{ deductorTan: text }, { deductorName: text }, { section: text }] } },
        { booksEntry: { OR: [{ deductorTan: text }, { deductorName: text }, { section: text }, { reference: text }] } },
      ] } : {}),
    }
    const [rows, total, byStatus, byAction] = await Promise.all([
      prisma.aaTdsReconRow.findMany({
        where, orderBy: [{ deductorKey: 'asc' }, { groupKey: 'asc' }, { createdAt: 'asc' }],
        take: Math.min(Math.max(filter.limit ?? 100, 1), 500), skip: Math.max(filter.offset ?? 0, 0),
        include: { filing26ASEntry: true, booksEntry: true },
      }),
      prisma.aaTdsReconRow.count({ where }),
      prisma.aaTdsReconRow.groupBy({ by: ['matchStatus'], where: { jobId }, _count: { _all: true } }),
      prisma.aaTdsReconRow.groupBy({ by: ['actionStatus'], where: { jobId }, _count: { _all: true } }),
    ])
    return {
      total,
      counts: Object.fromEntries(byStatus.map((b) => [b.matchStatus, b._count._all])),
      action_counts: Object.fromEntries(byAction.map((b) => [b.actionStatus, b._count._all])),
      items: rows.map(rowApi),
    }
  },

  /** A row, checked through the same scope as reading its job. */
  async rowFor(session: Session, rowId: string) {
    const row = await prisma.aaTdsReconRow.findUnique({ where: { id: rowId }, include: { filing26ASEntry: true, booksEntry: true } })
    if (!row) throw ApiError.notFound('No such row.')
    await jobRecord(session, row.jobId)
    return row
  },

  async updateRow(session: Session, rowId: string, patch: { action_status?: TdsActionStatus; auditor_note?: string | null; req?: Request }) {
    const row = await TdsReconJobService.rowFor(session, rowId)
    if (patch.action_status && !TDS_ACTIONS.includes(patch.action_status)) throw ApiError.badRequest(`Action is one of ${TDS_ACTIONS.join(', ')}.`)
    const updated = await prisma.aaTdsReconRow.update({
      where: { id: rowId },
      data: {
        ...(patch.action_status ? { actionStatus: patch.action_status } : {}),
        ...(patch.auditor_note !== undefined ? { auditorNote: patch.auditor_note?.slice(0, 2000) || null } : {}),
        reviewedByUserId: session.userId, reviewedAt: new Date(),
      },
    })
    await writeAudit({
      actorUserId: session.userId, action: 'aa.tds.row_reviewed', entityType: 'AaTdsReconJob', entityId: row.jobId,
      before: { row_id: rowId, action_status: row.actionStatus, auditor_note: row.auditorNote },
      after: { row_id: rowId, action_status: updated.actionStatus, auditor_note: updated.auditorNote },
      req: patch.req,
    })
    return { id: updated.id, action_status: updated.actionStatus, auditor_note: updated.auditorNote }
  },

  /** Set one action on every open row of a deductor (not the verified ones). */
  async setDeductorAction(session: Session, jobId: string, deductorKey: string, action: TdsActionStatus, req?: Request) {
    await jobRecord(session, jobId)
    if (!TDS_ACTIONS.includes(action)) throw ApiError.badRequest(`Action is one of ${TDS_ACTIONS.join(', ')}.`)
    const r = await prisma.aaTdsReconRow.updateMany({
      where: { jobId, deductorKey, NOT: { matchStatus: 'verified', flags: '' } },
      data: { actionStatus: action, reviewedByUserId: session.userId, reviewedAt: new Date() },
    })
    await writeAudit({ actorUserId: session.userId, action: 'aa.tds.deductor_action', entityType: 'AaTdsReconJob', entityId: jobId, after: { deductor_key: deductorKey, action_status: action, rows: r.count }, req })
    return { updated: r.count }
  },

  /** Pair a 26AS-only row with a books-only row the matcher couldn't connect. */
  async pair(session: Session, jobId: string, twoRowId: string, booksRowId: string, req?: Request) {
    const job = await jobRecord(session, jobId)
    const [a, b] = await Promise.all([TdsReconJobService.rowFor(session, twoRowId), TdsReconJobService.rowFor(session, booksRowId)])
    if (a.jobId !== jobId || b.jobId !== jobId) throw ApiError.badRequest('Both rows must belong to this reconciliation.')
    if (a.matchStatus !== 'only_26as' || !a.filing26ASEntry) throw ApiError.badRequest('The first row must be one that is only in 26AS.')
    if (b.matchStatus !== 'only_books' || !b.booksEntry) throw ApiError.badRequest('The second row must be one that is only in the books.')
    const two = from26(a.filing26ASEntry); const bk = fromBk(b.booksEntry)
    const mismatch: string[] = []
    if (!withinTolerance(two.tdsAmount, bk.tdsAmount)) mismatch.push('tds_amount')
    if (two.section && bk.section && two.section !== bk.section) mismatch.push('section')
    if (two.amountPaid && bk.amountPaid && !withinTolerance(two.amountPaid, bk.amountPaid)) mismatch.push('amount_paid')
    if (two.quarter !== bk.quarter) mismatch.push('quarter')
    if (two.deductorTan !== (b.deductorKey ?? '')) mismatch.push('deductor')
    mismatch.push('manual_pair')
    const status: TdsMatchStatus = mismatch.includes('tds_amount') || mismatch.includes('section') ? 'variance' : 'verified'
    const flags = rowFlags(two, bk, job.filing26AS.assessmentYear)
    const created = await prisma.$transaction(async (tx) => {
      await tx.aaTdsReconRow.deleteMany({ where: { id: { in: [a.id, b.id] } } })
      return tx.aaTdsReconRow.create({
        data: {
          jobId, matchStatus: status, filing26ASEntryId: two.id, booksEntryId: bk.id, matchMethod: 'manual', deductorKey: two.deductorTan,
          mismatchFields: mismatch.join(','), flags: flags.join(','), actionStatus: defaultAction(status, flags, two, bk.tdsAmount),
          reviewedByUserId: session.userId, reviewedAt: new Date(),
        },
      })
    })
    await reroll(jobId)
    await writeAudit({ actorUserId: session.userId, action: 'aa.tds.rows_paired', entityType: 'AaTdsReconJob', entityId: jobId, after: { row_id: created.id, filing_26as_entry_id: two.id, books_entry_id: bk.id, status }, req })
    return { id: created.id, match_status: status }
  },

  /** Split a paired row back into its 26AS-only and books-only halves (a whole group, for a grouped row). */
  async unpair(session: Session, rowId: string, req?: Request) {
    const row = await TdsReconJobService.rowFor(session, rowId)
    if (!row.filing26ASEntry || !row.booksEntry) throw ApiError.badRequest('This row is not a pair.')
    const job = await jobRecord(session, row.jobId)
    const ay = job.filing26AS.assessmentYear
    const members = row.groupKey
      ? await prisma.aaTdsReconRow.findMany({ where: { jobId: row.jobId, groupKey: row.groupKey }, include: { filing26ASEntry: true, booksEntry: true } })
      : [row]
    const all26 = new Map<string, E26>(); const allBk = new Map<string, EBk>()
    for (const m of members) { if (m.filing26ASEntry) all26.set(m.filing26ASEntry.id, m.filing26ASEntry); if (m.booksEntry) allBk.set(m.booksEntry.id, m.booksEntry) }
    // Books keys: keep the name-resolved TAN the rows carried.
    const bookKey = new Map(members.filter((m) => m.booksEntryId).map((m) => [m.booksEntryId!, m.deductorKey ?? m.booksEntry!.deductorTan]))
    await prisma.$transaction(async (tx) => {
      await tx.aaTdsReconRow.deleteMany({ where: { id: { in: members.map((m) => m.id) } } })
      for (const e of all26.values()) {
        const f = rowFlags(from26(e), undefined, ay)
        await tx.aaTdsReconRow.create({ data: { jobId: row.jobId, matchStatus: 'only_26as', filing26ASEntryId: e.id, deductorKey: e.deductorTan, mismatchFields: 'unpaired', flags: f.join(','), actionStatus: defaultAction('only_26as', f) } })
      }
      for (const e of allBk.values()) {
        const f = rowFlags(undefined, fromBk(e), ay)
        await tx.aaTdsReconRow.create({ data: { jobId: row.jobId, matchStatus: 'only_books', booksEntryId: e.id, deductorKey: bookKey.get(e.id) ?? e.deductorTan, mismatchFields: 'unpaired', flags: f.join(','), actionStatus: defaultAction('only_books', f) } })
      }
    })
    await reroll(row.jobId)
    await writeAudit({ actorUserId: session.userId, action: 'aa.tds.rows_unpaired', entityType: 'AaTdsReconJob', entityId: row.jobId, after: { from_row_ids: members.map((m) => m.id) }, req })
    return { unpaired: true, rows: members.length }
  },

  async remove(session: Session, jobId: string, req?: Request) {
    await jobRecord(session, jobId)
    await prisma.$transaction([
      prisma.aaTdsReconRow.deleteMany({ where: { jobId } }),
      prisma.aaTdsReconJob.delete({ where: { id: jobId } }),
    ])
    await writeAudit({ actorUserId: session.userId, action: 'aa.tds.recon_deleted', entityType: 'AaTdsReconJob', entityId: jobId, req })
  },

  // ── deductor chase ─────────────────────────────────────────────────

  /** One line per deductor: 26AS vs books TDS, what is open, and the follow-up. */
  async deductors(session: Session, jobId: string) {
    const job = await jobRecord(session, jobId)
    const rows = await prisma.aaTdsReconRow.findMany({ where: { jobId }, include: { filing26ASEntry: true, booksEntry: true } })
    const ay = job.filing26AS.assessmentYear
    type D = {
      key: string; tan: string | null; name: string | null; rows: number; open: number
      tds_26as: number; tds_books: number; status_counts: Record<string, number>; flags: Record<string, number>; seen26: Set<string>; seenBk: Set<string>
    }
    const map = new Map<string, D>()
    for (const r of rows) {
      const key = r.deductorKey ?? r.filing26ASEntry?.deductorTan ?? r.booksEntry?.deductorTan ?? '—'
      let d = map.get(key)
      if (!d) {
        d = { key, tan: key.startsWith('NAME:') || key.startsWith('NONE:') ? null : key, name: null, rows: 0, open: 0, tds_26as: 0, tds_books: 0, status_counts: {}, flags: {}, seen26: new Set(), seenBk: new Set() }
        map.set(key, d)
      }
      d.name = d.name ?? r.filing26ASEntry?.deductorName ?? r.booksEntry?.deductorName ?? null
      d.rows += 1
      d.status_counts[r.matchStatus] = (d.status_counts[r.matchStatus] ?? 0) + 1
      for (const f of r.flags.split(',').filter(Boolean)) d.flags[f] = (d.flags[f] ?? 0) + 1
      if (!['no_action', 'credit_claimed', 'written_off'].includes(r.actionStatus)) d.open += 1
      if (r.filing26ASEntry && !d.seen26.has(r.filing26ASEntry.id)) { d.seen26.add(r.filing26ASEntry.id); d.tds_26as += r.filing26ASEntry.tdsAmount }
      if (r.booksEntry && !d.seenBk.has(r.booksEntry.id)) { d.seenBk.add(r.booksEntry.id); d.tds_books += r.booksEntry.tdsAmount }
    }
    const followUps = await prisma.aaTdsDeductorFollowUp.findMany({
      where: { clientId: job.clientId, assessmentYear: ay, deductorKey: { in: [...map.keys()] } },
      include: { _count: { select: { events: true } } },
    })
    const fu = new Map(followUps.map((f) => [f.deductorKey, f]))
    return {
      assessment_year: ay,
      items: [...map.values()].map(({ seen26: _a, seenBk: _b, ...d }) => {
        const f = fu.get(d.key)
        return {
          ...d,
          // Positive: the books claim more than 26AS shows — credit to chase.
          shortfall: d.tds_books - d.tds_26as,
          follow_up: f ? {
            id: f.id, status: f.status as FollowUpStatus, due_date: f.dueDate, contact_email: f.contactEmail, contact_phone: f.contactPhone,
            note: f.note, last_contacted_at: f.lastContactedAt?.toISOString() ?? null, updated_at: f.updatedAt.toISOString(), events: f._count.events,
          } : null,
        }
      }).sort((x, y) => y.shortfall - x.shortfall || y.open - x.open),
    }
  },

  async saveFollowUp(session: Session, jobId: string, deductorKey: string, patch: {
    status?: FollowUpStatus; due_date?: string | null; contact_email?: string | null; contact_phone?: string | null; note?: string | null; contacted?: boolean
  }, req?: Request) {
    const job = await jobRecord(session, jobId)
    const sample = await prisma.aaTdsReconRow.findFirst({ where: { jobId, deductorKey }, include: { filing26ASEntry: true, booksEntry: true } })
    if (!sample) throw ApiError.notFound('No such deductor in this reconciliation.')
    const ay = job.filing26AS.assessmentYear
    const where = { clientId_assessmentYear_deductorKey: { clientId: job.clientId, assessmentYear: ay, deductorKey } }
    const before = await prisma.aaTdsDeductorFollowUp.findUnique({ where })
    const name = sample.filing26ASEntry?.deductorName ?? sample.booksEntry?.deductorName ?? null
    const data = {
      ...(patch.status ? { status: patch.status } : {}),
      ...(patch.due_date !== undefined ? { dueDate: patch.due_date || null } : {}),
      ...(patch.contact_email !== undefined ? { contactEmail: patch.contact_email?.trim() || null } : {}),
      ...(patch.contact_phone !== undefined ? { contactPhone: patch.contact_phone?.trim() || null } : {}),
      ...(patch.note !== undefined ? { note: patch.note?.slice(0, 2000) || null } : {}),
      ...(patch.contacted ? { lastContactedAt: new Date(), ...(!patch.status && (!before || before.status === 'open') ? { status: 'contacted' } : {}) } : {}),
      updatedByUserId: session.userId,
    }
    const saved = await prisma.aaTdsDeductorFollowUp.upsert({
      where,
      create: {
        organisationId: job.organisationId, clientId: job.clientId, assessmentYear: ay, deductorKey,
        deductorTan: deductorKey.includes(':') ? null : deductorKey, deductorName: name, ...data,
      },
      update: data,
    })
    const events: { kind: string; fromStatus?: string | null; toStatus?: string | null; note?: string | null }[] = []
    if ((before?.status ?? 'open') !== saved.status || !before) events.push({ kind: 'status', fromStatus: before?.status ?? null, toStatus: saved.status })
    if (patch.contacted) events.push({ kind: 'contacted', note: patch.note ?? null })
    else if (patch.note !== undefined && patch.note !== (before?.note ?? null)) events.push({ kind: 'note', note: patch.note })
    if (patch.due_date !== undefined && (patch.due_date || null) !== (before?.dueDate ?? null)) events.push({ kind: 'due_date', note: patch.due_date || 'cleared' })
    if (events.length) await prisma.aaTdsFollowUpEvent.createMany({ data: events.map((e) => ({ followUpId: saved.id, userId: session.userId, ...e })) })
    await writeAudit({
      actorUserId: session.userId, action: 'aa.tds.follow_up', entityType: 'AaTdsDeductorFollowUp', entityId: saved.id,
      before: before ? { status: before.status, due_date: before.dueDate, note: before.note } : undefined,
      after: { job_id: jobId, deductor_key: deductorKey, status: saved.status, due_date: saved.dueDate, note: saved.note, contacted: Boolean(patch.contacted) },
      req,
    })
    return { id: saved.id, status: saved.status, due_date: saved.dueDate, last_contacted_at: saved.lastContactedAt?.toISOString() ?? null }
  },

  async followUpHistory(session: Session, followUpId: string) {
    const f = await prisma.aaTdsDeductorFollowUp.findUnique({ where: { id: followUpId }, include: { events: { orderBy: { createdAt: 'desc' }, take: 200 } } })
    if (!f || f.organisationId !== (await orgOf(session))) throw ApiError.notFound('No such follow-up.')
    const users = await prisma.user.findMany({ where: { id: { in: [...new Set(f.events.map((e) => e.userId))] } }, select: { id: true, email: true, employee: { select: { fullName: true } } } })
    const who = new Map(users.map((u) => [u.id, u.employee?.fullName ?? u.email]))
    return {
      items: f.events.map((e) => ({ id: e.id, kind: e.kind, from_status: e.fromStatus, to_status: e.toStatus, note: e.note, by: who.get(e.userId) ?? null, at: e.createdAt.toISOString() })),
    }
  },

  /** A ready-to-send request to the deductor, listing what the books show and 26AS doesn't. */
  async chaseLetter(session: Session, jobId: string, deductorKey: string) {
    const job = await jobRecord(session, jobId)
    const rows = await prisma.aaTdsReconRow.findMany({
      where: { jobId, deductorKey, OR: [{ matchStatus: { in: ['only_books', 'variance'] } }, { NOT: { flags: '' } }] },
      include: { filing26ASEntry: true, booksEntry: true },
    })
    if (!rows.length) throw ApiError.notFound('Nothing is open with this deductor.')
    const client = await prisma.client.findUniqueOrThrow({ where: { id: job.clientId }, select: { companyName: true } })
    const rs = (p: number) => `₹${(p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    const name = rows[0].filing26ASEntry?.deductorName ?? rows[0].booksEntry?.deductorName ?? 'Sir / Madam'
    const pan = job.filing26AS.pan ?? '[PAN]'
    const ay = job.filing26AS.assessmentYear
    const lines = rows.map((r, i) => {
      const a = r.filing26ASEntry, b = r.booksEntry
      const f = r.flags.split(',')
      const why = r.matchStatus === 'only_books' ? 'not reflected in our Form 26AS'
        : r.mismatchFields.includes('tds_amount') ? `26AS shows ${rs(a!.tdsAmount)}`
        : f.includes('status_u') ? 'shown as Unmatched (U) — the challan does not tie to your TDS statement'
        : f.includes('short_deposit') ? `deducted ${rs(a!.tdsAmount)} but only ${rs(a!.tdsDeposited)} deposited`
        : f.includes('status_o') ? 'shown as Overbooked (O)'
        : f.includes('status_z') ? 'shown as Mismatched (Z)'
        : r.mismatchFields.includes('section') ? `reported under section ${a!.section} instead of ${b!.section}` : 'please verify'
      const e = b ?? a!
      return `${i + 1}. ${'reference' in e && e.reference ? `Ref ${e.reference}, ` : ''}${e.tdsDate}, section ${e.section || '—'}, TDS ${rs(e.tdsAmount)} — ${why}`
    })
    const body = [
      `Dear ${name},`,
      '',
      `Our Form 26AS (PAN ${pan}, FY ${fyLabel(ay)} / AY ${ayLabel(ay)}) does not match the TDS you deducted from our payments, as per our books:`,
      '',
      ...lines,
      '',
      'Please file or revise your TDS statement (24Q/26Q/27EQ) so that the credit reflects correctly against our PAN, and share the Form 16A for these deductions.',
      '',
      'Regards,',
      client.companyName,
    ].join('\n')
    return { subject: `TDS credit not reflected in Form 26AS — ${client.companyName} (PAN ${pan}), FY ${fyLabel(ay)}`, body, items: rows.length }
  },
}

