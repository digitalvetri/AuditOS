import fs from 'node:fs'
import path from 'node:path'
import webpush from 'web-push'
import { prisma } from '../lib/prisma.js'

/**
 * Web Push (§8.9) — the notification reaches a phone or desktop even when no
 * AuditOS tab is open. The service worker shows it; this module only sends.
 *
 * Keys come from VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT. Outside
 * production, missing keys are generated once and kept in `.vapid-keys.json`
 * (gitignored) so local push works out of the box. In production, missing keys
 * mean push is simply off — the in-app realtime feed still works.
 */
interface Keys { publicKey: string; privateKey: string; subject: string }

let keys: Keys | null | undefined

function loadKeys(): Keys | null {
  if (keys !== undefined) return keys
  const subject = process.env.VAPID_SUBJECT || 'mailto:admin@auditos.local'
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    keys = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY, subject }
  } else if (process.env.NODE_ENV !== 'production' && !process.env.VITEST) {
    const file = path.resolve(process.cwd(), '.vapid-keys.json')
    try {
      keys = { ...JSON.parse(fs.readFileSync(file, 'utf8')), subject }
    } catch {
      const generated = webpush.generateVAPIDKeys()
      fs.writeFileSync(file, JSON.stringify(generated, null, 2))
      keys = { ...generated, subject }
    }
  } else {
    keys = null
  }
  if (keys) webpush.setVapidDetails(keys.subject, keys.publicKey, keys.privateKey)
  return keys ?? null
}

export function pushPublicKey(): string | null {
  return loadKeys()?.publicKey ?? null
}

export interface PushPayload {
  id: string
  title: string
  body: string
  action_url: string | null
  module: string
}

/** Fan a notification out to every browser the user subscribed. Never throws. */
export async function sendPushToUser(userId: string, payload: PushPayload): Promise<void> {
  if (!loadKeys()) return
  const subs = await prisma.pushSubscription.findMany({ where: { userId } })
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify(payload),
        { TTL: 60 * 60 * 24, urgency: 'high' },
      )
      await prisma.pushSubscription.update({ where: { id: s.id }, data: { lastUsedAt: new Date() } })
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode
      // Gone / not found: the browser dropped this subscription — forget it.
      if (status === 404 || status === 410) {
        await prisma.pushSubscription.deleteMany({ where: { id: s.id } })
      }
    }
  }))
}
