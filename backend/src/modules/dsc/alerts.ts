/**
 * DSC expiry alerts — 30, 15 and 7 days before expiry.
 *
 * The threshold crossed is the smallest of 30/15/7 that is >= days left. An
 * alert fires only when that threshold is below `lastAlertDays` (or none has
 * fired), so each threshold fires at most once and a DSC first entered with
 * 5 days left gets one (7-day) alert, not three. Renewal (a new expiry date)
 * resets `lastAlertDays` — see PATCH /api/dsc/:id.
 *
 * Client DSC: the client's account manager gets a bell notification and a
 * follow-up on the Workstation dashboard. Firm DSC (no client): everyone
 * holding workstation.dsc.manage at organisation scope is notified.
 */
import type { PrismaClient } from '@prisma/client'
import { daysBetween, fmtDate } from '../../lib/dates.js'
import { notifyEmployee, notifyPermissionHolders } from '../../platform/notify.js'

export const DSC_THRESHOLDS = [30, 15, 7] as const

export function dscThreshold(daysLeft: number, lastAlertDays: number | null): number | null {
  const crossed = [...DSC_THRESHOLDS].sort((a, b) => a - b).find((t) => daysLeft <= t)
  if (crossed === undefined) return null
  if (lastAlertDays !== null && lastAlertDays <= crossed) return null
  return crossed
}

export async function sendDscAlerts(prisma: PrismaClient, today: string): Promise<number> {
  const rows = await prisma.digitalSignature.findMany({ where: { deletedAt: null } })
  let sent = 0
  for (const d of rows) {
    const left = daysBetween(today, d.expiryDate)
    if (left < -30) continue // long expired: nothing new to say
    const t = dscThreshold(left, d.lastAlertDays)
    if (t === null) continue
    // Claim the threshold first: two runs cannot both alert.
    const claimed = await prisma.digitalSignature.updateMany({
      where: { id: d.id, lastAlertDays: d.lastAlertDays },
      data: { lastAlertDays: t },
    })
    if (!claimed.count) continue
    const title = left < 0 ? `DSC expired — ${d.holderName}` : `DSC expires in ${left} day${left === 1 ? '' : 's'} — ${d.holderName}`
    const body = `${d.holderName}${d.holderRole ? ` (${d.holderRole})` : ''}: ${d.dscClass} DSC ${left < 0 ? 'expired' : 'expires'} ${fmtDate(d.expiryDate)}. Arrange renewal.`
    const input = {
      type: 'dsc_expiry', module: 'workstation' as const, title, body,
      entityType: 'dsc_expiry', entityId: `dsc:${d.id}:${d.expiryDate}:${t}`,
      actionUrl: `/workstation/dsc${d.clientId ? `?client=${d.clientId}` : ''}`,
    }
    if (d.clientId) {
      const c = await prisma.client.findFirst({ where: { id: d.clientId }, select: { id: true, companyName: true, accountManagerId: true } })
      if (!c) continue
      await notifyEmployee(c.accountManagerId, { ...input, title: `${title} (${c.companyName})` })
      await prisma.followUp.create({
        data: {
          organisationId: d.organisationId, clientId: c.id,
          title: `Renew DSC of ${d.holderName} — expires ${fmtDate(d.expiryDate)}`,
          type: 'other', scheduledAt: new Date(), assignedEmployeeId: c.accountManagerId,
          notes: `DSC expiry alert (${t}-day). ${d.provider ? `Provider: ${d.provider}. ` : ''}${d.tokenSerial ? `Token: ${d.tokenSerial}.` : ''}`.trim(),
        },
      })
    } else {
      await notifyPermissionHolders('workstation.dsc.manage', input)
    }
    sent++
  }
  return sent
}
