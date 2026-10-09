/**
 * /api/compliance — the compliance calendar (docs/compliance/README.md).
 *
 * Permissions: workstation.compliance.read / .manage. Client visibility is
 * the Workstation rule (assignedClientIds). Every write → writeAudit.
 */
import { Router, type Request } from 'express'
import type { ComplianceItem, Prisma } from '@prisma/client'
import { prisma, alive } from '../../lib/prisma.js'
import { ApiError, handler, noContent, ok } from '../../lib/http.js'
import { istToday, addDays } from '../../lib/dates.js'
import { can, requireSession, type Session } from '../../platform/auth.js'
import { writeAudit } from '../../platform/audit.js'
import { assertCanSeeClient, assignedClientIds, requireWorkstation } from '../../platform/workstation/scope.js'
import type { Scope } from '../../platform/rbac/matrix.js'
import { parseCsv } from '../zpay/invoice-import.js'
import {
  ENTITY_TYPES, dueFor, entityTypeOf, findPeriod, fyOfPeriodKey, isFy, parseMonths,
} from './engine.js'
import {
  CLOSED_STATUSES, ITEM_STATUSES, buildContext, defaultFys, extensionToApi, formToApi, generateItems, isIsoDate,
  itemToApi, orgOfUser, suggestedForms, toRule, type ItemApi,
} from './service.js'
import { gstRows, tdsRows } from './merge.js'

const READ = ['workstation.compliance.read', 'workstation.compliance.manage'] as const
const MANAGE = ['workstation.compliance.manage'] as const

export const complianceRouter = Router()

async function caller(req: Request, perms: readonly ('workstation.compliance.read' | 'workstation.compliance.manage')[]) {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...perms)
  const organisationId = await orgOfUser(prisma, session.userId)
  return { session, scope, organisationId }
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)

async function assertEmployee(organisationId: string, id: unknown): Promise<string | null> {
  if (id === null || id === '') return null
  if (typeof id !== 'string') throw ApiError.badRequest('assigned_employee_id must be a string.')
  const e = await prisma.employee.findFirst({ where: { id, organisationId, deletedAt: null }, select: { id: true } })
  if (!e) throw ApiError.badRequest('No such employee.', { assigned_employee_id: 'Unknown employee.' })
  return id
}

// ── catalogue ────────────────────────────────────────────────────────────────

complianceRouter.get('/forms', handler(async (req, res) => {
  await caller(req, READ)
  const forms = await prisma.complianceForm.findMany({ orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }] })
  ok(res, forms.map(formToApi))
}))

complianceRouter.patch('/forms/:code', handler(async (req, res) => {
  const { session } = await caller(req, MANAGE)
  if (!can(session, 'settings.manage')) throw ApiError.forbidden('Editing the catalogue needs Settings → manage.')
  const form = await prisma.complianceForm.findUnique({ where: { code: req.params.code } })
  if (!form) throw ApiError.notFound('No such form.')
  const b = req.body ?? {}
  const data: Prisma.ComplianceFormUpdateInput = {}
  const errors: Record<string, string> = {}
  if (b.name !== undefined) { if (!str(b.name)) errors.name = 'Required.'; else data.name = str(b.name)! }
  if (b.anchor !== undefined) {
    if (!['period_end', 'fy_end', 'fy_start', 'agm', 'event'].includes(b.anchor)) errors.anchor = 'Unknown anchor.'
    else data.anchor = b.anchor
  }
  for (const [k, col, min, max] of [['offset_months', 'offsetMonths', -12, 24], ['offset_days', 'offsetDays', -366, 366]] as const) {
    if (b[k] === undefined) continue
    if (!Number.isInteger(b[k]) || b[k] < min || b[k] > max) errors[k] = `Whole number ${min} to ${max}.`
    else (data as Record<string, unknown>)[col] = b[k]
  }
  if (b.due_day !== undefined) {
    if (b.due_day !== null && (!Number.isInteger(b.due_day) || b.due_day < 1 || b.due_day > 31)) errors.due_day = '1 to 31, or null.'
    else data.dueDay = b.due_day
  }
  if (b.months !== undefined) {
    if (b.months === null || (Array.isArray(b.months) && b.months.length === 0)) data.months = null
    else {
      const csv = Array.isArray(b.months) ? b.months.join(',') : String(b.months)
      const parsed = parseMonths(csv)
      if (!parsed || parsed.length !== csv.split(',').length) errors.months = 'Months 1–12.'
      else data.months = parsed.join(',')
    }
  }
  if (b.entity_types !== undefined) {
    const list = Array.isArray(b.entity_types) ? b.entity_types : String(b.entity_types).split(',')
    if (!list.length || list.some((t: unknown) => !ENTITY_TYPES.includes(String(t).trim() as never))) errors.entity_types = `One or more of ${ENTITY_TYPES.join(', ')}.`
    else data.entityTypes = list.map((t: unknown) => String(t).trim()).join(',')
  }
  for (const [k, col] of [['late_fee_note', 'lateFeeNote'], ['description', 'description'], ['source_url', 'sourceUrl']] as const) {
    if (b[k] !== undefined) (data as Record<string, unknown>)[col] = b[k] === null ? null : String(b[k]).slice(0, 2000)
  }
  if (b.is_active !== undefined) data.isActive = Boolean(b.is_active)
  if (Object.keys(errors).length) throw ApiError.badRequest('Check the highlighted fields.', errors)
  const after = await prisma.complianceForm.update({ where: { code: form.code }, data })
  await writeAudit({ actorUserId: session.userId, action: 'compliance_form.update', entityType: 'ComplianceForm', entityId: form.id, before: formToApi(form), after: formToApi(after), req })
  ok(res, formToApi(after))
}))

// ── obligations ──────────────────────────────────────────────────────────────

async function loadClient(clientId: string, organisationId: string) {
  const c = await prisma.client.findFirst({
    where: { id: clientId, organisationId, ...alive },
    select: { id: true, companyName: true, clientCode: true, businessType: true, organisationId: true, gstProfile: { select: { registrationType: true, filingFrequency: true, active: true, deletedAt: true } } },
  })
  if (!c) throw ApiError.forbidden()
  return c
}

async function obligationsView(clientId: string, organisationId: string) {
  const client = await loadClient(clientId, organisationId)
  const [forms, obligations] = await Promise.all([
    prisma.complianceForm.findMany({ orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }] }),
    prisma.clientObligation.findMany({ where: { clientId, isActive: true, deletedAt: null } }),
  ])
  const byCode = new Map(forms.map((f) => [f.code, f]))
  const entity = entityTypeOf(client.businessType)
  const gst = client.gstProfile && !client.gstProfile.deletedAt ? client.gstProfile : null
  const active = new Set(obligations.map((o) => o.formCode))
  return {
    client: { id: client.id, name: client.companyName, client_code: client.clientCode, business_type: client.businessType, entity_type: entity },
    obligations: obligations
      .sort((a, b) => (byCode.get(a.formCode)?.sortOrder ?? 0) - (byCode.get(b.formCode)?.sortOrder ?? 0))
      .map((o) => ({
        id: o.id, form_code: o.formCode, form_name: byCode.get(o.formCode)?.name ?? o.formCode,
        authority: byCode.get(o.formCode)?.authority ?? 'other', frequency: byCode.get(o.formCode)?.frequency ?? null,
        assigned_employee_id: o.assignedEmployeeId, remind_client: o.remindClient, is_active: o.isActive, notes: o.notes,
      })),
    suggested: suggestedForms(forms, entity, gst).map((s) => ({
      ...s, form_name: byCode.get(s.form_code)?.name ?? s.form_code, authority: byCode.get(s.form_code)?.authority ?? 'other', active: active.has(s.form_code),
    })),
  }
}

complianceRouter.get('/clients/:clientId/obligations', handler(async (req, res) => {
  const { session, scope, organisationId } = await caller(req, READ)
  await assertCanSeeClient(session, scope, req.params.clientId)
  ok(res, await obligationsView(req.params.clientId, organisationId))
}))

complianceRouter.put('/clients/:clientId/obligations', handler(async (req, res) => {
  const { session, scope, organisationId } = await caller(req, MANAGE)
  const clientId = req.params.clientId
  await assertCanSeeClient(session, scope, clientId)
  await loadClient(clientId, organisationId)
  const list = req.body?.forms
  if (!Array.isArray(list)) throw ApiError.badRequest('forms must be an array.')
  const forms = new Map((await prisma.complianceForm.findMany()).map((f) => [f.code, f]))
  const wanted = new Map<string, { assigned: string | null; remind: boolean }>()
  for (const [i, row] of list.entries()) {
    const code = row?.form_code
    if (typeof code !== 'string' || !forms.has(code)) throw ApiError.badRequest(`forms[${i}].form_code is not a known form.`)
    wanted.set(code, {
      assigned: row.assigned_employee_id === undefined ? null : await assertEmployee(organisationId, row.assigned_employee_id),
      remind: row.remind_client === undefined ? false : Boolean(row.remind_client),
    })
  }
  const before = await prisma.clientObligation.findMany({ where: { clientId } })
  const today = istToday()
  for (const [code, w] of wanted) {
    const prior = before.find((o) => o.formCode === code)
    if (prior) {
      await prisma.clientObligation.update({
        where: { id: prior.id },
        data: { isActive: true, deletedAt: null, assignedEmployeeId: w.assigned, remindClient: w.remind },
      })
    } else {
      await prisma.clientObligation.create({
        data: { organisationId, clientId, formCode: code, assignedEmployeeId: w.assigned, remindClient: w.remind, createdBy: session.userId },
      })
    }
  }
  const removed = before.filter((o) => o.isActive && !o.deletedAt && !wanted.has(o.formCode))
  if (removed.length) {
    await prisma.clientObligation.updateMany({ where: { id: { in: removed.map((o) => o.id) } }, data: { isActive: false } })
    // Open items not yet due go with the obligation; history stays.
    await prisma.complianceItem.updateMany({
      where: { clientId, formCode: { in: removed.map((o) => o.formCode) }, deletedAt: null, status: 'not_started', dueDate: { gte: today } },
      data: { deletedAt: new Date(), updatedBy: session.userId },
    })
  }
  const generated = await generateItems(prisma, { fys: defaultFys(today), clientId, actorUserId: session.userId, today })
  await writeAudit({
    actorUserId: session.userId, action: 'compliance_obligation.replace', entityType: 'Client', entityId: clientId,
    before: before.filter((o) => o.isActive && !o.deletedAt).map((o) => o.formCode),
    after: { forms: [...wanted.keys()], generated }, req,
  })
  ok(res, { ...(await obligationsView(clientId, organisationId)), generated })
}))

complianceRouter.post('/generate', handler(async (req, res) => {
  const { session, organisationId } = await caller(req, MANAGE)
  const fy = req.body?.financial_year
  if (fy !== undefined && fy !== null && !isFy(fy)) throw ApiError.badRequest('financial_year must look like 2025-26.')
  const fys = fy ? [fy as string] : defaultFys(istToday())
  const result = await generateItems(prisma, { fys, organisationId, actorUserId: session.userId, explicit: Boolean(fy) })
  await writeAudit({ actorUserId: session.userId, action: 'compliance_item.generate', entityType: 'ComplianceItem', entityId: organisationId, after: { fys, ...result }, req })
  ok(res, { financial_years: fys, ...result })
}))

// ── items ────────────────────────────────────────────────────────────────────

async function visibleIds(session: Session, scope: Scope) {
  return assignedClientIds(session, scope)
}

async function listItems(session: Session, scope: Scope, organisationId: string, q: Record<string, unknown>) {
  const today = istToday()
  const from = isIsoDate(q.from) ? q.from : null
  const to = isIsoDate(q.to) ? q.to : null
  if ((q.from && !from) || (q.to && !to)) throw ApiError.badRequest('from and to must be YYYY-MM-DD.')
  const ids = await visibleIds(session, scope)
  const clientId = str(q.client_id)
  if (clientId && ids !== 'ALL' && !ids.includes(clientId)) throw ApiError.forbidden()
  const extensions = await prisma.dueDateExtension.findMany({ where: { organisationId, deletedAt: null } })
  const where: Prisma.ComplianceItemWhereInput = {
    organisationId, deletedAt: null,
    ...(q.open_only ? { status: { notIn: [...CLOSED_STATUSES] } } : {}),
    ...(clientId ? { clientId } : ids === 'ALL' ? {} : { clientId: { in: ids } }),
    ...(str(q.form_code) ? { formCode: str(q.form_code)! } : {}),
    ...(from || to
      ? { OR: [{ dueDate: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }, ...extensions.map((e) => ({ formCode: e.formCode, periodKey: e.periodKey }))] }
      : {}),
  }
  const rows = await prisma.complianceItem.findMany({ where, orderBy: [{ dueDate: 'asc' }, { formCode: 'asc' }], take: 5000 })
  const ctx = await buildContext(prisma, organisationId, rows, today)
  let items: ItemApi[] = rows.map((r) => itemToApi(r, ctx))

  const include = String(q.include ?? '').split(',').map((s) => s.trim())
  if ((include.includes('gst') || include.includes('tds'))) {
    const rFrom = from ?? addDays(today, -31)
    const rTo = to ?? addDays(today, 90)
    const scopeIds = clientId ? [clientId] : ids
    const empAll = await prisma.employee.findMany({ where: { organisationId }, select: { id: true, firstName: true, lastName: true } })
    const employees = new Map(empAll.map((e) => [e.id, [e.firstName, e.lastName].filter(Boolean).join(' ')]))
    if (include.includes('gst')) items.push(...await gstRows(prisma, { clientIds: scopeIds, organisationId, from: rFrom, to: rTo, today, employees }))
    if (include.includes('tds')) items.push(...await tdsRows(prisma, { clientIds: scopeIds, organisationId, from: rFrom, to: rTo, today, employees }))
  }

  // Filters on computed fields, after the extension is applied.
  if (from) items = items.filter((i) => i.due_date >= from)
  if (to) items = items.filter((i) => i.due_date <= to)
  if (str(q.form_code)) items = items.filter((i) => i.form_code === q.form_code)
  if (str(q.authority)) items = items.filter((i) => i.authority === q.authority)
  if (str(q.status)) {
    const set = new Set(String(q.status).split(','))
    items = items.filter((i) => set.has(i.status))
  }
  if (str(q.assigned_to)) items = items.filter((i) => i.assigned_employee_id === q.assigned_to)
  if (q.mine === '1' || q.mine === 'true') {
    const me = session.employeeId ?? '__none__'
    const managed = new Set((await prisma.client.findMany({ where: { accountManagerId: me, organisationId }, select: { id: true } })).map((c) => c.id))
    items = items.filter((i) => i.assigned_employee_id === me || (!i.assigned_employee_id && managed.has(i.client_id)))
  }
  if (q.overdue === '1' || q.overdue === 'true') items = items.filter((i) => i.overdue)
  items.sort((a, b) => a.due_date.localeCompare(b.due_date) || (a.client_name ?? '').localeCompare(b.client_name ?? '') || a.form_code.localeCompare(b.form_code))
  return items
}

complianceRouter.get('/items', handler(async (req, res) => {
  const { session, scope, organisationId } = await caller(req, READ)
  ok(res, await listItems(session, scope, organisationId, req.query as Record<string, unknown>))
}))

complianceRouter.get('/summary', handler(async (req, res) => {
  const { session, scope, organisationId } = await caller(req, READ)
  const items = (await listItems(session, scope, organisationId, { open_only: true })).filter((i) => !CLOSED_STATUSES.has(i.status))
  const me = session.employeeId
  const managed = new Set(me ? (await prisma.client.findMany({ where: { accountManagerId: me, organisationId }, select: { id: true } })).map((c) => c.id) : [])
  const bucket = () => ({ open: 0, overdue: 0, due_7: 0, due_30: 0 })
  const add = (b: ReturnType<typeof bucket>, i: ItemApi) => {
    b.open += 1
    if (i.overdue) b.overdue += 1
    else if (i.days_left !== null && i.days_left <= 7) b.due_7 += 1
    if (!i.overdue && i.days_left !== null && i.days_left <= 30) b.due_30 += 1
  }
  const total = bucket()
  const mine = bucket()
  const byAuthority: Record<string, ReturnType<typeof bucket>> = {}
  for (const i of items) {
    add(total, i)
    add(byAuthority[i.authority] ??= bucket(), i)
    if (me && (i.assigned_employee_id === me || (!i.assigned_employee_id && managed.has(i.client_id)))) add(mine, i)
  }
  ok(res, {
    today: istToday(),
    overdue: total.overdue, due_7: total.due_7, due_30: total.due_30, open: total.open,
    agm_date_missing: items.filter((i) => i.anchor_missing).length,
    by_authority: byAuthority,
    mine,
  })
}))

/** AGM-anchored forms of the catalogue. */
async function agmCodes(): Promise<Set<string>> {
  return new Set((await prisma.complianceForm.findMany({ where: { anchor: 'agm' }, select: { code: true } })).map((f) => f.code))
}

interface PatchResult { before: ComplianceItem; after: ComplianceItem }

/** One item's update — shared by PATCH and bulk. Throws ApiError on bad input. */
async function applyPatch(item: ComplianceItem, b: Record<string, unknown>, organisationId: string, session: Session): Promise<PatchResult> {
  const data: Prisma.ComplianceItemUpdateInput = { updatedBy: session.userId }
  const errors: Record<string, string> = {}
  if (b.filed_on !== undefined) {
    if (b.filed_on === null || b.filed_on === '') data.filedOn = null
    else if (!isIsoDate(b.filed_on)) errors.filed_on = 'YYYY-MM-DD.'
    else if (b.filed_on > istToday()) errors.filed_on = 'Cannot be in the future.'
    else data.filedOn = b.filed_on
  }
  if (b.status !== undefined) {
    if (!ITEM_STATUSES.includes(b.status as never)) errors.status = `One of ${ITEM_STATUSES.join(', ')}.`
    else {
      data.status = b.status as string
      const filedOn = data.filedOn !== undefined ? data.filedOn : item.filedOn
      if (b.status === 'filed') {
        if (!filedOn) errors.filed_on = 'Required when the status is filed.'
        else if (item.status !== 'filed') data.filedBy = session.userId
      }
    }
  }
  if (b.assigned_employee_id !== undefined) {
    try { data.assignedEmployeeId = await assertEmployee(organisationId, b.assigned_employee_id) } catch { errors.assigned_employee_id = 'Unknown employee.' }
  }
  if (b.acknowledgement_no !== undefined) data.acknowledgementNo = b.acknowledgement_no === null ? null : String(b.acknowledgement_no).trim().slice(0, 100) || null
  if (b.notes !== undefined) data.notes = b.notes === null ? null : String(b.notes).slice(0, 4000)
  if (b.late_fee_paid_paise !== undefined) {
    const v = b.late_fee_paid_paise
    if (v === null) data.lateFeePaidPaise = null
    else if ((typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) || (typeof v === 'string' && /^\d{1,15}$/.test(v))) data.lateFeePaidPaise = BigInt(v)
    else errors.late_fee_paid_paise = 'Whole paise, 0 or more.'
  }
  let anchor: string | null | undefined
  if (b.anchor_date !== undefined) {
    if (b.anchor_date === null || b.anchor_date === '') anchor = null
    else if (!isIsoDate(b.anchor_date)) errors.anchor_date = 'YYYY-MM-DD.'
    else anchor = b.anchor_date
  }
  if (Object.keys(errors).length) throw ApiError.badRequest('Check the highlighted fields.', errors)

  if (anchor !== undefined) {
    const codes = await agmCodes()
    if (!codes.has(item.formCode) && item.formCode !== 'AGM') {
      throw ApiError.badRequest('anchor_date applies to the AGM and AGM-anchored forms only.', { anchor_date: 'Not an AGM-anchored form.' })
    }
    data.anchorDate = anchor
    // The AGM date is one fact per client and FY: carry it to every
    // AGM-anchored item of that period and recompute their due dates.
    const forms = new Map((await prisma.complianceForm.findMany({ where: { code: { in: [...codes] } } })).map((f) => [f.code, f]))
    const siblings = await prisma.complianceItem.findMany({
      where: { clientId: item.clientId, periodKey: item.periodKey, formCode: { in: [...codes, 'AGM'] }, deletedAt: null, id: { not: item.id } },
    })
    for (const s of siblings) {
      const f = forms.get(s.formCode)
      const due = f ? dueFor(toRule(f), s.periodKey, fyOfPeriodKey(s.periodKey), anchor) : null
      await prisma.complianceItem.update({
        where: { id: s.id },
        data: { anchorDate: anchor, ...(due && !CLOSED_STATUSES.has(s.status) ? { dueDate: due.statutory_due_date } : {}), updatedBy: session.userId },
      })
    }
    const own = forms.get(item.formCode)
    if (own) {
      const due = dueFor(toRule(own), item.periodKey, fyOfPeriodKey(item.periodKey), anchor)
      if (due) data.dueDate = due.statutory_due_date
    }
  }
  const after = await prisma.complianceItem.update({ where: { id: item.id }, data })
  return { before: item, after }
}

complianceRouter.patch('/items/:id', handler(async (req, res) => {
  const { session, scope, organisationId } = await caller(req, MANAGE)
  const item = await prisma.complianceItem.findFirst({ where: { id: req.params.id, organisationId, deletedAt: null } })
  if (!item) throw ApiError.notFound()
  await assertCanSeeClient(session, scope, item.clientId)
  const { before, after } = await applyPatch(item, req.body ?? {}, organisationId, session)
  await writeAudit({ actorUserId: session.userId, action: 'compliance_item.update', entityType: 'ComplianceItem', entityId: item.id, before, after, req })
  const ctx = await buildContext(prisma, organisationId, [after])
  ok(res, itemToApi(after, ctx))
}))

complianceRouter.post('/items/bulk', handler(async (req, res) => {
  const { session, scope, organisationId } = await caller(req, MANAGE)
  const b = req.body ?? {}
  const ids = await visibleIds(session, scope)
  const visible = (clientId: string) => ids === 'ALL' || ids.includes(clientId)
  const changed: string[] = []

  if (typeof b.csv === 'string') {
    const rows = parseCsv(b.csv).filter((r) => r.some((c) => c.trim()))
    if (rows.length && rows[0][0]?.trim().toLowerCase() === 'client_code') rows.shift()
    if (rows.length > 2000) throw ApiError.badRequest('At most 2,000 rows at a time.')
    const results = []
    for (const [n, r] of rows.entries()) {
      const [clientCode, formCode, periodKey, ack, filedOn] = r.map((c) => (c ?? '').trim())
      const out = { row: n + 1, client_code: clientCode, form_code: formCode, period_key: periodKey, ok: false as boolean, id: null as string | null, error: null as string | null }
      try {
        if (!clientCode || !formCode || !periodKey) throw new Error('client_code, form_code and period_key are required.')
        if (!isIsoDate(filedOn)) throw new Error('filed_on must be YYYY-MM-DD.')
        const client = await prisma.client.findFirst({ where: { clientCode, organisationId, deletedAt: null }, select: { id: true } })
        if (!client || !visible(client.id)) throw new Error('No such client.')
        const item = await prisma.complianceItem.findFirst({ where: { clientId: client.id, formCode, periodKey, deletedAt: null } })
        if (!item) throw new Error('No such item for this client, form and period.')
        const { after } = await applyPatch(item, { status: 'filed', filed_on: filedOn, ...(ack ? { acknowledgement_no: ack } : {}) }, organisationId, session)
        out.ok = true
        out.id = after.id
        changed.push(after.id)
      } catch (e) {
        out.error = e instanceof ApiError ? Object.values((e.details as Record<string, string>) ?? {}).join(' ') || e.message : (e as Error).message
      }
      results.push(out)
    }
    if (changed.length) await writeAudit({ actorUserId: session.userId, action: 'compliance_item.bulk_csv', entityType: 'ComplianceItem', entityId: organisationId, after: { ids: changed }, req })
    ok(res, { results, updated: changed.length, failed: results.length - changed.length })
    return
  }

  if (!Array.isArray(b.ids) || !b.ids.length || b.ids.some((i: unknown) => typeof i !== 'string')) throw ApiError.badRequest('ids must be a non-empty array, or send csv.')
  if (b.ids.length > 2000) throw ApiError.badRequest('At most 2,000 items at a time.')
  const patch: Record<string, unknown> = {}
  for (const k of ['status', 'assigned_employee_id', 'filed_on']) if (b[k] !== undefined) patch[k] = b[k]
  if (!Object.keys(patch).length) throw ApiError.badRequest('Nothing to change: send status, assigned_employee_id or filed_on.')
  const results = []
  for (const id of b.ids as string[]) {
    const item = await prisma.complianceItem.findFirst({ where: { id, organisationId, deletedAt: null } })
    if (!item || !visible(item.clientId)) { results.push({ id, ok: false, error: 'Not found.' }); continue }
    try {
      await applyPatch(item, patch, organisationId, session)
      changed.push(id)
      results.push({ id, ok: true, error: null })
    } catch (e) {
      results.push({ id, ok: false, error: e instanceof ApiError ? Object.values((e.details as Record<string, string>) ?? {}).join(' ') || e.message : 'Failed.' })
    }
  }
  if (changed.length) await writeAudit({ actorUserId: session.userId, action: 'compliance_item.bulk_update', entityType: 'ComplianceItem', entityId: organisationId, after: { ids: changed, patch }, req })
  ok(res, { results, updated: changed.length, failed: results.length - changed.length })
}))

// ── extensions ───────────────────────────────────────────────────────────────

complianceRouter.get('/extensions', handler(async (req, res) => {
  const { organisationId } = await caller(req, READ)
  const rows = await prisma.dueDateExtension.findMany({
    where: { organisationId, deletedAt: null, ...(str(req.query.form_code) ? { formCode: String(req.query.form_code) } : {}) },
    orderBy: { createdAt: 'desc' },
  })
  ok(res, rows.map(extensionToApi))
}))

complianceRouter.post('/extensions', handler(async (req, res) => {
  const { session, organisationId } = await caller(req, MANAGE)
  const b = req.body ?? {}
  const errors: Record<string, string> = {}
  const form = typeof b.form_code === 'string' ? await prisma.complianceForm.findUnique({ where: { code: b.form_code } }) : null
  if (!form) errors.form_code = 'Unknown form.'
  if (typeof b.period_key !== 'string' || (form && !findPeriod(toRule(form), b.period_key) && form.anchor !== 'event')) errors.period_key = 'Not a period of this form (e.g. 2025-26, 2026-04, 2025-26-Q1).'
  if (!isIsoDate(b.new_due_date)) errors.new_due_date = 'YYYY-MM-DD.'
  if (!str(b.reference)) errors.reference = 'Required — e.g. CBDT Circular 9/2026.'
  if (b.source_url && !/^https?:\/\//i.test(String(b.source_url))) errors.source_url = 'Must be an http(s) link.'
  let entityTypes: string | null = null
  if (b.entity_types !== undefined && b.entity_types !== null) {
    const list = Array.isArray(b.entity_types) ? b.entity_types : String(b.entity_types).split(',')
    if (list.some((t: unknown) => !ENTITY_TYPES.includes(String(t).trim() as never))) errors.entity_types = `One or more of ${ENTITY_TYPES.join(', ')}.`
    else entityTypes = list.map((t: unknown) => String(t).trim()).filter(Boolean).join(',') || null
  }
  if (Object.keys(errors).length) throw ApiError.badRequest('Check the highlighted fields.', errors)
  const row = await prisma.dueDateExtension.create({
    data: {
      organisationId, formCode: form!.code, periodKey: b.period_key, newDueDate: b.new_due_date,
      reference: str(b.reference)!.slice(0, 300), sourceUrl: str(b.source_url), entityTypes, createdBy: session.userId,
    },
  })
  await writeAudit({ actorUserId: session.userId, action: 'due_date_extension.create', entityType: 'DueDateExtension', entityId: row.id, after: extensionToApi(row), req })
  ok(res, extensionToApi(row), 201)
}))

complianceRouter.delete('/extensions/:id', handler(async (req, res) => {
  const { session, organisationId } = await caller(req, MANAGE)
  const row = await prisma.dueDateExtension.findFirst({ where: { id: req.params.id, organisationId, deletedAt: null } })
  if (!row) throw ApiError.notFound()
  await prisma.dueDateExtension.update({ where: { id: row.id }, data: { deletedAt: new Date() } })
  await writeAudit({ actorUserId: session.userId, action: 'due_date_extension.delete', entityType: 'DueDateExtension', entityId: row.id, before: extensionToApi(row), req })
  noContent(res)
}))

