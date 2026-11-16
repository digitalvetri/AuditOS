/**
 * Compliance calendar reminders (docs/compliance/README.md "Reminders").
 *
 *  Staff  — the item's assignee (else the obligation's, else the client's
 *           account manager) gets one bell notification per stage: 7 days
 *           before, 1 day before, once overdue, then once a week while it
 *           stays unfiled (up to OVERDUE_LOOKBACK_DAYS). Stages are thresholds
 *           (days_left <= N), not exact days, so a day the server was down
 *           does not skip one. Deduped on Notification.entityId; the due date
 *           is in the key so an extension re-arms the reminders.
 *  Client — for obligations with remindClient: one email 7 days before the
 *           due date to the client's email on record ONLY, listing the item
 *           and any documents_pending items. Off unless SMTP is configured.
 *           lastClientReminderAt prevents repeats. WhatsApp too when the
 *           Business API is configured (lib/whatsapp.ts), best effort.
 */
import type { PrismaClient } from '@prisma/client'
import { addDays, daysBetween, fmtDate } from '../../lib/dates.js'
import { env } from '../../lib/env.js'
import { mailConfigured, sendMail } from '../../lib/mailer.js'
import { sendWhatsAppLink, whatsappConfigured } from '../../lib/whatsapp.js'
import { notifyEmployee } from '../../platform/notify.js'
import { entityTypeOf } from './engine.js'
import { CLOSED_STATUSES, pickExtension } from './service.js'

const EMAIL_RE = /^[^@\s,;<>]+@[^@\s,;<>]+\.[^@\s,;<>]+$/

interface OpenItem {
  id: string
  organisationId: string
  clientId: string
  formCode: string
  formName: string
  periodLabel: string
  due: string
  daysLeft: number
  status: string
  assignee: string | null
  remindClient: boolean
  lastClientReminderAt: Date | null
  client: { companyName: string; email: string | null; contactNumber: string; accountManagerId: string }
  /// Clock-item extensions (POST-DELIVERY-CHANGES §A). Null for every
  /// recurring-form item — those keep the 7/1 schedule.
  leadUpDays: number[] | null
  internalDue: string | null
  daysToInternal: number | null
  escalateTo: string | null
}

/** Open items of active obligations whose effective due date is within [today+lo, today+hi]. */
async function openItems(prisma: PrismaClient, today: string, lo: number, hi: number): Promise<OpenItem[]> {
  const extensions = await prisma.dueDateExtension.findMany({ where: { deletedAt: null } })
  const rows = await prisma.complianceItem.findMany({
    where: {
      deletedAt: null, status: { notIn: [...CLOSED_STATUSES] },
      OR: [
        { dueDate: { gte: addDays(today, lo), lte: addDays(today, hi) } },
        ...extensions.map((e) => ({ formCode: e.formCode, periodKey: e.periodKey })),
      ],
    },
  })
  if (!rows.length) return []
  const [obligations, clients, forms] = await Promise.all([
    prisma.clientObligation.findMany({ where: { clientId: { in: [...new Set(rows.map((r) => r.clientId))] }, isActive: true, deletedAt: null } }),
    prisma.client.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.clientId))] }, deletedAt: null },
      select: { id: true, companyName: true, email: true, contactNumber: true, accountManagerId: true, businessType: true },
    }),
    prisma.complianceForm.findMany({ select: { code: true, name: true, leadUpDays: true, escalateTo: true } }),
  ])
  const ob = new Map(obligations.map((o) => [`${o.clientId}|${o.formCode}`, o]))
  const cl = new Map(clients.map((c) => [c.id, c]))
  const fn = new Map(forms.map((f) => [f.code, f]))
  const out: OpenItem[] = []
  for (const r of rows) {
    const o = ob.get(`${r.clientId}|${r.formCode}`)
    const c = cl.get(r.clientId)
    if (!o || !c) continue
    const ext = pickExtension(extensions.filter((e) => e.organisationId === r.organisationId), r.formCode, r.periodKey, entityTypeOf(c.businessType))
    const due = ext?.newDueDate ?? r.dueDate
    const daysLeft = daysBetween(today, due)
    const internalDue = r.internalDueDate ?? null
    const daysToInternal = internalDue ? daysBetween(today, internalDue) : null
    // Window test: a clock item with internalDueDate stays in range if EITHER
    // the statutory OR the internal target is within the window. Without this
    // an INC-20A clock whose statutory is 180 days out but internal is 30 out
    // would be dropped by the current `daysLeft` check.
    const inWindow = (daysLeft >= lo && daysLeft <= hi)
      || (daysToInternal !== null && daysToInternal >= lo && daysToInternal <= hi)
    if (!inWindow) continue
    const form = fn.get(r.formCode)
    let leadUps: number[] | null = null
    if (form?.leadUpDays) {
      try {
        const parsed: unknown = JSON.parse(form.leadUpDays)
        if (Array.isArray(parsed) && parsed.every((n) => typeof n === 'number' && Number.isInteger(n) && n > 0)) {
          leadUps = parsed as number[]
        }
      } catch { /* leave as null; non-clock behaviour applies */ }
    }
    out.push({
      id: r.id, organisationId: r.organisationId, clientId: r.clientId,
      formCode: r.formCode, formName: form?.name ?? r.formCode, periodLabel: r.periodLabel,
      due, daysLeft, status: r.status,
      assignee: r.assignedEmployeeId ?? o.assignedEmployeeId ?? c.accountManagerId ?? null,
      remindClient: o.remindClient, lastClientReminderAt: r.lastClientReminderAt, client: c,
      leadUpDays: leadUps,
      internalDue,
      daysToInternal,
      escalateTo: form?.escalateTo ?? null,
    })
  }
  return out
}

/**
 * Overdue items keep reminding once a week until filed. Past a year the
 * bell stops: an item that old is a clean-up job for the calendar, not a
 * reminder, and the first run after enabling this must not flood the bell.
 */
export const OVERDUE_LOOKBACK_DAYS = 365

/**
 * Weekly overdue stage: days 1–7 late → 'overdue' (the key earlier versions
 * used, so nothing already sent is repeated), 8–14 → 'overdue-w2', and so on.
 */
export function overdueStage(daysLeft: number): string | null {
  if (daysLeft >= 0 || daysLeft < -OVERDUE_LOOKBACK_DAYS) return null
  const week = Math.floor((-daysLeft - 1) / 7) + 1
  return week === 1 ? 'overdue' : `overdue-w${week}`
}

const isOverdueStage = (stage: string) => stage === 'overdue' || stage.startsWith('overdue-w')

export function staffStage(daysLeft: number): 'd7' | 'd1' | string | null {
  if (daysLeft < 0) return overdueStage(daysLeft)
  if (daysLeft <= 1) return 'd1'
  if (daysLeft <= 7) return 'd7'
  return null
}

/**
 * Clock lead-up stage (POST-DELIVERY-CHANGES §A). Counts down from the
 * INTERNAL target (fallback to statutory when no internal is set). Fires
 * once per listed lead-up day, then once daily after the last lead-up and
 * before the internal target, and switches to 'overdue' once the statutory
 * date has passed.
 *
 * `leadUps` is the sorted-desc array from form.leadUpDays, e.g. [30,15,7,2,1].
 */
export function clockLeadUpStage(
  daysToInternal: number,
  daysToStatutory: number,
  leadUps: number[],
): { stage: string; timing: 'lead' | 'daily' | 'past_internal' | 'overdue' } | null {
  if (daysToStatutory < 0) {
    const stage = overdueStage(daysToStatutory)
    return stage ? { stage, timing: 'overdue' } : null
  }
  if (!leadUps.length) return null
  const minLead = Math.min(...leadUps)
  // Exact-lead day match: t30, t15, t7, …
  if (leadUps.includes(daysToInternal)) return { stage: `t${daysToInternal}`, timing: 'lead' }
  // Between the last lead-up (exclusive) and the internal target (inclusive)
  // the bell chimes daily, so a two-day server outage still reaches the
  // assignee on the next run.
  if (daysToInternal >= 0 && daysToInternal < minLead) return { stage: `daily-${daysToInternal}`, timing: 'daily' }
  // Past the internal target but statutory is still ahead: this is where the
  // firm starts spending political capital. One bell per day until statutory.
  if (daysToInternal < 0 && daysToStatutory >= 0) return { stage: `past_internal-${-daysToInternal}`, timing: 'past_internal' }
  return null
}

/**
 * Does the given clock stage warrant an escalation ring on top of the
 * assignee's ring? Fires at `t`-stages with ≤7 days to internal, then at
 * daily-*, past_internal-*, and overdue. This matches the doc's "escalate
 * at T-5" for Rule 10A while also catching INC-20A, whose lead-ups skip 5
 * but hit 7.
 */
export function shouldEscalateClockStage(stage: string): boolean {
  if (isOverdueStage(stage)) return true
  if (stage.startsWith('daily-') || stage.startsWith('past_internal-')) return true
  if (stage.startsWith('t')) {
    const n = Number(stage.slice(1))
    if (Number.isFinite(n) && n <= 7) return true
  }
  return false
}

/**
 * Employees whose user has the given role, scoped to the organisation.
 * Exposed so the scheduler can look up escalation recipients once per run.
 */
export async function escalationRecipients(
  prisma: PrismaClient,
  organisationId: string,
  roleCode: string,
): Promise<string[]> {
  const users = await prisma.user.findMany({
    where: {
      organisationId,
      isActive: true,
      employeeId: { not: null },
      role: { code: roleCode },
    },
    select: { employeeId: true },
  })
  return users.map((u) => u.employeeId).filter((id): id is string => !!id)
}

export async function sendComplianceStaffReminders(prisma: PrismaClient, today: string): Promise<number> {
  // Widened window: INC-20A's T-30 lead-up needs 30 days of forward look;
  // overdue items stay in view for OVERDUE_LOOKBACK_DAYS (weekly bells).
  // Clock items don't use the window gate the same way — openItems() checks
  // daysToInternal too.
  const items = await openItems(prisma, today, -OVERDUE_LOOKBACK_DAYS, 30)
  const notes = items.flatMap((i) => {
    if (!i.assignee) return []
    // Clock items with a leadUpDays schedule use the clock stager; everything
    // else keeps the existing d7 / d1 / overdue cadence.
    if (i.leadUpDays && i.daysToInternal !== null) {
      const resolved = clockLeadUpStage(i.daysToInternal, i.daysLeft, i.leadUpDays)
      if (!resolved) return []
      return [{ i, stage: resolved.stage, key: `compliance:${i.id}:${i.due}:${resolved.stage}` }]
    }
    const stage = staffStage(i.daysLeft)
    if (!stage) return []
    return [{ i, stage, key: `compliance:${i.id}:${i.due}:${stage}` }]
  })
  // Escalations (POST-DELIVERY-CHANGES §A). When a clock item hits an urgent
  // stage (t≤7 / daily / past_internal / overdue) and its form sets
  // escalateTo, the listed role is pulled into the notification. One extra
  // ring per recipient per stage — same dedupe discipline as the assignee
  // ring, different entityType so the two paths never collide.
  const escalations: Array<{ i: OpenItem; stage: string; employeeId: string; key: string }> = []
  const recipientCache = new Map<string, string[]>() // key: `${organisationId}|${roleCode}`
  for (const { i, stage } of notes) {
    if (!i.escalateTo || !i.leadUpDays) continue
    if (!shouldEscalateClockStage(stage)) continue
    const cacheKey = `${i.organisationId}|${i.escalateTo}`
    let recipients = recipientCache.get(cacheKey)
    if (!recipients) {
      recipients = await escalationRecipients(prisma, i.organisationId, i.escalateTo)
      recipientCache.set(cacheKey, recipients)
    }
    for (const employeeId of recipients) {
      // Don't double-ring the assignee: if the assignee IS one of the
      // escalation recipients (e.g. an MD acting as their own account
      // manager), the primary bell already covered them.
      if (employeeId === i.assignee) continue
      escalations.push({
        i, stage, employeeId,
        key: `compliance_escalation:${i.id}:${i.due}:${stage}:${employeeId}`,
      })
    }
  }

  if (!notes.length && !escalations.length) return 0
  const keys = [...notes.map((n) => n.key), ...escalations.map((e) => e.key)]
  const already = new Set((await prisma.notification.findMany({
    where: { entityType: { in: ['compliance_reminder', 'compliance_escalation'] }, entityId: { in: keys } },
    select: { entityId: true },
  })).map((n) => n.entityId))
  let sent = 0

  for (const { i, stage, key } of notes) {
    if (already.has(key)) continue
    const what = `${i.formName} (${i.periodLabel})`
    const isClock = !!i.leadUpDays
    const isOverdue = isOverdueStage(stage)
    const title = isOverdue
      ? `Overdue — ${i.client.companyName}`
      : isClock
        ? `${titleForClockStage(stage, i.daysToInternal ?? 0)} — ${i.client.companyName}`
        : `Due ${stage === 'd1' ? (i.daysLeft === 0 ? 'today' : 'tomorrow') : 'in a week'} — ${i.client.companyName}`
    const body = isOverdue
      ? `${what} was due ${fmtDate(i.due)}${overdueBy(i.daysLeft)}.`
      : isClock
        ? bodyForClockStage(what, i, stage)
        : `${what} is due ${fmtDate(i.due)}${i.daysLeft === 0 ? ' (today)' : ` (in ${i.daysLeft} day${i.daysLeft === 1 ? '' : 's'})`}.`
    const row = await notifyEmployee(i.assignee!, {
      type: 'compliance_reminder', module: 'workstation',
      title,
      body,
      entityType: 'compliance_reminder', entityId: key,
      actionUrl: `/workstation/compliance?client=${i.clientId}&item=${i.id}`,
    })
    if (row) sent++
  }

  for (const { i, stage, employeeId, key } of escalations) {
    if (already.has(key)) continue
    const what = `${i.formName} (${i.periodLabel})`
    const isOverdue = isOverdueStage(stage)
    const title = isOverdue
      ? `Escalation: overdue — ${i.client.companyName}`
      : `Escalation: ${titleForClockStage(stage, i.daysToInternal ?? 0).toLowerCase()} — ${i.client.companyName}`
    const body = isOverdue
      ? `${what} was due ${fmtDate(i.due)}${overdueBy(i.daysLeft)}. Assignee has not filed; escalated.`
      : `${what}. ${bodyForClockStage('', i, stage).replace(/^\. /, '').trim()} Assignee is still open.`
    const row = await notifyEmployee(employeeId, {
      type: 'compliance_escalation', module: 'workstation',
      title,
      body,
      entityType: 'compliance_escalation', entityId: key,
      actionUrl: `/workstation/compliance?client=${i.clientId}&item=${i.id}`,
    })
    if (row) sent++
  }

  return sent
}

const overdueBy = (daysLeft: number) => (daysLeft < 0 ? ` (${-daysLeft} day${daysLeft === -1 ? '' : 's'} overdue)` : '')

function titleForClockStage(stage: string, daysToInternal: number): string {
  if (stage.startsWith('t')) {
    const n = Number(stage.slice(1))
    return n === 0 ? 'Internal target today' : n === 1 ? 'Internal target tomorrow' : `Internal target in ${n} days`
  }
  if (stage.startsWith('daily-')) {
    const n = Number(stage.slice('daily-'.length))
    return n === 0 ? 'Internal target today' : `Internal target in ${n} day${n === 1 ? '' : 's'}`
  }
  if (stage.startsWith('past_internal-')) {
    const n = Number(stage.slice('past_internal-'.length))
    return `Past internal target — ${n} day${n === 1 ? '' : 's'}`
  }
  return daysToInternal > 0 ? `Due in ${daysToInternal} days` : 'Due'
}

function bodyForClockStage(what: string, i: OpenItem, stage: string): string {
  const parts: string[] = []
  if (i.internalDue) parts.push(`Internal target ${fmtDate(i.internalDue)}`)
  parts.push(`Statutory deadline ${fmtDate(i.due)}`)
  if (stage.startsWith('past_internal-')) {
    parts.push("The firm's internal target has passed; the statutory deadline is still ahead.")
  }
  return `${what}. ${parts.join(' · ')}.`
}

/** 10-digit Indian mobile → 91XXXXXXXXXX; anything else unusable. */
function waNumber(raw: string): string | null {
  const d = raw.replace(/\D/g, '')
  if (/^[6-9]\d{9}$/.test(d)) return `91${d}`
  if (/^91[6-9]\d{9}$/.test(d)) return d
  return null
}

export async function sendComplianceClientReminders(prisma: PrismaClient, today: string): Promise<{ emails: number; whatsapp: number }> {
  if (!mailConfigured()) return { emails: 0, whatsapp: 0 }
  const due = (await openItems(prisma, today, 0, 7)).filter((i) => i.remindClient && !i.lastClientReminderAt)
  const byClient = new Map<string, OpenItem[]>()
  for (const i of due) byClient.set(i.clientId, [...(byClient.get(i.clientId) ?? []), i])
  let emails = 0
  let whatsapp = 0
  for (const [clientId, items] of byClient) {
    const client = items[0].client
    const to = client.email?.trim().toLowerCase()
    if (!to || !EMAIL_RE.test(to)) continue
    const pending = await prisma.complianceItem.findMany({
      where: { clientId, deletedAt: null, status: 'documents_pending', id: { notIn: items.map((i) => i.id) } },
      select: { formCode: true, periodLabel: true },
    })
    const lines = items.map((i) => `  • ${i.formName} — ${i.periodLabel}: due ${fmtDate(i.due)}${i.status === 'documents_pending' ? ' (we are waiting for your documents)' : ''}`)
    const pendingLines = pending.map((p) => `  • ${p.formCode} — ${p.periodLabel}`)
    const text = [
      `Dear ${client.companyName},`,
      '',
      'This is a reminder of the following compliance due in the next week:',
      ...lines,
      ...(pendingLines.length ? ['', 'We are also waiting for your documents for:', ...pendingLines] : []),
      '',
      'Please share any documents or information still pending so we can file on time.',
      '',
      'Regards',
    ].join('\n')
    try {
      await sendMail({ to: [to], subject: `Compliance due soon — ${items.map((i) => i.formName).slice(0, 3).join(', ')}${items.length > 3 ? '…' : ''}`, text })
    } catch (e) {
      console.warn('[compliance] client reminder not sent', e instanceof Error ? e.message : e)
      continue
    }
    emails++
    await prisma.complianceItem.updateMany({ where: { id: { in: items.map((i) => i.id) } }, data: { lastClientReminderAt: new Date() } })
    const wa = whatsappConfigured() ? waNumber(client.contactNumber ?? '') : null
    if (wa) {
      const link = env.webOrigins[0] ?? ''
      await sendWhatsAppLink({ to: wa, recipientName: client.companyName, link, body: `${text}\n\n${link}`.trim() })
        .then(() => { whatsapp++ })
        .catch((e) => console.warn('[compliance] WhatsApp reminder not sent', e instanceof Error ? e.message : e))
    }
  }
  return { emails, whatsapp }
}
