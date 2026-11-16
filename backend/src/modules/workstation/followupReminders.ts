/**
 * Follow-up reminders and "missed".
 *
 *  - Reminder: a pending follow-up with `reminderMinutesBefore` set rings its
 *    assignee's bell once, from `scheduledAt − reminderMinutesBefore` until
 *    the follow-up's time. The notification key carries the scheduled time,
 *    so rescheduling re-arms the reminder. Null minutes = no reminder.
 *  - Missed: a follow-up still pending after its scheduled (IST) day has
 *    ended is marked `missed`. Until then it is simply overdue. Missed ones
 *    still count as overdue, so they are not lost from the to-do list.
 */
import type { PrismaClient } from '@prisma/client'
import { notifyEmployee } from '../../platform/notify.js'

const TICK_MS = 5 * 60 * 1000
/** Never look further ahead than the largest reminder allowed (7 days). */
export const MAX_REMINDER_MINUTES = 10_080

/** The UTC instant at which today's IST day began. */
function istDayStart(now: Date): Date {
  const ist = new Date(now.getTime() + 5.5 * 3_600_000)
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) - 5.5 * 3_600_000)
}

const istTime = (d: Date) => d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

export async function sendFollowUpReminders(prisma: PrismaClient, now = new Date()): Promise<{ reminded: number; missed: number }> {
  // 1. Missed: pending, and its IST day is over.
  const missed = await prisma.followUp.updateMany({
    where: { deletedAt: null, status: 'pending', scheduledAt: { lt: istDayStart(now) } },
    data: { status: 'missed' },
  })

  // 2. Reminders due now: scheduled between now and the longest reminder ahead.
  const upcoming = await prisma.followUp.findMany({
    where: {
      deletedAt: null, status: 'pending', reminderMinutesBefore: { not: null },
      scheduledAt: { gt: now, lte: new Date(now.getTime() + MAX_REMINDER_MINUTES * 60_000) },
    },
    select: {
      id: true, title: true, scheduledAt: true, reminderMinutesBefore: true, assignedEmployeeId: true,
      client: { select: { companyName: true } }, lead: { select: { name: true } },
    },
  })
  const due = upcoming.filter((f) => f.scheduledAt.getTime() - f.reminderMinutesBefore! * 60_000 <= now.getTime())
  if (!due.length) return { reminded: 0, missed: missed.count }
  const keyOf = (f: { id: string; scheduledAt: Date }) => `followup_reminder:${f.id}:${f.scheduledAt.toISOString()}`
  const already = new Set((await prisma.notification.findMany({
    where: { type: 'followup.reminder', entityId: { in: due.map(keyOf) } }, select: { entityId: true },
  })).map((n) => n.entityId))
  let reminded = 0
  for (const f of due) {
    const key = keyOf(f)
    if (already.has(key)) continue
    const subject = f.client?.companyName ?? f.lead?.name ?? null
    const r = await notifyEmployee(f.assignedEmployeeId, {
      type: 'followup.reminder', module: 'system',
      title: `Follow-up at ${istTime(f.scheduledAt)}`,
      body: subject ? `${f.title} · ${subject}` : f.title,
      entityType: 'FollowUp', entityId: key, actionUrl: '/workstation/follow-ups',
    })
    if (r) reminded++
  }
  return { reminded, missed: missed.count }
}

/** Wire the job at server start. Off in tests. */
export function startFollowUpReminderScheduler(prisma: PrismaClient): void {
  if (process.env.NODE_ENV === 'test') return
  const tick = () => sendFollowUpReminders(prisma)
    .then(({ reminded, missed }) => {
      if (reminded || missed) console.log(`[follow-ups] ${reminded} reminder(s) sent, ${missed} marked missed`)
    })
    .catch((e) => console.error('[follow-ups] reminders', e))
  setTimeout(tick, 30_000)
  setInterval(tick, TICK_MS)
}
