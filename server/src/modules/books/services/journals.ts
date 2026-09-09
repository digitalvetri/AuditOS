import type { PrismaClient } from '@prisma/client'
import { ApiError } from '../../../lib/http.js'
import type { BooksContext } from '../engine/context.js'
import { toMinor } from '../engine/money.js'
import { deleteDraftJournal, postDraftJournal, postJournal, saveDraftJournal, voidJournal, withBooksTx, type PostLine } from '../engine/posting.js'

/**
 * MANUAL JOURNALS — the accountant's escape hatch (accruals, depreciation,
 * adjustments). Same engine, same invariants as every wrapper.
 */
export interface JournalInput {
  date: string
  narration?: string | null
  reference?: string | null
  lines: { ledger_id: string; side: 'debit' | 'credit'; amount: number | string; description?: string | null }[]
}

const include = { lines: { orderBy: { lineNo: 'asc' as const } }, allocations: true }

function toLines(b: JournalInput): PostLine[] {
  if (!Array.isArray(b.lines)) throw ApiError.badRequest('lines is required.')
  return b.lines.map((l) => ({ ledgerId: l.ledger_id, side: l.side, amount: toMinor(l.amount), description: l.description ?? null }))
}

export const Journals = {
  list: (prisma: PrismaClient, ctx: BooksContext, f: { status?: string; voucher_type?: string; from?: string; to?: string; q?: string; limit?: number } = {}) =>
    prisma.booksJournal.findMany({
      where: {
        booksOrgId: ctx.booksOrgId,
        ...(f.status ? { status: f.status } : {}), ...(f.voucher_type ? { voucherType: f.voucher_type } : {}),
        ...(f.from || f.to ? { date: { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lte: f.to } : {}) } } : {}),
        ...(f.q ? { OR: [{ number: { contains: f.q } }, { narration: { contains: f.q } }] } : {}),
      },
      include, orderBy: [{ date: 'desc' }, { createdAt: 'desc' }], take: Math.min(f.limit ?? 200, 1000),
    }),

  get: async (prisma: PrismaClient, ctx: BooksContext, id: string) => {
    const j = await prisma.booksJournal.findFirst({ where: { id, booksOrgId: ctx.booksOrgId }, include: { ...include, allocations: { include: { bill: true } } } })
    if (!j) throw ApiError.notFound('Journal not found.')
    return j
  },

  /** Post straight away. */
  create: (prisma: PrismaClient, ctx: BooksContext, b: JournalInput) => withBooksTx(prisma, (tx) =>
    postJournal(tx, ctx, { date: b.date, voucherType: 'journal', sourceModule: 'manual', narration: [b.reference, b.narration].filter(Boolean).join(' · ') || null, lines: toLines(b) })),

  saveDraft: (prisma: PrismaClient, ctx: BooksContext, b: JournalInput, id?: string) => withBooksTx(prisma, (tx) =>
    saveDraftJournal(tx, ctx, { id, date: b.date, voucherType: 'journal', sourceModule: 'manual', narration: [b.reference, b.narration].filter(Boolean).join(' · ') || null, lines: toLines(b) })),

  postDraft: (prisma: PrismaClient, ctx: BooksContext, id: string) => withBooksTx(prisma, (tx) => postDraftJournal(tx, ctx, id)),

  deleteDraft: (prisma: PrismaClient, ctx: BooksContext, id: string) => withBooksTx(prisma, (tx) => deleteDraftJournal(tx, ctx, id)),

  void: (prisma: PrismaClient, ctx: BooksContext, id: string, reason?: string | null) => withBooksTx(prisma, (tx) => voidJournal(tx, ctx, id, { reason: reason ?? null })),

  audit: (prisma: PrismaClient, ctx: BooksContext, entityType: string, entityId: string) =>
    prisma.booksAuditEvent.findMany({ where: { booksOrgId: ctx.booksOrgId, entityType, entityId }, orderBy: { createdAt: 'asc' } }),
}
