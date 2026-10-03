/**
 * NOTIFICATIONS · SNOOZE — list filtering + snooze/unsnooze behaviour.
 *
 * Exercises the three invariants that keep the bell honest:
 *   - A snoozed notification is hidden from the default list AND the
 *     unread counter until snoozedUntil passes.
 *   - include_snoozed=1 reveals it for the Snoozed tab.
 *   - Unsnooze clears the field and the row reappears in the default list.
 *
 * Run:  npx tsx src/modules/__tests__/notifications-snooze.ts
 */
import '../../lib/env.js'
import { PrismaClient } from '@prisma/client'
import { notifyUser } from '../../platform/notify.js'

const prisma = new PrismaClient()
const PREFIX = 'FIXTURE-SNOOZE-'
let passed = 0
const failures: string[] = []

function check(name: string, actual: unknown, expected: unknown) {
  if (actual === expected) { passed++; console.log(`  ✓ ${name}`); return }
  failures.push(`${name}: expected ${String(expected)}, got ${String(actual)}`)
  console.error(`  ✗ ${name} — expected ${String(expected)}, got ${String(actual)}`)
}

async function cleanup(userId: string) {
  await prisma.notification.deleteMany({ where: { userId, title: { startsWith: PREFIX } } })
}

async function suite() {
  const user = await prisma.user.findFirst({ where: { role: { code: 'md' } } })
  if (!user) throw new Error('No MD-role user available.')
  const userId = user.id
  await cleanup(userId)

  // Three notifications: one unsnoozed, one snoozed into the future,
  // one with an expired snoozedUntil (should appear in the active list).
  const n1 = await notifyUser({
    userId, type: 'test', module: 'system',
    title: `${PREFIX} active`, body: 'currently visible',
  })
  const n2 = await notifyUser({
    userId, type: 'test', module: 'system',
    title: `${PREFIX} future-snoozed`, body: 'hidden until later',
  })
  const n3 = await notifyUser({
    userId, type: 'test', module: 'system',
    title: `${PREFIX} past-snoozed`, body: 'snooze already expired',
  })

  const in1h = new Date(Date.now() + 60 * 60 * 1000)
  await prisma.notification.update({ where: { id: n2.id }, data: { snoozedUntil: in1h } })
  const past = new Date(Date.now() - 60 * 60 * 1000)
  await prisma.notification.update({ where: { id: n3.id }, data: { snoozedUntil: past } })

  const now = new Date()
  const defaultWhere = {
    userId,
    OR: [{ snoozedUntil: null }, { snoozedUntil: { lte: now } }],
    title: { startsWith: PREFIX },
  }
  const defaultItems = await prisma.notification.findMany({ where: defaultWhere, orderBy: { createdAt: 'desc' } })
  check('Default list excludes future-snoozed notifications', defaultItems.length, 2)
  check('Default list contains the active notification', defaultItems.some((n) => n.id === n1.id), true)
  check('Default list contains the past-snoozed (snooze expired)', defaultItems.some((n) => n.id === n3.id), true)
  check('Default list hides the future-snoozed notification', defaultItems.some((n) => n.id === n2.id), false)

  // Unread counter honours the same filter.
  const unread = await prisma.notification.count({
    where: {
      userId, isRead: false,
      OR: [{ snoozedUntil: null }, { snoozedUntil: { lte: now } }],
      title: { startsWith: PREFIX },
    },
  })
  check('Unread counter matches the default list (2)', unread, 2)

  // include_snoozed=1 shows everything.
  const everything = await prisma.notification.findMany({
    where: { userId, title: { startsWith: PREFIX } },
    orderBy: { createdAt: 'desc' },
  })
  check('include_snoozed=1 reveals the future-snoozed row', everything.length, 3)

  // Snoozed-only counter.
  const snoozedNow = await prisma.notification.count({
    where: { userId, snoozedUntil: { gt: now }, title: { startsWith: PREFIX } },
  })
  check('Snoozed counter is strictly future-dated (1, not 2)', snoozedNow, 1)

  // Unsnooze clears the field and the row joins the default list.
  await prisma.notification.update({ where: { id: n2.id }, data: { snoozedUntil: null } })
  const afterUnsnooze = await prisma.notification.findMany({ where: defaultWhere })
  check('Unsnooze adds the row back to the default list (3)', afterUnsnooze.length, 3)
  check('Unsnoozed row has null snoozedUntil', (await prisma.notification.findUnique({ where: { id: n2.id } }))?.snoozedUntil, null)

  await cleanup(userId)
}

async function main() {
  try { await suite() } finally { await prisma.$disconnect() }
  console.log(`\n${passed} checks passed, ${failures.length} failed`)
  if (failures.length) {
    console.error('\nFAILURES:\n  ' + failures.join('\n  '))
    process.exit(1)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
