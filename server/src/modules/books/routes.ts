import { Router, type Request } from 'express'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { ApiError, handler } from '../../lib/http.js'
import { can, requireSession } from '../../platform/auth.js'
import { writeAudit } from '../../platform/audit.js'
import { okB } from './serialize.js'
import { contextFor, listBooksForSession, requireArea, requireWrite, resolveBooksContext, type Area } from './scope.js'
import type { BooksContext } from './engine/context.js'
import { createBooksOrganisation } from './engine/organisation.js'
import { GST_STATES } from './engine/chart.js'
import { setPrefix } from './engine/numbering.js'
import { booksAudit } from './engine/audit.js'
import { withBooksTx } from './engine/posting.js'
import { Contacts, Items, TaxRates, Chart } from './services/masters.js'
import { Documents, type DocKind } from './services/documents.js'
import { Payments } from './services/payments.js'
import { Journals } from './services/journals.js'
import { Banking } from './services/banking.js'
import { FX } from './services/fx.js'
import { Recurring } from './services/recurring.js'
import { Reports } from './services/reports.js'

/**
 * BOOKS HTTP SURFACE — everything under /api/books.
 *
 * Every route inside a set of books starts with `ctx(req)`, which is the
 * only way to obtain a BooksContext: it resolves the caller's firm, the set
 * of books, and the caller's membership role, and refuses with 403/404
 * otherwise. Areas (settings / reports / accountant) narrow further.
 */
export const booksRouter = Router()

const KINDS: DocKind[] = ['estimate', 'sales_order', 'invoice', 'retainer_invoice', 'credit_note', 'purchase_order', 'bill', 'vendor_credit']
const kindOf = (s: string): DocKind => { if (!KINDS.includes(s as DocKind)) throw ApiError.notFound('No such document kind.'); return s as DocKind }
const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
const ctx = (req: Request) => resolveBooksContext(req, req.params.orgId)
const body = (req: Request) => (req.body ?? {}) as Record<string, unknown>
const area = (req: Request, c: BooksContext, a: Area) => requireArea(c, requireSession(req), a)

// ── Sets of books ─────────────────────────────────────────────────────────
booksRouter.get('/', handler(async (req, res) => {
  const session = requireSession(req)
  const rows = await listBooksForSession(session)
  const firmWide = can(session, 'books.access', 'organisation')
  okB(res, {
    items: rows.map((o) => ({ ...o, my_role: firmWide ? 'admin' : o.memberships.find((m) => m.userId === session.userId)?.role ?? null, member_count: o.memberships.length, memberships: undefined })),
    can_manage: can(session, 'books.manage', 'self'),
    states: GST_STATES,
  })
}))

booksRouter.post('/', handler(async (req, res) => {
  const session = requireSession(req)
  if (!can(session, 'books.manage', 'self')) throw ApiError.forbidden('You cannot create sets of books.')
  const b = z.object({
    name: z.string().trim().min(1), legal_name: z.string().nullable().optional(), gstin: z.string().nullable().optional(), pan: z.string().nullable().optional(),
    state_code: z.string().nullable().optional(), base_currency: z.string().length(3).optional(), fiscal_year_start_month: z.number().int().min(1).max(12).optional(),
    client_id: z.string().nullable().optional(), address_line1: z.string().nullable().optional(), city: z.string().nullable().optional(), pincode: z.string().nullable().optional(),
  }).safeParse(req.body ?? {})
  if (!b.success) throw ApiError.badRequest('name is required.', b.error.flatten().fieldErrors)
  const user = await prisma.user.findUniqueOrThrow({ where: { id: session.userId } })
  const org = await createBooksOrganisation(prisma, {
    organisationId: user.organisationId, userId: session.userId, name: b.data.name, legalName: b.data.legal_name ?? null, gstin: b.data.gstin?.toUpperCase() ?? null, pan: b.data.pan?.toUpperCase() ?? null,
    stateCode: b.data.state_code ?? (b.data.gstin ? b.data.gstin.slice(0, 2) : null), stateName: b.data.state_code ? GST_STATES[b.data.state_code] ?? null : b.data.gstin ? GST_STATES[b.data.gstin.slice(0, 2)] ?? null : null,
    baseCurrency: b.data.base_currency ?? 'INR', fiscalYearStartMonth: b.data.fiscal_year_start_month ?? 4, clientId: b.data.client_id ?? null, addressLine1: b.data.address_line1 ?? null, city: b.data.city ?? null, pincode: b.data.pincode ?? null,
  })
  await writeAudit({ actorUserId: session.userId, action: 'books.organisation.created', entityType: 'BooksOrganisation', entityId: org.id, after: { name: org.name }, req })
  okB(res, org, 201)
}))

/** Firm users, for the membership picker. */
booksRouter.get('/users', handler(async (req, res) => {
  const session = requireSession(req)
  if (!can(session, 'books.manage', 'self')) throw ApiError.forbidden()
  const me = await prisma.user.findUniqueOrThrow({ where: { id: session.userId } })
  const users = await prisma.user.findMany({ where: { organisationId: me.organisationId, isActive: true, deletedAt: null }, include: { employee: true, role: true }, orderBy: { email: 'asc' } })
  okB(res, { items: users.map((u) => ({ id: u.id, email: u.email, name: u.employee?.fullName ?? u.email, role: u.role.name })) })
}))

booksRouter.get('/:orgId', handler(async (req, res) => {
  const c = await ctx(req)
  const org = await prisma.booksOrganisation.findUniqueOrThrow({ where: { id: c.booksOrgId } })
  const [contacts, invoices, bills] = await Promise.all([
    prisma.booksContact.count({ where: { booksOrgId: c.booksOrgId, deletedAt: null } }),
    prisma.booksDocument.count({ where: { booksOrgId: c.booksOrgId, kind: 'invoice' } }),
    prisma.booksDocument.count({ where: { booksOrgId: c.booksOrgId, kind: 'bill' } }),
  ])
  okB(res, { ...org, my_role: c.role, areas: { settings: c.role === 'admin', reports: c.role === 'admin', accountant: c.role === 'admin' }, counts: { contacts, invoices, bills } })
}))

booksRouter.patch('/:orgId', handler(async (req, res) => {
  const c = await ctx(req); area(req, c, 'settings')
  const b = body(req)
  const before = await prisma.booksOrganisation.findUniqueOrThrow({ where: { id: c.booksOrgId } })
  const org = await withBooksTx(prisma, async (tx) => {
    const u = await tx.booksOrganisation.update({
      where: { id: c.booksOrgId },
      data: {
        ...(str(b.name) ? { name: str(b.name)!.trim() } : {}), ...('legal_name' in b ? { legalName: str(b.legal_name) ?? null } : {}), ...('gstin' in b ? { gstin: str(b.gstin)?.toUpperCase() ?? null } : {}),
        ...('pan' in b ? { pan: str(b.pan)?.toUpperCase() ?? null } : {}), ...('state_code' in b ? { stateCode: str(b.state_code) ?? null, stateName: str(b.state_code) ? GST_STATES[str(b.state_code)!] ?? null : null } : {}),
        ...('address_line1' in b ? { addressLine1: str(b.address_line1) ?? null } : {}), ...('city' in b ? { city: str(b.city) ?? null } : {}), ...('pincode' in b ? { pincode: str(b.pincode) ?? null } : {}),
        ...(typeof b.tds_enabled === 'boolean' ? { tdsEnabled: b.tds_enabled } : {}), ...(typeof b.fiscal_year_start_month === 'number' ? { fiscalYearStartMonth: b.fiscal_year_start_month } : {}),
        ...(typeof b.is_active === 'boolean' ? { isActive: b.is_active } : {}), updatedBy: c.userId,
      },
    })
    if (b.prefixes && typeof b.prefixes === 'object') for (const [kind, prefix] of Object.entries(b.prefixes as Record<string, string>)) if (typeof prefix === 'string' && prefix.length <= 12) await setPrefix(tx, c.booksOrgId, kind, prefix)
    await booksAudit(tx, c, { entityType: 'organisation', entityId: c.booksOrgId, action: 'organisation.updated', before: { name: before.name, gstin: before.gstin, state: before.stateCode }, after: { name: u.name, gstin: u.gstin, state: u.stateCode } })
    return u
  })
  okB(res, org)
}))

booksRouter.get('/:orgId/sequences', handler(async (req, res) => { const c = await ctx(req); area(req, c, 'settings'); okB(res, { items: await prisma.booksNumberSequence.findMany({ where: { booksOrgId: c.booksOrgId } }) }) }))

// ── Members ───────────────────────────────────────────────────────────────
booksRouter.get('/:orgId/members', handler(async (req, res) => {
  const c = await ctx(req); area(req, c, 'settings')
  const rows = await prisma.booksMembership.findMany({ where: { booksOrgId: c.booksOrgId } })
  const users = await prisma.user.findMany({ where: { id: { in: rows.map((r) => r.userId) } }, include: { employee: true } })
  okB(res, { items: rows.map((r) => { const u = users.find((x) => x.id === r.userId); return { ...r, name: u?.employee?.fullName ?? u?.email ?? r.userId, email: u?.email ?? null } }) })
}))
booksRouter.post('/:orgId/members', handler(async (req, res) => {
  const c = await ctx(req); area(req, c, 'settings')
  const b = z.object({ user_id: z.string().min(1), role: z.enum(['admin', 'staff', 'viewer']) }).safeParse(req.body ?? {})
  if (!b.success) throw ApiError.badRequest('user_id and role are required.')
  const user = await prisma.user.findFirst({ where: { id: b.data.user_id, organisationId: c.organisationId, deletedAt: null } })
  if (!user) throw ApiError.notFound('User not found in this firm.')
  const m = await withBooksTx(prisma, async (tx) => {
    const row = await tx.booksMembership.upsert({ where: { booksOrgId_userId: { booksOrgId: c.booksOrgId, userId: user.id } }, update: { role: b.data.role }, create: { booksOrgId: c.booksOrgId, userId: user.id, role: b.data.role, createdBy: c.userId } })
    await booksAudit(tx, c, { entityType: 'membership', entityId: row.id, action: 'membership.set', after: { user_id: user.id, role: b.data.role } })
    return row
  })
  okB(res, m, 201)
}))
booksRouter.delete('/:orgId/members/:userId', handler(async (req, res) => {
  const c = await ctx(req); area(req, c, 'settings')
  await withBooksTx(prisma, async (tx) => {
    await tx.booksMembership.deleteMany({ where: { booksOrgId: c.booksOrgId, userId: req.params.userId } })
    await booksAudit(tx, c, { entityType: 'membership', entityId: req.params.userId, action: 'membership.removed' })
  })
  res.status(204).end()
}))

// ── Dashboard ─────────────────────────────────────────────────────────────
booksRouter.get('/:orgId/dashboard', handler(async (req, res) => {
  const c = await ctx(req)
  const today = new Date().toISOString().slice(0, 10)
  const monthStart = `${today.slice(0, 7)}-01`
  const [openInv, openBills, cash, pl, recent] = await Promise.all([
    prisma.booksBill.aggregate({ where: { booksOrgId: c.booksOrgId, side: 'debit', status: 'open', billType: 'new_ref' }, _sum: { balance: true }, _count: true }),
    prisma.booksBill.aggregate({ where: { booksOrgId: c.booksOrgId, side: 'credit', status: 'open', billType: 'new_ref' }, _sum: { balance: true }, _count: true }),
    Banking.accounts(prisma, c),
    Reports.profitAndLoss(prisma, c, monthStart, today),
    prisma.booksJournal.findMany({ where: { booksOrgId: c.booksOrgId, status: { in: ['posted', 'void'] } }, orderBy: { createdAt: 'desc' }, take: 8 }),
  ])
  const overdue = await prisma.booksBill.aggregate({ where: { booksOrgId: c.booksOrgId, side: 'debit', status: 'open', billType: 'new_ref', dueDate: { lt: today } }, _sum: { balance: true } })
  okB(res, {
    receivables: { total: openInv._sum.balance ?? 0n, count: openInv._count, overdue: overdue._sum.balance ?? 0n },
    payables: { total: openBills._sum.balance ?? 0n, count: openBills._count },
    cash: cash.map((a) => ({ id: a.id, name: a.name, balance: a.balance })),
    month: { from: monthStart, to: today, income: pl.total_income, expense: pl.total_expense, net: pl.net_profit },
    recent,
  })
}))

// ── Masters ───────────────────────────────────────────────────────────────
booksRouter.get('/:orgId/contacts', handler(async (req, res) => { const c = await ctx(req); okB(res, { items: await Contacts.list(prisma, c, { type: str(req.query.type), q: str(req.query.q) }) }) }))
booksRouter.post('/:orgId/contacts', handler(async (req, res) => { const c = await ctx(req); requireWrite(c); okB(res, await Contacts.create(prisma, c, body(req) as never), 201) }))
booksRouter.get('/:orgId/contacts/:id', handler(async (req, res) => {
  const c = await ctx(req)
  const contact = await Contacts.get(prisma, c, req.params.id)
  const [docs, open] = await Promise.all([
    prisma.booksDocument.findMany({ where: { booksOrgId: c.booksOrgId, contactId: contact.id }, orderBy: { date: 'desc' }, take: 50 }),
    prisma.booksBill.findMany({ where: { booksOrgId: c.booksOrgId, contactId: contact.id, status: 'open' } }),
  ])
  okB(res, { contact, documents: docs, open_items: open, receivable: open.filter((b) => b.side === 'debit').reduce((t, b) => t + b.balance, 0n), payable: open.filter((b) => b.side === 'credit').reduce((t, b) => t + b.balance, 0n) })
}))
booksRouter.patch('/:orgId/contacts/:id', handler(async (req, res) => { const c = await ctx(req); requireWrite(c); okB(res, await Contacts.update(prisma, c, req.params.id, body(req) as never)) }))
booksRouter.post('/:orgId/contacts/:id/status', handler(async (req, res) => { const c = await ctx(req); requireWrite(c); okB(res, await Contacts.deactivate(prisma, c, req.params.id, body(req).is_active !== false)) }))

booksRouter.get('/:orgId/items', handler(async (req, res) => { const c = await ctx(req); okB(res, { items: await Items.list(prisma, c, { q: str(req.query.q) }) }) }))
booksRouter.post('/:orgId/items', handler(async (req, res) => { const c = await ctx(req); requireWrite(c); okB(res, await Items.create(prisma, c, body(req) as never), 201) }))
booksRouter.patch('/:orgId/items/:id', handler(async (req, res) => { const c = await ctx(req); requireWrite(c); okB(res, await Items.update(prisma, c, req.params.id, body(req) as never)) }))

booksRouter.get('/:orgId/tax-rates', handler(async (req, res) => { const c = await ctx(req); okB(res, { items: await TaxRates.list(prisma, c, str(req.query.type)) }) }))
booksRouter.post('/:orgId/tax-rates', handler(async (req, res) => { const c = await ctx(req); area(req, c, 'settings'); okB(res, await TaxRates.create(prisma, c, body(req) as never), 201) }))
booksRouter.patch('/:orgId/tax-rates/:id', handler(async (req, res) => { const c = await ctx(req); area(req, c, 'settings'); okB(res, await TaxRates.update(prisma, c, req.params.id, body(req) as never)) }))

booksRouter.get('/:orgId/chart/groups', handler(async (req, res) => { const c = await ctx(req); okB(res, { items: await Chart.groups(prisma, c) }) }))
booksRouter.post('/:orgId/chart/groups', handler(async (req, res) => { const c = await ctx(req); area(req, c, 'settings'); okB(res, await Chart.createGroup(prisma, c, body(req) as never), 201) }))
booksRouter.get('/:orgId/chart/ledgers', handler(async (req, res) => { const c = await ctx(req); okB(res, { items: await Chart.ledgers(prisma, c, { root: str(req.query.root), q: str(req.query.q), bank: req.query.bank === '1' }) }) }))
booksRouter.post('/:orgId/chart/ledgers', handler(async (req, res) => { const c = await ctx(req); area(req, c, 'settings'); okB(res, await Chart.createLedger(prisma, c, body(req) as never), 201) }))
booksRouter.get('/:orgId/chart/ledgers/:id', handler(async (req, res) => { const c = await ctx(req); okB(res, await Chart.getLedger(prisma, c, req.params.id)) }))
booksRouter.patch('/:orgId/chart/ledgers/:id', handler(async (req, res) => { const c = await ctx(req); area(req, c, 'settings'); okB(res, await Chart.updateLedger(prisma, c, req.params.id, body(req) as never)) }))
booksRouter.delete('/:orgId/chart/ledgers/:id', handler(async (req, res) => { const c = await ctx(req); area(req, c, 'settings'); await Chart.deleteLedger(prisma, c, req.params.id); res.status(204).end() }))

// ── Documents ─────────────────────────────────────────────────────────────
booksRouter.get('/:orgId/documents/:kind', handler(async (req, res) => {
  const c = await ctx(req)
  okB(res, { items: await Documents.list(prisma, c, kindOf(req.params.kind), { status: str(req.query.status), contact_id: str(req.query.contact_id), from: str(req.query.from), to: str(req.query.to), q: str(req.query.q) }) })
}))
booksRouter.post('/:orgId/documents/:kind', handler(async (req, res) => { const c = await ctx(req); requireWrite(c); okB(res, await Documents.create(prisma, c, kindOf(req.params.kind), body(req) as never), 201) }))
booksRouter.get('/:orgId/documents/:kind/:id', handler(async (req, res) => {
  const c = await ctx(req)
  const d = await Documents.get(prisma, c, req.params.id)
  if (d.kind !== req.params.kind) throw ApiError.notFound('Document not found.')
  const [contact, journal, bill, applications, audit] = await Promise.all([
    prisma.booksContact.findUnique({ where: { id: d.contactId } }),
    d.journalId ? prisma.booksJournal.findUnique({ where: { id: d.journalId }, include: { lines: { include: { ledger: { select: { name: true } } }, orderBy: { lineNo: 'asc' } } } }) : null,
    prisma.booksBill.findFirst({ where: { booksOrgId: c.booksOrgId, sourceType: d.kind, sourceId: d.id } }),
    prisma.booksBillAllocation.findMany({ where: { booksOrgId: c.booksOrgId, bill: { sourceType: d.kind, sourceId: d.id }, type: { in: ['against_ref', 'revalue'] } }, include: { journal: { select: { id: true, number: true, date: true, voucherType: true, status: true, narration: true } } } }),
    Journals.audit(prisma, c, d.kind, d.id),
  ])
  okB(res, { document: d, contact, journal, open_item: bill, applications, audit })
}))
booksRouter.patch('/:orgId/documents/:kind/:id', handler(async (req, res) => { const c = await ctx(req); requireWrite(c); okB(res, await Documents.update(prisma, c, req.params.id, body(req) as never)) }))
booksRouter.post('/:orgId/documents/:kind/:id/post', handler(async (req, res) => { const c = await ctx(req); requireWrite(c); okB(res, await Documents.post(prisma, c, req.params.id)) }))
booksRouter.post('/:orgId/documents/:kind/:id/void', handler(async (req, res) => { const c = await ctx(req); requireWrite(c); okB(res, await Documents.void(prisma, c, req.params.id, str(body(req).reason) ?? null)) }))
booksRouter.post('/:orgId/documents/:kind/:id/status', handler(async (req, res) => { const c = await ctx(req); requireWrite(c); okB(res, await Documents.setStatus(prisma, c, req.params.id, String(body(req).status ?? ''))) }))
booksRouter.post('/:orgId/documents/:kind/:id/convert', handler(async (req, res) => { const c = await ctx(req); requireWrite(c); okB(res, await Documents.convert(prisma, c, req.params.id, kindOf(String(body(req).to ?? ''))), 201) }))
booksRouter.post('/:orgId/documents/:kind/:id/apply-credit', handler(async (req, res) => { const c = await ctx(req); requireWrite(c); okB(res, await Documents.applyCredit(prisma, c, req.params.id, (body(req).applications as never) ?? [], str(body(req).date))) }))
booksRouter.post('/:orgId/documents/:kind/:id/apply-retainer', handler(async (req, res) => { const c = await ctx(req); requireWrite(c); okB(res, await Documents.applyRetainer(prisma, c, req.params.id, (body(req).applications as never) ?? [], str(body(req).date))) }))

/** Open items for the allocation pickers. */
booksRouter.get('/:orgId/open-items', handler(async (req, res) => {
  const c = await ctx(req)
  const side = req.query.side === 'credit' ? 'credit' : 'debit'
  const bills = await prisma.booksBill.findMany({ where: { booksOrgId: c.booksOrgId, status: 'open', side, ...(str(req.query.contact_id) ? { contactId: str(req.query.contact_id) } : {}) }, orderBy: { date: 'asc' } })
  const docs = await prisma.booksDocument.findMany({ where: { booksOrgId: c.booksOrgId, id: { in: bills.map((b) => b.sourceId) } }, select: { id: true, kind: true, number: true, date: true, dueDate: true, total: true, balanceDue: true, currency: true, contactId: true } })
  okB(res, { items: bills.map((b) => ({ ...b, document: docs.find((d) => d.id === b.sourceId) ?? null })) })
}))

// ── Payments ──────────────────────────────────────────────────────────────
const pkind = (s: string) => { if (s !== 'received' && s !== 'made') throw ApiError.notFound('No such payment kind.'); return s }
booksRouter.get('/:orgId/payments/:kind', handler(async (req, res) => { const c = await ctx(req); okB(res, { items: await Payments.list(prisma, c, pkind(req.params.kind), { contact_id: str(req.query.contact_id), from: str(req.query.from), to: str(req.query.to) }) }) }))
booksRouter.post('/:orgId/payments/:kind', handler(async (req, res) => { const c = await ctx(req); requireWrite(c); okB(res, await Payments.create(prisma, c, pkind(req.params.kind), body(req) as never), 201) }))
booksRouter.get('/:orgId/payments/:kind/:id', handler(async (req, res) => { const c = await ctx(req); const p = await Payments.get(prisma, c, req.params.id); okB(res, { ...p, audit: await Journals.audit(prisma, c, `payment_${p.payment.kind}`, p.payment.id) }) }))
booksRouter.post('/:orgId/payments/:kind/:id/void', handler(async (req, res) => { const c = await ctx(req); requireWrite(c); okB(res, await Payments.void(prisma, c, req.params.id, str(body(req).reason) ?? null)) }))

// ── Journals (accountant) ─────────────────────────────────────────────────
booksRouter.get('/:orgId/journals', handler(async (req, res) => { const c = await ctx(req); okB(res, { items: await Journals.list(prisma, c, { status: str(req.query.status), voucher_type: str(req.query.voucher_type), from: str(req.query.from), to: str(req.query.to), q: str(req.query.q), limit: Number(req.query.limit) || undefined }) }) }))
booksRouter.post('/:orgId/journals', handler(async (req, res) => { const c = await ctx(req); area(req, c, 'accountant'); const b = body(req); okB(res, b.draft ? await Journals.saveDraft(prisma, c, b as never) : await Journals.create(prisma, c, b as never), 201) }))
booksRouter.get('/:orgId/journals/:id', handler(async (req, res) => { const c = await ctx(req); const j = await Journals.get(prisma, c, req.params.id); okB(res, { ...j, audit: await Journals.audit(prisma, c, 'journal', j.id) }) }))
booksRouter.patch('/:orgId/journals/:id', handler(async (req, res) => { const c = await ctx(req); area(req, c, 'accountant'); okB(res, await Journals.saveDraft(prisma, c, body(req) as never, req.params.id)) }))
booksRouter.post('/:orgId/journals/:id/post', handler(async (req, res) => { const c = await ctx(req); area(req, c, 'accountant'); okB(res, await Journals.postDraft(prisma, c, req.params.id)) }))
booksRouter.post('/:orgId/journals/:id/void', handler(async (req, res) => { const c = await ctx(req); area(req, c, 'accountant'); okB(res, await Journals.void(prisma, c, req.params.id, str(body(req).reason) ?? null)) }))
booksRouter.delete('/:orgId/journals/:id', handler(async (req, res) => { const c = await ctx(req); area(req, c, 'accountant'); await Journals.deleteDraft(prisma, c, req.params.id); res.status(204).end() }))
booksRouter.get('/:orgId/audit', handler(async (req, res) => { const c = await ctx(req); okB(res, { items: await prisma.booksAuditEvent.findMany({ where: { booksOrgId: c.booksOrgId, ...(str(req.query.entity_type) ? { entityType: str(req.query.entity_type) } : {}), ...(str(req.query.entity_id) ? { entityId: str(req.query.entity_id) } : {}) }, orderBy: { createdAt: 'desc' }, take: 200 }) }) }))

// ── Banking ───────────────────────────────────────────────────────────────
booksRouter.get('/:orgId/banking/accounts', handler(async (req, res) => { const c = await ctx(req); okB(res, { items: await Banking.accounts(prisma, c) }) }))
booksRouter.get('/:orgId/banking/transfers', handler(async (req, res) => { const c = await ctx(req); okB(res, { items: await Banking.transfers(prisma, c) }) }))
booksRouter.post('/:orgId/banking/transfers', handler(async (req, res) => { const c = await ctx(req); requireWrite(c); okB(res, await Banking.transfer(prisma, c, body(req) as never), 201) }))
booksRouter.post('/:orgId/banking/transfers/:id/void', handler(async (req, res) => { const c = await ctx(req); requireWrite(c); okB(res, await Banking.voidTransfer(prisma, c, req.params.id, str(body(req).reason) ?? null)) }))
booksRouter.get('/:orgId/banking/:ledgerId/reconciliation', handler(async (req, res) => { const c = await ctx(req); area(req, c, 'accountant'); okB(res, await Banking.reconciliation(prisma, c, req.params.ledgerId, { from: str(req.query.from), to: str(req.query.to) })) }))
booksRouter.post('/:orgId/banking/:ledgerId/statement-lines', handler(async (req, res) => { const c = await ctx(req); area(req, c, 'accountant'); okB(res, { items: await Banking.addStatementLines(prisma, c, req.params.ledgerId, (body(req).lines as never) ?? []) }, 201) }))
booksRouter.delete('/:orgId/banking/statement-lines/:id', handler(async (req, res) => { const c = await ctx(req); area(req, c, 'accountant'); await Banking.deleteStatementLine(prisma, c, req.params.id); res.status(204).end() }))
booksRouter.post('/:orgId/banking/match', handler(async (req, res) => { const c = await ctx(req); area(req, c, 'accountant'); await Banking.match(prisma, c, String(body(req).statement_line_id ?? ''), String(body(req).journal_line_id ?? '')); res.status(204).end() }))
booksRouter.post('/:orgId/banking/unmatch', handler(async (req, res) => { const c = await ctx(req); area(req, c, 'accountant'); await Banking.unmatch(prisma, c, String(body(req).statement_line_id ?? '')); res.status(204).end() }))

// ── FX ────────────────────────────────────────────────────────────────────
booksRouter.get('/:orgId/fx/rates', handler(async (req, res) => { const c = await ctx(req); okB(res, { items: await FX.rates(prisma, c, str(req.query.currency)) }) }))
booksRouter.post('/:orgId/fx/rates', handler(async (req, res) => { const c = await ctx(req); area(req, c, 'accountant'); okB(res, await FX.setRate(prisma, c, body(req) as never), 201) }))
booksRouter.get('/:orgId/fx/exposure', handler(async (req, res) => { const c = await ctx(req); area(req, c, 'accountant'); okB(res, { items: await FX.exposure(prisma, c, String(req.query.currency ?? ''), req.query.rate ? Number(req.query.rate) : undefined) }) }))
booksRouter.post('/:orgId/fx/revalue', handler(async (req, res) => { const c = await ctx(req); area(req, c, 'accountant'); okB(res, await FX.revalue(prisma, c, body(req) as never), 201) }))
booksRouter.get('/:orgId/fx/revaluations', handler(async (req, res) => { const c = await ctx(req); area(req, c, 'accountant'); okB(res, { items: await FX.revaluations(prisma, c) }) }))
booksRouter.post('/:orgId/fx/revaluations/:id/void', handler(async (req, res) => { const c = await ctx(req); area(req, c, 'accountant'); await FX.voidRevaluation(prisma, c, req.params.id); res.status(204).end() }))

// ── Recurring ─────────────────────────────────────────────────────────────
booksRouter.get('/:orgId/recurring', handler(async (req, res) => { const c = await ctx(req); okB(res, { items: await Recurring.list(prisma, c, str(req.query.kind)) }) }))
booksRouter.post('/:orgId/recurring', handler(async (req, res) => { const c = await ctx(req); requireWrite(c); okB(res, await Recurring.create(prisma, c, body(req) as never), 201) }))
booksRouter.post('/:orgId/recurring/:id/status', handler(async (req, res) => { const c = await ctx(req); requireWrite(c); okB(res, await Recurring.setStatus(prisma, c, req.params.id, String(body(req).status) as never)) }))
booksRouter.post('/:orgId/recurring/run', handler(async (req, res) => { const c = await ctx(req); requireWrite(c); okB(res, { created: await Recurring.runDue(prisma, c, str(body(req).today) ?? new Date().toISOString().slice(0, 10)) }) }))

// ── Reports ───────────────────────────────────────────────────────────────
booksRouter.get('/:orgId/reports/:name', handler(async (req, res) => {
  const c = await ctx(req); area(req, c, 'reports')
  const today = new Date().toISOString().slice(0, 10)
  const org = await prisma.booksOrganisation.findUniqueOrThrow({ where: { id: c.booksOrgId } })
  const fy = (() => { const [y, m] = today.split('-').map(Number); return `${m >= org.fiscalYearStartMonth ? y : y - 1}-${String(org.fiscalYearStartMonth).padStart(2, '0')}-01` })()
  const from = str(req.query.from) ?? fy
  const to = str(req.query.to) ?? today
  const asOf = str(req.query.as_of) ?? to
  switch (req.params.name) {
    case 'trial-balance': return okB(res, await Reports.trialBalance(prisma, c, asOf))
    case 'profit-and-loss': return okB(res, await Reports.profitAndLoss(prisma, c, from, to))
    case 'balance-sheet': return okB(res, await Reports.balanceSheet(prisma, c, asOf))
    case 'cash-flow': return okB(res, await Reports.cashFlow(prisma, c, from, to))
    case 'general-ledger': return okB(res, await Reports.generalLedger(prisma, c, String(req.query.ledger_id ?? ''), from, to))
    case 'ar-ageing': return okB(res, await Reports.ageing(prisma, c, 'receivable', asOf))
    case 'ap-ageing': return okB(res, await Reports.ageing(prisma, c, 'payable', asOf))
    case 'gstr-1': return okB(res, await Reports.gstr1(prisma, c, from, to))
    case 'gstr-3b': return okB(res, await Reports.gstr3b(prisma, c, from, to))
    case 'tds': return okB(res, { items: await Reports.tdsSummary(prisma, c, from, to) })
    default: throw ApiError.notFound('No such report.')
  }
}))

export { contextFor }
