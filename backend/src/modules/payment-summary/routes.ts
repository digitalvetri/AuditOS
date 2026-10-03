/**
 * PAYMENT SUMMARY (HRMS) — what every client has been invoiced, paid and
 * still owes, built from the Workstation invoices and their payment history.
 *
 *   GET    /api/payment-summary                         firm totals, ageing, per-client rows, recent payments
 *   GET    /api/payment-summary/monthly?months=6        billed vs collected per month (cash-flow chart)
 *   GET    /api/payment-summary/clients/:clientId       one client's invoices with each instalment
 *   POST   /api/payment-summary/invoices/:id/payments   record a payment / instalment
 *   DELETE /api/payment-summary/invoices/:id/payments/:paymentId   remove a wrong entry
 *
 * Draft and cancelled invoices are left out: a draft was never billed and a
 * cancelled one is not owed. Firm-wide view — `payment_summary.read` at
 * organisation scope; recording needs `payment_summary.manage`.
 */
import { Router } from 'express'
import { z } from 'zod'
import { ApiError, handler, ok } from '../../lib/http.js'
import { prisma } from '../../lib/prisma.js'
import { istToday, daysBetween } from '../../lib/dates.js'
import { requirePermission, requireSession } from '../../platform/auth.js'
import { writeAudit } from '../../platform/audit.js'
import { avgDaysToCollect, bucketMonthly, monthWindow } from './monthly.js'
import {
  addPayment, listPayments, notifyPaymentRecorded, paymentBodySchema, paymentToApi, removePayment, toPaymentInput,
} from '../invoice/payments.js'

export const paymentSummaryRouter = Router()
paymentSummaryRouter.use(requirePermission('payment_summary.read', 'organisation'))

const BILLED = { deletedAt: null, status: { notIn: ['draft', 'cancelled'] } }

type ClientStatus = 'paid' | 'partial' | 'unpaid' | 'overdue'

function invoiceState(inv: { totalPaise: number; amountPaidPaise: number; balanceDuePaise: number; dueDate: string }, today: string) {
  const overdue = inv.balanceDuePaise > 0 && inv.dueDate < today
  const state = inv.balanceDuePaise === 0 ? 'paid' : overdue ? 'overdue' : inv.amountPaidPaise > 0 ? 'partial' : 'unpaid'
  return { overdue, state: state as ClientStatus, daysOverdue: overdue ? daysBetween(inv.dueDate, today) : 0 }
}

// ── GET /api/payment-summary ──────────────────────────────────────────────
paymentSummaryRouter.get('/', handler(async (req, res) => {
  const q = z.object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  }).parse(req.query)
  const today = istToday()

  const invoices = await prisma.invoice.findMany({
    where: {
      ...BILLED,
      ...(q.from || q.to ? { invoiceDate: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } } : {}),
    },
    select: {
      id: true, clientId: true, totalPaise: true, amountPaidPaise: true, balanceDuePaise: true, dueDate: true,
      client: { select: { companyName: true, clientCode: true, contactNumber: true, email: true } },
    },
  })

  const ageing = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 }
  const byClient = new Map<string, {
    client_id: string; client_name: string; client_code: string | null; contact_number: string | null; email: string | null
    invoices: number; open_invoices: number; invoiced_paise: number; paid_paise: number; pending_paise: number; overdue_paise: number
    oldest_due_date: string | null; last_payment_on: string | null
  }>()

  for (const inv of invoices) {
    const s = invoiceState(inv, today)
    if (inv.balanceDuePaise > 0) {
      const d = s.daysOverdue
      if (!s.overdue) ageing.current += inv.balanceDuePaise
      else if (d <= 30) ageing.d1_30 += inv.balanceDuePaise
      else if (d <= 60) ageing.d31_60 += inv.balanceDuePaise
      else if (d <= 90) ageing.d61_90 += inv.balanceDuePaise
      else ageing.d90_plus += inv.balanceDuePaise
    }
    const row = byClient.get(inv.clientId) ?? {
      client_id: inv.clientId,
      client_name: inv.client.companyName,
      client_code: inv.client.clientCode,
      contact_number: inv.client.contactNumber,
      email: inv.client.email,
      invoices: 0, open_invoices: 0, invoiced_paise: 0, paid_paise: 0, pending_paise: 0, overdue_paise: 0,
      oldest_due_date: null, last_payment_on: null,
    }
    row.invoices++
    row.invoiced_paise += inv.totalPaise
    row.paid_paise += inv.amountPaidPaise
    row.pending_paise += inv.balanceDuePaise
    if (inv.balanceDuePaise > 0) {
      row.open_invoices++
      if (!row.oldest_due_date || inv.dueDate < row.oldest_due_date) row.oldest_due_date = inv.dueDate
    }
    if (s.overdue) row.overdue_paise += inv.balanceDuePaise
    byClient.set(inv.clientId, row)
  }

  // Last payment per client, and the latest payments firm-wide.
  const invoiceIds = invoices.map((i) => i.id)
  const [lastByClient, recent] = await Promise.all([
    prisma.invoicePayment.groupBy({
      by: ['clientId'], where: { deletedAt: null, invoiceId: { in: invoiceIds } }, _max: { paidOn: true },
    }),
    prisma.invoicePayment.findMany({
      where: { deletedAt: null, invoiceId: { in: invoiceIds } },
      orderBy: [{ paidOn: 'desc' }, { createdAt: 'desc' }],
      take: 10,
      include: { invoice: { select: { invoiceNumber: true, client: { select: { companyName: true } } } } },
    }),
  ])
  for (const l of lastByClient) {
    const row = byClient.get(l.clientId)
    if (row) row.last_payment_on = l._max.paidOn
  }

  const monthStart = `${today.slice(0, 7)}-01`
  const collectedThisMonth = await prisma.invoicePayment.aggregate({
    where: { deletedAt: null, paidOn: { gte: monthStart, lte: today }, invoice: { ...BILLED } },
    _sum: { amountPaise: true },
  })

  const clients = [...byClient.values()]
    .map((c) => ({
      ...c,
      status: (c.pending_paise === 0 ? 'paid' : c.overdue_paise > 0 ? 'overdue' : c.paid_paise > 0 ? 'partial' : 'unpaid') as ClientStatus,
    }))
    .sort((a, b) => b.pending_paise - a.pending_paise || a.client_name.localeCompare(b.client_name))

  const sum = (k: 'invoiced_paise' | 'paid_paise' | 'pending_paise' | 'overdue_paise') => clients.reduce((t, c) => t + c[k], 0)
  const invoiced = sum('invoiced_paise')
  const paid = sum('paid_paise')
  ok(res, {
    totals: {
      invoiced_paise: invoiced,
      paid_paise: paid,
      pending_paise: sum('pending_paise'),
      overdue_paise: sum('overdue_paise'),
      collected_this_month_paise: collectedThisMonth._sum.amountPaise ?? 0,
      collection_rate: invoiced > 0 ? Math.round((paid / invoiced) * 1000) / 10 : null,
      invoices: invoices.length,
      clients: clients.length,
      clients_with_dues: clients.filter((c) => c.pending_paise > 0).length,
    },
    ageing,
    clients,
    recent_payments: recent.map((p) => ({
      ...paymentToApi(p),
      invoice_number: p.invoice.invoiceNumber,
      client_name: p.invoice.client.companyName,
    })),
  })
}))

// ── GET /api/payment-summary/monthly ──────────────────────────────────────
// Billed (by invoice date) vs collected (by payment date) for the last N
// months including this one. Same scope as the summary: billed invoices only
// (draft and cancelled excluded), and only payments made against them.
paymentSummaryRouter.get('/monthly', handler(async (req, res) => {
  const q = z.object({ months: z.coerce.number().int().min(1).max(24).default(6) }).parse(req.query)
  const months = monthWindow(istToday(), q.months)
  const from = `${months[0]}-01`
  const to = `${months[months.length - 1]}-31`

  const [invoices, payments] = await Promise.all([
    prisma.invoice.findMany({
      where: { ...BILLED, invoiceDate: { gte: from, lte: to } },
      select: { invoiceDate: true, totalPaise: true },
    }),
    prisma.invoicePayment.findMany({
      where: { paidOn: { gte: from, lte: to }, invoice: BILLED },
      select: { paidOn: true, amountPaise: true, invoice: { select: { invoiceDate: true } } },
    }),
  ])

  ok(res, {
    months: bucketMonthly(months, invoices, payments),
    avg_days_to_collect: avgDaysToCollect(payments.map((p) => ({ paidOn: p.paidOn, amountPaise: p.amountPaise, invoiceDate: p.invoice.invoiceDate }))),
  })
}))

// ── GET /api/payment-summary/clients/:clientId ────────────────────────────
paymentSummaryRouter.get('/clients/:clientId', handler(async (req, res) => {
  const today = istToday()
  const client = await prisma.client.findUnique({ where: { id: req.params.clientId } })
  if (!client) throw ApiError.notFound('Client not found.')
  const invoices = await prisma.invoice.findMany({
    where: { ...BILLED, clientId: client.id },
    orderBy: [{ invoiceDate: 'desc' }, { invoiceNumber: 'desc' }],
    include: { payments: { where: { deletedAt: null }, orderBy: [{ paidOn: 'asc' }, { createdAt: 'asc' }] } },
  })
  ok(res, {
    client: {
      id: client.id, name: client.companyName, code: client.clientCode,
      contact_number: client.contactNumber, email: client.email,
    },
    invoices: invoices.map((inv) => {
      const s = invoiceState(inv, today)
      return {
        id: inv.id,
        invoice_number: inv.invoiceNumber,
        invoice_date: inv.invoiceDate,
        due_date: inv.dueDate,
        total_paise: inv.totalPaise,
        paid_paise: inv.amountPaidPaise,
        pending_paise: inv.balanceDuePaise,
        state: s.state,
        days_overdue: s.daysOverdue,
        payments: inv.payments.map(paymentToApi),
      }
    }),
  })
}))

// ── Record / remove a payment ─────────────────────────────────────────────
paymentSummaryRouter.post('/invoices/:id/payments',
  requirePermission('payment_summary.manage', 'organisation'),
  handler(async (req, res) => {
    const session = requireSession(req)
    const parsed = paymentBodySchema.safeParse(req.body ?? {})
    if (!parsed.success) throw ApiError.badRequest(parsed.error.issues[0]?.message ?? 'Check the payment.')
    const row = await addPayment(req.params.id, toPaymentInput(parsed.data), session.userId)
    await writeAudit({
      actorUserId: session.userId, action: 'invoice_payment.recorded', entityType: 'Invoice', entityId: req.params.id,
      after: paymentToApi(row), req,
    })
    await notifyPaymentRecorded(req.params.id, row.amountPaise, session)
    ok(res, { payment: paymentToApi(row), payments: await listPayments(req.params.id) })
  }))

paymentSummaryRouter.delete('/invoices/:id/payments/:paymentId',
  requirePermission('payment_summary.manage', 'organisation'),
  handler(async (req, res) => {
    const session = requireSession(req)
    const row = await removePayment(req.params.id, req.params.paymentId, session.userId)
    await writeAudit({
      actorUserId: session.userId, action: 'invoice_payment.removed', entityType: 'Invoice', entityId: req.params.id,
      before: paymentToApi(row), req,
    })
    ok(res, { payments: await listPayments(req.params.id) })
  }))
