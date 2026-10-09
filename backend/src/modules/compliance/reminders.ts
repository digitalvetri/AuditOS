/**
 * Compliance calendar reminders (docs/compliance/README.md "Reminders").
 *
 *  Staff  — the item's assignee (else the obligation's, else the client's
 *           account manager) gets one bell notification per stage: 7 days
 *           before, 1 day before, and once overdue. Stages are thresholds
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
    prisma.complianceForm.findMany({ select: { code: true, name: true } }),
  ])
  const ob = new Map(obligations.map((o) => [`${o.clientId}|${o.formCode}`, o]))
  const cl = new Map(clients.map((c) => [c.id, c]))
  const fn = new Map(forms.map((f) => [f.code, f.name]))
  const out: OpenItem[] = []
  for (const r of rows) {
    const o = ob.get(`${r.clientId}|${r.formCode}`)
    const c = cl.get(r.clientId)
    if (!o || !c) continue
    const ext = pickExtension(extensions.filter((e) => e.organisationId === r.organisationId), r.formCode, r.periodKey, entityTypeOf(c.businessType))
    const due = ext?.newDueDate ?? r.dueDate
    const daysLeft = daysBetween(today, due)
    if (daysLeft < lo || daysLeft > hi) continue
    out.push({
      id: r.id, clientId: r.clientId, formCode: r.formCode, formName: fn.get(r.formCode) ?? r.formCode, periodLabel: r.periodLabel,
      due, daysLeft, status: r.status,
      assignee: r.assignedEmployeeId ?? o.assignedEmployeeId ?? c.accountManagerId ?? null,
      remindClient: o.remindClient, lastClientReminderAt: r.lastClientReminderAt, client: c,
    })
  }
  return out
}

export function staffStage(daysLeft: number): 'd7' | 'd1' | 'overdue' | null {
  if (daysLeft < -7) return null // first enabled long after: don't flood the bell
  if (daysLeft < 0) return 'overdue'
  if (daysLeft <= 1) return 'd1'
  if (daysLeft <= 7) return 'd7'
  return null
}

export async function sendComplianceStaffReminders(prisma: PrismaClient, today: string): Promise<number> {
  const items = await openItems(prisma, today, -7, 7)
  const notes = items.flatMap((i) => {
    const stage = staffStage(i.daysLeft)
    if (!stage || !i.assignee) return []
    return [{ i, stage, key: `compliance:${i.id}:${i.due}:${stage}` }]
  })
  if (!notes.length) return 0
  const already = new Set((await prisma.notification.findMany({
    where: { entityType: 'compliance_reminder', entityId: { in: notes.map((n) => n.key) } }, select: { entityId: true },
  })).map((n) => n.entityId))
  let sent = 0
  for (const { i, stage, key } of notes) {
    if (already.has(key)) continue
    const what = `${i.formName} (${i.periodLabel})`
    const row = await notifyEmployee(i.assignee!, {
      type: 'compliance_reminder', module: 'workstation',
      title: stage === 'overdue' ? `Overdue — ${i.client.companyName}` : `Due ${stage === 'd1' ? (i.daysLeft === 0 ? 'today' : 'tomorrow') : 'in a week'} — ${i.client.companyName}`,
      body: stage === 'overdue'
        ? `${what} was due ${fmtDate(i.due)}.`
        : `${what} is due ${fmtDate(i.due)}${i.daysLeft === 0 ? ' (today)' : ` (in ${i.daysLeft} day${i.daysLeft === 1 ? '' : 's'})`}.`,
      entityType: 'compliance_reminder', entityId: key,
      actionUrl: `/workstation/compliance?client=${i.clientId}&item=${i.id}`,
    })
    if (row) sent++
  }
  return sent
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
