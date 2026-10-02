/**
 * TDS reminders — tells each client's account manager, in the bell menu,
 * when a challan / return / certificate falls due within DUE_SOON_DAYS,
 * when it goes overdue, and when the weekly TRACES check is due.
 *
 * Runs at boot and every few hours. Each (item, stage) is notified once:
 * the notification's entityId is the item key plus the stage, and an
 * existing row with that key means it was already sent.
 */
import type { PrismaClient } from '@prisma/client'
import { notifyEmployee } from '../../platform/notify.js'
import { fyOf, todayIst, addDays } from './calendar.js'
import { buildOverview } from './overview.js'

const TICK_MS = 6 * 60 * 60 * 1000
const SLUG: Record<string, string> = {
  challan: 'challan-payment', return: 'return-filing', certificate: 'form-16', challan_statement_cert: 'challan-statements',
}
const fmt = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })

export async function sendTdsReminders(prisma: PrismaClient, today = todayIst()): Promise<number> {
  // The FY in progress, and the previous one until its last returns (31 May) are past.
  const fys = [...new Set([fyOf(today), fyOf(addDays(today, -75))])]
  let sent = 0
  for (const fy of fys) {
    const rows = await buildOverview(prisma, 'ALL', fy, today)
    for (const row of rows) {
      if (!row.tan) continue
      const url = (slug: string) => `/workstation/services/tds/${slug}?client=${row.client_id}&fy=${fy}&tan=${row.tan}`
      const notes: { key: string; title: string; body: string; url: string }[] = []
      for (const i of row.open_items) {
        const stage = i.state === 'overdue' ? 'overdue' : i.due_soon ? 'due_soon' : null
        if (!stage) continue
        notes.push({
          key: `tds:${row.client_id}:${row.tan}:${fy}:${i.kind}:${i.period}:${i.formType ?? ''}:${stage}`,
          title: stage === 'overdue' ? `TDS overdue — ${row.client_name}` : `TDS due soon — ${row.client_name}`,
          body: `${i.label} (TAN ${row.tan}) ${stage === 'overdue' ? 'was due' : 'is due'} ${fmt(i.due)}.`,
          url: url(SLUG[i.kind] ?? ''),
        })
      }
      // Weekly TRACES check: one reminder per ISO week it stays unchecked.
      if (row.notice_check_stale && fy === fyOf(today)) {
        const week = Math.floor(Date.parse(`${today}T00:00:00Z`) / (7 * 86_400_000))
        notes.push({
          key: `tds:${row.client_id}:${row.tan}:notice_check:${week}`,
          title: `TRACES check due — ${row.client_name}`,
          body: `Check TRACES for defaults (TAN ${row.tan}). ${row.last_notice_check ? `Last checked ${fmt(row.last_notice_check)}.` : 'Never checked.'}`,
          url: url('notices'),
        })
      }
      if (!notes.length) continue
      const already = new Set((await prisma.notification.findMany({
        where: { entityType: 'tds_reminder', entityId: { in: notes.map((n) => n.key) } },
        select: { entityId: true },
      })).map((n) => n.entityId))
      for (const n of notes) {
        if (already.has(n.key)) continue
        const r = await notifyEmployee(row.account_manager_id, {
          type: 'tds_reminder', module: 'workstation', title: n.title, body: n.body,
          entityType: 'tds_reminder', entityId: n.key, actionUrl: n.url,
        })
        if (r) sent++
      }
    }
  }
  return sent
}

/** Wire the reminder job at server start. Off in tests. */
export function startTdsReminderScheduler(prisma: PrismaClient): void {
  if (process.env.NODE_ENV === 'test') return
  const tick = () => sendTdsReminders(prisma)
    .then((n) => { if (n) console.log(`[tds] ${n} reminder${n === 1 ? '' : 's'} sent`) })
    .catch((e) => console.error('[tds] reminders', e))
  setTimeout(tick, 15_000)
  setInterval(tick, TICK_MS)
  console.log('[tds] reminder job armed — checks due dates every 6 hours')
}
