import crypto from 'node:crypto'
import type { Router } from 'express'
import multer from 'multer'
import { z } from 'zod'
import type { AuditEngagement } from '@prisma/client'
import { prisma, alive } from '../../lib/prisma.js'
import { ApiError, handler, ok } from '../../lib/http.js'
import { setUploadedFileHeaders } from '../../lib/fileResponse.js'
import { CLIENT_DOC_MAX_MB, CLIENT_DOC_MIME, clientDocContentMatches } from '../workstation/client-folders.routes.js'
import { auditStorage, assertEmployee, employeeNames, guardWrite, isManager, isSigningPartner, me } from './service.js'
import * as S from './serialize.js'
import { audit, fileAccess, isUniqueViolation, parse } from './common.js'

/**
 * Working papers, their evidence files, and review notes.
 *
 * Maker-checker is absolute here: the preparer of a working paper can never
 * review it, and it cannot be reviewed while any of its notes is uncleared.
 */

const SECTIONS = ['planning', 'risk', 'execution', 'completion', 'reporting', 'permanent'] as const

async function loadPaper(e: AuditEngagement, wpId: string) {
  const wp = await prisma.auditWorkingPaper.findFirst({ where: { id: wpId, engagementId: e.id, ...alive }, include: { files: { where: alive, orderBy: { uploadedAt: 'asc' } } } })
  if (!wp) throw ApiError.notFound('Working paper not found.')
  return wp
}

async function paperOut(wpId: string) {
  const wp = await prisma.auditWorkingPaper.findUniqueOrThrow({ where: { id: wpId }, include: { files: { where: alive, orderBy: { uploadedAt: 'asc' } } } })
  const open = await prisma.auditReviewNote.count({ where: { workingPaperId: wpId, ...alive, status: { not: 'cleared' } } })
  const names = await employeeNames([wp.assignedTo, wp.preparedBy, wp.reviewedBy, ...wp.files.map((f) => f.uploadedBy)])
  return S.workingPaper(wp, names, open)
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: CLIENT_DOC_MAX_MB * 1024 * 1024, files: 1 } })

export function registerPapers(r: Router) {
  // ── Working papers ──
  r.get('/:id/working-papers', handler(async (req, res) => {
    const { e } = await fileAccess(req, 'read')
    const rows = await prisma.auditWorkingPaper.findMany({
      where: { engagementId: e.id, ...alive },
      include: { files: { where: alive, orderBy: { uploadedAt: 'asc' } } },
    })
    const notes = await prisma.auditReviewNote.groupBy({
      by: ['workingPaperId'], where: { engagementId: e.id, ...alive, status: { not: 'cleared' }, workingPaperId: { not: null } }, _count: true,
    })
    const open = new Map(notes.map((n) => [n.workingPaperId, n._count]))
    const names = await employeeNames(rows.flatMap((w) => [w.assignedTo, w.preparedBy, w.reviewedBy, ...w.files.map((f) => f.uploadedBy)]))
    // Index order: by section (planning → reporting), then ref with A-2 before A-10.
    rows.sort((a, b) => (SECTIONS.indexOf(a.section as never) - SECTIONS.indexOf(b.section as never)) || a.ref.localeCompare(b.ref, 'en', { numeric: true }))
    ok(res, S.list(rows.map((w) => S.workingPaper(w, names, open.get(w.id) ?? 0))))
  }))

  const wpBody = {
    ref: z.string().trim().min(1, 'Give the index reference.').max(20).regex(/^[A-Za-z0-9.\-/]+$/, 'Letters, digits, dot, hyphen or slash.'),
    section: z.enum(SECTIONS),
    area: z.string().trim().max(200).nullish(),
    title: z.string().trim().min(1, 'Give the working paper a title.').max(300),
    objective: z.string().max(10000).nullish(),
    procedure: z.string().max(20000).nullish(),
    conclusion: z.string().max(20000).nullish(),
    assigned_to: z.string().nullish(),
  }

  r.post('/:id/working-papers', handler(async (req, res) => {
    const { session, e } = await fileAccess(req, 'manage')
    const mode = guardWrite(e, session, req.body, true)
    const b = parse(z.object(wpBody), req.body, 'Invalid working paper.')
    await assertEmployee(b.assigned_to, 'assigned_to')
    const wp = await prisma.auditWorkingPaper.create({
      data: {
        engagementId: e.id, ref: b.ref, section: b.section, area: b.area ?? null, title: b.title,
        objective: b.objective ?? null, procedure: b.procedure ?? null, conclusion: b.conclusion ?? null,
        assignedTo: b.assigned_to ?? null, isAddendum: mode.addendum, addendumReason: mode.reason,
        createdBy: session.userId, updatedBy: session.userId,
      },
    }).catch((err) => {
      if (isUniqueViolation(err)) throw ApiError.conflict('ref_exists', `Working paper ${b.ref} already exists on this file.`)
      throw err
    })
    await audit(req, session, mode.addendum ? 'addendum_working_paper' : 'working_paper_create', 'AuditWorkingPaper', wp.id, undefined,
      { engagement_id: e.id, ref: wp.ref, title: wp.title, ...(mode.addendum ? { addendum_reason: mode.reason } : {}) })
    ok(res, await paperOut(wp.id), 201)
  }))

  r.patch('/:id/working-papers/:wpId', handler(async (req, res) => {
    const { session, e } = await fileAccess(req, 'manage')
    guardWrite(e, session, req.body)
    const wp = await loadPaper(e, req.params.wpId)
    if (wp.status === 'reviewed') throw ApiError.unprocessable('wp_reviewed', 'This working paper is reviewed. Reopen it to make changes.')
    const { ref: _ref, ...rest } = wpBody
    const b = parse(z.object(rest).partial(), req.body, 'Invalid working paper.')
    if (b.assigned_to) await assertEmployee(b.assigned_to, 'assigned_to')
    const content = (['title', 'objective', 'procedure', 'conclusion'] as const)
      .some((k) => b[k] !== undefined && (b[k] ?? null) !== (wp[k] ?? null))
    const updated = await prisma.auditWorkingPaper.update({
      where: { id: wp.id },
      data: {
        ...(b.title !== undefined ? { title: b.title } : {}),
        ...(b.area !== undefined ? { area: b.area ?? null } : {}),
        ...(b.section !== undefined ? { section: b.section } : {}),
        ...(b.objective !== undefined ? { objective: b.objective ?? null } : {}),
        ...(b.procedure !== undefined ? { procedure: b.procedure ?? null } : {}),
        ...(b.conclusion !== undefined ? { conclusion: b.conclusion ?? null } : {}),
        ...(b.assigned_to !== undefined ? { assignedTo: b.assigned_to ?? null } : {}),
        // Work started; a change to a prepared paper withdraws the preparer's sign-off.
        ...(wp.status === 'not_started' && content ? { status: 'in_progress' } : {}),
        ...(wp.status === 'prepared' && content ? { status: 'in_progress', preparedBy: null, preparedAt: null } : {}),
        updatedBy: session.userId,
      },
    })
    await audit(req, session, 'working_paper_update', 'AuditWorkingPaper', wp.id,
      { title: wp.title, conclusion: wp.conclusion, status: wp.status, assigned_to: wp.assignedTo },
      { title: updated.title, conclusion: updated.conclusion, status: updated.status, assigned_to: updated.assignedTo })
    ok(res, await paperOut(wp.id))
  }))

  r.post('/:id/working-papers/:wpId/prepare', handler(async (req, res) => {
    const { session, e } = await fileAccess(req, 'manage')
    guardWrite(e, session, req.body)
    const myId = me(session)
    const wp = await loadPaper(e, req.params.wpId)
    if (wp.status === 'reviewed') throw ApiError.unprocessable('wp_reviewed', 'This working paper is already reviewed.')
    if (!wp.conclusion?.trim()) throw ApiError.unprocessable('conclusion_required', 'Record the conclusion before signing off as preparer.')
    await prisma.auditWorkingPaper.update({
      where: { id: wp.id }, data: { status: 'prepared', preparedBy: myId, preparedAt: new Date(), updatedBy: session.userId },
    })
    await audit(req, session, 'working_paper_prepare', 'AuditWorkingPaper', wp.id, { status: wp.status }, { status: 'prepared', prepared_by: myId })
    ok(res, await paperOut(wp.id))
  }))

  r.post('/:id/working-papers/:wpId/review', handler(async (req, res) => {
    const { session, e } = await fileAccess(req, 'review')
    guardWrite(e, session, req.body)
    const myId = me(session)
    const wp = await loadPaper(e, req.params.wpId)
    if (wp.status !== 'prepared') throw ApiError.unprocessable('not_prepared', 'The preparer must sign off before review.')
    if (wp.preparedBy === myId) throw ApiError.forbidden('The preparer of a working paper cannot review it.')
    const open = await prisma.auditReviewNote.count({ where: { workingPaperId: wp.id, ...alive, status: { not: 'cleared' } } })
    if (open) throw ApiError.unprocessable('review_notes_open', `Clear the ${open} open review note${open === 1 ? '' : 's'} on this working paper first.`)
    await prisma.auditWorkingPaper.update({
      where: { id: wp.id }, data: { status: 'reviewed', reviewedBy: myId, reviewedAt: new Date(), updatedBy: session.userId },
    })
    await audit(req, session, 'working_paper_review', 'AuditWorkingPaper', wp.id, { status: wp.status }, { status: 'reviewed', reviewed_by: myId })
    ok(res, await paperOut(wp.id))
  }))

  r.post('/:id/working-papers/:wpId/reopen', handler(async (req, res) => {
    const { session, e } = await fileAccess(req, 'review')
    guardWrite(e, session, req.body)
    const b = parse(z.object({ reason: z.string().trim().min(1, 'Give the reason for reopening.').max(2000) }), req.body, 'Give the reason for reopening.')
    const wp = await loadPaper(e, req.params.wpId)
    if (wp.status !== 'reviewed') throw ApiError.unprocessable('not_reviewed', 'Only a reviewed working paper can be reopened.')
    await prisma.auditWorkingPaper.update({
      where: { id: wp.id }, data: { status: 'prepared', reviewedBy: null, reviewedAt: null, updatedBy: session.userId },
    })
    await audit(req, session, 'working_paper_reopen', 'AuditWorkingPaper', wp.id,
      { status: 'reviewed', reviewed_by: wp.reviewedBy, reviewed_at: wp.reviewedAt }, { status: 'prepared', reason: b.reason })
    ok(res, await paperOut(wp.id))
  }))

  // ── Evidence files ──
  r.post('/:id/working-papers/:wpId/files', (req, res, next) => {
    upload.single('file')(req, res, (err: unknown) => {
      if (!err) return next()
      if ((err as { code?: string }).code === 'LIMIT_FILE_SIZE') {
        return next(ApiError.unprocessable('too_large', `File is larger than the ${CLIENT_DOC_MAX_MB} MB limit.`))
      }
      next(ApiError.badRequest('Upload could not be read.'))
    })
  }, handler(async (req, res) => {
    const { session, e } = await fileAccess(req, 'manage')
    const mode = guardWrite(e, session, req.body, true)
    const wp = await loadPaper(e, req.params.wpId)
    if (wp.status === 'reviewed' && !mode.addendum) throw ApiError.unprocessable('wp_reviewed', 'This working paper is reviewed. Reopen it to add evidence.')
    const file = req.file
    if (!file) throw ApiError.badRequest('Choose a file to upload.', { file: 'Choose a file to upload.' })
    const ext = (file.originalname.split('.').pop() ?? '').toLowerCase()
    const mimeType = CLIENT_DOC_MIME[ext]
    if (!mimeType) throw ApiError.unprocessable('file_type', `Allowed types: ${Object.keys(CLIENT_DOC_MIME).join(', ').toUpperCase()}.`)
    if (!clientDocContentMatches(file.buffer, ext)) {
      throw ApiError.unprocessable('file_content', `This file's content does not match its .${ext} extension. Re-save it in its real format and upload again.`)
    }
    const sha256 = crypto.createHash('sha256').update(file.buffer).digest('hex')
    const safe = file.originalname.replace(/[^A-Za-z0-9._-]/g, '_').slice(-120)
    const key = `${e.id}/${wp.id}/${crypto.randomUUID()}-${safe}`
    await auditStorage.put(key, file.buffer)
    const row = await prisma.auditWorkingPaperFile.create({
      data: {
        workingPaperId: wp.id, fileKey: key, originalName: file.originalname.slice(0, 255), mimeType,
        sizeBytes: file.size, sha256, uploadedBy: session.employeeId ?? session.userId, isAddendum: mode.addendum,
      },
    })
    await audit(req, session, mode.addendum ? 'addendum_file' : 'file_upload', 'AuditWorkingPaperFile', row.id, undefined, {
      engagement_id: e.id, working_paper_id: wp.id, ref: wp.ref, original_name: row.originalName, size_bytes: row.sizeBytes, sha256,
      ...(mode.addendum ? { addendum_reason: mode.reason } : {}),
    })
    ok(res, S.wpFile(row, await employeeNames([row.uploadedBy])), 201)
  }))

  r.get('/:id/working-papers/:wpId/files/:fileId', handler(async (req, res) => {
    const { session, e } = await fileAccess(req, 'read')
    const wp = await loadPaper(e, req.params.wpId)
    const f = await prisma.auditWorkingPaperFile.findFirst({ where: { id: req.params.fileId, workingPaperId: wp.id, ...alive } })
    if (!f) throw ApiError.notFound('File not found.')
    let bytes: Buffer
    try { bytes = await auditStorage.get(f.fileKey) } catch { throw ApiError.notFound('This file is no longer in storage.') }
    await audit(req, session, 'file_download', 'AuditWorkingPaperFile', f.id, undefined, { engagement_id: e.id, working_paper_id: wp.id, original_name: f.originalName })
    const download = req.query.download === '1' || req.query.download === 'true'
    setUploadedFileHeaders(res, { mime: f.mimeType ?? 'application/octet-stream', filename: f.originalName, inline: !download, size: bytes.length })
    res.send(bytes)
  }))

  r.delete('/:id/working-papers/:wpId/files/:fileId', handler(async (req, res) => {
    const { session, e } = await fileAccess(req, 'manage')
    guardWrite(e, session, req.body)
    const wp = await loadPaper(e, req.params.wpId)
    if (wp.status === 'reviewed') throw ApiError.unprocessable('wp_reviewed', 'Evidence on a reviewed working paper cannot be removed.')
    const f = await prisma.auditWorkingPaperFile.findFirst({ where: { id: req.params.fileId, workingPaperId: wp.id, ...alive } })
    if (!f) throw ApiError.notFound('File not found.')
    await prisma.auditWorkingPaperFile.update({ where: { id: f.id }, data: { deletedAt: new Date(), deletedBy: session.employeeId ?? session.userId } })
    await audit(req, session, 'file_delete', 'AuditWorkingPaperFile', f.id, { original_name: f.originalName, sha256: f.sha256 })
    ok(res, { id: f.id, deleted: true })
  }))

  // ── Review notes ──
  const noteInclude = { workingPaper: { select: { ref: true, title: true } } } as const

  async function noteOut(id: string) {
    const n = await prisma.auditReviewNote.findUniqueOrThrow({ where: { id }, include: noteInclude })
    return S.reviewNote(n, await employeeNames([n.raisedBy, n.respondedBy, n.clearedBy]))
  }

  r.get('/:id/review-notes', handler(async (req, res) => {
    const { e } = await fileAccess(req, 'read')
    const q = parse(z.object({ status: z.string().optional(), working_paper_id: z.string().optional() }), req.query, 'Invalid filters.')
    const status = q.status === 'uncleared' || q.status === 'pending'
      ? { status: { not: 'cleared' } }
      : q.status && q.status !== 'all' ? { status: q.status } : {}
    const rows = await prisma.auditReviewNote.findMany({
      where: { engagementId: e.id, ...alive, ...status, ...(q.working_paper_id ? { workingPaperId: q.working_paper_id } : {}) },
      include: noteInclude, orderBy: { raisedAt: 'asc' },
    })
    const names = await employeeNames(rows.flatMap((n) => [n.raisedBy, n.respondedBy, n.clearedBy]))
    ok(res, S.list(rows.map((n) => S.reviewNote(n, names))))
  }))

  r.post('/:id/review-notes', handler(async (req, res) => {
    const { session, e } = await fileAccess(req, 'manage')
    guardWrite(e, session, req.body)
    const myId = me(session)
    const b = parse(z.object({ working_paper_id: z.string().nullish(), note: z.string().trim().min(1, 'Write the note.').max(10000) }), req.body, 'Invalid review note.')
    if (b.working_paper_id) await loadPaper(e, b.working_paper_id)
    const n = await prisma.auditReviewNote.create({ data: { engagementId: e.id, workingPaperId: b.working_paper_id ?? null, note: b.note, raisedBy: myId } })
    await audit(req, session, 'review_note_raise', 'AuditReviewNote', n.id, undefined, { engagement_id: e.id, working_paper_id: n.workingPaperId, note: n.note })
    ok(res, await noteOut(n.id), 201)
  }))

  async function loadNote(e: AuditEngagement, id: string) {
    const n = await prisma.auditReviewNote.findFirst({ where: { id, engagementId: e.id, ...alive } })
    if (!n) throw ApiError.notFound('Review note not found.')
    return n
  }

  r.post('/:id/review-notes/:noteId/respond', handler(async (req, res) => {
    const { session, e } = await fileAccess(req, 'manage')
    guardWrite(e, session, req.body)
    const myId = me(session)
    const b = parse(z.object({ response: z.string().trim().min(1, 'Write the response.').max(10000) }), req.body, 'Invalid response.')
    const n = await loadNote(e, req.params.noteId)
    if (n.status === 'cleared') throw ApiError.unprocessable('note_cleared', 'This note is already cleared.')
    await prisma.auditReviewNote.update({ where: { id: n.id }, data: { response: b.response, respondedBy: myId, respondedAt: new Date(), status: 'responded' } })
    await audit(req, session, 'review_note_respond', 'AuditReviewNote', n.id, { status: n.status, response: n.response }, { status: 'responded', response: b.response })
    ok(res, await noteOut(n.id))
  }))

  r.post('/:id/review-notes/:noteId/clear', handler(async (req, res) => {
    const { session, e } = await fileAccess(req, 'review')
    guardWrite(e, session, req.body)
    const myId = me(session)
    const n = await loadNote(e, req.params.noteId)
    if (n.status === 'cleared') throw ApiError.unprocessable('note_cleared', 'This note is already cleared.')
    if (n.raisedBy !== myId && !isManager(e, session) && !isSigningPartner(e, session)) {
      throw ApiError.forbidden('Only the person who raised the note, the manager or the signing partner can clear it.')
    }
    await prisma.auditReviewNote.update({ where: { id: n.id }, data: { status: 'cleared', clearedBy: myId, clearedAt: new Date() } })
    await audit(req, session, 'review_note_clear', 'AuditReviewNote', n.id, { status: n.status }, { status: 'cleared' })
    ok(res, await noteOut(n.id))
  }))
}
