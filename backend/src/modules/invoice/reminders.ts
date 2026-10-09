/**
 * Overdue reminders (dunning).
 *
 *   sendInvoiceReminder  one email to the client's address on record with the
 *                        invoice's public PDF link — the "Send reminder"
 *                        button, and each step of the scheduler.
 *   runDunning           daily: an overdue invoice gets ONE reminder at 7, 15
 *                        and 30 days past due — only the highest stage it has
 *                        reached, and only once per stage. Off unless
 *                        INVOICE_DUNNING=on.
 *
 * Every send is an audit row `invoice.reminder.<stage>` on the invoice, which
 * is both the log the invoice page shows and the record that makes the
 * scheduler idempotent.
 */
import type { Request } from 'express'
import { ApiError } from '../../lib/http.js'
import { env } from '../../lib/env.js'
import { prisma } from '../../lib/prisma.js'
import { daysBetween, istToday } from '../../lib/dates.js'
import { formatINR } from '../../lib/money.js'
import { mailConfigured, MailError, sendMail } from '../../lib/mailer.js'
import { permanentLink } from '../../platform/signedUrl.js'
import { writeAudit } from '../../platform/audit.js'
import { withRunLock } from '../recurring/run-lock.js'

export type ReminderStage = 'manual' | 'd7' | 'd15' | 'd30'
const STAGES: { stage: Exclude<ReminderStage, 'manual'>; days: number }[] = [
  { stage: 'd30', days: 30 }, { stage: 'd15', days: 15 }, { stage: 'd7', days: 7 },
]

/** The highest dunning stage an invoice `daysOverdue` past due has reached. */
export function dunningStage(daysOverdue: number): Exclude<ReminderStage, 'manual'> | null {
  return STAGES.find((s) => daysOverdue >= s.days)?.stage ?? null
}

function isOverdue(inv: { status: string; balanceDuePaise: number; dueDate: string }, today: string) {
  return !['draft', 'paid', 'cancelled'].includes(inv.status) && inv.balanceDuePaise > 0 && inv.dueDate < today
}

/** A user the public link can be issued in the name of — permanent links need an active subject. */
async function linkSubject(preferred: string | null): Promise<string | null> {
  if (preferred) {
    const u = await prisma.user.findFirst({ where: { id: preferred, isActive: true }, select: { id: true } })
    if (u) return u.id
  }
  const admin = await prisma.user.findFirst({
    where: { isActive: true, role: { code: { in: ['md', 'hr_admin'] } } },
    select: { id: true }, orderBy: { createdAt: 'asc' },
  })
  return admin?.id ?? null
}

export async function sendInvoiceReminder(
  invoiceId: string,
  opts: { actorUserId: string | null; stage: ReminderStage; replyTo?: string | null; req?: Request; today?: string },
): Promise<{ sent: true; to: string[]; link: string }> {
  const today = opts.today ?? istToday()
  const inv = await prisma.invoice.findFirst({
    where: { id: invoiceId, deletedAt: null },
    include: { client: { select: { companyName: true, email: true, contactPerson: true } } },
  })
  if (!inv) throw ApiError.notFound('No such invoice.')
  if (!isOverdue(inv, today)) throw ApiError.conflict('not_overdue', 'Only an overdue invoice can be sent a reminder.')
  const email = inv.client.email?.trim()
  if (!email) throw ApiError.conflict('no_email', `${inv.client.companyName} has no email address on record.`)
  if (!mailConfigured()) throw new ApiError(503, 'mail_not_configured', 'Email is not configured on the server. Add SMTP_HOST, SMTP_USER and SMTP_PASS to backend/.env.')
  if (!env.publicAppUrl) throw new ApiError(503, 'config_missing', 'Set PUBLIC_APP_URL in backend/.env so the reminder can carry a link to the invoice.')
  const subject = await linkSubject(opts.actorUserId ?? inv.createdBy)
  if (!subject) throw new ApiError(503, 'config_missing', 'No active user to issue the invoice link in the name of.')

  const { url } = permanentLink(`${env.publicAppUrl}/api/invoices/${inv.id}/pdf`, `invoice:${inv.id}`, subject)
  const days = daysBetween(inv.dueDate, today)
  const number = inv.invoiceNumber ?? 'Invoice'
  const text = [
    `Dear ${inv.client.contactPerson || inv.client.companyName},`,
    '',
    `This is a reminder that invoice ${number} dated ${inv.invoiceDate} was due on ${inv.dueDate} ` +
      `and is now ${days} day${days === 1 ? '' : 's'} overdue. The balance due is ${formatINR(inv.balanceDuePaise)}.`,
    '',
    `You can download the invoice here:\n${url}`,
    '',
    'If you have already paid, please share the payment reference so we can update our records. Thank you.',
  ].join('\n')
  try {
    await sendMail({ to: [email], replyTo: opts.replyTo ?? undefined, subject: `Payment reminder — ${number} (${formatINR(inv.balanceDuePaise)} due)`, text })
  } catch (e) {
    if (e instanceof MailError) throw new ApiError(502, 'mail_failed', e.message)
    throw e
  }
  await writeAudit({
    actorUserId: opts.actorUserId, action: `invoice.reminder.${opts.stage}`, entityType: 'Invoice', entityId: inv.id,
    after: { to: [email], link: url, days_overdue: days, balance_due_paise: inv.balanceDuePaise, stage: opts.stage }, req: opts.req,
  })
  return { sent: true, to: [email], link: url }
}

export async function listReminders(invoiceId: string) {
  const rows = await prisma.auditLog.findMany({
    where: { entityType: 'Invoice', entityId: invoiceId, action: { startsWith: 'invoice.reminder.' } },
    orderBy: { createdAt: 'desc' },
    include: { actor: { select: { email: true } } },
  })
  return rows.map((r) => {
    let to: string[] = []
    try { to = (JSON.parse(r.afterJson ?? '{}') as { to?: string[] }).to ?? [] } catch { /* old row */ }
    return { at: r.createdAt.toISOString(), to, stage: r.action.slice('invoice.reminder.'.length), by: r.actor?.email ?? null }
  })
}

/** One dunning pass. Returns how many reminders went out. */
export async function runDunning(today = istToday()): Promise<{ sent: number; failed: number }> {
  const candidates = await prisma.invoice.findMany({
    where: {
      deletedAt: null, status: { notIn: ['draft', 'paid', 'cancelled'] }, balanceDuePaise: { gt: 0 },
      dueDate: { lte: (() => { const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - 7); return d.toISOString().slice(0, 10) })() },
      client: { email: { not: null } },
    },
    select: { id: true, dueDate: true },
  })
  let sent = 0
  let failed = 0
  for (const c of candidates) {
    const stage = dunningStage(daysBetween(c.dueDate, today))
    if (!stage) continue
    // Once per stage — and a later stage already sent covers the earlier ones.
    const higher = STAGES.slice(0, STAGES.findIndex((s) => s.stage === stage) + 1).map((s) => `invoice.reminder.${s.stage}`)
    const already = await prisma.auditLog.count({ where: { entityType: 'Invoice', entityId: c.id, action: { in: higher } } })
    if (already > 0) continue
    try {
      await sendInvoiceReminder(c.id, { actorUserId: null, stage, today })
      sent++
    } catch (e) {
      failed++
      console.warn('[dunning] reminder not sent', c.id, e instanceof Error ? e.message : e)
    }
  }
  return { sent, failed }
}

const DAY_MS = 24 * 60 * 60 * 1000

/** Daily dunning, off unless INVOICE_DUNNING=on. Off in tests. */
export function startDunningScheduler(): void {
  if (process.env.NODE_ENV === 'test' || process.env.INVOICE_DUNNING !== 'on') return
  const tick = () => withRunLock('invoice-dunning', () => runDunning())
    .then((r) => { if (r && (r.sent || r.failed)) console.log(`[dunning] ${r.sent} reminder(s) sent, ${r.failed} failed`) })
    .catch((e) => console.error('[dunning]', e instanceof Error ? e.message : e))
  setTimeout(tick, 60_000).unref?.()
  setInterval(tick, DAY_MS).unref?.()
  console.log('[dunning] overdue reminders armed — daily, at 7 / 15 / 30 days past due')
}
