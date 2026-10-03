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

/** One pass: sync every due organisation. Returns what it did, for tests and logs. */
export async function runBooksSyncPass(now = new Date()): Promise<{ synced: string[]; failed: string[] }> {
  const orgs = await prisma.booksZohoOrganization.findMany({
    where: { isActive: true, autoRefreshMinutes: { gt: 0 }, connection: { status: 'connected', deletedAt: null } },
    select: { id: true, name: true, lastSyncAt: true, autoRefreshMinutes: true, syncStatus: true },
  })
  const synced: string[] = []
  const failed: string[] = []
  for (const o of orgs) {
    const due = !o.lastSyncAt || now.getTime() - o.lastSyncAt.getTime() >= o.autoRefreshMinutes * 60_000
    if (!due || o.syncStatus === 'syncing') continue
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
