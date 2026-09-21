import { Router } from 'express'
import { z } from 'zod'
import { ApiError, handler, noContent, ok } from '../../lib/http.js'
import { can, requireSession, type Session } from '../../platform/auth.js'
import { requireWorkstation } from '../../platform/workstation/scope.js'
import { signedLink } from '../../platform/signedUrl.js'
import { DocService, type DocInput } from './service.js'
import { DOC_TYPES } from './types.js'

export const docsRouter = Router()

const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.')

function parse<T extends z.ZodTypeAny>(schema: T, data: unknown, message: string): z.infer<T> {
  const r = schema.safeParse(data)
  if (!r.success) {
    throw ApiError.badRequest(message, r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })))
  }
  return r.data
}

function requireManage(session: Session) {
  if (!can(session, 'workstation.doc.manage', 'self')) {
    throw ApiError.forbidden('You do not have permission to manage documents.')
  }
}

/**
 * field_values, block_config and layout_config are the editor's own shapes —
 * opaque here on purpose. The type is NOT: it decides what the row is, so it
 * is checked against the canonical list.
 */
const docSchema = z.object({
  doc_type: z.enum(DOC_TYPES),
  title: z.string().trim().min(1, 'Give the document a title.'),
  client_id: z.string().nullish(),
  lead_id: z.string().nullish(),
  doc_date: ISO_DATE,
  field_values: z.record(z.unknown()).nullish(),
  block_config: z.array(z.record(z.unknown())).nullish(),
  layout_config: z.record(z.unknown()).nullish(),
})

function toInput(b: z.infer<typeof docSchema>): DocInput {
  return {
    docType: b.doc_type,
    title: b.title,
    clientId: b.client_id ?? null,
    leadId: b.lead_id ?? null,
    docDate: b.doc_date,
    fieldValues: b.field_values ?? null,
    blockConfig: b.block_config ?? null,
    layoutConfig: b.layout_config ?? null,
  }
}

docsRouter.get('/', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.doc.read')
  const q = parse(z.object({
    doc_type: z.string().optional(),
    status: z.string().optional(),
    client_id: z.string().optional(),
    q: z.string().optional(),
    limit: z.coerce.number().optional(),
    offset: z.coerce.number().optional(),
  }), req.query, 'Invalid filters.')
  ok(res, await DocService.list(session, scope, {
    docType: q.doc_type, status: q.status, clientId: q.client_id, q: q.q, limit: q.limit, offset: q.offset,
  }))
}))

/** The per-type counts behind the cards on the Doc landing page. */
docsRouter.get('/counts', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.doc.read')
  ok(res, { counts: await DocService.counts(session, scope) })
}))

docsRouter.get('/:id', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.doc.read')
  ok(res, await DocService.get(session, scope, req.params.id))
}))

docsRouter.post('/', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.doc.manage')
  requireManage(session)
  const body = parse(docSchema, req.body, 'Invalid document.')
  ok(res, await DocService.create(session, scope, toInput(body)), 201)
}))

docsRouter.put('/:id', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.doc.manage')
  requireManage(session)
  const body = parse(docSchema, req.body, 'Invalid document.')
  ok(res, await DocService.update(session, scope, req.params.id, toInput(body)))
}))

const STATUS_PATH = { draft: 'reopen', final: 'finalise', archived: 'archive' } as const
for (const to of ['draft', 'final', 'archived'] as const) {
  docsRouter.post(`/:id/${STATUS_PATH[to]}`, handler(async (req, res) => {
    const session = requireSession(req)
    const scope = requireWorkstation(session, 'workstation.doc.manage')
    requireManage(session)
    ok(res, await DocService.setStatus(session, scope, req.params.id, to))
  }))
}

docsRouter.post('/:id/duplicate', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.doc.manage')
  requireManage(session)
  ok(res, await DocService.duplicate(session, scope, req.params.id), 201)
}))

/** A signed public link to the document's PDF — see the signed router. */
docsRouter.get('/:id/pdf-url', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.doc.read')
  const d = await DocService.get(session, scope, req.params.id)
  ok(res, signedLink(`/api/workstation-docs/${d.id}/pdf`, `wsdoc:${d.id}`, session.userId))
}))

docsRouter.delete('/:id', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.doc.manage')
  requireManage(session)
  await DocService.remove(session, scope, req.params.id)
  noContent(res)
}))
