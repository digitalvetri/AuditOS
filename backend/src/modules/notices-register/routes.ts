/**
 * /api/notices-register — income-tax, MCA and other notices (ClientNotice),
 * with GST notices (GstNotice, which keeps its AI drafting in modules/notices)
 * merged into the one list. docs/compliance/README.md "Notices".
 *
 * Permissions: workstation.notice.read / .manage. Client visibility as
 * everywhere in Workstation. Every write → writeAudit.
 *
 * Status flow (ClientNotice): received → in_progress → replied → hearing →
 * order_received → appeal → closed. Forward-only (steps may be skipped);
 * moving back ("reopen") is for a manager: the client's account manager or
 * staff who see every client.
 */
import { Router } from 'express'
import multer from 'multer'
import path from 'node:path'
import crypto from 'node:crypto'
import type { ClientNotice, GstNotice, Prisma } from '@prisma/client'
import { prisma, alive } from '../../lib/prisma.js'
import { ApiError, handler, noContent, ok } from '../../lib/http.js'
import { daysBetween, istToday } from '../../lib/dates.js'
import { setUploadedFileHeaders } from '../../lib/fileResponse.js'
import { requireSession, type Session } from '../../platform/auth.js'
import { writeAudit } from '../../platform/audit.js'
import { assertCanSeeClient, assignedClientIds, requireWorkstation, seesAllClients, workstationScope } from '../../platform/workstation/scope.js'
import { LocalStorageAdapter } from '../tools/storage/LocalStorageAdapter.js'
import { sniffDocument, sniffImage } from '../messages/attachments.js'
import { orgOfUser, isIsoDate } from '../compliance/service.js'
import { scanUploads } from '../../platform/virusScan.js'

const READ = ['workstation.notice.read', 'workstation.notice.manage'] as const
const MANAGE = ['workstation.notice.manage'] as const

export const NOTICE_STATUSES = ['received', 'in_progress', 'replied', 'hearing', 'order_received', 'appeal', 'closed'] as const
export const NOTICE_AUTHORITIES = ['income_tax', 'mca', 'gst', 'tds', 'labour', 'other'] as const
/** Statuses in which the reply is still owed — the deadline counts. */
export const AWAITING_REPLY = new Set<string>(['received', 'in_progress'])
const GST_AWAITING_REPLY = new Set<string>(['draft', 'review'])

const MAX_UPLOAD_MB = 15
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 1 } })
const storage = () => new LocalStorageAdapter(process.env.CLIENT_NOTICE_STORAGE_ROOT
  ? path.resolve(process.env.CLIENT_NOTICE_STORAGE_ROOT)
  : path.resolve(process.cwd(), 'uploads', 'client-notices'))

export const noticesRegisterRouter = Router()

/** Forward-only, except a manager may move a notice back (reopen). */
export function statusMoveAllowed(from: string, to: string, isManager: boolean): boolean {
  const a = NOTICE_STATUSES.indexOf(from as never)
  const b = NOTICE_STATUSES.indexOf(to as never)
  if (b < 0) return false
  if (b >= a) return true
  return isManager
}

type Names = { clients: Map<string, { name: string; code: string }>; employees: Map<string, string> }

function noticeToApi(n: ClientNotice, names: Names, today: string) {
  const due = n.responseDueDate
  const awaiting = AWAITING_REPLY.has(n.status)
  return {
    id: n.id, source: 'notice' as 'notice' | 'gst', read_only: false,
    client_id: n.clientId, client_name: names.clients.get(n.clientId)?.name ?? null, client_code: names.clients.get(n.clientId)?.code ?? null,
    authority: n.authority, section: n.section as string | null, kind: null as string | null, reference_no: n.referenceNo, din: n.din,
    notice_date: n.noticeDate as string | null, assessment_year: n.assessmentYear, response_due_date: due, hearing_date: n.hearingDate,
    demand_paise: n.demandPaise === null ? null : Number(n.demandPaise),
    status: n.status, assigned_employee_id: n.assignedEmployeeId,
    assigned_employee_name: n.assignedEmployeeId ? names.employees.get(n.assignedEmployeeId) ?? null : null,
    reply_filed_on: n.replyFiledOn, reply_ack_no: n.replyAckNo, summary: n.summary, outcome: n.outcome,
    file_name: n.fileName, file_mime: n.fileMime, has_file: Boolean(n.fileKey),
    days_left: due && awaiting ? daysBetween(today, due) : null,
    overdue: Boolean(due && awaiting && due < today),
    link: null as string | null,
    created_at: n.createdAt, updated_at: n.updatedAt,
  }
}

function gstNoticeToApi(n: GstNotice, names: Names, today: string): ReturnType<typeof noticeToApi> {
  const due = n.responseDueDate
  const awaiting = GST_AWAITING_REPLY.has(n.status)
  return {
    id: n.id, source: 'gst', read_only: true,
    client_id: n.clientId, client_name: names.clients.get(n.clientId)?.name ?? null, client_code: names.clients.get(n.clientId)?.code ?? null,
    authority: 'gst', section: n.section ?? n.kind, kind: n.kind, reference_no: n.referenceNo, din: null,
    notice_date: n.noticeDate, assessment_year: n.financialYear, response_due_date: due, hearing_date: null,
    demand_paise: n.totalDemand === null ? null : Math.round(Number(n.totalDemand) * 100),
    status: n.status, assigned_employee_id: n.assignedEmployeeId,
    assigned_employee_name: n.assignedEmployeeId ? names.employees.get(n.assignedEmployeeId) ?? null : null,
    reply_filed_on: null, reply_ack_no: null, summary: null, outcome: null,
    file_name: n.uploadedFileName, file_mime: n.uploadedMime, has_file: Boolean(n.uploadedFileKey),
    days_left: due && awaiting ? daysBetween(today, due) : null,
    overdue: Boolean(due && awaiting && due < today),
    link: `/workstation/services/registration/gst/clients/${n.clientId}`,
    created_at: n.createdAt, updated_at: n.updatedAt,
  }
}

async function namesFor(rows: { clientId: string; assignedEmployeeId: string | null }[]): Promise<Names> {
  const [clients, employees] = await Promise.all([
    prisma.client.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.clientId))] } }, select: { id: true, companyName: true, clientCode: true } }),
    prisma.employee.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.assignedEmployeeId).filter((x): x is string => !!x))] } }, select: { id: true, firstName: true, lastName: true } }),
  ])
  return {
    clients: new Map(clients.map((c) => [c.id, { name: c.companyName, code: c.clientCode }])),
    employees: new Map(employees.map((e) => [e.id, [e.firstName, e.lastName].filter(Boolean).join(' ')])),
  }
}

async function caller(req: Parameters<typeof requireSession>[0], perms: readonly string[]) {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...(perms as ['workstation.notice.read']))
  return { session, scope, organisationId: await orgOfUser(prisma, session.userId) }
}

async function assertEmployee(organisationId: string, id: unknown): Promise<string | null> {
  if (id === null || id === '' || id === undefined) return null
  if (typeof id !== 'string' || !(await prisma.employee.findFirst({ where: { id, organisationId, deletedAt: null }, select: { id: true } }))) {
    throw ApiError.badRequest('No such employee.', { assigned_employee_id: 'Unknown employee.' })
  }
  return id
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)

/** Validate the editable fields; `partial` for PATCH. */
function noticeFields(b: Record<string, unknown>, partial: boolean): { data: Record<string, unknown>; errors: Record<string, string> } {
  const data: Record<string, unknown> = {}
  const errors: Record<string, string> = {}
  const req = (k: string) => !partial || b[k] !== undefined
  if (req('authority')) {
    if (!NOTICE_AUTHORITIES.includes(b.authority as never)) errors.authority = `One of ${NOTICE_AUTHORITIES.join(', ')}.`
    else data.authority = b.authority
  }
  if (req('section')) { if (!str(b.section)) errors.section = 'Required, e.g. 143(2).'; else data.section = str(b.section)!.slice(0, 60) }
  if (req('notice_date')) { if (!isIsoDate(b.notice_date)) errors.notice_date = 'YYYY-MM-DD.'; else data.noticeDate = b.notice_date }
  for (const [k, col] of [['response_due_date', 'responseDueDate'], ['hearing_date', 'hearingDate'], ['reply_filed_on', 'replyFiledOn']] as const) {
    if (b[k] === undefined) continue
    if (b[k] === null || b[k] === '') data[col] = null
    else if (!isIsoDate(b[k])) errors[k] = 'YYYY-MM-DD.'
    else data[col] = b[k]
  }
  for (const [k, col, max] of [['reference_no', 'referenceNo', 100], ['din', 'din', 60], ['assessment_year', 'assessmentYear', 20], ['reply_ack_no', 'replyAckNo', 100], ['summary', 'summary', 4000], ['outcome', 'outcome', 4000]] as const) {
    if (b[k] === undefined) continue
    data[col] = b[k] === null ? null : String(b[k]).trim().slice(0, max) || null
  }
  if (b.demand_paise !== undefined) {
    const v = b.demand_paise
    if (v === null || v === '') data.demandPaise = null
    else if ((typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) || (typeof v === 'string' && /^\d{1,15}$/.test(v))) data.demandPaise = BigInt(v)
    else errors.demand_paise = 'Whole paise, 0 or more.'
  }
  return { data, errors }
}

function sniffNoticeFile(bytes: Buffer, filename: string): { ext: string; mime: string } {
  const img = sniffImage(bytes)
  if (img) return { mime: img, ext: img === 'image/jpeg' ? 'jpg' : img.split('/')[1] }
  const doc = sniffDocument(bytes, filename)
  if (doc && ['pdf', 'docx', 'doc', 'xlsx', 'xls', 'txt'].includes(doc.ext)) return doc
  throw ApiError.unprocessable('unsupported_type', 'Upload the notice as a PDF, image, Word or Excel file whose contents match its extension.')
}

// ── routes ───────────────────────────────────────────────────────────────────

noticesRegisterRouter.get('/', handler(async (req, res) => {
  const { session, scope, organisationId } = await caller(req, READ)
  const q = req.query as Record<string, string | undefined>
  const ids = await assignedClientIds(session, scope)
  if (q.client_id && ids !== 'ALL' && !ids.includes(q.client_id)) throw ApiError.forbidden()
  const clientWhere = q.client_id ? { clientId: q.client_id } : ids === 'ALL' ? {} : { clientId: { in: ids } }
  const today = istToday()
  const [own, gst] = await Promise.all([
    prisma.clientNotice.findMany({
      where: { organisationId, ...alive, ...clientWhere, ...(q.authority && q.authority !== 'gst' ? { authority: q.authority } : {}) },
      orderBy: { createdAt: 'desc' }, take: 2000,
    }),
    q.include_gst === '0' || (q.authority && q.authority !== 'gst')
      ? Promise.resolve([] as GstNotice[])
      : prisma.gstNotice.findMany({ where: { organisationId, ...alive, ...clientWhere }, orderBy: { createdAt: 'desc' }, take: 2000 }),
  ])
  const names = await namesFor([...own, ...gst])
  let rows = [
    ...own.filter((n) => !q.authority || n.authority === q.authority).map((n) => noticeToApi(n, names, today)),
    ...gst.map((n) => gstNoticeToApi(n, names, today)),
  ]
  if (q.status) { const set = new Set(q.status.split(',')); rows = rows.filter((r) => set.has(r.status)) }
  if (q.assigned_to) rows = rows.filter((r) => r.assigned_employee_id === q.assigned_to)
  if (q.mine === '1' || q.mine === 'true') rows = rows.filter((r) => r.assigned_employee_id === (session.employeeId ?? '__none__'))
  if (q.overdue === '1' || q.overdue === 'true') rows = rows.filter((r) => r.overdue)
  if (q.due_within_days && /^\d+$/.test(q.due_within_days)) rows = rows.filter((r) => r.days_left !== null && r.days_left <= Number(q.due_within_days))
  // Reply deadline first (overdue at the top), then undated, newest first.
  rows.sort((a, b) => (a.days_left ?? Infinity) - (b.days_left ?? Infinity) || String(b.created_at).localeCompare(String(a.created_at)))
  ok(res, rows)
}))

noticesRegisterRouter.post('/', upload.single('file'), scanUploads, handler(async (req, res) => {
  const { session, scope, organisationId } = await caller(req, MANAGE)
  const b = (req.body ?? {}) as Record<string, unknown>
  const clientId = str(b.client_id)
  if (!clientId) throw ApiError.badRequest('client_id is required.', { client_id: 'Required.' })
  await assertCanSeeClient(session, scope, clientId)
  const client = await prisma.client.findFirst({ where: { id: clientId, organisationId, ...alive }, select: { id: true } })
  if (!client) throw ApiError.forbidden()
  // Multipart sends every field as text.
  if (typeof b.demand_paise === 'string' && b.demand_paise === '') delete b.demand_paise
  const { data, errors } = noticeFields(b, false)
  if (b.status !== undefined && !NOTICE_STATUSES.includes(b.status as never)) errors.status = `One of ${NOTICE_STATUSES.join(', ')}.`
  if (Object.keys(errors).length) throw ApiError.badRequest('Check the highlighted fields.', errors)
  const assigned = await assertEmployee(organisationId, b.assigned_employee_id)
  let file: { fileKey: string; fileName: string; fileMime: string } | null = null
  if (req.file) {
    const { ext, mime } = sniffNoticeFile(req.file.buffer, req.file.originalname)
    const key = `${clientId}/${crypto.randomUUID()}.${ext}`
    await storage().put(key, req.file.buffer)
    file = { fileKey: key, fileName: req.file.originalname.slice(0, 200), fileMime: mime }
  }
  const row = await prisma.clientNotice.create({
    data: {
      ...(data as Prisma.ClientNoticeUncheckedCreateInput),
      organisationId, clientId, status: (b.status as string) ?? 'received', assignedEmployeeId: assigned,
      ...(file ?? {}), createdBy: session.userId, updatedBy: session.userId,
    },
  })
  await writeAudit({ actorUserId: session.userId, action: 'client_notice.create', entityType: 'ClientNotice', entityId: row.id, after: row, req })
  ok(res, noticeToApi(row, await namesFor([row]), istToday()), 201)
}))

async function isManager(session: Session, clientId: string): Promise<boolean> {
  if (seesAllClients(session) && workstationScope(session, ...MANAGE) === 'organisation') return true
  const c = await prisma.client.findFirst({ where: { id: clientId }, select: { accountManagerId: true } })
  return Boolean(session.employeeId && c?.accountManagerId === session.employeeId)
}

// GstNotice deadline and owner. Before '/:id' so 'gst' is not taken for an id.
noticesRegisterRouter.patch('/gst/:id', handler(async (req, res) => {
  const { session, scope, organisationId } = await caller(req, MANAGE)
  const row = await prisma.gstNotice.findFirst({ where: { id: req.params.id, organisationId, ...alive } })
  if (!row) throw ApiError.notFound()
  await assertCanSeeClient(session, scope, row.clientId)
  const b = req.body ?? {}
  const data: Prisma.GstNoticeUpdateInput = { updatedBy: session.userId }
  if (b.response_due_date !== undefined) {
    if (b.response_due_date === null || b.response_due_date === '') data.responseDueDate = null
    else if (!isIsoDate(b.response_due_date)) throw ApiError.badRequest('Check the highlighted fields.', { response_due_date: 'YYYY-MM-DD.' })
    else data.responseDueDate = b.response_due_date
  }
  if (b.assigned_employee_id !== undefined) data.assignedEmployeeId = await assertEmployee(organisationId, b.assigned_employee_id)
  const after = await prisma.gstNotice.update({ where: { id: row.id }, data })
  await writeAudit({
    actorUserId: session.userId, action: 'gst_notice.deadline', entityType: 'GstNotice', entityId: row.id,
    before: { response_due_date: row.responseDueDate, assigned_employee_id: row.assignedEmployeeId },
    after: { response_due_date: after.responseDueDate, assigned_employee_id: after.assignedEmployeeId }, req,
  })
  ok(res, gstNoticeToApi(after, await namesFor([after]), istToday()))
}))

noticesRegisterRouter.patch('/:id', handler(async (req, res) => {
  const { session, scope, organisationId } = await caller(req, MANAGE)
  const row = await prisma.clientNotice.findFirst({ where: { id: req.params.id, organisationId, ...alive } })
  if (!row) throw ApiError.notFound()
  await assertCanSeeClient(session, scope, row.clientId)
  const b = (req.body ?? {}) as Record<string, unknown>
  const { data, errors } = noticeFields(b, true)
  if (b.status !== undefined) {
    if (!NOTICE_STATUSES.includes(b.status as never)) errors.status = `One of ${NOTICE_STATUSES.join(', ')}.`
    else if (!statusMoveAllowed(row.status, b.status as string, await isManager(session, row.clientId))) {
      throw ApiError.unprocessable('status_backwards', 'A notice moves forward only. Only the client\'s manager can reopen it.')
    } else data.status = b.status
  }
  if (Object.keys(errors).length) throw ApiError.badRequest('Check the highlighted fields.', errors)
  if (b.assigned_employee_id !== undefined) data.assignedEmployeeId = await assertEmployee(organisationId, b.assigned_employee_id)
  const after = await prisma.clientNotice.update({ where: { id: row.id }, data: { ...(data as Prisma.ClientNoticeUpdateInput), updatedBy: session.userId } })
  await writeAudit({ actorUserId: session.userId, action: 'client_notice.update', entityType: 'ClientNotice', entityId: row.id, before: row, after, req })
  ok(res, noticeToApi(after, await namesFor([after]), istToday()))
}))

noticesRegisterRouter.delete('/:id', handler(async (req, res) => {
  const { session, scope, organisationId } = await caller(req, MANAGE)
  const row = await prisma.clientNotice.findFirst({ where: { id: req.params.id, organisationId, ...alive } })
  if (!row) throw ApiError.notFound()
  await assertCanSeeClient(session, scope, row.clientId)
  await prisma.clientNotice.update({ where: { id: row.id }, data: { deletedAt: new Date(), updatedBy: session.userId } })
  await writeAudit({ actorUserId: session.userId, action: 'client_notice.delete', entityType: 'ClientNotice', entityId: row.id, before: row, req })
  noContent(res)
}))

noticesRegisterRouter.get('/:id/file', handler(async (req, res) => {
  const { session, scope, organisationId } = await caller(req, READ)
  const row = await prisma.clientNotice.findFirst({ where: { id: req.params.id, organisationId, ...alive } })
  if (!row) throw ApiError.notFound()
  await assertCanSeeClient(session, scope, row.clientId)
  if (!row.fileKey) throw ApiError.notFound('This notice has no file.')
  const bytes = await storage().get(row.fileKey)
  setUploadedFileHeaders(res, { mime: row.fileMime ?? 'application/octet-stream', filename: row.fileName ?? 'notice', inline: req.query.download !== '1', size: bytes.length })
  res.end(bytes)
}))
