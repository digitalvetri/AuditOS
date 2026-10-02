/**
 * Monthly per-client pull job — the "6-month retention" workaround.
 *
 * The e-way bill portal retains only the last six months of data. If the
 * firm wants to reconcile in March, the data from April must already be in
 * our store. That means the pull is a SCHEDULED job, not on-demand.
 *
 * This module is the wiring. In this build the pull itself is a stub — it
 * records a run row so the reconciliation store has a monthly entry, but
 * does not call the government portal (no credentials in a demo build).
 * When real IRP / EWB API access lands, only fetchAndStore() below changes.
 */
import type { PrismaClient } from '@prisma/client'

/** Interval between ticks. Kept short for demo purposes — a real
 *  deployment would run this once a day. */
const TICK_MS = 6 * 3_600_000 // every 6 hours

/** Format a Date as 'YYYY-MM'. */
function monthOf(d: Date): string { return d.toISOString().slice(0, 7) }

/**
 * Run the pull for a specific (client, kind, month). In this build we only
 * record the run; no data is fetched. Idempotent: a duplicate month/kind
 * combination on the same client is a no-op.
 */
async function fetchAndStore(prisma: PrismaClient, clientId: string, kind: 'ewb' | 'einvoice', month: string): Promise<void> {
  const existing = await prisma.eInvoiceEwbPullRun.findFirst({
    where: { clientId, kind, periodMonth: month, source: 'scheduled' },
  })
  if (existing) return
  await prisma.eInvoiceEwbPullRun.create({
    data: {
      clientId, kind, periodMonth: month,
      source: 'scheduled',
      status: 'ok',
      recordCount: 0,
      notes: 'Stub run — no external API call yet.',
    },
  })
}

/** Which months to make sure are present in the store, for each client. */
function monthsToCover(now: Date, howManyBack = 12): string[] {
  const months: string[] = []
  for (let i = 0; i < howManyBack; i += 1) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))
    months.push(monthOf(d))
  }
  return months
}

async function tick(prisma: PrismaClient): Promise<void> {
  const clients = await prisma.client.findMany({
    where: { deletedAt: null, eInvoiceEwbProfile: { isNot: null } },
    select: { id: true },
  })
  const months = monthsToCover(new Date(), 12)
  for (const c of clients) {
    for (const kind of ['ewb', 'einvoice'] as const) {
      for (const m of months) {
        try { await fetchAndStore(prisma, c.id, kind, m) } catch (e) {
          console.error(`[einvoice-ewb] pull failed`, { clientId: c.id, kind, month: m, e })
        }
      }
    }
  }
}

/** Wire the scheduler at server start. Off in tests. */
export function startEinvoiceEwbScheduler(prisma: PrismaClient): void {
  if (process.env.NODE_ENV === 'test') return
  // Fire once shortly after boot so the first month gets recorded without
  // waiting a full interval. Errors are caught inside tick().
  setTimeout(() => { tick(prisma).catch((e) => console.error('[einvoice-ewb] tick', e)) }, 5_000)
  setInterval(() => { tick(prisma).catch((e) => console.error('[einvoice-ewb] tick', e)) }, TICK_MS)
  console.log('[einvoice-ewb] scheduler armed — monthly pull will record every 6 hours')
}
