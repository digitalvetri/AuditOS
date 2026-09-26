/**
 * TDS SERVICE — the records behind Workstation → Services → TDS.
 *
 *   GET    /api/tds/:clientId?fy=2026-27&tan=…  client TANs + profile + that TAN's records (FY rows, registration, notices)
 *   PUT    /api/tds/:clientId/profile           return forms, deductor type, Form 49B details, additional TANs
 *   POST   /api/tds/:clientId/records           record a registration / challan / return / correction / certificate / notice(-check)
 *   PATCH  /api/tds/:clientId/records/:id
 *   DELETE /api/tds/:clientId/records/:id       soft delete
 *   POST   /api/tds/:clientId/records/:id/file  attach receipt / ack / certificate (multipart `file`) — new version on replace
 *   GET    /api/tds/:clientId/records/:id/file  download the current version
 *
 * The firm files on the government portals; this module only records what
 * was done and derives what is due. Every :clientId is checked against the
 * caller's client scope, and every record query is keyed on that clientId.
 * A client can deduct under several TANs (branches). Client.tan is the
 * primary; others sit on TdsProfile.additionalTans. Every record belongs to
 * one TAN (TdsFiling.tan, null = primary) and every read / duplicate check
 * is per TAN. A registration row carrying an allotted TAN fills Client.tan
 * when empty, otherwise adds it as an additional TAN.
 *
 * Files are stored in the client's document store (ClientDocument, category
 * 'tds') so they also show under the client's documents.
 */
import path from 'node:path'
import { Router } from 'express'
import multer from 'multer'
import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { ApiError, handler, ok } from '../../lib/http.js'
import { requireSession } from '../../platform/auth.js'
import { writeAudit } from '../../platform/audit.js'
import { requireWorkstation, assignedClientIds } from '../../platform/workstation/scope.js'
import { body, FieldErrors } from '../workstation/validate.js'
import { LocalStorageAdapter } from '../tools/storage/LocalStorageAdapter.js'

/** Resolved per call so TDS_STORAGE_ROOT can be set after import (tests, ops). */
const tdsStorage = () => new LocalStorageAdapter(process.env.TDS_STORAGE_ROOT
  ? path.resolve(process.env.TDS_STORAGE_ROOT)
  : path.resolve(process.cwd(), 'uploads', 'tds-documents'))
const MAX_UPLOAD_MB = 25
const MIME_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  zip: 'application/zip', txt: 'text/plain', csi: 'text/plain', fvu: 'text/plain',
}
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 1 } })
const TDS_DOC_CATEGORY = 'tds'

const READ = ['workstation.service.read', 'workstation.service.manage'] as const
const MANAGE = ['workstation.service.manage'] as const

const KINDS = ['registration', 'challan', 'return', 'correction', 'certificate', 'notice_check', 'notice'] as const
type Kind = (typeof KINDS)[number]
const STATUSES = ['pending', 'in_progress', 'done'] as const
const RETURN_FORMS = ['24Q', '26Q', '27Q', '27EQ'] as const
const CERT_FORMS = ['16', '16A', '27D'] as const
const DEDUCTOR_TYPES = ['company', 'firm', 'individual', 'government', 'trust', 'aop', 'other'] as const
const QUARTERS = ['Q1', 'Q2', 'Q3', 'Q4'] as const

const TAN_RE = /^[A-Z]{4}[0-9]{5}[A-Z]$/
const FY_RE = /^\d{4}-\d{2}$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/

export const tdsServiceRouter = Router()

type Session = ReturnType<typeof requireSession>
async function assertClient(session: Session, scope: 'self' | 'department' | 'organisation', clientId: string) {
  const client = await prisma.client.findFirst({
    where: { id: clientId, deletedAt: null },
    select: { id: true, companyName: true, tan: true, organisationId: true, tdsProfile: { select: { additionalTans: true } } },
  })
  if (!client) throw ApiError.notFound('Client not found.')
  const ids = await assignedClientIds(session, scope)
  if (ids !== 'ALL' && !ids.includes(client.id)) throw ApiError.notFound('Client not found.')
  const additional = splitTans(client.tdsProfile?.additionalTans)
  return { ...client, tans: [...(client.tan ? [client.tan] : []), ...additional.filter((t) => t !== client.tan)] }
}
type ScopedClient = Awaited<ReturnType<typeof assertClient>>

const splitTans = (csv: string | null | undefined) => (csv ?? '').split(',').map((t) => t.trim()).filter(Boolean)

/** Which TAN a request is about: an explicit one the client has, else the primary. */
function resolveTan(client: ScopedClient, requested: unknown): string | null {
  if (requested === undefined || requested === null || requested === '') return client.tan
  if (typeof requested !== 'string' || !client.tans.includes(requested)) {
    throw ApiError.badRequest('That TAN is not registered for this client.', { tan: 'Unknown TAN for this client.' })
  }
  return requested
}
/** Records of one TAN. Rows with tan = null belong to the primary. */
function tanWhere(client: ScopedClient, tan: string | null): Prisma.TdsFilingWhereInput {
  return tan && tan !== client.tan ? { tan } : { OR: [{ tan: null }, ...(client.tan ? [{ tan: client.tan }] : [])] }
}
/** Stored value: null for the primary TAN so a later change of Client.tan carries its history. */
const storedTan = (client: ScopedClient, tan: string | null) => (tan && tan !== client.tan ? tan : null)

type Row = Awaited<ReturnType<typeof prisma.tdsFiling.findFirstOrThrow>>
type DocInfo = { version: number; original_name: string | null; size_bytes: number; uploaded_at: Date } | null
function toApi(r: Row, doc: DocInfo = null) {
  const n = (d: Prisma.Decimal | null) => (d === null ? null : Number(d))
  return {
    id: r.id, tan: r.tan, kind: r.kind, fy: r.fy, period: r.period, form_type: r.formType, status: r.status,
    document: doc,
    reference: r.reference, bsr_code: r.bsrCode, event_date: r.eventDate,
    amount_tax: n(r.amountTax), amount_interest: n(r.amountInterest), amount_fee: n(r.amountFee),
    filed_by: r.filedBy, notes: r.notes, original_id: r.originalId,
    created_at: r.createdAt, updated_at: r.updatedAt,
  }
}

/** Optional free-text profile fields: api key → [column, max length, format]. */
const PROFILE_TEXT: Record<string, [string, number, RegExp?, string?]> = {
  responsible_person: ['responsiblePerson', 150],
  rp_designation: ['rpDesignation', 100],
  rp_pan: ['rpPan', 10, /^[A-Z]{5}[0-9]{4}[A-Z]$/, 'PAN must be 5 letters, 4 digits, 1 letter.'],
  rp_email: ['rpEmail', 150, /^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Enter a valid email.'],
  rp_mobile: ['rpMobile', 10, /^[6-9][0-9]{9}$/, 'Mobile must be 10 digits.'],
  addr_flat: ['addrFlat', 100],
  addr_building: ['addrBuilding', 100],
  addr_road: ['addrRoad', 100],
  addr_area: ['addrArea', 100],
  addr_city: ['addrCity', 100],
  addr_pin: ['addrPin', 6, /^[1-9][0-9]{5}$/, 'Pin code must be 6 digits.'],
  ao_code: ['aoCode', 40],
}

/** Current file version per record, for the rows being returned. */
async function docsFor(rows: Row[]): Promise<Map<string, DocInfo>> {
  const ids = rows.map((r) => r.documentId).filter((x): x is string => !!x)
  if (!ids.length) return new Map()
  const docs = await prisma.clientDocument.findMany({
    where: { id: { in: ids }, deletedAt: null },
    include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
  })
  return new Map(docs.map((d) => {
    const v = d.versions[0]
    return [d.id, v ? { version: v.version, original_name: v.originalName, size_bytes: v.sizeBytes, uploaded_at: v.uploadedAt } : null]
  }))
}

function profileApi(p: ({ returnForms: string; deductorType: string | null } & Record<string, unknown>) | null) {
  return {
    return_forms: (p?.returnForms ?? '26Q').split(',').filter(Boolean),
    deductor_type: p?.deductorType ?? null,
    additional_tans: splitTans(p?.additionalTans as string | null | undefined),
    ...Object.fromEntries(Object.entries(PROFILE_TEXT).map(([k, [col]]) => [k, (p?.[col] as string | null | undefined) ?? null])),
  }
}

tdsServiceRouter.get('/:clientId', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...READ)
  const client = await assertClient(session, scope, req.params.clientId)
  const fy = typeof req.query.fy === 'string' && FY_RE.test(req.query.fy) ? req.query.fy : null
  const tan = resolveTan(client, req.query.tan)
  const byTan = tanWhere(client, tan)
  const [profile, rows] = await Promise.all([
    prisma.tdsProfile.findUnique({ where: { clientId: client.id } }),
    prisma.tdsFiling.findMany({
      where: {
        clientId: client.id, deletedAt: null, AND: [byTan],
        // Registration + notices are not FY-bound; everything else is filtered to the FY.
        OR: [{ kind: { in: ['registration', 'notice', 'notice_check'] } }, ...(fy ? [{ fy }] : [{}])],
      },
      orderBy: [{ eventDate: 'desc' }, { createdAt: 'desc' }],
    }),
  ])
  // Has any return ever been filed (any FY)? Gates TRACES / Form 16 / corrections.
  const anyFiledReturn = await prisma.tdsFiling.count({
    where: { clientId: client.id, kind: 'return', status: 'done', deletedAt: null, AND: [byTan] },
  })
  const docs = await docsFor(rows)
  ok(res, {
    client: { id: client.id, company_name: client.companyName, tan: client.tan, tans: client.tans },
    active_tan: tan,
    profile: profileApi(profile),
    records: rows.map((r) => toApi(r, r.documentId ? docs.get(r.documentId) ?? null : null)),
    any_filed_return: anyFiledReturn > 0,
  })
}))

tdsServiceRouter.put('/:clientId/profile', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...MANAGE)
  const client = await assertClient(session, scope, req.params.clientId)
  const b = body(req)
  const e = new FieldErrors()
  let forms: string[] | undefined
  if (b.return_forms !== undefined) {
    if (!Array.isArray(b.return_forms) || b.return_forms.some((f) => !(RETURN_FORMS as readonly unknown[]).includes(f))) {
      e.add('return_forms', `Each must be one of ${RETURN_FORMS.join(', ')}.`)
    } else if (b.return_forms.length === 0) e.add('return_forms', 'Pick at least one return form.')
    else forms = RETURN_FORMS.filter((f) => (b.return_forms as string[]).includes(f))
  }
  const deductorType = b.deductor_type === undefined ? undefined
    : b.deductor_type === null || b.deductor_type === '' ? null
    : (DEDUCTOR_TYPES as readonly unknown[]).includes(b.deductor_type) ? (b.deductor_type as string)
    : (e.add('deductor_type', `Must be one of ${DEDUCTOR_TYPES.join(', ')}.`), undefined)
  let additionalTans: string | null | undefined
  if (b.additional_tans !== undefined) {
    const list = Array.isArray(b.additional_tans) ? b.additional_tans.map((t) => (typeof t === 'string' ? t.trim().toUpperCase() : '')) : null
    if (!list || list.some((t) => !TAN_RE.test(t))) e.add('additional_tans', 'Each TAN must be 4 letters, 5 digits, 1 letter.')
    else {
      const uniq = [...new Set(list)].filter((t) => t !== client.tan)
      const inUse = await prisma.tdsFiling.findMany({
        where: { clientId: client.id, deletedAt: null, tan: { notIn: uniq.length ? uniq : ['-'] }, NOT: { tan: null } },
        select: { tan: true }, distinct: ['tan'],
      })
      if (inUse.length) e.add('additional_tans', `Records exist under ${inUse.map((x) => x.tan).join(', ')} — delete those before removing the TAN.`)
      additionalTans = uniq.join(',') || null
    }
  }
  const text: Record<string, string | null> = {}
  for (const [key, [col, max, re, msg]] of Object.entries(PROFILE_TEXT)) {
    const v = b[key]
    if (v === undefined) continue
    if (v === null || v === '') { text[col] = null; continue }
    if (typeof v !== 'string') { e.add(key, 'Must be text.'); continue }
    const t = key === 'rp_pan' ? v.trim().toUpperCase() : v.trim()
    if (t.length > max) e.add(key, `Max ${max} characters.`)
    else if (re && !re.test(t)) e.add(key, msg!)
    else text[col] = t || null
  }
  e.throwIfAny()

  const data = {
    ...(forms ? { returnForms: forms.join(',') } : {}),
    ...(deductorType !== undefined ? { deductorType } : {}),
    ...text,
    ...(additionalTans !== undefined ? { additionalTans } : {}),
    updatedBy: session.userId,
  }
  const saved = await prisma.tdsProfile.upsert({
    where: { clientId: client.id },
    update: data,
    create: { clientId: client.id, ...data, createdBy: session.userId },
  })
  await writeAudit({
    actorUserId: session.userId, action: 'tds_profile.save', entityType: 'tds_profile', entityId: saved.id,
    after: { clientId: client.id, ...data }, req,
  })
  ok(res, { profile: profileApi(saved) })
}))

/** Validate a record body. `partial` = PATCH (only supplied keys). */
function parseRecord(b: Record<string, unknown>, partial: boolean, kindForPatch?: string) {
  const e = new FieldErrors()
  const kind = (partial ? kindForPatch : b.kind) as Kind
  if (!partial && !(KINDS as readonly unknown[]).includes(b.kind)) {
    e.add('kind', `Must be one of ${KINDS.join(', ')}.`)
    e.throwIfAny()
  }
  const has = (k: string) => b[k] !== undefined
  const str = (k: string, max: number, re?: RegExp, msg?: string): string | null | undefined => {
    if (!has(k)) return undefined
    const v = b[k]
    if (v === null || v === '') return null
    if (typeof v !== 'string') { e.add(k, 'Must be a string.'); return undefined }
    const t = v.trim()
    if (t.length > max) { e.add(k, `Max ${max} characters.`); return undefined }
    if (re && !re.test(t)) { e.add(k, msg ?? 'Invalid format.'); return undefined }
    return t
  }
  const money = (k: string): Prisma.Decimal | null | undefined => {
    if (!has(k)) return undefined
    const v = b[k]
    if (v === null || v === '') return null
    const num = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
    if (!Number.isFinite(num) || num < 0 || num > 1e12) { e.add(k, 'Must be a non-negative amount.'); return undefined }
    return new Prisma.Decimal(num.toFixed(2))
  }

  const status = has('status')
    ? ((STATUSES as readonly unknown[]).includes(b.status) ? (b.status as string) : (e.add('status', `Must be one of ${STATUSES.join(', ')}.`), undefined))
    : undefined

  const fy = str('fy', 7, FY_RE, 'FY must look like 2026-27.')
  let period: string | null | undefined
  let formType: string | null | undefined
  let reference: string | null | undefined
  switch (kind) {
    case 'registration':
      reference = str('reference', 14, /^\d{14}$/, 'Acknowledgement must be exactly 14 digits.')
      break
    case 'challan':
      period = str('period', 7, MONTH_RE, 'Deduction month must look like 2026-08.')
      reference = str('reference', 10, /^\d{1,10}$/, 'Challan serial is numeric (up to 10 digits).')
      break
    case 'return':
    case 'correction':
      period = str('period', 2, /^Q[1-4]$/, 'Quarter must be Q1–Q4.')
      formType = str('form_type', 4)
      if (formType && !(RETURN_FORMS as readonly string[]).includes(formType)) e.add('form_type', `Must be one of ${RETURN_FORMS.join(', ')}.`)
      reference = str('reference', 15, /^\d{15}$/, 'Token number must be exactly 15 digits.')
      break
    case 'certificate':
      period = str('period', 2, /^(Q[1-4]|FY)$/, 'Period must be Q1–Q4, or FY for Form 16.')
      formType = str('form_type', 3)
      if (formType && !(CERT_FORMS as readonly string[]).includes(formType)) e.add('form_type', `Must be one of ${CERT_FORMS.join(', ')}.`)
      break
    case 'notice':
      reference = str('reference', 60)
      break
  }

  const data = {
    fy, period, formType, reference, status,
    bsrCode: kind === 'challan' ? str('bsr_code', 7, /^\d{7}$/, 'BSR code must be exactly 7 digits.') : undefined,
    eventDate: str('event_date', 10, DATE_RE, 'Date must be YYYY-MM-DD.'),
    amountTax: money('amount_tax'),
    amountInterest: money('amount_interest'),
    amountFee: money('amount_fee'),
    filedBy: str('filed_by', 120),
    notes: str('notes', 2000),
    originalId: kind === 'correction' ? str('original_id', 64) : undefined,
  }
  const tan = kind === 'registration' ? str('tan', 10, TAN_RE, 'TAN must be 4 letters, 5 digits, 1 letter — e.g. CHEK09876B.') : undefined

  // Required fields on create — the "evidence capture is a gate" rule.
  if (!partial) {
    const need = (k: string, v: unknown) => { if (v === undefined || v === null) e.add(k, 'Required.') }
    // A correction takes its FY / quarter / form from the original return.
    if (['challan', 'return', 'certificate'].includes(kind)) { need('fy', data.fy); need('period', period) }
    if (['return', 'certificate'].includes(kind)) need('form_type', formType)
    if (kind === 'notice_check') need('event_date', data.eventDate)
    const done = (status ?? 'done') === 'done'
    if (done) {
      if (kind === 'registration') { need('reference', reference); need('event_date', data.eventDate) }
      if (kind === 'challan') { need('reference', reference); need('bsr_code', data.bsrCode); need('event_date', data.eventDate); need('amount_tax', data.amountTax) }
      if (kind === 'return' || kind === 'correction') { need('reference', reference); need('event_date', data.eventDate) }
      if (kind === 'certificate') need('event_date', data.eventDate)
    }
    if (kind === 'correction') need('original_id', data.originalId)
  }
  e.throwIfAny()
  return { data: Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)), tan }
}

/** An allotted TAN from a registration row: fills Client.tan if empty, else joins the additional TANs. */
async function syncTan(client: ScopedClient, tan: string | null | undefined, userId: string) {
  if (!tan || client.tans.includes(tan)) return
  if (!client.tan) {
    await prisma.client.update({ where: { id: client.id }, data: { tan, updatedBy: userId } })
    return
  }
  const additional = [...client.tans.filter((t) => t !== client.tan), tan].join(',')
  await prisma.tdsProfile.upsert({
    where: { clientId: client.id },
    update: { additionalTans: additional, updatedBy: userId },
    create: { clientId: client.id, additionalTans: additional, createdBy: userId, updatedBy: userId },
  })
}

/** One return / challan / certificate per (period, form) per FY — duplicates are a data error, not history. */
async function assertNoDuplicate(client: ScopedClient, tan: string | null, kind: string, d: Record<string, unknown>, exceptId?: string) {
  if (!['challan', 'return', 'certificate'].includes(kind)) return
  const clash = await prisma.tdsFiling.findFirst({
    where: {
      clientId: client.id, kind, deletedAt: null, fy: d.fy as string, period: d.period as string, AND: [tanWhere(client, tan)],
      formType: (d.formType as string | undefined) ?? null,
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
  })
  if (clash) throw ApiError.conflict('duplicate', 'A record for this period already exists — edit it instead.')
}

tdsServiceRouter.post('/:clientId/records', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...MANAGE)
  const client = await assertClient(session, scope, req.params.clientId)
  const b = body(req)
  const { data, tan } = parseRecord(b, false)
  const kind = b.kind as Kind
  // Registration can be for a not-yet-allotted TAN, so it may be filed with no TAN in scope.
  const forTan = kind === 'registration' && !client.tan ? null : resolveTan(client, b.for_tan)
  if (kind !== 'registration' && !forTan) throw ApiError.badRequest('Record the TAN under TDS Registration first.')
  if (kind === 'correction') {
    const orig = await prisma.tdsFiling.findFirst({
      where: { id: data.originalId as string, clientId: client.id, kind: 'return', status: 'done', deletedAt: null, AND: [tanWhere(client, forTan)] },
    })
    if (!orig) throw ApiError.badRequest('A correction must reference a filed return of this client.')
    Object.assign(data, { fy: orig.fy, period: orig.period, formType: orig.formType })
  }
  await assertNoDuplicate(client, forTan, kind, data)
  const saved = await prisma.tdsFiling.create({
    data: { clientId: client.id, tan: storedTan(client, forTan), kind, status: 'done', ...data, createdBy: session.userId, updatedBy: session.userId } as Prisma.TdsFilingUncheckedCreateInput,
  })
  await syncTan(client, tan, session.userId)
  await writeAudit({
    actorUserId: session.userId, action: `tds_${kind}.create`, entityType: 'tds_filing', entityId: saved.id,
    after: { clientId: client.id, companyName: client.companyName, forTan, ...data, ...(tan ? { tan } : {}) }, req,
  })
  ok(res, { record: toApi(saved) }, 201)
}))

tdsServiceRouter.patch('/:clientId/records/:id', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...MANAGE)
  const client = await assertClient(session, scope, req.params.clientId)
  const row = await prisma.tdsFiling.findFirst({ where: { id: req.params.id, clientId: client.id, deletedAt: null } })
  if (!row) throw ApiError.notFound('Record not found.')
  const { data, tan } = parseRecord(body(req), true, row.kind)
  delete data.originalId // a correction's original is fixed at creation
  await assertNoDuplicate(client, row.tan ?? client.tan, row.kind, {
    fy: data.fy ?? row.fy, period: data.period ?? row.period, formType: data.formType ?? row.formType,
  }, row.id)
  const saved = await prisma.tdsFiling.update({ where: { id: row.id }, data: { ...data, updatedBy: session.userId } })
  await syncTan(client, tan, session.userId)
  await writeAudit({
    actorUserId: session.userId, action: `tds_${row.kind}.update`, entityType: 'tds_filing', entityId: row.id,
    before: toApi(row), after: { ...data, ...(tan ? { tan } : {}) }, req,
  })
  const docs = await docsFor([saved])
  ok(res, { record: toApi(saved, saved.documentId ? docs.get(saved.documentId) ?? null : null) })
}))

tdsServiceRouter.delete('/:clientId/records/:id', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...MANAGE)
  const client = await assertClient(session, scope, req.params.clientId)
  const row = await prisma.tdsFiling.findFirst({ where: { id: req.params.id, clientId: client.id, deletedAt: null } })
  if (!row) throw ApiError.notFound('Record not found.')
  if (row.kind === 'return') {
    const corrections = await prisma.tdsFiling.count({ where: { originalId: row.id, deletedAt: null } })
    if (corrections) throw ApiError.conflict('has_corrections', 'This return has corrections recorded against it — delete those first.')
  }
  await prisma.tdsFiling.update({ where: { id: row.id }, data: { deletedAt: new Date(), updatedBy: session.userId } })
  await writeAudit({
    actorUserId: session.userId, action: `tds_${row.kind}.delete`, entityType: 'tds_filing', entityId: row.id,
    before: toApi(row), req,
  })
  ok(res, { deleted: true })
}))

async function tdsCategoryId(organisationId: string): Promise<string> {
  const cat = await prisma.documentCategory.upsert({
    where: { code: TDS_DOC_CATEGORY },
    update: {},
    create: { organisationId, code: TDS_DOC_CATEGORY, name: 'TDS', description: 'Challans, return receipts, certificates and notices recorded under TDS.' },
  })
  return cat.id
}

const KIND_LABEL: Record<string, string> = {
  registration: 'Form 49B acknowledgement', challan: 'Challan receipt', return: 'TDS return receipt',
  correction: 'TDS correction receipt', certificate: 'TDS certificate', notice: 'TDS notice', notice_check: 'TRACES check',
}

tdsServiceRouter.post('/:clientId/records/:id/file',
  (req, res, next) => {
    upload.single('file')(req, res, (err: unknown) => {
      if (!err) return next()
      if ((err as { code?: string }).code === 'LIMIT_FILE_SIZE') {
        return next(ApiError.unprocessable('too_large', `File is larger than the ${MAX_UPLOAD_MB} MB limit.`))
      }
      next(ApiError.badRequest('Upload could not be read.'))
    })
  },
  handler(async (req, res) => {
    const session = requireSession(req)
    const scope = requireWorkstation(session, ...MANAGE)
    const client = await assertClient(session, scope, req.params.clientId)
    const row = await prisma.tdsFiling.findFirst({ where: { id: req.params.id, clientId: client.id, deletedAt: null } })
    if (!row) throw ApiError.notFound('Record not found.')
    const file = req.file
    if (!file) throw ApiError.badRequest('Choose a file to upload.', { file: 'Choose a file to upload.' })
    const ext = (file.originalname.split('.').pop() ?? '').toLowerCase()
    if (!MIME_BY_EXT[ext]) {
      throw ApiError.unprocessable('file_type', `Allowed types: ${Object.keys(MIME_BY_EXT).join(', ').toUpperCase()}.`)
    }

    const existing = row.documentId
      ? await prisma.clientDocument.findFirst({ where: { id: row.documentId, clientId: client.id, deletedAt: null } })
      : null
    const period = [row.formType, row.period, row.fy].filter(Boolean).join(' · ')
    const doc = existing ?? await prisma.clientDocument.create({
      data: {
        clientId: client.id, categoryId: await tdsCategoryId(client.organisationId),
        name: `${KIND_LABEL[row.kind] ?? 'TDS document'}${period ? ` — ${period}` : ''}${row.tan ? ` (${row.tan})` : ''}`,
        financialYear: row.fy, status: 'uploaded', createdBy: session.userId,
      },
    })
    const version = doc.currentVersion + 1
    const key = `${client.id}/${doc.id}/v${version}-${file.originalname.replace(/[^A-Za-z0-9._-]/g, '_').slice(-120)}`
    await tdsStorage().put(key, file.buffer)
    const prev = await prisma.clientDocumentVersion.findFirst({ where: { documentId: doc.id, version: doc.currentVersion } })
    await prisma.$transaction([
      prisma.clientDocumentVersion.create({
        data: {
          documentId: doc.id, version, fileKey: key, uploadedBy: session.employeeId ?? session.userId, sizeBytes: file.size,
          previousVersionId: prev?.id ?? null, originalName: file.originalname, mimeType: MIME_BY_EXT[ext],
          reviewStatus: 'uploaded', documentDate: row.eventDate,
        },
      }),
      prisma.clientDocument.update({ where: { id: doc.id }, data: { currentVersion: version, status: 'uploaded', updatedBy: session.userId } }),
      prisma.tdsFiling.update({ where: { id: row.id }, data: { documentId: doc.id, updatedBy: session.userId } }),
    ])
    await writeAudit({
      actorUserId: session.userId, action: `tds_${row.kind}.file`, entityType: 'tds_filing', entityId: row.id,
      after: { clientId: client.id, documentId: doc.id, version, originalName: file.originalname, sizeBytes: file.size }, req,
    })
    ok(res, { document: { version, original_name: file.originalname, size_bytes: file.size, uploaded_at: new Date() } }, 201)
  }))

tdsServiceRouter.get('/:clientId/records/:id/file', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...READ)
  const client = await assertClient(session, scope, req.params.clientId)
  const row = await prisma.tdsFiling.findFirst({ where: { id: req.params.id, clientId: client.id, deletedAt: null } })
  if (!row?.documentId) throw ApiError.notFound('No file attached.')
  const v = await prisma.clientDocumentVersion.findFirst({
    where: { documentId: row.documentId, document: { clientId: client.id, deletedAt: null } },
    orderBy: { version: 'desc' },
  })
  if (!v?.mimeType) throw ApiError.notFound('No file attached.')
  const bytes = await tdsStorage().get(v.fileKey)
  const nameOut = v.originalName ?? `tds-document-v${v.version}`
  res.setHeader('Content-Type', v.mimeType)
  res.setHeader('Content-Length', String(bytes.length))
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Cache-Control', 'private, no-store')
  res.setHeader('Content-Disposition', `${req.query.inline === '1' ? 'inline' : 'attachment'}; filename="${nameOut.replace(/[^\x20-\x7e]|"/g, '_')}"; filename*=UTF-8''${encodeURIComponent(nameOut)}`)
  res.send(bytes)
}))
