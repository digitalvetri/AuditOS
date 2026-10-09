import type { Router } from 'express'
import { z } from 'zod'
import type { AuditEngagement, Prisma } from '@prisma/client'
import { prisma, alive } from '../../lib/prisma.js'
import { ApiError, handler, ok } from '../../lib/http.js'
import { lockSequence, maxSuffix } from '../../lib/sequence.js'
import { appliesTo, assertEmployee, employeeNames, guardWrite, me } from './service.js'
import * as S from './serialize.js'
import { ISO_DATE, access, audit, fileAccess, parse } from './common.js'

/** Risks (SA 315), observations (SA 450 / management letter), and checklists. */

const LEVELS = ['low', 'medium', 'high', 'significant'] as const
const ASSERTIONS = ['existence', 'completeness', 'accuracy', 'cut_off', 'classification', 'valuation', 'rights', 'presentation', 'occurrence'] as const
const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const
const KINDS = ['query', 'observation', 'misstatement', 'control_deficiency'] as const
const IMPACTS = ['none', 'caro', 'emphasis_of_matter', 'qualification', 'management_letter'] as const
const OBS_STATUS = ['open', 'sent_to_client', 'responded', 'resolved', 'carried_forward'] as const
const ANSWERS = ['yes', 'no', 'na', 'qualified', 'adverse', 'pending'] as const

const refsField = z.union([z.string(), z.array(z.string())]).nullish()
  .transform((v) => (Array.isArray(v) ? v.map((s) => s.trim()).filter(Boolean).join(', ') : v?.trim() || null))

function templates(r: Router) {
  r.get('/checklist-templates', handler(async (req, res) => {
    access(req, 'read')
    const rows = await prisma.auditChecklistTemplate.findMany({
      where: { isActive: true }, include: { _count: { select: { items: true } } }, orderBy: { code: 'asc' },
    })
    const order = ['acceptance', 'caro_2020', 'form_3cd', 'completion']
    rows.sort((a, b) => (order.indexOf(a.code) + 1 || 99) - (order.indexOf(b.code) + 1 || 99))
    ok(res, S.list(rows.map((t) => ({
      id: t.id, code: t.code, name: t.name,
      /** Comma-separated audit types, e.g. 'statutory'. */
      applies_to: t.appliesTo,
      description: t.description, source: t.source, is_active: t.isActive, item_count: t._count.items,
    }))))
  }))
}

function file(r: Router) {
  // ── Risks ──
  const riskSchema = z.object({
    area: z.string().trim().min(1, 'Name the area.').max(200),
    assertion: z.enum(ASSERTIONS).nullish(),
    description: z.string().trim().min(1, 'Describe the risk.').max(10000),
    level: z.enum(LEVELS).default('medium'),
    fraud_risk: z.boolean().default(false),
    response: z.string().max(10000).nullish(),
    working_paper_refs: refsField,
  })

  r.get('/:id/risks', handler(async (req, res) => {
    const { e } = await fileAccess(req, 'read')
    const rows = await prisma.auditRisk.findMany({ where: { engagementId: e.id, ...alive }, orderBy: { createdAt: 'asc' } })
    ok(res, S.list(rows.map(S.risk)))
  }))

  r.post('/:id/risks', handler(async (req, res) => {
    const { session, e } = await fileAccess(req, 'manage')
    guardWrite(e, session, req.body)
    const b = parse(riskSchema, req.body, 'Invalid risk.')
    const row = await prisma.auditRisk.create({
      data: {
        engagementId: e.id, area: b.area, assertion: b.assertion ?? null, description: b.description, level: b.level,
        fraudRisk: b.fraud_risk, response: b.response ?? null, workingPaperRefs: b.working_paper_refs, createdBy: session.userId,
      },
    })
    await audit(req, session, 'risk_create', 'AuditRisk', row.id, undefined, S.risk(row))
    ok(res, S.risk(row), 201)
  }))

  async function loadRisk(e: AuditEngagement, id: string) {
    const row = await prisma.auditRisk.findFirst({ where: { id, engagementId: e.id, ...alive } })
    if (!row) throw ApiError.notFound('Risk not found.')
    return row
  }

  r.patch('/:id/risks/:riskId', handler(async (req, res) => {
    const { session, e } = await fileAccess(req, 'manage')
    guardWrite(e, session, req.body)
    const row = await loadRisk(e, req.params.riskId)
    const b = parse(riskSchema.partial(), req.body, 'Invalid risk.')
    const data: Prisma.AuditRiskUpdateInput = {}
    const raw = (req.body ?? {}) as Record<string, unknown>
    if (b.area !== undefined) data.area = b.area
    if ('assertion' in raw) data.assertion = b.assertion ?? null
    if (b.description !== undefined) data.description = b.description
    if ('level' in raw && b.level) data.level = b.level
    if ('fraud_risk' in raw && b.fraud_risk !== undefined) data.fraudRisk = b.fraud_risk
    if ('response' in raw) data.response = b.response ?? null
    if ('working_paper_refs' in raw) data.workingPaperRefs = b.working_paper_refs ?? null
    const updated = await prisma.auditRisk.update({ where: { id: row.id }, data })
    await audit(req, session, 'risk_update', 'AuditRisk', row.id, S.risk(row), S.risk(updated))
    ok(res, S.risk(updated))
  }))

  r.delete('/:id/risks/:riskId', handler(async (req, res) => {
    const { session, e } = await fileAccess(req, 'manage')
    guardWrite(e, session, req.body)
    const row = await loadRisk(e, req.params.riskId)
    await prisma.auditRisk.update({ where: { id: row.id }, data: { deletedAt: new Date() } })
    await audit(req, session, 'risk_delete', 'AuditRisk', row.id, S.risk(row))
    ok(res, { id: row.id, deleted: true })
  }))

  // ── Observations ──
  const obsSchema = z.object({
    title: z.string().trim().min(1, 'Give the observation a title.').max(300),
    description: z.string().trim().min(1, 'Describe the observation.').max(20000),
    area: z.string().trim().max(200).nullish(),
    severity: z.enum(SEVERITIES).default('medium'),
    kind: z.enum(KINDS).default('query'),
    amount_paise: z.number().int().nullish(),
    adjusted: z.boolean().nullish(),
    report_impact: z.enum(IMPACTS).default('none'),
    owner_id: z.string().nullish(),
    due_date: ISO_DATE.nullish(),
  })

  async function obsOut(rows: Awaited<ReturnType<typeof prisma.auditObservation.findMany>>) {
    const names = await employeeNames(rows.flatMap((o) => [o.ownerId, o.resolvedBy]))
    return rows.map((o) => S.observation(o, names))
  }

  r.get('/:id/observations', handler(async (req, res) => {
    const { e } = await fileAccess(req, 'read')
    const rows = await prisma.auditObservation.findMany({ where: { engagementId: e.id, ...alive } })
    rows.sort((a, b) => a.ref.localeCompare(b.ref, 'en', { numeric: true }))
    ok(res, S.list(await obsOut(rows)))
  }))

  r.post('/:id/observations', handler(async (req, res) => {
    const { session, e } = await fileAccess(req, 'manage')
    guardWrite(e, session, req.body)
    const b = parse(obsSchema, req.body, 'Invalid observation.')
    await assertEmployee(b.owner_id, 'owner_id')
    const row = await prisma.$transaction(async (tx) => {
      await lockSequence(tx, `audit-obs:${e.id}`)
      // Deleted rows count: a ref is never handed out twice.
      const refs = (await tx.auditObservation.findMany({ where: { engagementId: e.id }, select: { ref: true } })).map((o) => o.ref)
      const ref = `OBS-${String(maxSuffix(refs, 'OBS-') + 1).padStart(2, '0')}`
      return tx.auditObservation.create({
        data: {
          engagementId: e.id, ref, title: b.title, description: b.description, area: b.area ?? null,
          severity: b.severity, kind: b.kind, amountPaise: b.amount_paise == null ? null : BigInt(b.amount_paise),
          adjusted: b.adjusted ?? null, reportImpact: b.report_impact, ownerId: b.owner_id ?? null,
          dueDate: b.due_date ?? null, createdBy: session.userId,
        },
      })
    })
    await audit(req, session, 'observation_create', 'AuditObservation', row.id, undefined, { engagement_id: e.id, ref: row.ref, title: row.title })
    ok(res, (await obsOut([row]))[0], 201)
  }))

  r.patch('/:id/observations/:obsId', handler(async (req, res) => {
    const { session, e } = await fileAccess(req, 'manage')
    guardWrite(e, session, req.body)
    const row = await prisma.auditObservation.findFirst({ where: { id: req.params.obsId, engagementId: e.id, ...alive } })
    if (!row) throw ApiError.notFound('Observation not found.')
    const b = parse(obsSchema.partial().extend({
      management_response: z.string().max(20000).nullish(),
      status: z.enum(OBS_STATUS).optional(),
    }), req.body, 'Invalid observation.')
    const raw = (req.body ?? {}) as Record<string, unknown>
    if (b.owner_id) await assertEmployee(b.owner_id, 'owner_id')
    const data: Prisma.AuditObservationUpdateInput = {}
    if (b.title !== undefined) data.title = b.title
    if (b.description !== undefined) data.description = b.description
    if ('area' in raw) data.area = b.area ?? null
    if ('severity' in raw && b.severity) data.severity = b.severity
    if ('kind' in raw && b.kind) data.kind = b.kind
    if ('amount_paise' in raw) data.amountPaise = b.amount_paise == null ? null : BigInt(b.amount_paise)
    if ('adjusted' in raw) data.adjusted = b.adjusted ?? null
    if ('report_impact' in raw && b.report_impact) data.reportImpact = b.report_impact
    if ('owner_id' in raw) data.ownerId = b.owner_id ?? null
    if ('due_date' in raw) data.dueDate = b.due_date ?? null
    if ('management_response' in raw) data.managementResponse = b.management_response ?? null
    if (b.status && b.status !== row.status) {
      data.status = b.status
      if (b.status === 'resolved') { data.resolvedBy = me(session); data.resolvedAt = new Date() } else { data.resolvedBy = null; data.resolvedAt = null }
    }
    const updated = await prisma.auditObservation.update({ where: { id: row.id }, data })
    await audit(req, session, 'observation_update', 'AuditObservation', row.id, { status: row.status, title: row.title }, { status: updated.status, title: updated.title })
    ok(res, (await obsOut([updated]))[0])
  }))

  // ── Checklists ──
  async function loadTemplate(code: string) {
    const t = await prisma.auditChecklistTemplate.findUnique({ where: { code }, include: { items: { orderBy: { sortOrder: 'asc' } } } })
    if (!t) throw ApiError.notFound('Checklist not found.')
    return t
  }

  async function checklistOut(e: AuditEngagement, code: string) {
    const t = await loadTemplate(code)
    const responses = await prisma.auditChecklistResponse.findMany({ where: { engagementId: e.id, templateCode: code } })
    const byClause = new Map(responses.map((r) => [r.clause, r]))
    const names = await employeeNames(responses.flatMap((r) => [r.preparedBy, r.reviewedBy]))
    const items = t.items.map((i) => {
      const r = byClause.get(i.clause)
      return {
        clause: i.clause, heading: i.heading, guidance: i.guidance, sort_order: i.sortOrder,
        answer: r?.answer ?? 'pending', remarks: r?.remarks ?? null, working_paper_ref: r?.workingPaperRef ?? null,
        prepared_by: r?.preparedBy ?? null, preparer: r?.preparedBy ? names.get(r.preparedBy) ?? null : null, prepared_at: r?.preparedAt ?? null,
        reviewed_by: r?.reviewedBy ?? null, reviewer: r?.reviewedBy ? names.get(r.reviewedBy) ?? null : null, reviewed_at: r?.reviewedAt ?? null,
      }
    })
    const pending = items.filter((i) => i.answer === 'pending').length
    return {
      template: {
        id: t.id, code: t.code, name: t.name, description: t.description, source: t.source,
        applies_to: t.appliesTo, is_active: t.isActive, item_count: t.items.length, applicable: appliesTo(t, e.auditType),
      },
      items,
      counts: { total: items.length, answered: items.length - pending, pending, reviewed: items.filter((i) => i.reviewed_at).length },
    }
  }

  r.get('/:id/checklists/:templateCode', handler(async (req, res) => {
    const { e } = await fileAccess(req, 'read')
    ok(res, await checklistOut(e, req.params.templateCode))
  }))

  async function loadItem(code: string, clause: string) {
    const t = await loadTemplate(code)
    const item = t.items.find((i) => i.clause === clause)
    if (!item) throw ApiError.notFound('Checklist item not found.')
    return item
  }

  r.put('/:id/checklists/:templateCode/:clause', handler(async (req, res) => {
    const { session, e } = await fileAccess(req, 'manage')
    guardWrite(e, session, req.body)
    const myId = me(session)
    const { templateCode, clause } = req.params
    await loadItem(templateCode, clause)
    const b = parse(z.object({
      answer: z.enum(ANSWERS),
      remarks: z.string().max(20000).nullish(),
      working_paper_ref: z.string().trim().max(50).nullish(),
    }), req.body, 'Invalid answer.')
    const key = { engagementId_templateCode_clause: { engagementId: e.id, templateCode, clause } }
    const before = await prisma.auditChecklistResponse.findUnique({ where: key })
    const changed = !before || before.answer !== b.answer || (before.remarks ?? null) !== (b.remarks ?? null) || (before.workingPaperRef ?? null) !== (b.working_paper_ref ?? null)
    const fields = {
      answer: b.answer, remarks: b.remarks ?? null, workingPaperRef: b.working_paper_ref ?? null,
      // Whoever changes an answer is its preparer; a change withdraws the review.
      ...(changed ? { preparedBy: myId, preparedAt: new Date(), reviewedBy: null, reviewedAt: null } : {}),
    }
    await prisma.auditChecklistResponse.upsert({
      where: key, create: { engagementId: e.id, templateCode, clause, ...fields }, update: fields,
    })
    if (changed) {
      await audit(req, session, 'checklist_answer', 'AuditChecklistResponse', `${e.id}:${templateCode}:${clause}`,
        before ? { answer: before.answer, remarks: before.remarks } : undefined, { answer: b.answer, remarks: b.remarks ?? null })
    }
    const out = await checklistOut(e, templateCode)
    ok(res, { item: out.items.find((i) => i.clause === clause), counts: out.counts })
  }))

  r.post('/:id/checklists/:templateCode/:clause/review', handler(async (req, res) => {
    const { session, e } = await fileAccess(req, 'review')
    guardWrite(e, session, req.body)
    const myId = me(session)
    const { templateCode, clause } = req.params
    await loadItem(templateCode, clause)
    const row = await prisma.auditChecklistResponse.findUnique({ where: { engagementId_templateCode_clause: { engagementId: e.id, templateCode, clause } } })
    if (!row || row.answer === 'pending') throw ApiError.unprocessable('not_answered', 'Answer this item before reviewing it.')
    if (row.preparedBy === myId) throw ApiError.forbidden('The preparer of a checklist item cannot review it.')
    await prisma.auditChecklistResponse.update({ where: { id: row.id }, data: { reviewedBy: myId, reviewedAt: new Date() } })
    await audit(req, session, 'checklist_review', 'AuditChecklistResponse', row.id, undefined, { template: templateCode, clause, reviewed_by: myId })
    const out = await checklistOut(e, templateCode)
    ok(res, { item: out.items.find((i) => i.clause === clause), counts: out.counts })
  }))
}

export const registerRecords = { templates, file }
