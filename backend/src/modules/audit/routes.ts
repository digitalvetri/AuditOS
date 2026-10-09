import { Router } from 'express'
import { z } from 'zod'
import type { AuditEngagement, Prisma } from '@prisma/client'
import { prisma, alive } from '../../lib/prisma.js'
import { ApiError, handler, ok } from '../../lib/http.js'
import { addDays, istToday } from '../../lib/dates.js'
import { assertCanSeeClient, clientScopeWhere } from '../../platform/workstation/scope.js'
import { nextAuditCode } from '../../platform/workstation/codes.js'
import { lockSequence } from '../../lib/sequence.js'
import { AUDIT_TYPES, AUDIT_TYPE_LABEL, defaultPapers, type AuditType } from './data.js'
import {
  PRE_SIGN, assertEmployee, blockersOf, clientsById, computeMateriality, employeeNames, guardWrite,
  isManager, isSigningPartner, me, pctString, progressFor,
} from './service.js'
import * as S from './serialize.js'
import { FY, ISO_DATE, access, audit, fileAccess, isUniqueViolation, parse } from './common.js'
import { registerPapers } from './papers.js'
import { registerRecords } from './records.js'
import { registerUdins, udinDocType, validateUdin } from './udin.js'
import { registerExport } from './export.js'

/**
 * AUDIT FILES — /api/audits (docs/audit-files/README.md).
 *
 * Fixed paths (/checklist-templates, /udins…) are registered before /:id so
 * the id route never swallows them.
 */
export const auditFilesRouter = Router()

registerUdins(auditFilesRouter)
registerRecords.templates(auditFilesRouter)

const TEAM_ROLES = ['partner', 'manager', 'senior', 'assistant', 'article', 'eqcr'] as const
const OPINIONS = ['unmodified', 'qualified', 'adverse', 'disclaimer'] as const

const createSchema = z.object({
  client_id: z.string().min(1, 'Choose the client.'),
  financial_year: FY,
  audit_type: z.enum(AUDIT_TYPES),
  title: z.string().trim().max(200).nullish(),
  engagement_letter_id: z.string().nullish(),
  signing_partner_id: z.string().nullish(),
  partner_membership_no: z.string().trim().regex(/^\d{1,6}$/, 'A membership number is up to 6 digits.').nullish(),
  manager_id: z.string().nullish(),
  planned_start_date: ISO_DATE.nullish(),
  planned_report_date: ISO_DATE.nullish(),
})

/** One file per client × financial year × audit type. */
async function assertNoDuplicate(tx: Prisma.TransactionClient, clientId: string, fy: string, type: string, exceptId?: string) {
  await lockSequence(tx, `audit-file:${clientId}:${fy}:${type}`)
  const dup = await tx.auditEngagement.findFirst({
    where: { clientId, financialYear: fy, auditType: type, ...alive, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { auditCode: true },
  })
  if (dup) throw ApiError.conflict('audit_exists', `There is already a ${AUDIT_TYPE_LABEL[type as AuditType].toLowerCase()} file for this client and year (${dup.auditCode}).`)
}

/** Make sure an employee is on the team (restoring a removed row). */
async function ensureTeam(tx: Prisma.TransactionClient, engagementId: string, employeeId: string, role: string) {
  const row = await tx.auditTeamMember.findUnique({ where: { engagementId_employeeId: { engagementId, employeeId } } })
  if (!row) await tx.auditTeamMember.create({ data: { engagementId, employeeId, role } })
  else if (row.deletedAt) await tx.auditTeamMember.update({ where: { id: row.id }, data: { deletedAt: null, role } })
}

async function detail(e: AuditEngagement) {
  const [team, clients, prog] = await Promise.all([
    prisma.auditTeamMember.findMany({ where: { engagementId: e.id, ...alive }, orderBy: { createdAt: 'asc' } }),
    clientsById([e.clientId]),
    progressFor([e]),
  ])
  const names = await employeeNames([e.signingPartnerId, e.managerId, e.acceptanceApprovedBy, e.lockedBy, ...team.map((t) => t.employeeId)])
  const d = prog.get(e.id)!
  return S.engagementDetail(e, { client: clients.get(e.clientId) ?? null, names, progress: d.progress, team, blockers: blockersOf(e, d) })
}

// ── List / create ───────────────────────────────────────────────────────────

auditFilesRouter.get('/', handler(async (req, res) => {
  const { session, scope } = access(req, 'read')
  const q = parse(z.object({
    client_id: z.string().optional(),
    financial_year: z.string().optional(),
    audit_type: z.string().optional(),
    status: z.string().optional(),
    mine: z.string().optional(),
    q: z.string().optional(),
    limit: z.coerce.number().optional(),
    offset: z.coerce.number().optional(),
  }), req.query, 'Invalid filters.')
  const and: Prisma.AuditEngagementWhereInput[] = [await clientScopeWhere(session, scope)]
  if (q.mine === '1' || q.mine === 'true') {
    const id = session.employeeId ?? '__none__'
    and.push({ OR: [{ signingPartnerId: id }, { managerId: id }, { team: { some: { employeeId: id, deletedAt: null } } }] })
  }
  if (q.q?.trim()) {
    const term = q.q.trim()
    const clientIds = (await prisma.client.findMany({ where: { companyName: { contains: term, mode: 'insensitive' } }, select: { id: true }, take: 500 })).map((c) => c.id)
    and.push({ OR: [
      { auditCode: { contains: term, mode: 'insensitive' } },
      { title: { contains: term, mode: 'insensitive' } },
      { clientId: { in: clientIds } },
    ] })
  }
  const where: Prisma.AuditEngagementWhereInput = {
    ...alive,
    ...(q.client_id ? { clientId: q.client_id } : {}),
    ...(q.financial_year ? { financialYear: q.financial_year } : {}),
    ...(q.audit_type && q.audit_type !== 'all' ? { auditType: q.audit_type } : {}),
    ...(q.status && q.status !== 'all' ? { status: q.status } : {}),
    AND: and,
  }
  const take = Math.min(Math.max(q.limit ?? 100, 1), 500)
  const [rows, total] = await Promise.all([
    prisma.auditEngagement.findMany({ where, orderBy: { createdAt: 'desc' }, take, skip: q.offset ?? 0 }),
    prisma.auditEngagement.count({ where }),
  ])
  const [clients, prog, names] = await Promise.all([
    clientsById(rows.map((r) => r.clientId)),
    progressFor(rows),
    employeeNames(rows.flatMap((r) => [r.signingPartnerId, r.managerId, r.lockedBy, r.acceptanceApprovedBy])),
  ])
  ok(res, {
    items: rows.map((r) => S.engagement(r, { client: clients.get(r.clientId) ?? null, names, progress: prog.get(r.id)!.progress })),
    total,
    count: total,
  })
}))

auditFilesRouter.post('/', handler(async (req, res) => {
  const { session, scope } = access(req, 'manage')
  const b = parse(createSchema, req.body, 'Invalid audit file.')
  await assertCanSeeClient(session, scope, b.client_id)
  const client = await prisma.client.findFirst({ where: { id: b.client_id, ...alive }, select: { id: true, organisationId: true } })
  if (!client) throw ApiError.notFound('Client not found.')
  await assertEmployee(b.signing_partner_id, 'signing_partner_id')
  await assertEmployee(b.manager_id, 'manager_id')
  if (b.engagement_letter_id) {
    const l = await prisma.engagementLetter.findFirst({ where: { id: b.engagement_letter_id, deletedAt: null }, select: { clientId: true } })
    if (!l || l.clientId !== b.client_id) throw ApiError.badRequest('That engagement letter is not for this client.', { engagement_letter_id: 'Not for this client.' })
  }
  const year = Number(istToday().slice(0, 4))
  const created = await prisma.$transaction(async (tx) => {
    await assertNoDuplicate(tx, b.client_id, b.financial_year, b.audit_type)
    const auditCode = await nextAuditCode(tx, year)
    const e = await tx.auditEngagement.create({
      data: {
        organisationId: client.organisationId,
        auditCode,
        clientId: b.client_id,
        financialYear: b.financial_year,
        auditType: b.audit_type,
        title: b.title?.trim() || `${AUDIT_TYPE_LABEL[b.audit_type]} ${b.financial_year}`,
        engagementLetterId: b.engagement_letter_id ?? null,
        signingPartnerId: b.signing_partner_id ?? null,
        partnerMembershipNo: b.partner_membership_no ?? null,
        managerId: b.manager_id ?? null,
        plannedStartDate: b.planned_start_date ?? null,
        plannedReportDate: b.planned_report_date ?? null,
        createdBy: session.userId,
        updatedBy: session.userId,
      },
    })
    await tx.auditWorkingPaper.createMany({
      data: defaultPapers(b.audit_type).map((p) => ({
        engagementId: e.id, ref: p.ref, section: p.section, title: p.title, area: p.area ?? null, createdBy: session.userId,
      })),
    })
    if (e.signingPartnerId) await ensureTeam(tx, e.id, e.signingPartnerId, 'partner')
    if (e.managerId && e.managerId !== e.signingPartnerId) await ensureTeam(tx, e.id, e.managerId, 'manager')
    return e
  }, { timeout: 20_000 })
  await audit(req, session, 'create', 'AuditEngagement', created.id, undefined, { audit_code: created.auditCode, client_id: created.clientId, financial_year: created.financialYear, audit_type: created.auditType })
  ok(res, await detail(created), 201)
}))

// ── One file ────────────────────────────────────────────────────────────────

auditFilesRouter.get('/:id', handler(async (req, res) => {
  const { e } = await fileAccess(req, 'read')
  ok(res, await detail(e))
}))

const patchSchema = createSchema.partial().extend({ status: z.enum(PRE_SIGN).optional() })

auditFilesRouter.patch('/:id', handler(async (req, res) => {
  const { session, scope, e } = await fileAccess(req, 'manage')
  guardWrite(e, session, req.body)
  const b = parse(patchSchema, req.body, 'Invalid audit file.')
  const signed = e.status === 'signed' || e.status === 'archived'
  if (b.status && b.status !== e.status) {
    if (signed) throw ApiError.unprocessable('invalid_status', 'A signed file keeps its status.')
    const from = PRE_SIGN.indexOf(e.status as (typeof PRE_SIGN)[number])
    const to = PRE_SIGN.indexOf(b.status)
    if (Math.abs(to - from) !== 1) throw ApiError.unprocessable('invalid_status', 'Status moves one step forward or back at a time.')
  }
  if (signed && (b.signing_partner_id !== undefined || b.client_id !== undefined || b.audit_type !== undefined || b.financial_year !== undefined)) {
    if ((b.signing_partner_id !== undefined && b.signing_partner_id !== e.signingPartnerId)
      || (b.client_id !== undefined && b.client_id !== e.clientId)
      || (b.audit_type !== undefined && b.audit_type !== e.auditType)
      || (b.financial_year !== undefined && b.financial_year !== e.financialYear)) {
      throw ApiError.unprocessable('file_signed', 'The client, year, type and signing partner of a signed file cannot change.')
    }
  }
  if (b.client_id && b.client_id !== e.clientId) await assertCanSeeClient(session, scope, b.client_id)
  if (b.signing_partner_id) await assertEmployee(b.signing_partner_id, 'signing_partner_id')
  if (b.manager_id) await assertEmployee(b.manager_id, 'manager_id')
  const data: Prisma.AuditEngagementUpdateInput = { updatedBy: session.userId }
  if (b.client_id !== undefined) data.clientId = b.client_id
  if (b.financial_year !== undefined) data.financialYear = b.financial_year
  if (b.audit_type !== undefined) data.auditType = b.audit_type
  if (b.title !== undefined && b.title?.trim()) data.title = b.title.trim()
  if (b.engagement_letter_id !== undefined) data.engagementLetterId = b.engagement_letter_id ?? null
  if (b.signing_partner_id !== undefined) data.signingPartnerId = b.signing_partner_id ?? null
  if (b.partner_membership_no !== undefined) data.partnerMembershipNo = b.partner_membership_no ?? null
  if (b.manager_id !== undefined) data.managerId = b.manager_id ?? null
  if (b.planned_start_date !== undefined) data.plannedStartDate = b.planned_start_date ?? null
  if (b.planned_report_date !== undefined) data.plannedReportDate = b.planned_report_date ?? null
  if (b.status !== undefined) data.status = b.status
  const updated = await prisma.$transaction(async (tx) => {
    const clientId = b.client_id ?? e.clientId
    const fy = b.financial_year ?? e.financialYear
    const type = b.audit_type ?? e.auditType
    if (clientId !== e.clientId || fy !== e.financialYear || type !== e.auditType) await assertNoDuplicate(tx, clientId, fy, type, e.id)
    const u = await tx.auditEngagement.update({ where: { id: e.id }, data })
    if (u.signingPartnerId && u.signingPartnerId !== e.signingPartnerId) await ensureTeam(tx, u.id, u.signingPartnerId, 'partner')
    if (u.managerId && u.managerId !== e.managerId && u.managerId !== u.signingPartnerId) await ensureTeam(tx, u.id, u.managerId, 'manager')
    return u
  })
  await audit(req, session, 'update', 'AuditEngagement', e.id, e, updated)
  ok(res, await detail(updated))
}))

auditFilesRouter.post('/:id/acceptance/approve', handler(async (req, res) => {
  const { session, e } = await fileAccess(req, 'review')
  guardWrite(e, session, req.body)
  const myId = me(session)
  const partnerOnTeam = await prisma.auditTeamMember.findFirst({ where: { engagementId: e.id, employeeId: myId, role: 'partner', ...alive } })
  if (!isSigningPartner(e, session) && !partnerOnTeam) throw ApiError.forbidden('Only a partner on this file can approve client acceptance.')
  const tpl = await prisma.auditChecklistTemplate.findUnique({ where: { code: 'acceptance' }, include: { items: { select: { clause: true } } } })
  if (!tpl) throw ApiError.unprocessable('acceptance_incomplete', 'The acceptance checklist is not set up. Run the audit seed.')
  const answered = new Set((await prisma.auditChecklistResponse.findMany({
    where: { engagementId: e.id, templateCode: 'acceptance', answer: { not: 'pending' } }, select: { clause: true },
  })).map((r) => r.clause))
  const pending = tpl.items.filter((i) => !answered.has(i.clause)).map((i) => i.clause)
  if (pending.length) {
    throw ApiError.unprocessable('acceptance_incomplete', `Answer every acceptance checklist item first (${pending.length} pending).`, { pending })
  }
  const updated = await prisma.auditEngagement.update({
    where: { id: e.id }, data: { acceptanceApprovedBy: myId, acceptanceApprovedAt: new Date(), updatedBy: session.userId },
  })
  await audit(req, session, 'acceptance_approve', 'AuditEngagement', e.id, { acceptance_approved_at: e.acceptanceApprovedAt }, { acceptance_approved_by: myId })
  ok(res, await detail(updated))
}))

auditFilesRouter.put('/:id/materiality', handler(async (req, res) => {
  const { session, e } = await fileAccess(req, 'manage')
  guardWrite(e, session, req.body)
  const pct = z.union([z.number(), z.string().trim().regex(/^\d+(\.\d+)?$/, 'A number.')])
  const b = parse(z.object({
    benchmark: z.enum(['profit_before_tax', 'revenue', 'total_assets', 'equity', 'expenses', 'other']),
    base_paise: z.number().int().min(0),
    percent: pct,
    performance_percent: pct.default(75),
    trivial_percent: pct.default(5),
    rationale: z.string().trim().max(4000).nullish(),
  }), req.body, 'Invalid materiality.')
  const m = computeMateriality(BigInt(b.base_paise), b.percent, b.performance_percent, b.trivial_percent)
  const updated = await prisma.auditEngagement.update({
    where: { id: e.id },
    data: {
      materialityBenchmark: b.benchmark,
      materialityBasePaise: BigInt(b.base_paise),
      materialityPercent: pctString(b.percent),
      overallMaterialityPaise: m.overall,
      performanceMaterialityPaise: m.performance,
      clearlyTrivialPaise: m.trivial,
      materialityRationale: b.rationale ?? null,
      updatedBy: session.userId,
    },
  })
  await audit(req, session, 'materiality', 'AuditEngagement', e.id, S.materiality(e), S.materiality(updated))
  ok(res, await detail(updated))
}))

// ── Sign and lock ───────────────────────────────────────────────────────────

auditFilesRouter.post('/:id/sign', handler(async (req, res) => {
  const { session, e } = await fileAccess(req, 'sign')
  guardWrite(e, session, req.body)
  if (!isSigningPartner(e, session)) throw ApiError.forbidden('Only the signing partner of this file can sign it.')
  const b = parse(z.object({
    report_date: ISO_DATE,
    opinion_type: z.enum(OPINIONS),
    report_place: z.string().trim().min(1, 'Give the place of signature.').max(100),
    udin: z.string().trim().toUpperCase().nullish(),
  }), req.body, 'Invalid sign-off.')
  if (e.status === 'signed' || e.status === 'archived') throw ApiError.conflict('already_signed', 'This file is already signed.')
  if (b.report_date > istToday()) throw ApiError.badRequest('The report date cannot be in the future.', { report_date: 'In the future.' })
  const d = (await progressFor([e])).get(e.id)!
  const blockers = blockersOf(e, d)
  if (blockers.length) {
    throw ApiError.unprocessable('sign_blocked', 'This file cannot be signed yet.', { blockers: blockers.map((x) => x.message), blocker_details: blockers })
  }
  if (b.udin) {
    if (!e.partnerMembershipNo) throw ApiError.unprocessable('membership_required', "Record the signing partner's membership number on the file before adding a UDIN.")
    validateUdin(b.udin, e.partnerMembershipNo)
  }
  const assemblyDueDate = addDays(b.report_date, 60)
  const updated = await prisma.$transaction(async (tx) => {
    const u = await tx.auditEngagement.update({
      where: { id: e.id },
      data: {
        status: 'signed', reportDate: b.report_date, opinionType: b.opinion_type, reportPlace: b.report_place,
        assemblyDueDate, updatedBy: session.userId,
      },
    })
    if (b.udin) {
      await tx.auditUdin.create({
        data: {
          organisationId: e.organisationId, engagementId: e.id, clientId: e.clientId, udin: b.udin,
          documentType: udinDocType(e.auditType), documentDescription: e.title, documentDate: b.report_date,
          partnerId: e.signingPartnerId, membershipNo: e.partnerMembershipNo, generatedOn: istToday(), createdBy: session.userId,
        },
      })
    }
    return u
  }).catch((err) => {
    if (isUniqueViolation(err)) throw ApiError.conflict('udin_exists', 'That UDIN is already in the register.')
    throw err
  })
  await audit(req, session, 'sign', 'AuditEngagement', e.id, { status: e.status }, {
    status: 'signed', report_date: b.report_date, opinion_type: b.opinion_type, report_place: b.report_place, assembly_due_date: assemblyDueDate, udin: b.udin ?? null,
  })
  ok(res, await detail(updated))
}))

auditFilesRouter.post('/:id/lock', handler(async (req, res) => {
  const { session, e } = await fileAccess(req, 'sign')
  if (e.lockedAt) throw ApiError.conflict('already_locked', 'This file is already locked.')
  if (!isSigningPartner(e, session) && !isManager(e, session)) throw ApiError.forbidden('Only the signing partner or the manager can lock the file.')
  if (e.status !== 'signed') throw ApiError.unprocessable('not_signed', 'Sign the report before locking the file.')
  const updated = await prisma.auditEngagement.update({
    where: { id: e.id }, data: { lockedAt: new Date(), lockedBy: me(session), status: 'archived', updatedBy: session.userId },
  })
  await audit(req, session, 'lock', 'AuditEngagement', e.id, { status: e.status }, { status: 'archived', locked_at: updated.lockedAt, assembly_due_date: e.assemblyDueDate })
  ok(res, await detail(updated))
}))

// ── Team ────────────────────────────────────────────────────────────────────

async function teamList(e: AuditEngagement) {
  const team = await prisma.auditTeamMember.findMany({ where: { engagementId: e.id, ...alive }, orderBy: { createdAt: 'asc' } })
  const names = await employeeNames(team.map((t) => t.employeeId))
  return team.map((t) => S.teamMember(t, names, e))
}

auditFilesRouter.get('/:id/team', handler(async (req, res) => {
  const { e } = await fileAccess(req, 'read')
  ok(res, S.list(await teamList(e)))
}))

auditFilesRouter.post('/:id/team', handler(async (req, res) => {
  const { session, e } = await fileAccess(req, 'manage')
  guardWrite(e, session, req.body)
  const b = parse(z.object({ employee_id: z.string().min(1), role: z.enum(TEAM_ROLES) }), req.body, 'Invalid team member.')
  await assertEmployee(b.employee_id, 'employee_id')
  const existing = await prisma.auditTeamMember.findUnique({ where: { engagementId_employeeId: { engagementId: e.id, employeeId: b.employee_id } } })
  if (existing && !existing.deletedAt) throw ApiError.conflict('already_on_team', 'This person is already on the team.')
  const row = existing
    ? await prisma.auditTeamMember.update({ where: { id: existing.id }, data: { deletedAt: null, role: b.role, independenceDeclaredAt: null, independenceNote: null } })
    : await prisma.auditTeamMember.create({ data: { engagementId: e.id, employeeId: b.employee_id, role: b.role } })
  await audit(req, session, 'team_add', 'AuditTeamMember', row.id, undefined, { engagement_id: e.id, employee_id: b.employee_id, role: b.role })
  ok(res, S.teamMember(row, await employeeNames([row.employeeId]), e), 201)
}))

auditFilesRouter.delete('/:id/team/:memberId', handler(async (req, res) => {
  const { session, e } = await fileAccess(req, 'manage')
  guardWrite(e, session, req.body)
  const row = await prisma.auditTeamMember.findFirst({ where: { id: req.params.memberId, engagementId: e.id, ...alive } })
  if (!row) throw ApiError.notFound('Team member not found.')
  if (row.employeeId === e.signingPartnerId) throw ApiError.unprocessable('signing_partner', 'The signing partner cannot be removed from the team. Change the signing partner first.')
  await prisma.auditTeamMember.update({ where: { id: row.id }, data: { deletedAt: new Date() } })
  await audit(req, session, 'team_remove', 'AuditTeamMember', row.id, { employee_id: row.employeeId, role: row.role })
  ok(res, { id: row.id, removed: true })
}))

auditFilesRouter.post('/:id/team/declare-independence', handler(async (req, res) => {
  const { session, e } = await fileAccess(req, 'read')
  guardWrite(e, session, req.body)
  const myId = me(session)
  const b = parse(z.object({ note: z.string().trim().max(2000).nullish() }), req.body, 'Invalid declaration.')
  const row = await prisma.auditTeamMember.findFirst({ where: { engagementId: e.id, employeeId: myId, ...alive } })
  if (!row) throw ApiError.unprocessable('not_on_team', 'You are not on the team for this file.')
  const updated = await prisma.auditTeamMember.update({
    where: { id: row.id }, data: { independenceDeclaredAt: new Date(), independenceNote: b.note ?? null },
  })
  await audit(req, session, 'declare_independence', 'AuditTeamMember', row.id, undefined, { engagement_id: e.id, note: b.note ?? null })
  ok(res, S.teamMember(updated, await employeeNames([row.employeeId]), e))
}))

registerPapers(auditFilesRouter)
registerRecords.file(auditFilesRouter)
registerExport(auditFilesRouter)

