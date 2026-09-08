import { Router } from 'express'
import { z } from 'zod'
import { ApiError, handler, ok } from '../../lib/http.js'
import { can, requireSession, type Session } from '../../platform/auth.js'
import { writeAudit } from '../../platform/audit.js'
import { TallyCompanyService } from './services/TallyCompanyService.js'
import { TallyFinancialYearService } from './services/TallyFinancialYearService.js'
import { TallyGroupService } from './services/TallyGroupService.js'
import { TallyLedgerService } from './services/TallyLedgerService.js'

/**
 * Tally HTTP surface (Slice 1: Foundation).
 *
 * Mounted at /api/tally/*. Sits inside the Audit Automation umbrella
 * per the user's placement, but as its own router (all subsequent
 * slices — vouchers, inventory, reports — will hang more routes off
 * this same base).
 *
 * Pipeline per request: authenticate → require tally.* permission →
 * Zod validate → service call → writeAudit for mutations.
 */
export const tallyRouter = Router()

function requireAccess(session: Session) {
  if (!can(session, 'tools.audit_automation.tally.access', 'self')) {
    throw ApiError.forbidden('You do not have access to Tally.')
  }
}
function requireCompanyManage(session: Session) {
  if (!can(session, 'tools.audit_automation.tally.company.manage', 'self')) {
    throw ApiError.forbidden('You do not have permission to manage Tally companies.')
  }
}
function requireMasterRead(session: Session) {
  if (!can(session, 'tools.audit_automation.tally.master.read', 'self')) {
    throw ApiError.forbidden('You do not have permission to view Tally masters.')
  }
}
function requireMasterManage(session: Session) {
  if (!can(session, 'tools.audit_automation.tally.master.manage', 'self')) {
    throw ApiError.forbidden('You do not have permission to manage Tally masters.')
  }
}

// ── Companies ────────────────────────────────────────────────────────────
tallyRouter.get('/companies', handler(async (req, res) => {
  const session = requireSession(req)
  requireAccess(session)
  ok(res, { items: await TallyCompanyService.listForOrg(session) })
}))

tallyRouter.get('/companies/:id', handler(async (req, res) => {
  const session = requireSession(req)
  requireAccess(session)
  ok(res, await TallyCompanyService.get(session, req.params.id))
}))

tallyRouter.post('/companies', handler(async (req, res) => {
  const session = requireSession(req)
  requireCompanyManage(session)
  const b = z.object({
    name: z.string().min(1),
    mailing_name: z.string().optional(),
    address: z.string().optional(),
    state: z.string().optional(),
    pin: z.string().optional(),
    phone: z.string().optional(),
    email: z.string().email().optional().or(z.literal('')),
    website: z.string().optional(),
    gst_registration_type: z.enum(['regular', 'composition', 'unregistered', 'sez', 'overseas']).optional(),
    gstin: z.string().optional(),
    pan: z.string().optional(),
    tan: z.string().optional(),
    fy_begin_month: z.number().int().min(1).max(12).optional(),
    books_begin_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }).safeParse(req.body)
  if (!b.success) throw ApiError.badRequest('name and books_begin_from are required.')
  const created = await TallyCompanyService.create(session, {
    name: b.data.name,
    mailingName: b.data.mailing_name,
    address: b.data.address,
    state: b.data.state,
    pin: b.data.pin,
    phone: b.data.phone,
    email: b.data.email || undefined,
    website: b.data.website,
    gstRegistrationType: b.data.gst_registration_type,
    gstin: b.data.gstin,
    pan: b.data.pan,
    tan: b.data.tan,
    fyBeginMonth: b.data.fy_begin_month,
    booksBeginFrom: b.data.books_begin_from,
  })
  await writeAudit({
    actorUserId: session.userId,
    action: 'tally.company_created',
    entityType: 'TallyCompany',
    entityId: created.id,
    after: { name: created.name, gstin: created.gstin, books_begin_from: created.books_begin_from },
    req,
  })
  ok(res, created, 201)
}))

tallyRouter.patch('/companies/:id', handler(async (req, res) => {
  const session = requireSession(req)
  requireCompanyManage(session)
  const b = z.object({
    name: z.string().min(1).optional(),
    mailing_name: z.string().nullable().optional(),
    address: z.string().nullable().optional(),
    state: z.string().nullable().optional(),
    pin: z.string().nullable().optional(),
    phone: z.string().nullable().optional(),
    email: z.string().nullable().optional(),
    website: z.string().nullable().optional(),
    gst_registration_type: z.enum(['regular', 'composition', 'unregistered', 'sez', 'overseas']).optional(),
    gstin: z.string().nullable().optional(),
    pan: z.string().nullable().optional(),
    tan: z.string().nullable().optional(),
    active: z.boolean().optional(),
  }).safeParse(req.body)
  if (!b.success) throw ApiError.badRequest('Invalid patch.')
  const updated = await TallyCompanyService.update(session, req.params.id, {
    name: b.data.name,
    mailingName: b.data.mailing_name ?? undefined,
    address: b.data.address ?? undefined,
    state: b.data.state ?? undefined,
    pin: b.data.pin ?? undefined,
    phone: b.data.phone ?? undefined,
    email: b.data.email ?? undefined,
    website: b.data.website ?? undefined,
    gstRegistrationType: b.data.gst_registration_type,
    gstin: b.data.gstin ?? undefined,
    pan: b.data.pan ?? undefined,
    tan: b.data.tan ?? undefined,
    active: b.data.active,
  })
  await writeAudit({
    actorUserId: session.userId,
    action: 'tally.company_updated',
    entityType: 'TallyCompany',
    entityId: updated.id,
    after: { name: updated.name },
    req,
  })
  ok(res, updated)
}))

// ── Financial years ─────────────────────────────────────────────────────
tallyRouter.get('/companies/:id/financial-years', handler(async (req, res) => {
  const session = requireSession(req)
  requireAccess(session)
  ok(res, { items: await TallyFinancialYearService.list(session, req.params.id) })
}))

tallyRouter.post('/companies/:id/financial-years', handler(async (req, res) => {
  const session = requireSession(req)
  requireCompanyManage(session)
  const b = z.object({
    label: z.string().min(1),
    start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }).safeParse(req.body)
  if (!b.success) throw ApiError.badRequest('label, start_date, end_date required.')
  const fy = await TallyFinancialYearService.create(session, req.params.id, {
    label: b.data.label, startDate: b.data.start_date, endDate: b.data.end_date,
  })
  await writeAudit({
    actorUserId: session.userId, action: 'tally.fy_created',
    entityType: 'TallyFinancialYear', entityId: fy.id,
    after: { company_id: req.params.id, label: fy.label }, req,
  })
  ok(res, fy, 201)
}))

tallyRouter.patch('/companies/:id/financial-years/:fyId/close', handler(async (req, res) => {
  const session = requireSession(req)
  requireCompanyManage(session)
  const closed = await TallyFinancialYearService.close(session, req.params.id, req.params.fyId)
  await writeAudit({
    actorUserId: session.userId, action: 'tally.fy_closed',
    entityType: 'TallyFinancialYear', entityId: closed.id,
    after: { company_id: req.params.id, label: closed.label }, req,
  })
  ok(res, closed)
}))

// ── Groups ──────────────────────────────────────────────────────────────
tallyRouter.get('/companies/:id/groups', handler(async (req, res) => {
  const session = requireSession(req)
  requireMasterRead(session)
  const tree = req.query.tree === '1'
  if (tree) ok(res, { tree: await TallyGroupService.tree(session, req.params.id) })
  else ok(res, { items: await TallyGroupService.list(session, req.params.id) })
}))

tallyRouter.post('/companies/:id/groups', handler(async (req, res) => {
  const session = requireSession(req)
  requireMasterManage(session)
  const b = z.object({
    name: z.string().min(1),
    parent_group_id: z.string().nullable().optional(),
    nature: z.enum(['assets', 'liabilities', 'income', 'expenses']).optional(),
    affects_pl: z.boolean().optional(),
  }).safeParse(req.body)
  if (!b.success) throw ApiError.badRequest('name is required.')
  const g = await TallyGroupService.create(session, req.params.id, {
    name: b.data.name,
    parentGroupId: b.data.parent_group_id ?? undefined,
    nature: b.data.nature,
    affectsPL: b.data.affects_pl,
  })
  await writeAudit({
    actorUserId: session.userId, action: 'tally.group_created',
    entityType: 'TallyGroup', entityId: g.id,
    after: { company_id: req.params.id, name: g.name, nature: g.nature }, req,
  })
  ok(res, g, 201)
}))

tallyRouter.patch('/companies/:id/groups/:groupId', handler(async (req, res) => {
  const session = requireSession(req)
  requireMasterManage(session)
  const b = z.object({
    name: z.string().min(1).optional(),
    parent_group_id: z.string().nullable().optional(),
    affects_pl: z.boolean().optional(),
  }).safeParse(req.body)
  if (!b.success) throw ApiError.badRequest('Invalid patch.')
  const g = await TallyGroupService.update(session, req.params.id, req.params.groupId, {
    name: b.data.name,
    parentGroupId: b.data.parent_group_id ?? undefined,
    affectsPL: b.data.affects_pl,
  })
  await writeAudit({
    actorUserId: session.userId, action: 'tally.group_updated',
    entityType: 'TallyGroup', entityId: g.id,
    after: { company_id: req.params.id, name: g.name }, req,
  })
  ok(res, g)
}))

tallyRouter.delete('/companies/:id/groups/:groupId', handler(async (req, res) => {
  const session = requireSession(req)
  requireMasterManage(session)
  await TallyGroupService.softDelete(session, req.params.id, req.params.groupId)
  await writeAudit({
    actorUserId: session.userId, action: 'tally.group_deleted',
    entityType: 'TallyGroup', entityId: req.params.groupId,
    after: { company_id: req.params.id }, req,
  })
  res.status(204).end()
}))

// ── Ledgers ─────────────────────────────────────────────────────────────
tallyRouter.get('/companies/:id/ledgers', handler(async (req, res) => {
  const session = requireSession(req)
  requireMasterRead(session)
  const q = z.object({
    group_id: z.string().optional(),
    q: z.string().optional(),
  }).safeParse(req.query)
  if (!q.success) throw ApiError.badRequest('Invalid filter.')
  ok(res, { items: await TallyLedgerService.list(session, req.params.id, {
    groupId: q.data.group_id, q: q.data.q,
  }) })
}))

tallyRouter.get('/companies/:id/ledgers/:ledgerId', handler(async (req, res) => {
  const session = requireSession(req)
  requireMasterRead(session)
  ok(res, await TallyLedgerService.get(session, req.params.id, req.params.ledgerId))
}))

tallyRouter.post('/companies/:id/ledgers', handler(async (req, res) => {
  const session = requireSession(req)
  requireMasterManage(session)
  const b = z.object({
    name: z.string().min(1),
    group_id: z.string().min(1),
    opening_balance_paise: z.number().int().nonnegative().optional(),
    opening_balance_type: z.enum(['dr', 'cr']).optional(),
    opening_balance_as_of_fy_id: z.string().nullable().optional(),
    address: z.string().optional(),
    contact: z.string().optional(),
    gstin: z.string().optional(),
    pan: z.string().optional(),
    state: z.string().optional(),
    gst_registration_type: z.string().optional(),
    credit_period_days: z.number().int().nonnegative().optional(),
    bank_account_name: z.string().optional(),
    bank_account_number: z.string().optional(),
    bank_ifsc: z.string().optional(),
    tax_config: z.unknown().optional(),
  }).safeParse(req.body)
  if (!b.success) throw ApiError.badRequest('name and group_id are required.')
  const l = await TallyLedgerService.create(session, req.params.id, {
    name: b.data.name,
    groupId: b.data.group_id,
    openingBalancePaise: b.data.opening_balance_paise,
    openingBalanceType: b.data.opening_balance_type,
    openingBalanceAsOfFyId: b.data.opening_balance_as_of_fy_id ?? undefined,
    address: b.data.address,
    contact: b.data.contact,
    gstin: b.data.gstin,
    pan: b.data.pan,
    state: b.data.state,
    gstRegistrationType: b.data.gst_registration_type,
    creditPeriodDays: b.data.credit_period_days,
    bankAccountName: b.data.bank_account_name,
    bankAccountNumber: b.data.bank_account_number,
    bankIfsc: b.data.bank_ifsc,
    taxConfig: b.data.tax_config,
  })
  await writeAudit({
    actorUserId: session.userId, action: 'tally.ledger_created',
    entityType: 'TallyLedger', entityId: l.id,
    after: { company_id: req.params.id, name: l.name, group_id: l.group_id, opening_balance_paise: l.opening_balance_paise, opening_balance_type: l.opening_balance_type }, req,
  })
  ok(res, l, 201)
}))

tallyRouter.patch('/companies/:id/ledgers/:ledgerId', handler(async (req, res) => {
  const session = requireSession(req)
  requireMasterManage(session)
  const b = z.object({
    name: z.string().min(1).optional(),
    group_id: z.string().min(1).optional(),
    opening_balance_paise: z.number().int().nonnegative().optional(),
    opening_balance_type: z.enum(['dr', 'cr']).optional(),
    opening_balance_as_of_fy_id: z.string().nullable().optional(),
    address: z.string().nullable().optional(),
    contact: z.string().nullable().optional(),
    gstin: z.string().nullable().optional(),
    pan: z.string().nullable().optional(),
    state: z.string().nullable().optional(),
    gst_registration_type: z.string().nullable().optional(),
    credit_period_days: z.number().int().nonnegative().nullable().optional(),
    bank_account_name: z.string().nullable().optional(),
    bank_account_number: z.string().nullable().optional(),
    bank_ifsc: z.string().nullable().optional(),
    tax_config: z.unknown().optional(),
    active: z.boolean().optional(),
  }).safeParse(req.body)
  if (!b.success) throw ApiError.badRequest('Invalid patch.')
  const l = await TallyLedgerService.update(session, req.params.id, req.params.ledgerId, {
    name: b.data.name,
    groupId: b.data.group_id,
    openingBalancePaise: b.data.opening_balance_paise,
    openingBalanceType: b.data.opening_balance_type,
    openingBalanceAsOfFyId: b.data.opening_balance_as_of_fy_id,
    address: b.data.address ?? undefined,
    contact: b.data.contact ?? undefined,
    gstin: b.data.gstin ?? undefined,
    pan: b.data.pan ?? undefined,
    state: b.data.state ?? undefined,
    gstRegistrationType: b.data.gst_registration_type ?? undefined,
    creditPeriodDays: b.data.credit_period_days ?? undefined,
    bankAccountName: b.data.bank_account_name ?? undefined,
    bankAccountNumber: b.data.bank_account_number ?? undefined,
    bankIfsc: b.data.bank_ifsc ?? undefined,
    taxConfig: b.data.tax_config,
    active: b.data.active,
  })
  await writeAudit({
    actorUserId: session.userId, action: 'tally.ledger_updated',
    entityType: 'TallyLedger', entityId: l.id,
    after: { company_id: req.params.id, name: l.name }, req,
  })
  ok(res, l)
}))

tallyRouter.delete('/companies/:id/ledgers/:ledgerId', handler(async (req, res) => {
  const session = requireSession(req)
  requireMasterManage(session)
  await TallyLedgerService.softDelete(session, req.params.id, req.params.ledgerId)
  await writeAudit({
    actorUserId: session.userId, action: 'tally.ledger_deleted',
    entityType: 'TallyLedger', entityId: req.params.ledgerId,
    after: { company_id: req.params.id }, req,
  })
  res.status(204).end()
}))
