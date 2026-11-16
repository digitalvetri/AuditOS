/**
 * Background Zoho Books sync. Every few minutes, each active organisation
 * whose snapshot is older than its auto-refresh interval is synced through
 * ITS OWN connection (syncOrganization loads it from the organisation row) —
 * independent of what any user has selected, so data never crosses
 * organisations. One organisation at a time keeps well under Zoho's limits.
 */
import { prisma } from '../../lib/prisma.js'
import { nameUnnamedConnections } from './connection.js'
import { syncOrganization } from './routes.js'

const TICK_MS = 5 * 60_000
/**
 * A sync still marked "syncing" this long after it started died with its
 * process (deploy, crash): treat it as failed and run it again. syncOrganization
 * records the interrupted run in the sync log as failed.
 */
export const STALE_SYNC_MS = 30 * 60_000

/**
 * One pass: sync every due organisation. Returns what it did, for tests and logs.
 * Organisations paused after Zoho's daily API limit wait until the pause ends.
 * `only` limits the pass to the given organisations (tests share one database).
 */
export async function runBooksSyncPass(now = new Date(), opts: { only?: string[] } = {}): Promise<{ synced: string[]; failed: string[] }> {
  const orgs = await prisma.booksZohoOrganization.findMany({
    where: {
      isActive: true, autoRefreshMinutes: { gt: 0 }, connection: { status: 'connected', deletedAt: null },
      OR: [{ syncPausedUntil: null }, { syncPausedUntil: { lte: now } }],
      ...(opts.only ? { id: { in: opts.only } } : {}),
    },
    select: { id: true, name: true, lastSyncAt: true, autoRefreshMinutes: true, syncStatus: true, lastSyncAttemptAt: true },
  })
  const synced: string[] = []
  const failed: string[] = []
  for (const o of orgs) {
    const stuck = o.syncStatus === 'syncing' && (!o.lastSyncAttemptAt || now.getTime() - o.lastSyncAttemptAt.getTime() >= STALE_SYNC_MS)
    const due = stuck || !o.lastSyncAt || now.getTime() - o.lastSyncAt.getTime() >= o.autoRefreshMinutes * 60_000
    if (!due || (o.syncStatus === 'syncing' && !stuck)) continue
    try {
      await syncOrganization(o.id, 'scheduled', null)
      synced.push(o.id)
    } catch {
      failed.push(o.id) // recorded on the organisation and in its sync log
    }
  }
  return { synced, failed }
}

let timer: NodeJS.Timeout | null = null
export function startBooksSyncScheduler() {
  if (process.env.NODE_ENV === 'test' || timer) return
  // Connections made before names existed get one ("Main Account") — tokens untouched.
  nameUnnamedConnections().then((n) => { if (n) console.log(`[books] named ${n} existing Zoho connection(s)`) }).catch(() => undefined)
  timer = setInterval(() => {
    runBooksSyncPass().catch((e) => console.error('[books] scheduled sync failed:', e instanceof Error ? e.message : 'unknown'))
  }, TICK_MS)
  timer.unref?.()
  console.log('[books] background sync armed — due organisations every 5 min, each through its own connection')
}
