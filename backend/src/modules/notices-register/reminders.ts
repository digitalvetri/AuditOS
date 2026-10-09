/**
 * Notice reply-deadline reminders: 7, 3 and 1 days before responseDueDate,
 * for ClientNotice and GstNotice rows whose reply is still owed. The owner
 * (assignee, else the client's account manager) gets one bell notification
 * per stage; thresholds, not exact days, so a missed day does not skip one.
 */
import type { PrismaClient } from '@prisma/client'
import { addDays, daysBetween, fmtDate } from '../../lib/dates.js'
import { notifyEmployee } from '../../platform/notify.js'

export function noticeStage(daysLeft: number): 'd7' | 'd3' | 'd1' | null {
  if (daysLeft < 0) return null
  if (daysLeft <= 1) return 'd1'
  if (daysLeft <= 3) return 'd3'
  if (daysLeft <= 7) return 'd7'
  return null
}

export async function sendNoticeReminders(prisma: PrismaClient, today: string): Promise<number> {
  const window = { gte: today, lte: addDays(today, 7) }
  const [own, gst] = await Promise.all([
    prisma.clientNotice.findMany({ where: { deletedAt: null, status: { in: ['received', 'in_progress'] }, responseDueDate: window } }),
    prisma.gstNotice.findMany({ where: { deletedAt: null, status: { in: ['draft', 'review'] }, responseDueDate: window } }),
  ])
  const rows = [
    ...own.map((n) => ({ id: n.id, src: 'notice', clientId: n.clientId, due: n.responseDueDate!, owner: n.assignedEmployeeId, label: `${n.section}${n.referenceNo ? ` (${n.referenceNo})` : ''}`, url: `/workstation/notices-register?notice=${n.id}` })),
    ...gst.map((n) => ({ id: n.id, src: 'gst', clientId: n.clientId, due: n.responseDueDate!, owner: n.assignedEmployeeId, label: `GST ${n.kind}${n.referenceNo ? ` (${n.referenceNo})` : ''}`, url: `/workstation/services/registration/gst/clients/${n.clientId}` })),
  ]
  if (!rows.length) return 0
  const clients = new Map((await prisma.client.findMany({
    where: { id: { in: [...new Set(rows.map((r) => r.clientId))] }, deletedAt: null },
    select: { id: true, companyName: true, accountManagerId: true },
  })).map((c) => [c.id, c]))
  const notes = rows.flatMap((r) => {
    const stage = noticeStage(daysBetween(today, r.due))
    const c = clients.get(r.clientId)
    if (!stage || !c) return []
    return [{ r, c, stage, key: `notice:${r.src}:${r.id}:${r.due}:${stage}` }]
  })
  const already = new Set((await prisma.notification.findMany({
    where: { entityType: 'notice_reminder', entityId: { in: notes.map((n) => n.key) } }, select: { entityId: true },
  })).map((n) => n.entityId))
  let sent = 0
  for (const { r, c, stage, key } of notes) {
    if (already.has(key)) continue
    const owner = r.owner ?? c.accountManagerId
    if (!owner) continue
    const left = daysBetween(today, r.due)
    const row = await notifyEmployee(owner, {
      type: 'notice_reminder', module: 'workstation',
      title: `Notice reply due ${left === 0 ? 'today' : `in ${left} day${left === 1 ? '' : 's'}`} — ${c.companyName}`,
      body: `Reply to ${r.label} is due ${fmtDate(r.due)}. (${stage === 'd7' ? '7' : stage === 'd3' ? '3' : '1'}-day reminder)`,
      entityType: 'notice_reminder', entityId: key, actionUrl: r.url,
    })
    if (row) sent++
  }
  return sent
}
