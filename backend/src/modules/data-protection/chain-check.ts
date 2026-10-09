/**
 * Daily audit-log chain check. Recomputes the AuditLog hash chain
 * (platform/audit.ts) and, if a link is broken, logs loudly and notifies
 * every active Admin / Super Admin (in-app bell) — once per broken row per
 * day. Runs under an advisory lock so only one API process does the walk.
 */
import type { PrismaClient } from '@prisma/client'
import { verifyAuditChain, type ChainReport } from '../../platform/audit.js'
import { notifyUser } from '../../platform/notify.js'
import { istToday } from '../../lib/dates.js'
import { runExclusive } from '../compliance/scheduler.js'

const DAY_MS = 24 * 60 * 60 * 1000
const ADMIN_ROLES = ['md', 'hr_admin']

export async function runAuditChainCheck(
  prisma: PrismaClient,
  opts: { verify?: () => Promise<ChainReport>; today?: string } = {},
): Promise<{ report: ChainReport; notified: number }> {
  const report = await (opts.verify ?? (() => verifyAuditChain()))()
  if (report.ok) return { report, notified: 0 }

  const b = report.first_broken!
  console.error(
    `[audit-chain] !!! AUDIT LOG CHAIN BROKEN at seq ${b.seq} (${b.reason}, row ${b.id}, written ${b.created_at}). `
    + `Rows may have been edited or deleted outside the application. ${report.checked} rows verified before the break.`,
  )
  const today = opts.today ?? istToday()
  const key = `audit_chain:${b.seq}:${today}`
  const already = await prisma.notification.findFirst({ where: { entityType: 'audit_chain_broken', entityId: key }, select: { id: true } })
  if (already) return { report, notified: 0 }

  const admins = await prisma.user.findMany({
    where: { isActive: true, deletedAt: null, role: { code: { in: ADMIN_ROLES } } },
    select: { id: true },
  })
  for (const a of admins) {
    await notifyUser({
      userId: a.id, type: 'audit_chain_broken', module: 'system',
      title: 'Audit log integrity check failed',
      body: `The audit trail's hash chain is broken at entry #${b.seq} (${b.reason.replace(/_/g, ' ')}). An entry may have been edited or deleted directly in the database. Investigate before relying on the log.`,
      entityType: 'audit_chain_broken', entityId: key, actionUrl: '/hrms/settings',
    })
  }
  return { report, notified: admins.length }
}

/** Wire the daily check at server boot. Off in tests. */
export function startAuditChainScheduler(prisma: PrismaClient): void {
  if (process.env.NODE_ENV === 'test') return
  const tick = () => runExclusive(prisma, 'audit_chain_check', () => runAuditChainCheck(prisma))
    .then((r) => { if (r?.report.ok) console.log(`[audit-chain] verified ${r.report.checked} entries — chain intact`) })
    .catch((e) => console.error('[audit-chain] check failed to run', e instanceof Error ? e.message : e))
  setTimeout(tick, 60_000).unref?.()
  setInterval(tick, DAY_MS).unref?.()
}
