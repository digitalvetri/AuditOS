/**
 * Daily compliance jobs: generate calendar items, staff and client
 * reminders, notice reply-deadline reminders, DSC expiry alerts.
 *
 * Each job runs under a Postgres advisory lock taken with
 * pg_try_advisory_xact_lock inside a transaction that spans the run, so when
 * two API processes tick together only one runs the job; the other skips
 * (rather than queueing behind it and running it again). The job body uses
 * the global client; the transaction only holds the lock.
 */
import type { PrismaClient } from '@prisma/client'
import { istToday } from '../../lib/dates.js'
import { defaultFys, generateItems } from './service.js'
import { sendComplianceClientReminders, sendComplianceStaffReminders } from './reminders.js'
import { sendNoticeReminders } from '../notices-register/reminders.js'
import { sendDscAlerts } from '../dsc/alerts.js'
import { sendArticleshipFormAlerts } from '../articleship/service.js'

const DAY_MS = 24 * 60 * 60 * 1000

/** Run `fn` only if no other process holds `name`. Null when skipped. */
export async function runExclusive<T>(prisma: PrismaClient, name: string, fn: () => Promise<T>): Promise<T | null> {
  return prisma.$transaction(async (tx) => {
    const [row] = await tx.$queryRaw<{ ok: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtext(${`job:${name}`})) AS ok`
    if (!row?.ok) return null
    return fn()
  }, { maxWait: 10_000, timeout: 30 * 60_000 })
}

export interface ComplianceJobReport {
  generated: Awaited<ReturnType<typeof generateItems>> | null
  staff_reminders: number | null
  client_reminders: Awaited<ReturnType<typeof sendComplianceClientReminders>> | null
  notice_reminders: number | null
  dsc_alerts: number | null
  articleship_form_alerts: number | null
}

export async function runComplianceJobs(prisma: PrismaClient, today = istToday()): Promise<ComplianceJobReport> {
  const step = async <T>(name: string, fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await runExclusive(prisma, name, fn)
    } catch (e) {
      console.error(`[compliance] ${name}`, e instanceof Error ? e.message : e)
      return null
    }
  }
  return {
    generated: await step('compliance.generate', () => generateItems(prisma, { fys: defaultFys(today), today })),
    staff_reminders: await step('compliance.staff_reminders', () => sendComplianceStaffReminders(prisma, today)),
    client_reminders: await step('compliance.client_reminders', () => sendComplianceClientReminders(prisma, today)),
    notice_reminders: await step('compliance.notice_reminders', () => sendNoticeReminders(prisma, today)),
    dsc_alerts: await step('compliance.dsc_alerts', () => sendDscAlerts(prisma, today)),
    // ICAI Form 103 / 108 / 109 reminders for articled assistants.
    articleship_form_alerts: await step('articleship.form_alerts', () => sendArticleshipFormAlerts(prisma, today)),
  }
}

/** Wire the daily job at server boot. Off in tests. */
export function startComplianceScheduler(prisma: PrismaClient): void {
  if (process.env.NODE_ENV === 'test') return
  const tick = () => runComplianceJobs(prisma)
    .then((r) => console.log('[compliance] daily jobs', JSON.stringify(r)))
    .catch((e) => console.error('[compliance] daily jobs', e))
  setTimeout(tick, 20_000)
  setInterval(tick, DAY_MS)
  console.log('[compliance] daily job armed — calendar, reminders, notices, DSC expiry')
}
