/**
 * Recurring retainers — mounted at /api/recurring-invoices. Same gates as
 * invoices (workstation.invoice.read / .manage). Every write is audited.
 */
import { Router } from 'express'
import { z } from 'zod'
import { ApiError, handler, ok } from '../../lib/http.js'
import { requireSession } from '../../platform/auth.js'
import { requireWorkstation } from '../../platform/workstation/scope.js'
import { writeAudit } from '../../platform/audit.js'
import { GST_RATES } from '../invoice/totals.js'
import { formBool } from '../invoice/supply.js'
import { FREQUENCIES } from './dates.js'
import { RecurringService, runDueProfiles, type ProfileInput } from './service.js'

export const recurringInvoicesRouter = Router()

const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.')

function parse<T extends z.ZodTypeAny>(schema: T, data: unknown, message: string): z.infer<T> {
  const r = schema.safeParse(data)
  if (!r.success) throw ApiError.badRequest(message, r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })))
  return r.data
}

const lineSchema = z.object({
  description: z.string().trim().min(1, 'Describe the line.').max(200),
  sac_code: z.string().trim().regex(/^\d{4,8}$/, 'SAC is 4 to 8 digits.').nullish().or(z.literal('')),
  quantity_centi: z.coerce.number().int().positive().max(100_000_000).default(100),
  unit_rate_paise: z.coerce.number().int().nonnegative().max(1_000_000_000_0),
  gst_rate: z.coerce.number().int().refine((n) => (GST_RATES as readonly number[]).includes(n), { message: `GST rate must be one of ${GST_RATES.join(', ')}.` }),
  discount_paise: z.coerce.number().int().nonnegative().default(0),
})

const bodySchema = z.object({
  client_id: z.string().min(1, 'Choose a client.'),
  name: z.string().trim().min(1, 'Name the retainer.').max(120),
  frequency: z.enum(FREQUENCIES),
  day_of_month: z.coerce.number().int().refine((n) => (n >= 1 && n <= 28) || n === 31, 'Day of month is 1–28, or 31 for month end.'),
  start_date: ISO_DATE,
  end_date: ISO_DATE.nullish().or(z.literal('')),
  terms: z.enum(['due_on_receipt', 'net_7', 'net_15', 'net_30', 'net_45']).default('net_15'),
  place_of_supply: z.string().trim().max(100).nullish(),
  client_service_id: z.string().max(64).nullish().or(z.literal('')),
  lines: z.array(lineSchema).min(1, 'A retainer needs at least one line.').max(50),
  auto_send: formBool.default(false),
  is_active: formBool.default(true),
})

const toInput = (b: z.infer<typeof bodySchema>): ProfileInput => ({
  clientId: b.client_id,
  name: b.name,
  frequency: b.frequency,
  dayOfMonth: b.day_of_month,
  startDate: b.start_date,
  endDate: b.end_date || null,
  terms: b.terms,
  placeOfSupply: b.place_of_supply || null,
  clientServiceId: b.client_service_id || null,
  lines: b.lines.map((l) => ({ ...l, sac_code: l.sac_code || null })),
  autoSend: b.auto_send,
  isActive: b.is_active,
})

recurringInvoicesRouter.get('/', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.invoice.read')
  ok(res, await RecurringService.list(session, scope))
}))

/** Run every due profile now (the scheduler does this daily). Organisation scope only. */
recurringInvoicesRouter.post('/run-due', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.invoice.manage')
  if (scope !== 'organisation') throw ApiError.forbidden('Only a firm-wide invoice manager can run every retainer.')
  const r = await runDueProfiles()
  await writeAudit({ actorUserId: session.userId, action: 'recurring_invoice.run_due', entityType: 'RecurringInvoiceProfile', entityId: '*', after: r, req })
  ok(res, { created: r.created, failed: r.failed })
}))

recurringInvoicesRouter.get('/:id', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.invoice.read')
  ok(res, await RecurringService.get(session, scope, req.params.id))
}))

recurringInvoicesRouter.post('/', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.invoice.manage')
  const b = parse(bodySchema, req.body, 'Check the retainer.')
  const p = await RecurringService.create(session, scope, toInput(b))
  await writeAudit({ actorUserId: session.userId, action: 'recurring_invoice.created', entityType: 'RecurringInvoiceProfile', entityId: p.id, after: b, req })
  ok(res, p, 201)
}))

recurringInvoicesRouter.put('/:id', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.invoice.manage')
  const b = parse(bodySchema, req.body, 'Check the retainer.')
  const p = await RecurringService.update(session, scope, req.params.id, toInput(b))
  await writeAudit({ actorUserId: session.userId, action: 'recurring_invoice.updated', entityType: 'RecurringInvoiceProfile', entityId: p.id, after: b, req })
  ok(res, p)
}))

recurringInvoicesRouter.delete('/:id', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.invoice.manage')
  const p = await RecurringService.remove(session, scope, req.params.id)
  await writeAudit({ actorUserId: session.userId, action: 'recurring_invoice.deleted', entityType: 'RecurringInvoiceProfile', entityId: p.id, before: { name: p.name, client_id: p.client_id }, req })
  res.status(204).end()
}))

recurringInvoicesRouter.post('/:id/run', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, 'workstation.invoice.manage')
  const r = await RecurringService.runNow(session, scope, req.params.id)
  await writeAudit({ actorUserId: session.userId, action: 'recurring_invoice.run', entityType: 'RecurringInvoiceProfile', entityId: req.params.id, after: r, req })
  ok(res, r)
}))
