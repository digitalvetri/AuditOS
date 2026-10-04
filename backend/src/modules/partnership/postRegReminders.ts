/**
 * PRIVATE LIMITED — POST-REGISTRATION REMINDERS (bell + push).
 *
 * Every open INC-20A / ADTC row with a trigger date reminds the people on the
 * case (assigned, reviewer, approver) and the client's account manager:
 *   - every `reminderEveryDays` after the trigger date (INC-20A: 20, ADTC: 7),
 *     and keeps going once overdue, until the compliance is marked completed;
 *   - on the due date itself.
 *
 * Runs at boot and every few hours. Each (row, period) is sent once: the
 * notification's entityId is the row id plus the period, and an existing row
 * with that key means it was already sent. Only the CURRENT period is sent —
 * a company incorporated months ago gets one reminder, not a backlog.
 */
import type { PrismaClient } from '@prisma/client'
import { notifyEmployees } from '../../platform/notify.js'
import { RULE, complianceState, daysBetween } from './compliance.js'
import { today as todayIst } from './service.js'

const TICK_MS = 6 * 60 * 60 * 1000
const fmt = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
const plural = (n: number) => `${n} day${n === 1 ? '' : 's'}`

export async function sendPostRegistrationReminders(prisma: PrismaClient, today = todayIst()): Promise<number> {
  const rows = await prisma.postRegistrationCompliance.findMany({
    where: { completedOn: null, triggerDate: { not: null }, dueDate: { not: null }, case: { deletedAt: null, kind: 'PRIVATE_LIMITED', status: 'COMPLETED' } },
    include: { case: { select: { id: true, assignedEmployeeId: true, reviewerEmployeeId: true, approverEmployeeId: true, client: { select: { companyName: true, accountManagerId: true } } } } },
  })
  const notes: { key: string; title: string; body: string; url: string; to: (string | null)[] }[] = []
  for (const r of rows) {
    const rule = RULE.get(r.code)
    if (!rule || !r.triggerDate || !r.dueDate) continue
    const elapsed = daysBetween(r.triggerDate, today)
    const { status, daysRemaining } = complianceState(r, today)
    const onDueDate = daysRemaining === 0
    const period = Math.floor(elapsed / rule.reminderEveryDays)
    if (!onDueDate && period < 1) continue
    const name = r.case.client.companyName
    const left = daysRemaining ?? 0
    notes.push({
      key: `postreg:${r.id}:${onDueDate ? 'due' : `p${period}`}`,
      title: status === 'OVERDUE' ? `${rule.label} overdue — ${name}` : onDueDate ? `${rule.label} due today — ${name}` : `${rule.label} reminder — ${name}`,
      body: `${rule.title} ${status === 'OVERDUE' ? `was due ${fmt(r.dueDate)} — overdue by ${plural(-left)}` : onDueDate ? `is due today (${fmt(r.dueDate)})` : `is due ${fmt(r.dueDate)} — ${plural(left)} remaining`}. Mark it completed once filed.`,
      url: `/workstation/services/registration/private-limited/clients/${r.case.id}?tab=compliance`,
      to: [r.case.assignedEmployeeId, r.case.reviewerEmployeeId, r.case.approverEmployeeId, r.case.client.accountManagerId],
    })
  }
  if (!notes.length) return 0
  const already = new Set((await prisma.notification.findMany({
    where: { entityType: 'post_registration_reminder', entityId: { in: notes.map((n) => n.key) } },
    select: { entityId: true },
  })).map((n) => n.entityId))
  let sent = 0
  for (const n of notes) {
    if (already.has(n.key)) continue
    await notifyEmployees(n.to, {
      type: 'post_registration_reminder', module: 'workstation', title: n.title, body: n.body,
      entityType: 'post_registration_reminder', entityId: n.key, actionUrl: n.url,
    })
    sent++
  }
  return sent
}

/** Wire the reminder job at server start. Off in tests. */
export function startPostRegistrationReminderScheduler(prisma: PrismaClient): void {
  if (process.env.NODE_ENV === 'test') return
  const tick = () => sendPostRegistrationReminders(prisma)
    .then((n) => { if (n) console.log(`[post-registration] ${n} reminder${n === 1 ? '' : 's'} sent`) })
    .catch((e) => console.error('[post-registration] reminders', e))
  setTimeout(tick, 20_000)
  setInterval(tick, TICK_MS)
  console.log('[post-registration] reminder job armed — INC-20A / ADTC checked every 6 hours')
}
