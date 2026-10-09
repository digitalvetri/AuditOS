import { withRunLock } from './run-lock.js'
import { runDueProfiles } from './service.js'

const TICK_MS = 6 * 60 * 60 * 1000

/**
 * Raise due retainer invoices — at boot and every 6 hours (a missed tick is
 * caught up on the next one; each period is raised once whatever the
 * cadence). One process at a time via the run lock. Off in tests.
 */
export function startRecurringInvoiceScheduler(): void {
  if (process.env.NODE_ENV === 'test') return
  const tick = () => withRunLock('recurring-invoices', () => runDueProfiles())
    .then((r) => { if (r && (r.created || r.failed)) console.log(`[recurring] ${r.created} invoice(s) raised, ${r.failed} failed`) })
    .catch((e) => console.error('[recurring]', e instanceof Error ? e.message : e))
  setTimeout(tick, 30_000).unref?.()
  setInterval(tick, TICK_MS).unref?.()
  console.log('[recurring] retainer invoices armed — due profiles every 6 hours')
}
