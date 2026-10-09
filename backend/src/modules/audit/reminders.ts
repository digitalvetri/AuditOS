/**
 * Audit file assembly reminder — SA 230 expects the file assembled within
 * 60 days of the report date. Once a signed file passes its assemblyDueDate
 * without being locked, its signing partner gets a bell notification, once
 * per day (the notification entityId carries the date).
 */
import type { PrismaClient } from '@prisma/client'
import { notifyEmployee } from '../../platform/notify.js'
import { istToday } from '../../lib/dates.js'

const TICK_MS = 6 * 60 * 60 * 1000

export async function sendAuditAssemblyReminders(prisma: PrismaClient, today = istToday()): Promise<number> {
  const files = await prisma.auditEngagement.findMany({
    where: { deletedAt: null, status: 'signed', lockedAt: null, assemblyDueDate: { lte: today }, signingPartnerId: { not: null } },
    select: { id: true, auditCode: true, title: true, clientId: true, assemblyDueDate: true, signingPartnerId: true },
  })
  if (!files.length) return 0
  const keys = files.map((f) => `audit_assembly:${f.id}:${today}`)
  const already = new Set((await prisma.notification.findMany({
    where: { entityType: 'audit_assembly_reminder', entityId: { in: keys } }, select: { entityId: true },
  })).map((n) => n.entityId))
  const clients = new Map((await prisma.client.findMany({
    where: { id: { in: files.map((f) => f.clientId) } }, select: { id: true, companyName: true },
  })).map((c) => [c.id, c.companyName]))
  let sent = 0
  for (const f of files) {
    const key = `audit_assembly:${f.id}:${today}`
    if (already.has(key)) continue
    const r = await notifyEmployee(f.signingPartnerId!, {
      type: 'audit_assembly_reminder', module: 'workstation',
      title: `Audit file not locked — ${f.auditCode}`,
      body: `${clients.get(f.clientId) ?? f.title}: the file was due for assembly on ${f.assemblyDueDate}. Lock it once assembled.`,
      entityType: 'audit_assembly_reminder', entityId: key, actionUrl: `/workstation/audits/${f.id}`,
    })
    if (r) sent++
  }
  return sent
}

/** Wire the reminder job at server start. Off in tests. */
export function startAuditReminderScheduler(prisma: PrismaClient): void {
  if (process.env.NODE_ENV === 'test') return
  const tick = () => sendAuditAssemblyReminders(prisma)
    .then((n) => { if (n) console.log(`[audit-files] ${n} assembly reminder${n === 1 ? '' : 's'} sent`) })
    .catch((e) => console.error('[audit-files] reminders', e))
  setTimeout(tick, 20_000)
  setInterval(tick, TICK_MS)
}
