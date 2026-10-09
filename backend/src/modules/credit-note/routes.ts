/**
 * Credit notes — mounted at /api/credit-notes. Same gates as invoices
 * (workstation.invoice.read / .manage); visibility follows the invoice's
 * client scope. Every write is audited.
 */
import { Router } from 'express'
import { z } from 'zod'
import { ApiError, handler, ok } from '../../lib/http.js'
import { requireSession } from '../../platform/auth.js'
import { requireWorkstation } from '../../platform/workstation/scope.js'
import { signedLink } from '../../platform/signedUrl.js'
import { writeAudit } from '../../platform/audit.js'
import { GST_RATES } from '../invoice/totals.js'
import { CREDIT_NOTE_REASONS, CreditNoteService, type CreditNoteInput } from './service.js'

export const creditNotesRouter = Router()

const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.')

function parse<T extends z.ZodTypeAny>(schema: T, data: unknown, message: string): z.infer<T> {
  const r = schema.safeParse(data)
  if (!r.success) throw ApiError.badRequest(message, r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })))
  return r.data
}

const lineSchema = z.object({
  description: z.string().trim().min(1, 'Describe the line.').max(300),
  sac_code: z.string().trim().regex(/^\d{4,8}$/, 'SAC is 4 to 8 digits.').nullish().or(z.literal('')),
  taxable_paise: z.coerce.number().int().positive('Each line must credit more than zero.').max(1_000_000_000_0),
  gst_rate: z.coerce.number().int().refine((n) => (GST_RATES as readonly number[]).includes(n), { message: `GST rate must be one of ${GST_RATES.join(', ')}.` }),
})
const bodySchema = z.object({
  note_date: ISO_DATE,
  reason: z.enum(CREDIT_NOTE_REASONS),
  reason_note: z.string().trim().max(1000).nullish(),
  lines: z.array(lineSchema).min(1, 'A credit note needs at least one line.').max(100),
})
const toInput = (b: z.infer<typeof bodySchema>): CreditNoteInput => ({
  noteDate: b.note_date,
  reason: b.reason,
  reasonNote: b.reason_note ?? null,
  lines: b.lines.map((l) => ({ description: l.description, sacCode: l.sac_code || null, taxablePaise: l.taxable_paise, gstRate: l.gst_rate })),
})

creditNotesRouter.get('/', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.invoice.read')
  const q = parse(z.object({
    invoice_id: z.string().optional(), client_id: z.string().optional(), status: z.enum(['draft', 'issued', 'cancelled']).optional(), q: z.string().max(100).optional(),
  }), req.query, 'Invalid filters.')
  ok(res, await CreditNoteService.list(session, scope, { invoiceId: q.invoice_id, clientId: q.client_id, status: q.status, q: q.q }))
}))

creditNotesRouter.get('/creditable/:invoiceId', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.invoice.read')
  ok(res, await CreditNoteService.creditable(session, scope, req.params.invoiceId))
}))

creditNotesRouter.get('/:id', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.invoice.read')
  ok(res, await CreditNoteService.get(session, scope, req.params.id))
}))

creditNotesRouter.post('/', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.invoice.manage')
  const b = parse(bodySchema.extend({ invoice_id: z.string().min(1, 'Choose the invoice.') }), req.body, 'Check the credit note.')
  const note = await CreditNoteService.create(session, scope, b.invoice_id, toInput(b))
  await writeAudit({ actorUserId: session.userId, action: 'credit_note.created', entityType: 'CreditNote', entityId: note.id, after: { invoice_id: note.invoice_id, total_paise: note.total_paise, reason: note.reason }, req })
  ok(res, note, 201)
}))

creditNotesRouter.put('/:id', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.invoice.manage')
  const b = parse(bodySchema, req.body, 'Check the credit note.')
  const note = await CreditNoteService.update(session, scope, req.params.id, toInput(b))
  await writeAudit({ actorUserId: session.userId, action: 'credit_note.updated', entityType: 'CreditNote', entityId: note.id, after: { total_paise: note.total_paise, reason: note.reason }, req })
  ok(res, note)
}))

creditNotesRouter.post('/:id/issue', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.invoice.manage')
  const note = await CreditNoteService.issue(session, scope, req.params.id)
  await writeAudit({ actorUserId: session.userId, action: 'credit_note.issued', entityType: 'CreditNote', entityId: note.id, after: { number: note.credit_note_number, invoice_id: note.invoice_id, total_paise: note.total_paise }, req })
  ok(res, note)
}))

creditNotesRouter.post('/:id/cancel', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.invoice.manage')
  const b = parse(z.object({ reason: z.string().trim().max(500).optional() }), req.body ?? {}, 'Check the reason.')
  const note = await CreditNoteService.cancel(session, scope, req.params.id, b.reason)
  await writeAudit({ actorUserId: session.userId, action: 'credit_note.cancelled', entityType: 'CreditNote', entityId: note.id, after: { number: note.credit_note_number, reason: b.reason ?? null }, req })
  ok(res, note)
}))

creditNotesRouter.delete('/:id', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.invoice.manage')
  const note = await CreditNoteService.remove(session, scope, req.params.id)
  await writeAudit({ actorUserId: session.userId, action: 'credit_note.deleted', entityType: 'CreditNote', entityId: note.id, before: { invoice_id: note.invoice_id, total_paise: note.total_paise }, req })
  res.status(204).end()
}))

/** Short-lived signed link to the PDF (billing-signed.ts serves it). */
creditNotesRouter.get('/:id/pdf-url', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.invoice.read')
  const note = await CreditNoteService.get(session, scope, req.params.id)
  ok(res, signedLink(`/api/credit-notes/${note.id}/pdf`, `credit-note:${note.id}`, session.userId))
}))
