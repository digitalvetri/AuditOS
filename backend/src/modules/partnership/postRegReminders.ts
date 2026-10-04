/**
 * POST-REGISTRATION REMINDERS (bell + push) — Private Limited and LLP.
 *
 * Every open compliance row with a trigger date reminds its assignee, the
 * people on the case (assigned, reviewer, approver) and the client's account
 * manager, on the schedule its rule sets (compliance.ts → ReminderRule):
 *   - INC-20A / ADTC: every 20 / 7 days after the trigger date;
 *   - LLP Form 3: at 20, 10 and 3 days left;
 *   - all: on the due date, and repeatedly while overdue, until completed.
 *
 * Runs at boot and every few hours. Each (row, period) is sent once: the
 * notification's entityId is the row id plus the period key, and an existing
 * row with that key means it was already sent. Only the CURRENT period is
 * sent — a company incorporated months ago gets one reminder, not a backlog.
 */
import type { PrismaClient } from '@prisma/client'
import { notifyEmployees } from '../../platform/notify.js'
import { COMPLIANCE_KINDS, RULE, complianceState, reminderKey, reminderMessage } from './compliance.js'
import { today as todayIst } from './service.js'

const TICK_MS = 6 * 60 * 60 * 1000
const SLUG: Record<string, string> = { PRIVATE_LIMITED: 'private-limited', LLP: 'llp' }
const fmt = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })

export async function sendPostRegistrationReminders(prisma: PrismaClient, today = todayIst()): Promise<number> {
  const rows = await prisma.postRegistrationCompliance.findMany({
    where: { completedOn: null, triggerDate: { not: null }, dueDate: { not: null }, case: { deletedAt: null, kind: { in: [...COMPLIANCE_KINDS] }, status: 'COMPLETED' } },
    include: { case: { select: { id: true, kind: true, assignedEmployeeId: true, reviewerEmployeeId: true, approverEmployeeId: true, client: { select: { companyName: true, accountManagerId: true } } } } },
  })
  const notes: { key: string; title: string; body: string; url: string; to: (string | null)[] }[] = []
  for (const r of rows) {
    const rule = RULE.get(r.code)
    const period = reminderKey(r, today)
    if (!rule || !period || !r.dueDate) continue
    const state = complianceState(r, today)
    const name = r.case.client.companyName
    notes.push({
      key: `postreg:${r.id}:${period}`,
      title: state.status === 'OVERDUE' ? `${rule.label} overdue — ${name}` : period === 'due' ? `${rule.label} due today — ${name}` : `${rule.label} reminder — ${name}`,
      body: `${reminderMessage(rule.label, name, state)} ${rule.title} — due ${fmt(r.dueDate)}. Mark it completed once filed.`,
      url: `/workstation/services/registration/${SLUG[r.case.kind] ?? 'llp'}/clients/${r.case.id}?tab=compliance`,
      to: [r.assignedEmployeeId, r.case.assignedEmployeeId, r.case.reviewerEmployeeId, r.case.approverEmployeeId, r.case.client.accountManagerId],
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
  console.log('[post-registration] reminder job armed — INC-20A / ADTC / LLP Form 3 checked every 6 hours')
}
