/**
 * GST notices — upload a departmental notice/order, extract its facts, let
 * the practitioner enter grounds/facts/prayer, then draft the reply with an
 * LLM (Groq, llama-3.3-70b-versatile).
 *
 * Pipeline per upload:
 *   POST /api/notices                     file + kind + clientId
 *     → sniff PDF/image
 *     → persist bytes under uploads/gst-notices/
 *     → extract text (pdfjs text layer, OCR fallback via OCRService)
 *     → LLM extracts structured fields (JSON)
 *     → GstNotice row created
 *
 *   PATCH /api/notices/:id                corrected extracted fields + reply inputs
 *   POST  /api/notices/:id/generate       re-runs the draft prompt with saved inputs
 *   GET   /api/clients/:clientId/notices  list for a GST client (mounted below)
 *   GET   /api/notices/:id                single
 *   DELETE /api/notices/:id               soft delete
 *
 * Permission: workstation.gst.read / workstation.gst.manage — same gate as the
 * rest of the GST module.
 */
import { Router } from 'express'
import multer from 'multer'
import path from 'node:path'
import crypto from 'node:crypto'
import { prisma, alive } from '../../lib/prisma.js'
import { ApiError, handler, noContent, ok } from '../../lib/http.js'
import { requireSession } from '../../platform/auth.js'
import { writeAudit } from '../../platform/audit.js'
import { assertCanSeeClient, requireWorkstation } from '../../platform/workstation/scope.js'
import { LocalStorageAdapter } from '../tools/storage/LocalStorageAdapter.js'
import { sniffImage } from '../messages/attachments.js'
import { extractNoticeText, isSupportedNoticeMime } from './extract.js'
import { complete } from './groq.js'
import {
  NOTICE_KINDS,
  clientLetterSystem,
  clientLetterUser,
  draftSystem,
  draftUser,
  extractSystem,
  extractUser,
  type ExtractedFields,
  type NoticeKind,
  type ReplyInputs,
} from './prompts.js'
import { scanUploads } from '../../platform/virusScan.js'

const READ = ['workstation.gst.read', 'workstation.gst.manage'] as const
const MANAGE = ['workstation.gst.manage'] as const

const NOTICE_STATUSES = ['draft', 'review', 'sent', 'closed'] as const
type NoticeStatus = (typeof NOTICE_STATUSES)[number]
/** The reply has gone out: its text is frozen and the status only moves between these. */
const isReplySent = (s: string) => s === 'sent' || s === 'closed'

const MAX_UPLOAD_MB = 15
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 1 },
})

const root = process.env.GST_NOTICE_STORAGE_ROOT
  ? path.resolve(process.env.GST_NOTICE_STORAGE_ROOT)
  : path.resolve(process.cwd(), 'uploads', 'gst-notices')
const storage = new LocalStorageAdapter(root)

// ── helpers ────────────────────────────────────────────────────────────────

function assertKind(v: unknown): NoticeKind {
  if (typeof v !== 'string' || !NOTICE_KINDS.includes(v as NoticeKind)) {
    throw ApiError.badRequest(`kind must be one of: ${NOTICE_KINDS.join(', ')}`)
  }
  return v as NoticeKind
}

function assertClientId(v: unknown): string {
  if (typeof v !== 'string' || !v) throw ApiError.badRequest('clientId is required.')
  return v
}

function sniff(bytes: Buffer, declared: string): { mime: string; ext: string } {
  if (bytes.length >= 4 && bytes.subarray(0, 4).toString('latin1') === '%PDF') {
    return { mime: 'application/pdf', ext: 'pdf' }
  }
  const img = sniffImage(bytes)
  if (img === 'image/png') return { mime: 'image/png', ext: 'png' }
  if (img === 'image/jpeg') return { mime: 'image/jpeg', ext: 'jpg' }
  if (img === 'image/webp') return { mime: 'image/webp', ext: 'webp' }
  throw ApiError.unprocessable(
    'unsupported_type',
    'Only PDF, PNG, JPG, and WebP are supported. The declared type was ' + declared + '.',
  )
}

function toExtracted(json: unknown): ExtractedFields {
  const o = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>
  const str = (k: string) => (typeof o[k] === 'string' && (o[k] as string).trim() ? (o[k] as string).trim() : null)
  const num = (k: string) => {
    const v = o[k]
    if (typeof v === 'number' && Number.isFinite(v)) return v
    if (typeof v === 'string') {
      const n = Number(v.replace(/[, ₹]/g, ''))
      return Number.isFinite(n) ? n : null
    }
    return null
  }
  return {
    reference_no: str('reference_no'),
    notice_date: str('notice_date'),
    section: str('section'),
    financial_year: str('financial_year'),
    period_from: str('period_from'),
    period_to: str('period_to'),
    officer_name: str('officer_name'),
    officer_designation: str('officer_designation'),
    jurisdiction: str('jurisdiction'),
    total_demand: num('total_demand'),
  }
}

function toReplyInputs(v: unknown): ReplyInputs {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const str = (k: string) => (typeof o[k] === 'string' ? (o[k] as string) : '')
  return {
    grounds: str('grounds'),
    facts: str('facts'),
    documents_in_support: str('documents_in_support') || undefined,
    prayer: str('prayer') || undefined,
    taxpayer_name: str('taxpayer_name') || undefined,
    taxpayer_gstin: str('taxpayer_gstin') || undefined,
  }
}

type NoticeRow = Awaited<ReturnType<typeof prisma.gstNotice.findFirstOrThrow>>

function serialize(n: NoticeRow) {
  return {
    id: n.id,
    client_id: n.clientId,
    kind: n.kind,
    status: n.status,
    reference_no: n.referenceNo,
    notice_date: n.noticeDate,
    section: n.section,
    financial_year: n.financialYear,
    period_from: n.periodFrom,
    period_to: n.periodTo,
    officer_name: n.officerName,
    officer_designation: n.officerDesignation,
    jurisdiction: n.jurisdiction,
    total_demand: n.totalDemand ? Number(n.totalDemand) : null,
    uploaded_file_name: n.uploadedFileName,
    uploaded_file_size: n.uploadedFileSize,
    uploaded_mime: n.uploadedMime,
    extraction_source: n.extractionSource,
    extracted_text_length: n.extractedText?.length ?? 0,
    reply_inputs: n.replyInputs,
    client_letter: n.clientLetter,
    draft_content: n.draftContent,
    llm_provider: n.llmProvider,
    llm_model: n.llmModel,
    generated_at: n.generatedAt,
    created_at: n.createdAt,
    updated_at: n.updatedAt,
  }
}

// ── routers ────────────────────────────────────────────────────────────────

/** /api/notices — mounted on its own. */
export const noticesRouter = Router()

/** /api/clients/:clientId/notices — the per-client list used by the GST client view. */
export const clientNoticesRouter = Router()

clientNoticesRouter.get('/:clientId/notices', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...READ)
  const clientId = req.params.clientId
  await assertCanSeeClient(session, scope, clientId)
  const rows = await prisma.gstNotice.findMany({
    where: { clientId, ...alive },
    orderBy: { createdAt: 'desc' },
  })
  ok(res, rows.map(serialize))
}))

noticesRouter.post('/', upload.single('file'), scanUploads, handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...MANAGE)
  const clientId = assertClientId(req.body?.clientId)
  const kind = assertKind(req.body?.kind)
  await assertCanSeeClient(session, scope, clientId)
  const client = await prisma.client.findFirst({
    where: { id: clientId, ...alive },
    select: { id: true, organisationId: true, companyName: true, gstin: true },
  })
  if (!client) throw ApiError.notFound()
  const file = req.file
  if (!file) throw ApiError.badRequest('A file is required.')

  const { mime, ext } = sniff(file.buffer, file.mimetype)
  if (!isSupportedNoticeMime(mime)) {
    throw ApiError.unprocessable('unsupported_type', 'That file type is not supported.')
  }

  // 1. Persist the raw bytes.
  const key = `${clientId}/${crypto.randomUUID()}.${ext}`
  await storage.put(key, file.buffer)

  // 2. Extract text (pdfjs or OCR fallback).
  const extracted = await extractNoticeText(file.buffer, mime)

  // 3. Ask the LLM for structured fields, then (in parallel) draft both the
  //    client-facing letter and a first-cut department reply with placeholders.
  //    If GROQ_API_KEY is missing we still create the row with the raw text
  //    so the practitioner can enter fields and generate drafts manually; the
  //    UI shows a "configure LLM" hint in that case.
  let fields: ExtractedFields | null = null
  let llmModel: string | null = null
  let clientLetter: string | null = null
  let autoDraft: string | null = null
  if (extracted.text) {
    try {
      const r = await complete<unknown>({
        organisationId: client.organisationId,
        system: extractSystem(kind),
        user: extractUser(extracted.text),
        temperature: 0.1,
        json: true,
      })
      fields = toExtracted(r.content)
      llmModel = r.model
    } catch (err) {
      if (!(err instanceof ApiError && (err.code === 'llm_unconfigured' || err.code === 'ai_disabled'))) throw err
      // Soft-fail: let the user fill it in by hand.
    }
  }

  // Both auto-drafts run in parallel. Any single one failing is tolerated —
  // we still save the row and let the UI offer a Regenerate button.
  if (fields) {
    const emptyInputs: ReplyInputs = { grounds: '', facts: '', taxpayer_name: client.companyName }
    const [letterRes, draftRes] = await Promise.allSettled([
      complete<string>({
        organisationId: client.organisationId,
        system: clientLetterSystem(kind),
        user: clientLetterUser({ extracted: fields, taxpayer: { name: client.companyName, gstin: client.gstin ?? undefined } }),
        temperature: 0.3,
        json: false,
      }),
      complete<string>({
        organisationId: client.organisationId,
        system: draftSystem(kind),
        user: draftUser({ extracted: fields, reply: emptyInputs, noticeText: extracted.text }),
        temperature: 0.3,
        json: false,
      }),
    ])
    if (letterRes.status === 'fulfilled') clientLetter = letterRes.value.content
    if (draftRes.status === 'fulfilled') autoDraft = draftRes.value.content
  }

  const row = await prisma.gstNotice.create({
    data: {
      organisationId: client.organisationId,
      clientId,
      kind,
      referenceNo: fields?.reference_no ?? null,
      noticeDate: fields?.notice_date ?? null,
      section: fields?.section ?? null,
      financialYear: fields?.financial_year ?? null,
      periodFrom: fields?.period_from ?? null,
      periodTo: fields?.period_to ?? null,
      officerName: fields?.officer_name ?? null,
      officerDesignation: fields?.officer_designation ?? null,
      jurisdiction: fields?.jurisdiction ?? null,
      totalDemand: fields?.total_demand ?? null,
      uploadedFileName: file.originalname.slice(0, 200),
      uploadedFileKey: key,
      uploadedFileSize: file.size,
      uploadedMime: mime,
      extractedText: extracted.text || null,
      extractedJson: fields ? (fields as unknown as object) : undefined,
      extractionSource: extracted.source,
      clientLetter,
      draftContent: autoDraft,
      llmProvider: llmModel ? 'groq' : null,
      llmModel,
      generatedAt: autoDraft || clientLetter ? new Date() : null,
      status: autoDraft ? 'review' : 'draft',
      createdBy: session.userId,
      updatedBy: session.userId,
    },
  })
  await writeAudit({
    actorUserId: session.userId, action: 'gst_notice.create', entityType: 'GstNotice', entityId: row.id,
    after: { client_id: row.clientId, kind: row.kind, reference_no: row.referenceNo, status: row.status, file: row.uploadedFileName }, req,
  })
  ok(res, serialize(row), 201)
}))

noticesRouter.get('/:id', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...READ)
  const row = await prisma.gstNotice.findFirst({ where: { id: req.params.id, ...alive } })
  if (!row) throw ApiError.notFound()
  await assertCanSeeClient(session, scope, row.clientId)
  ok(res, serialize(row))
}))

noticesRouter.patch('/:id', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...MANAGE)
  const existing = await prisma.gstNotice.findFirst({ where: { id: req.params.id, ...alive } })
  if (!existing) throw ApiError.notFound()
  await assertCanSeeClient(session, scope, existing.clientId)

  const b = req.body ?? {}
  const str = (k: string) => (typeof b[k] === 'string' ? (b[k] as string).trim() || null : undefined)
  const num = (k: string) => {
    if (b[k] === null) return null
    if (typeof b[k] === 'number' && Number.isFinite(b[k])) return b[k] as number
    return undefined
  }
  const updates: Parameters<typeof prisma.gstNotice.update>[0]['data'] = {
    updatedBy: session.userId,
  }
  if ('reference_no' in b) updates.referenceNo = str('reference_no')
  if ('notice_date' in b) updates.noticeDate = str('notice_date')
  if ('section' in b) updates.section = str('section')
  if ('financial_year' in b) updates.financialYear = str('financial_year')
  if ('period_from' in b) updates.periodFrom = str('period_from')
  if ('period_to' in b) updates.periodTo = str('period_to')
  if ('officer_name' in b) updates.officerName = str('officer_name')
  if ('officer_designation' in b) updates.officerDesignation = str('officer_designation')
  if ('jurisdiction' in b) updates.jurisdiction = str('jurisdiction')
  if ('total_demand' in b) updates.totalDemand = num('total_demand') as number | null | undefined
  if ('status' in b && typeof b.status === 'string') {
    const s = b.status as string
    if (!NOTICE_STATUSES.includes(s as NoticeStatus)) throw ApiError.badRequest('Invalid status.')
    // Once the reply has gone to the department it is a record: the notice
    // moves between sent and closed, never back to draft or review.
    if (isReplySent(existing.status) && !isReplySent(s)) {
      throw ApiError.conflict('reply_sent', `This reply is already marked ${existing.status}; it cannot go back to ${s}.`)
    }
    updates.status = s
  }
  if ('reply_inputs' in b) updates.replyInputs = toReplyInputs(b.reply_inputs) as unknown as object
  if ('draft_content' in b) {
    const next = typeof b.draft_content === 'string' ? b.draft_content : null
    // Judged on the status BEFORE this request, so one PATCH cannot reopen
    // and rewrite at once.
    if (isReplySent(existing.status) && next !== existing.draftContent) {
      throw ApiError.conflict('reply_sent', 'The reply has been marked sent, so its text can no longer be edited.')
    }
    updates.draftContent = next
  }
  if ('client_letter' in b) updates.clientLetter = typeof b.client_letter === 'string' ? b.client_letter : null

  const row = await prisma.gstNotice.update({ where: { id: existing.id }, data: updates })
  const changed = Object.keys(updates).filter((k) => k !== 'updatedBy')
  await writeAudit({
    actorUserId: session.userId, action: 'gst_notice.update', entityType: 'GstNotice', entityId: row.id,
    before: Object.fromEntries(changed.map((k) => [k, (existing as Record<string, unknown>)[k]])),
    after: Object.fromEntries(changed.map((k) => [k, (row as Record<string, unknown>)[k]])), req,
  })
  if (row.status !== existing.status) {
    await writeAudit({
      actorUserId: session.userId, action: 'gst_notice.status', entityType: 'GstNotice', entityId: row.id,
      before: { status: existing.status }, after: { status: row.status }, req,
    })
  }
  ok(res, serialize(row))
}))

noticesRouter.post('/:id/generate', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...MANAGE)
  const existing = await prisma.gstNotice.findFirst({ where: { id: req.params.id, ...alive } })
  if (!existing) throw ApiError.notFound()
  await assertCanSeeClient(session, scope, existing.clientId)

  // Caller may send fresh replyInputs with the generate call OR rely on what
  // was saved by a prior PATCH. Fresh inputs win and are persisted so the next
  // "Regenerate" uses the same seed.
  if (isReplySent(existing.status)) {
    throw ApiError.conflict('reply_sent', 'The reply has been marked sent, so it cannot be regenerated.')
  }
  const freshInputs = req.body?.reply_inputs ? toReplyInputs(req.body.reply_inputs) : null
  const reply = freshInputs ?? toReplyInputs(existing.replyInputs)
  if (!reply.grounds.trim() && !reply.facts.trim()) {
    throw ApiError.badRequest('Enter the client\'s facts or grounds before generating a draft.')
  }

  const extractedFields: ExtractedFields = {
    reference_no: existing.referenceNo,
    notice_date: existing.noticeDate,
    section: existing.section,
    financial_year: existing.financialYear,
    period_from: existing.periodFrom,
    period_to: existing.periodTo,
    officer_name: existing.officerName,
    officer_designation: existing.officerDesignation,
    jurisdiction: existing.jurisdiction,
    total_demand: existing.totalDemand ? Number(existing.totalDemand) : null,
  }
  const kind = existing.kind as NoticeKind
  const r = await complete<string>({
    organisationId: existing.organisationId,
    system: draftSystem(kind),
    user: draftUser({ extracted: extractedFields, reply, noticeText: existing.extractedText ?? '' }),
    temperature: 0.3,
    json: false,
  })

  const row = await prisma.gstNotice.update({
    where: { id: existing.id },
    data: {
      draftContent: r.content,
      llmProvider: 'groq',
      llmModel: r.model,
      generatedAt: new Date(),
      replyInputs: reply as unknown as object,
      status: existing.status === 'draft' ? 'review' : existing.status,
      updatedBy: session.userId,
    },
  })
  await writeAudit({
    actorUserId: session.userId, action: 'gst_notice.draft_generated', entityType: 'GstNotice', entityId: row.id,
    before: { status: existing.status }, after: { status: row.status, llm_model: row.llmModel }, req,
  })
  ok(res, serialize(row))
}))

noticesRouter.post('/:id/client-letter', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...MANAGE)
  const existing = await prisma.gstNotice.findFirst({ where: { id: req.params.id, ...alive } })
  if (!existing) throw ApiError.notFound()
  await assertCanSeeClient(session, scope, existing.clientId)
  const client = await prisma.client.findFirst({
    where: { id: existing.clientId, ...alive },
    select: { companyName: true, gstin: true },
  })
  if (!client) throw ApiError.notFound()
  const extractedFields: ExtractedFields = {
    reference_no: existing.referenceNo,
    notice_date: existing.noticeDate,
    section: existing.section,
    financial_year: existing.financialYear,
    period_from: existing.periodFrom,
    period_to: existing.periodTo,
    officer_name: existing.officerName,
    officer_designation: existing.officerDesignation,
    jurisdiction: existing.jurisdiction,
    total_demand: existing.totalDemand ? Number(existing.totalDemand) : null,
  }
  const kind = existing.kind as NoticeKind
  const r = await complete<string>({
    organisationId: existing.organisationId,
    system: clientLetterSystem(kind),
    user: clientLetterUser({ extracted: extractedFields, taxpayer: { name: client.companyName, gstin: client.gstin ?? undefined } }),
    temperature: 0.3,
    json: false,
  })
  const row = await prisma.gstNotice.update({
    where: { id: existing.id },
    data: {
      clientLetter: r.content,
      llmProvider: 'groq',
      llmModel: r.model,
      updatedBy: session.userId,
    },
  })
  ok(res, serialize(row))
}))

noticesRouter.delete('/:id', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...MANAGE)
  const existing = await prisma.gstNotice.findFirst({ where: { id: req.params.id, ...alive } })
  if (!existing) throw ApiError.notFound()
  await assertCanSeeClient(session, scope, existing.clientId)
  await prisma.gstNotice.update({
    where: { id: existing.id },
    data: { deletedAt: new Date(), updatedBy: session.userId },
  })
  await writeAudit({
    actorUserId: session.userId, action: 'gst_notice.delete', entityType: 'GstNotice', entityId: existing.id,
    before: { client_id: existing.clientId, kind: existing.kind, reference_no: existing.referenceNo, status: existing.status }, req,
  })
  noContent(res)
}))
