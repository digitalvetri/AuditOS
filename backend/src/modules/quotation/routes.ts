import { Router } from 'express'
import { z } from 'zod'
import { ApiError, handler, noContent, ok } from '../../lib/http.js'
import { can, requireSession, type Session } from '../../platform/auth.js'
import { requireWorkstation } from '../../platform/workstation/scope.js'
import { signedLink } from '../../platform/signedUrl.js'
import { QuotationService, type ItemInput } from './service.js'
import { GST_RATES } from './totals.js'

/**
 * Quotation HTTP surface — mounted at /api/quotations.
 *
 * Same pipeline as the rest of Workstation: authenticate → require the
 * permission (which returns the caller's scope) → Zod validate → service.
 *
 * NOTHING in any request body carries a total, a tax figure or a timestamp.
 * Totals are recomputed from the lines on every write and the clock is the
 * server's, which is what makes "the numbers add up" a property of the API
 * rather than a rule the UI is trusted to follow.
 */
export const quotationsRouter = Router()

const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.')

function parse<T extends z.ZodTypeAny>(schema: T, data: unknown, message: string): z.infer<T> {
  const r = schema.safeParse(data)
  if (!r.success) {
    throw ApiError.badRequest(message, r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })))
  }
  return r.data
}

function requireManage(session: Session) {
  if (!can(session, 'workstation.quotation.manage', 'self')) {
    throw ApiError.forbidden('You do not have permission to manage quotations.')
  }
}

const itemSchema = z.object({
  service_id: z.string().nullish(),
  description: z.string().trim().min(1, 'Describe the line.').max(500),
  /* Hundredths, so 2.5 units arrives as 250 and no float touches the wire. */
  quantity_centi: z.coerce.number().int().positive().max(1_000_000).default(100),
  unit_rate_paise: z.coerce.number().int().nonnegative().max(1_000_000_000),
  discount_percent: z.coerce.number().int().min(0).max(100).default(0),
  gst_rate_percent: z.coerce.number().int().refine((v) => (GST_RATES as readonly number[]).includes(v), {
    message: `GST rate must be one of ${GST_RATES.join(', ')}.`,
  }).default(18),
  /* Free text: §12 wants 'Every 6 Months' to be possible. */
  frequency: z.string().trim().max(60).nullish(),
  category: z.string().trim().max(80).nullish(),
  detail: z.string().trim().max(2000).nullish(),
})

const workSectionSchema = z.object({
  title: z.string().trim().min(1, 'Name the work section.').max(150),
  description: z.string().trim().max(2000).nullish(),
  items: z.array(z.string().trim().min(1).max(500)).max(50).default([]),
})

const bodySchema = z.object({
  lead_id: z.string().nullish(),
  client_id: z.string().nullish(),
  subject: z.string().trim().min(1, 'Give the quotation a subject.').max(200),
  quote_date: ISO_DATE,
  valid_until: ISO_DATE,
  place_of_supply: z.string().trim().max(100).nullish(),
  is_inter_state: z.coerce.boolean().default(false),
  discount_paise: z.coerce.number().int().nonnegative().max(1_000_000_000).default(0),
  notes: z.string().trim().max(2000).nullish(),
  terms: z.string().trim().max(4000).nullish(),
  items: z.array(itemSchema).min(1, 'A quotation needs at least one line.').max(100),

  // ── Document composition ────────────────────────────────────────────────
  template_id: z.string().trim().max(60).nullish(),
  introduction: z.string().trim().max(4000).nullish(),
  closing_text: z.string().trim().max(1000).nullish(),
  prepared_by_name: z.string().trim().max(120).nullish(),
  prepared_by_designation: z.string().trim().max(120).nullish(),
  /* Layout and blocks are the builder's own shape; the server stores them
     verbatim and never interprets them, so passthrough objects are correct
     here — validating them would couple the API to the editor's internals. */
  layout_config: z.record(z.unknown()).nullish(),
  block_config: z.array(z.record(z.unknown())).nullish(),
  client_snapshot: z.record(z.unknown()).nullish(),
  work_sections: z.array(workSectionSchema).max(30).default([]),
})

function toInput(b: z.infer<typeof bodySchema>) {
  return {
    leadId: b.lead_id ?? null,
    clientId: b.client_id ?? null,
    subject: b.subject,
    quoteDate: b.quote_date,
    validUntil: b.valid_until,
    placeOfSupply: b.place_of_supply ?? null,
    isInterState: b.is_inter_state,
    discountPaise: b.discount_paise,
    notes: b.notes ?? null,
    terms: b.terms ?? null,
    items: b.items.map((i): ItemInput => ({
      serviceId: i.service_id ?? null,
      description: i.description,
      quantityCenti: i.quantity_centi,
      unitRatePaise: i.unit_rate_paise,
      discountPercent: i.discount_percent,
      gstRatePercent: i.gst_rate_percent,
      frequency: i.frequency ?? null,
      category: i.category ?? null,
      detail: i.detail ?? null,
    })),
    templateId: b.template_id ?? null,
    introduction: b.introduction ?? null,
    closingText: b.closing_text ?? null,
    preparedByName: b.prepared_by_name ?? null,
    preparedByDesignation: b.prepared_by_designation ?? null,
    layoutConfig: b.layout_config ?? null,
    blockConfig: b.block_config ?? null,
    clientSnapshot: b.client_snapshot ?? null,
    workSections: b.work_sections.map((w) => ({
      title: w.title,
      description: w.description ?? null,
      items: w.items,
    })),
  }
}

// ── Read ──────────────────────────────────────────────────────────────────

quotationsRouter.get('/', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.quotation.read')
  const q = parse(z.object({
    status: z.string().optional(),
    client_id: z.string().optional(),
    lead_id: z.string().optional(),
    date_from: ISO_DATE.optional(),
    date_to: ISO_DATE.optional(),
    q: z.string().optional(),
    limit: z.coerce.number().int().positive().optional(),
    offset: z.coerce.number().int().nonnegative().optional(),
  }), req.query, 'Invalid quotation filter.')

  ok(res, await QuotationService.list(session, scope, {
    status: q.status, clientId: q.client_id, leadId: q.lead_id,
    dateFrom: q.date_from, dateTo: q.date_to, q: q.q,
    limit: q.limit, offset: q.offset,
  }))
}))

/**
 * The templates a quotation can be built from (§30).
 *
 * Seeded on first read like the checklist catalogue, so a fresh database has
 * them without a seed step. The renderer switches on `slug`; everything else
 * here is presentation.
 */
quotationsRouter.get('/templates', handler(async (req, res) => {
  const session = requireSession(req)
  requireWorkstation(session, 'workstation.quotation.read')
  ok(res, await QuotationService.templates())
}))

/** Header counts for the list screen, over the caller's scope only. */
quotationsRouter.get('/summary', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.quotation.read')
  ok(res, await QuotationService.summary(session, scope))
}))

quotationsRouter.get('/:id', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.quotation.read')
  ok(res, await QuotationService.get(session, scope, req.params.id))
}))

// ── Write ─────────────────────────────────────────────────────────────────

quotationsRouter.post('/', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.quotation.manage')
  requireManage(session)
  const body = parse(bodySchema, req.body, 'Invalid quotation.')
  ok(res, await QuotationService.create(session, scope, toInput(body)), 201)
}))

quotationsRouter.put('/:id', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.quotation.manage')
  requireManage(session)
  const body = parse(bodySchema, req.body, 'Invalid quotation.')
  ok(res, await QuotationService.update(session, scope, req.params.id, toInput(body)))
}))

/** Draft → sent. Stamped with the server clock. */
quotationsRouter.post('/:id/send', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.quotation.manage')
  requireManage(session)
  ok(res, await QuotationService.transition(session, scope, req.params.id, 'sent'))
}))

/**
 * Sent → accepted / rejected. This is the OUTCOME of a quotation, so it sits
 * behind its own permission: an executive may prepare and send, while
 * recording that the client said yes is a manager's call.
 */
quotationsRouter.post('/:id/accept', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.quotation.approve')
  ok(res, await QuotationService.transition(session, scope, req.params.id, 'accepted'))
}))

quotationsRouter.post('/:id/reject', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.quotation.approve')
  const body = parse(z.object({ reason: z.string().trim().min(1, 'Record why it was rejected.').max(500) }),
    req.body, 'Invalid rejection.')
  ok(res, await QuotationService.transition(session, scope, req.params.id, 'rejected', { reason: body.reason }))
}))

/** Copy into a fresh draft — how a sent quotation gets "edited". */
quotationsRouter.post('/:id/revise', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.quotation.manage')
  requireManage(session)
  ok(res, await QuotationService.revise(session, scope, req.params.id), 201)
}))

/** Accepted → work. Requires task manage as well: it creates a Task. */
quotationsRouter.post('/:id/convert-to-task', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.quotation.approve')
  if (!can(session, 'workstation.task.manage', 'self')) {
    throw ApiError.forbidden('You do not have permission to assign work.')
  }
  const body = parse(z.object({
    assigned_employee_id: z.string().min(1, 'Choose who does the work.'),
    due_date: ISO_DATE.optional(),
  }), req.body, 'Invalid conversion.')
  ok(res, await QuotationService.convertToTask(session, scope, req.params.id, body.assigned_employee_id, body.due_date), 201)
}))

/**
 * A signed, public link to this quotation's PDF — what gets pasted into a
 * WhatsApp message or an email, since neither can carry an attachment. Issuing
 * the link is authorised here; the link itself carries its own expiry.
 */
quotationsRouter.get('/:id/pdf-url', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.quotation.read')
  const q = await QuotationService.get(session, scope, req.params.id)
  ok(res, signedLink(`/api/quotations/${q.id}/pdf`, `quotation:${q.id}`, session.userId))
}))

quotationsRouter.delete('/:id', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.quotation.manage')
  requireManage(session)
  await QuotationService.remove(session, scope, req.params.id)
  noContent(res)
}))
