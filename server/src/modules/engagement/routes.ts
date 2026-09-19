import { Router } from 'express'
import { z } from 'zod'
import { ApiError, handler, noContent, ok } from '../../lib/http.js'
import { can, requireSession, type Session } from '../../platform/auth.js'
import { requireWorkstation } from '../../platform/workstation/scope.js'
import { signedLink } from '../../platform/signedUrl.js'
import { EngagementService, type LetterInput } from './service.js'

export const engagementRouter = Router()

const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.')

function parse<T extends z.ZodTypeAny>(schema: T, data: unknown, message: string): z.infer<T> {
  const r = schema.safeParse(data)
  if (!r.success) {
    throw ApiError.badRequest(message, r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })))
  }
  return r.data
}

function requireManage(session: Session) {
  if (!can(session, 'workstation.engagement.manage', 'self')) {
    throw ApiError.forbidden('You do not have permission to manage engagement letters.')
  }
}

const feeSchema = z.object({
  service: z.string().trim().min(1, 'Name the service.'),
  description: z.string().nullish(),
  frequency: z.string().nullish(),
  amount_paise: z.number().int().min(0),
  billing_basis: z.string().nullish(),
  notes: z.string().nullish(),
})

/** block_config and layout_config are the builder's own shapes — opaque here. */
const letterSchema = z.object({
  client_id: z.string().nullish(),
  lead_id: z.string().nullish(),
  subject: z.string().trim().min(1, 'Give the letter a subject.'),
  letter_date: ISO_DATE,
  effective_from: ISO_DATE.nullish(),
  effective_until: ISO_DATE.nullish(),
  financial_year: z.string().nullish(),
  recipient_snapshot: z.record(z.unknown()).nullish(),
  template_id: z.string().optional(),
  block_config: z.array(z.record(z.unknown())).nullish(),
  layout_config: z.record(z.unknown()).nullish(),
  signatory_name: z.string().nullish(),
  signatory_designation: z.string().nullish(),
  client_signatory_name: z.string().nullish(),
  client_signatory_designation: z.string().nullish(),
  fee_items: z.array(feeSchema).default([]),
}).refine(
  (b) => !b.effective_from || !b.effective_until || b.effective_from <= b.effective_until,
  { message: 'Effective until must not be before effective from.', path: ['effective_until'] },
)

function toInput(b: z.infer<typeof letterSchema>): LetterInput {
  return {
    clientId: b.client_id ?? null,
    leadId: b.lead_id ?? null,
    subject: b.subject,
    letterDate: b.letter_date,
    effectiveFrom: b.effective_from ?? null,
    effectiveUntil: b.effective_until ?? null,
    financialYear: b.financial_year ?? null,
    recipientSnapshot: b.recipient_snapshot ?? null,
    templateId: b.template_id,
    blockConfig: b.block_config ?? null,
    layoutConfig: b.layout_config ?? null,
    signatoryName: b.signatory_name ?? null,
    signatoryDesignation: b.signatory_designation ?? null,
    clientSignatoryName: b.client_signatory_name ?? null,
    clientSignatoryDesignation: b.client_signatory_designation ?? null,
    feeItems: b.fee_items.map((f) => ({
      service: f.service,
      description: f.description ?? null,
      frequency: f.frequency ?? null,
      amountPaise: f.amount_paise,
      billingBasis: f.billing_basis ?? null,
      notes: f.notes ?? null,
    })),
  }
}

engagementRouter.get('/', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.engagement.read')
  const q = parse(z.object({
    status: z.string().optional(),
    client_id: z.string().optional(),
    q: z.string().optional(),
    limit: z.coerce.number().optional(),
    offset: z.coerce.number().optional(),
  }), req.query, 'Invalid filters.')
  ok(res, await EngagementService.list(session, scope, {
    status: q.status, clientId: q.client_id, q: q.q, limit: q.limit, offset: q.offset,
  }))
}))

engagementRouter.get('/:id', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.engagement.read')
  ok(res, await EngagementService.get(session, scope, req.params.id))
}))

engagementRouter.post('/', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.engagement.manage')
  requireManage(session)
  const body = parse(letterSchema, req.body, 'Invalid engagement letter.')
  ok(res, await EngagementService.create(session, scope, toInput(body)), 201)
}))

engagementRouter.put('/:id', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.engagement.manage')
  requireManage(session)
  const body = parse(letterSchema, req.body, 'Invalid engagement letter.')
  ok(res, await EngagementService.update(session, scope, req.params.id, toInput(body)))
}))

const STATUS_PATH = { draft: 'reopen', sent: 'send', accepted: 'accept', archived: 'archive' } as const
for (const to of ['draft', 'sent', 'accepted', 'archived'] as const) {
  const path = STATUS_PATH[to]
  engagementRouter.post(`/:id/${path}`, handler(async (req, res) => {
    const session = requireSession(req)
    const scope = requireWorkstation(session, 'workstation.engagement.manage')
    requireManage(session)
    ok(res, await EngagementService.setStatus(session, scope, req.params.id, to))
  }))
}

engagementRouter.post('/:id/duplicate', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.engagement.manage')
  requireManage(session)
  ok(res, await EngagementService.duplicate(session, scope, req.params.id), 201)
}))

/** A signed public link to the letter's PDF — see the signed router. */
engagementRouter.get('/:id/pdf-url', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.engagement.read')
  const l = await EngagementService.get(session, scope, req.params.id)
  ok(res, signedLink(`/api/engagement-letters/${l.id}/pdf`, `engagement:${l.id}`, session.userId))
}))

engagementRouter.delete('/:id', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.engagement.manage')
  requireManage(session)
  await EngagementService.remove(session, scope, req.params.id)
  noContent(res)
}))
