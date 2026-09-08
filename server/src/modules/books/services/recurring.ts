import type { PrismaClient } from '@prisma/client'
import { ApiError } from '../../../lib/http.js'
import type { BooksContext } from '../engine/context.js'
import { booksAudit } from '../engine/audit.js'
import { BooksError } from '../engine/errors.js'
import { withBooksTx } from '../engine/posting.js'
import { Documents, type DocInput } from './documents.js'

/**
 * RECURRING invoices and bills. A profile holds a document template and a
 * schedule; `runDue` creates one document per elapsed period (posting it
 * when the profile says so) and advances the next run date.
 */
export type Frequency = 'weekly' | 'monthly' | 'quarterly' | 'yearly'

export interface ProfileInput {
  kind: 'invoice' | 'bill'
  name: string
  frequency: Frequency
  start_date: string
  end_date?: string | null
  auto_post?: boolean
  template: DocInput
}

export function advance(date: string, f: Frequency): string {
  const d = new Date(`${date}T00:00:00Z`)
  if (f === 'weekly') d.setUTCDate(d.getUTCDate() + 7)
  else if (f === 'monthly') d.setUTCMonth(d.getUTCMonth() + 1)
  else if (f === 'quarterly') d.setUTCMonth(d.getUTCMonth() + 3)
  else d.setUTCFullYear(d.getUTCFullYear() + 1)
  return d.toISOString().slice(0, 10)
}

export const Recurring = {
  list: (prisma: PrismaClient, ctx: BooksContext, kind?: string) =>
    prisma.booksRecurringProfile.findMany({ where: { booksOrgId: ctx.booksOrgId, ...(kind ? { kind } : {}) }, orderBy: { nextRunDate: 'asc' } }),

  create: (prisma: PrismaClient, ctx: BooksContext, b: ProfileInput) => withBooksTx(prisma, async (tx) => {
    if (!['invoice', 'bill'].includes(b.kind)) throw ApiError.badRequest('kind must be invoice or bill.')
    if (!['weekly', 'monthly', 'quarterly', 'yearly'].includes(b.frequency)) throw ApiError.badRequest('frequency must be weekly, monthly, quarterly or yearly.')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(b.start_date ?? '')) throw ApiError.badRequest('start_date must be YYYY-MM-DD.')
    if (!b.template?.contact_id || !b.template.lines?.length) throw ApiError.badRequest('template needs a contact and lines.')
    const contact = await tx.booksContact.findFirst({ where: { id: b.template.contact_id, booksOrgId: ctx.booksOrgId, deletedAt: null } })
    if (!contact) throw new BooksError('unknown_contact', 'Contact not found.')
    const p = await tx.booksRecurringProfile.create({
      data: { booksOrgId: ctx.booksOrgId, kind: b.kind, name: b.name?.trim() || `${contact.displayName} ${b.frequency}`, contactId: contact.id, frequency: b.frequency, startDate: b.start_date, endDate: b.end_date ?? null, nextRunDate: b.start_date, templateJson: JSON.stringify({ ...b.template, auto_post: b.auto_post ?? false }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)), createdBy: ctx.userId },
    })
    await booksAudit(tx, ctx, { entityType: 'recurring_profile', entityId: p.id, action: 'recurring_profile.created', after: { name: p.name, frequency: p.frequency } })
    return p
  }),

  setStatus: (prisma: PrismaClient, ctx: BooksContext, id: string, status: 'active' | 'paused' | 'stopped') => withBooksTx(prisma, async (tx) => {
    const p = await tx.booksRecurringProfile.findFirst({ where: { id, booksOrgId: ctx.booksOrgId } })
    if (!p) throw ApiError.notFound('Profile not found.')
    const u = await tx.booksRecurringProfile.update({ where: { id }, data: { status } })
    await booksAudit(tx, ctx, { entityType: 'recurring_profile', entityId: id, action: 'recurring_profile.status', before: { status: p.status }, after: { status } })
    return u
  }),

  /** Create every document that has fallen due up to `today`. */
  runDue: async (prisma: PrismaClient, ctx: BooksContext, today: string) => {
    const due = await prisma.booksRecurringProfile.findMany({ where: { booksOrgId: ctx.booksOrgId, status: 'active', nextRunDate: { lte: today } } })
    const created: { profile_id: string; document_id: string; number: string; date: string; posted: boolean }[] = []
    for (const p of due) {
      let next = p.nextRunDate
      let guard = 0
      while (next <= today && guard++ < 60) {
        if (p.endDate && next > p.endDate) { await prisma.booksRecurringProfile.update({ where: { id: p.id }, data: { status: 'expired' } }); break }
        const template = JSON.parse(p.templateJson) as DocInput & { auto_post?: boolean }
        const doc = await Documents.create(prisma, ctx, p.kind as 'invoice' | 'bill', { ...template, date: next, reference_no: `${p.name} · ${next}` })
        await prisma.booksDocument.update({ where: { id: doc.id }, data: { recurringProfileId: p.id } })
        let posted = false
        if (template.auto_post) { await Documents.post(prisma, ctx, doc.id); posted = true }
        created.push({ profile_id: p.id, document_id: doc.id, number: doc.number, date: next, posted })
        next = advance(next, p.frequency as Frequency)
        await prisma.booksRecurringProfile.update({ where: { id: p.id }, data: { lastRunDate: doc.date, nextRunDate: next } })
      }
    }
    return created
  },
}
