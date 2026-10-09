/**
 * GST reminders — surfaces return filings that are due within DUE_SOON_DAYS
 * (default 3) or overdue, writes idempotent bell notifications to the GST
 * profile's assignee, and (when SMTP is configured) lets the operator shoot
 * a one-click reminder email to the client's address on record.
 *
 * The business rule follows the TDS reminder pattern (see
 * backend/src/modules/tds/reminders.ts): dedupe on
 * `notification.entityType = 'gst_reminder' + entityId = <stable key>`, so
 * the scheduler can tick every few hours without spamming the bell. For
 * every (client, kind, period) that enters the window, exactly one
 * notification is written, and never again until the window closes
 * (filing complete, period rolls over, or dueDate is extended).
 *
 * Dashboard parity: the three states this module emits reminders for are
 * the same three the dashboard shows as `due` or `overdue`, resolved via
 * `createRuleResolver` so the CBIC calendar + per-period overrides are
 * respected without duplicating the lookup.
 */
import type { PrismaClient } from '@prisma/client'
import { notifyEmployee } from '../../platform/notify.js'
import { mailConfigured, sendMail } from '../../lib/mailer.js'
import { ApiError } from '../../lib/http.js'
import { addDays, istToday } from '../../lib/dates.js'
import {
  createRuleResolver, kindsOwed, stateGroupOf, type FilingFrequency, type ReturnKind,
} from './dueDate.js'

export const DUE_SOON_DAYS = 3
/** How far back an unfinished return can still surface as overdue. */
const OVERDUE_LOOKBACK_MONTHS = 12
const MAX_CC = 5
const TICK_MS = 6 * 60 * 60 * 1000

const KIND_LABEL: Record<ReturnKind, string> = {
  GSTR1: 'GSTR-1', GSTR2B: 'GSTR-2B / IMS', GSTR3B: 'GSTR-3B',
}

/** `YYYY-MM` that is `back` months before the month `iso` (YYYY-MM-DD) falls in. */
function periodBefore(iso: string, back: number): string {
  const d = new Date(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1 - back, 1))
  return d.toISOString().slice(0, 7)
}
function fmt(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  })
}

export interface UpcomingItem {
  key: string
  caseId: string | null
  clientId: string
  clientName: string
  clientEmail: string | null
  gstin: string
  assignedEmployeeId: string | null
  reviewerEmployeeId: string | null
  kind: ReturnKind
  period: string
  dueDate: string
  state: 'due' | 'overdue'
  daysToDue: number
}

/**
 * Walk every active GST profile, resolve each return's (status, due date)
 * via the shared rule resolver, and return the rows that are either `due`
 * within DUE_SOON_DAYS or already `overdue`. Called by both the HTTP
 * endpoint (which filters by the operator's visible clients) and the
 * scheduler (which runs org-wide).
 *
 * Periods: a return is FOR period M and falls due in M+1 (see applyDay),
 * so without an explicit `period` we evaluate the previous month — whose
 * returns fall due this month — plus the current month (hand-set or
 * CBIC-overridden case dates). A quarterly filer's period is the
 * quarter-end month, so the previous month also covers the quarter that
 * just closed.
 *
 * Older periods (up to OVERDUE_LOOKBACK_MONTHS back) stay on the list while
 * their case is still open — an overdue return must not silently drop out
 * just because the month rolled over. Older periods WITHOUT a case are not
 * guessed at: nothing records whether they were filed (the client may
 * predate the firm), and flagging all of them would flood every bell.
 * Nothing before the profile's registration date is ever flagged.
 *
 * Which returns are owed per period comes from `kindsOwed`: GSTR-2B every
 * month for everyone, GSTR-1/3B only in quarter-end months for QRMP filers,
 * none of the three for composition dealers.
 *
 * The `clientIdFilter` is applied by the caller — the compute step is
 * scope-agnostic so the scheduler can reach every client even when no
 * operator session exists.
 */
export async function computeUpcoming(
  prisma: PrismaClient,
  opts: { period?: string; today?: string; clientIdFilter?: string[] } = {},
): Promise<UpcomingItem[]> {
  const today = opts.today ?? istToday()
  const recent = opts.period ? [opts.period] : [periodBefore(today, 1), today.slice(0, 7)]
  const older = opts.period
    ? []
    : Array.from({ length: OVERDUE_LOOKBACK_MONTHS - 1 }, (_, i) => periodBefore(today, i + 2))
  const windowEnd = addDays(today, DUE_SOON_DAYS)

  const profiles = await prisma.gstProfile.findMany({
    where: {
      deletedAt: null,
      active: true,
      ...(opts.clientIdFilter ? { clientId: { in: opts.clientIdFilter } } : {}),
    },
    include: { client: { select: { id: true, companyName: true, email: true } } },
  })
  if (profiles.length === 0) return []

  const cases = await prisma.partnershipCase.findMany({
    where: {
      deletedAt: null,
      kind: { in: ['GSTR1', 'GSTR2B', 'GSTR3B'] },
      period: { in: [...recent, ...older] },
      clientId: { in: profiles.map((p) => p.clientId) },
    },
    select: { id: true, clientId: true, kind: true, period: true, status: true, dueDate: true },
  })
  const caseByKey = new Map<string, (typeof cases)[number]>()
  for (const c of cases) caseByKey.set(`${c.clientId}::${c.kind}::${c.period}`, c)

  const resolver = await createRuleResolver(prisma)
  const out: UpcomingItem[] = []

  for (const p of profiles) {
    const freq = p.filingFrequency as FilingFrequency
    const group = stateGroupOf(p)
    const regPeriod = p.registrationDate && /^\d{4}-\d{2}/.test(p.registrationDate)
      ? p.registrationDate.slice(0, 7) : null
    for (const period of [...recent, ...older]) {
      if (regPeriod && period < regPeriod) continue
      const isOlder = !recent.includes(period)
      for (const kind of kindsOwed(p, period)) {
        const c = caseByKey.get(`${p.clientId}::${kind}::${period}`)
        if (c?.status === 'COMPLETED') continue
        if (isOlder && !c) continue // no open case → nothing to say it is unfiled
        const due = c?.dueDate ?? resolver.resolve(period, kind, freq, group)
        if (!due) continue
        // In window = (due in [today, today+N]) OR overdue (due < today).
        let state: 'due' | 'overdue' | null = null
        if (due < today) state = 'overdue'
        else if (due <= windowEnd) state = 'due'
        if (!state) continue
        // Days remaining — negative for overdue, 0 for today, 1-N for due.
        const daysToDue = Math.round((Date.parse(`${due}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000)
        out.push({
          key: `gst:${p.clientId}:${kind}:${period}:${state}`,
          caseId: c?.id ?? null,
          clientId: p.clientId,
          clientName: p.client.companyName,
          clientEmail: p.client.email ?? null,
          gstin: p.gstin,
          assignedEmployeeId: p.assignedEmployeeId ?? null,
          reviewerEmployeeId: p.reviewerEmployeeId ?? null,
          kind,
          period,
          dueDate: due,
          state,
          daysToDue,
        })
      }
    }
  }

  // Overdue first (negative daysToDue), then due soon.
  out.sort((a, b) => a.daysToDue - b.daysToDue)
  return out
}

/**
 * Scheduler tick. For every org-wide upcoming return, send ONE bell
 * notification to the GST profile's assignee. Deduped by the entityId key
 * so repeated ticks never fire a second time for the same (client, kind,
 * period, state) pair. Returns the count actually fired.
 */
export async function sendGstReminders(
  prisma: PrismaClient,
  opts: { today?: string } = {},
): Promise<number> {
  const items = await computeUpcoming(prisma, { today: opts.today })
  if (items.length === 0) return 0

  const existing = new Set(
    (await prisma.notification.findMany({
      where: {
        entityType: 'gst_reminder',
        entityId: { in: items.map((i) => i.key) },
      },
      select: { entityId: true },
    })).map((n) => n.entityId),
  )

  let sent = 0
  for (const i of items) {
    if (existing.has(i.key)) continue
    if (!i.assignedEmployeeId) continue
    const title = i.state === 'overdue'
      ? `${KIND_LABEL[i.kind]} overdue — ${i.clientName}`
      : `${KIND_LABEL[i.kind]} due soon — ${i.clientName}`
    const body = i.state === 'overdue'
      ? `${KIND_LABEL[i.kind]} for ${i.period} was due ${fmt(i.dueDate)} (${Math.abs(i.daysToDue)} day${Math.abs(i.daysToDue) === 1 ? '' : 's'} overdue).`
      : `${KIND_LABEL[i.kind]} for ${i.period} is due ${fmt(i.dueDate)}${i.daysToDue === 0 ? ' — today' : ` (in ${i.daysToDue} day${i.daysToDue === 1 ? '' : 's'})`}.`
    const actionUrl = i.caseId
      ? `/workstation/registration/gst?caseId=${i.caseId}`
      : `/workstation/registration/gst?client=${i.clientId}&kind=${i.kind}&period=${i.period}`
    const row = await notifyEmployee(i.assignedEmployeeId, {
      type: 'gst_reminder',
      module: 'workstation',
      title,
      body,
      entityType: 'gst_reminder',
      entityId: i.key,
      actionUrl,
    })
    if (row) sent++
  }
  return sent
}

/** Wire the scheduler at server boot. No-op in tests. */
export function startGstReminderScheduler(prisma: PrismaClient): void {
  if (process.env.NODE_ENV === 'test') return
  const tick = () => sendGstReminders(prisma)
    .then((n) => { if (n) console.log(`[gst] ${n} reminder${n === 1 ? '' : 's'} sent`) })
    .catch((e) => console.error('[gst] reminders', e))
  // First tick a few seconds after boot so a cold start doesn't block
  // startup health checks.
  setTimeout(tick, 15_000)
  setInterval(tick, TICK_MS)
  console.log('[gst] reminder job armed — checks GST deadlines every 6 hours')
}

/**
 * Fire an email reminder to the client. Uses the firm's SMTP config
 * (see mailer.ts). The subject + body are templated here and the operator
 * can override before sending.
 *
 * Recipients are LOCKED so this can never act as an open mail relay:
 *   - `to` must be an address the firm already holds for this client — the
 *     client record's email, the GST profile's contact email, or a live
 *     client contact's email. Blank → the client record's email.
 *   - `cc` is at most MAX_CC addresses, each either one of those client
 *     addresses or a staff member (user / employee) of the client's firm.
 * Anything else is refused with 422 BEFORE the SMTP check, so the lock
 * holds whether or not mail is configured.
 */
export interface SendClientReminderInput {
  caseId?: string | null
  clientId: string
  kind: ReturnKind
  period: string
  dueDate: string
  subject: string
  body: string
  to: string
  cc?: string[]
}
export interface SendClientReminderResult {
  messageId: string
  to: string
  cc: string[]
  sentAt: string
}

const norm = (e: string) => e.trim().toLowerCase()
const EMAIL_RE = /^[^@\s,;<>]+@[^@\s,;<>]+\.[^@\s,;<>]+$/

/** Every address on record for a client, normalised. */
export async function clientAddresses(prisma: PrismaClient, clientId: string): Promise<{ primary: string | null; all: Set<string> }> {
  const [client, profile, contacts] = await Promise.all([
    prisma.client.findFirst({ where: { id: clientId, deletedAt: null }, select: { email: true } }),
    prisma.gstProfile.findFirst({ where: { clientId, deletedAt: null }, select: { contactEmail: true } }),
    prisma.clientContact.findMany({ where: { clientId, deletedAt: null, email: { not: null } }, select: { email: true } }),
  ])
  const all = new Set<string>()
  for (const e of [client?.email, profile?.contactEmail, ...contacts.map((c) => c.email)]) {
    if (e && EMAIL_RE.test(e.trim())) all.add(norm(e))
  }
  return { primary: client?.email ? norm(client.email) : null, all }
}

/**
 * Validate (and default) the recipients of a client reminder. Exported so
 * the route and tests can exercise the lock without sending mail.
 */
export async function resolveReminderRecipients(
  prisma: PrismaClient,
  clientId: string,
  toInput: string,
  ccInput: string[] | undefined,
): Promise<{ to: string; cc: string[] }> {
  const client = await prisma.client.findFirst({
    where: { id: clientId, deletedAt: null },
    select: { id: true, organisationId: true },
  })
  if (!client) throw ApiError.notFound('No such client.')
  const { primary, all } = await clientAddresses(prisma, clientId)

  const to = toInput.trim() ? norm(toInput) : primary
  if (!to) {
    throw ApiError.unprocessable('no_client_email', 'This client has no email address on record. Add one to the client before sending reminders.')
  }
  if (!EMAIL_RE.test(to) || !all.has(to)) {
    throw ApiError.unprocessable(
      'recipient_not_on_record',
      'Reminders can only be sent to an email address on record for this client (client, GST contact or client contact).',
    )
  }

  const cc = Array.from(new Set((ccInput ?? []).map(norm).filter(Boolean))).filter((e) => e !== to)
  if (cc.length > MAX_CC) {
    throw ApiError.unprocessable('too_many_cc', `At most ${MAX_CC} cc addresses are allowed.`)
  }
  const notClient = cc.filter((e) => !all.has(e))
  if (notClient.length) {
    if (notClient.some((e) => !EMAIL_RE.test(e))) {
      throw ApiError.unprocessable('cc_not_allowed', 'A cc address is not a valid email.')
    }
    const [users, employees] = await Promise.all([
      prisma.user.findMany({
        where: { organisationId: client.organisationId, email: { in: notClient, mode: 'insensitive' } },
        select: { email: true },
      }),
      prisma.employee.findMany({
        where: { organisationId: client.organisationId, email: { in: notClient, mode: 'insensitive' } },
        select: { email: true },
      }),
    ])
    const staff = new Set([...users, ...employees].map((r) => norm(r.email)))
    const rejected = notClient.filter((e) => !staff.has(e))
    if (rejected.length) {
      throw ApiError.unprocessable(
        'cc_not_allowed',
        "cc may only include this client's contacts or staff of the firm.",
        { rejected },
      )
    }
  }
  return { to, cc }
}

export async function sendClientReminder(
  prisma: PrismaClient,
  input: SendClientReminderInput,
  actorUserId: string | null,
): Promise<SendClientReminderResult> {
  // Recipient lock first — refuses foreign addresses even with SMTP off.
  const { to, cc } = await resolveReminderRecipients(prisma, input.clientId, input.to, input.cc)
  if (!mailConfigured()) {
    throw ApiError.unprocessable(
      'mail_not_configured',
      'SMTP is not set up on this server. Ask your admin to configure SMTP_HOST / SMTP_USER / SMTP_PASS in settings before sending reminders.',
    )
  }
  const client = await prisma.client.findFirst({
    where: { id: input.clientId, deletedAt: null },
    select: { id: true, companyName: true },
  })
  if (!client) throw ApiError.notFound('No such client.')
  const subject = input.subject?.trim() || defaultReminderSubject({ clientName: client.companyName, kind: input.kind, period: input.period, dueDate: input.dueDate })
  const body = input.body?.trim() || defaultReminderBody({ clientName: client.companyName, kind: input.kind, period: input.period, dueDate: input.dueDate })

  const messageId = await sendMail({
    to: [to],
    cc: cc.length ? cc : undefined,
    subject,
    text: body,
  })

  // History stamp: a notification row with a stable key so a second send to
  // the same (case/kind/period) is distinguishable in history. Not deduped —
  // the operator may legitimately send a second nudge later.
  const sentAtIso = new Date().toISOString()
  await prisma.notification.create({
    data: {
      userId: actorUserId ?? '',
      type: 'gst_reminder_sent',
      module: 'workstation',
      title: `Reminder sent — ${subject}`,
      body: `To ${to}. ${KIND_LABEL[input.kind]} for ${input.period}.`,
      entityType: 'gst_reminder_sent',
      entityId: `gst_sent:${input.clientId}:${input.kind}:${input.period}:${sentAtIso}`,
      actionUrl: input.caseId ? `/workstation/registration/gst?caseId=${input.caseId}` : null,
    },
  }).catch(() => undefined) // best-effort — the mail already went out

  return { messageId, to, cc, sentAt: sentAtIso }
}

export function defaultReminderSubject(opts: { clientName: string; kind: ReturnKind; period: string; dueDate: string }): string {
  return `Reminder: ${KIND_LABEL[opts.kind]} for ${opts.period} due on ${fmt(opts.dueDate)}`
}

export function defaultReminderBody(opts: { clientName: string; kind: ReturnKind; period: string; dueDate: string }): string {
  return [
    `Dear ${opts.clientName},`,
    '',
    `This is a reminder that your ${KIND_LABEL[opts.kind]} return for the period ${opts.period} is due on ${fmt(opts.dueDate)}.`,
    '',
    'Please share any pending documents (invoices, bank statements, purchase bills, expense vouchers) at the earliest so we can prepare and file the return on time.',
    '',
    'If the documents have already been shared, kindly disregard this message.',
    '',
    'Regards,',
    'Compliance team',
  ].join('\n')
}
