/**
 * GST reminders — computeUpcoming + sendGstReminders.
 *
 * Builds a fixture company / client / GST profile / return cases, then
 * exercises:
 *   - computeUpcoming returns the right set (today-anchored window)
 *   - sendGstReminders creates one bell notification per upcoming item
 *   - a second tick creates no new notifications (dedup via entityId)
 *   - sendClientReminder refuses when SMTP is unconfigured
 *   - defaultReminderSubject / defaultReminderBody are stable + helpful
 *
 * Run:  npx tsx src/modules/gst/__tests__/reminders.ts
 */
import '../../../lib/env.js'
import { PrismaClient } from '@prisma/client'
import { computeUpcoming, defaultReminderBody, defaultReminderSubject, sendClientReminder, sendGstReminders } from '../reminders.js'

const prisma = new PrismaClient()
const PREFIX = 'FIXTURE-GST-REM-'
let passed = 0
const failures: string[] = []

function check(name: string, actual: unknown, expected: unknown) {
  const ok = actual === expected
  if (ok) { passed++; console.log(`  ✓ ${name}`); return }
  failures.push(`${name}: expected ${String(expected)}, got ${String(actual)}`)
  console.error(`  ✗ ${name} — expected ${String(expected)}, got ${String(actual)}`)
}

const ONE_DAY = 86_400_000
function iso(d: Date) { return d.toISOString().slice(0, 10) }

async function cleanup(organisationId: string) {
  const clients = await prisma.client.findMany({ where: { organisationId, companyName: { startsWith: PREFIX } } })
  const clientIds = clients.map((c) => c.id)
  if (clientIds.length === 0) return
  await prisma.notification.deleteMany({ where: { entityType: { in: ['gst_reminder', 'gst_reminder_sent'] }, entityId: { contains: ':', mode: 'insensitive' }, title: { contains: PREFIX } } })
  await prisma.partnershipCase.deleteMany({ where: { clientId: { in: clientIds } } })
  await prisma.gstProfile.deleteMany({ where: { clientId: { in: clientIds } } })
  await prisma.notification.deleteMany({ where: { entityType: 'gst_reminder', entityId: { contains: clientIds[0] ?? '__none__' } } })
  for (const id of clientIds) {
    await prisma.notification.deleteMany({ where: { entityId: { contains: id } } })
  }
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } })
}

async function suite() {
  // Pick any existing organisation + account manager — the fixture is
  // additive, we never alter their rows.
  const user = await prisma.user.findFirst({ where: { role: { code: 'md' } } })
  if (!user) throw new Error('No MD-role user available for the fixture suite.')
  const organisationId = user.organisationId
  const accountManagerId = user.employeeId ?? user.id
  await cleanup(organisationId)

  // Dates anchored around "today" so the window check is meaningful.
  const today = new Date()
  const in2Days = iso(new Date(today.getTime() + 2 * ONE_DAY))
  const yesterday = iso(new Date(today.getTime() - ONE_DAY))
  const in10Days = iso(new Date(today.getTime() + 10 * ONE_DAY))
  const period = iso(today).slice(0, 7)

  const stamp = Date.now()
  const client = await prisma.client.create({
    data: {
      organisationId,
      clientCode: `${PREFIX}${stamp}`,
      companyName: `${PREFIX}${stamp}`,
      contactPerson: 'Test contact',
      contactNumber: '9999999999',
      email: 'client@example.test',
      accountManagerId,
      status: 'active',
      onboardingDate: iso(today),
    },
  })
  await prisma.gstProfile.create({
    data: {
      clientId: client.id,
      gstin: '33AAACT1234A1Z5',
      registrationStatus: 'active',
      filingFrequency: 'monthly',
      assignedEmployeeId: accountManagerId,
    },
  })

  // Four return cases to prove the GSTR-2B exclusion:
  //   GSTR-1  due in 2 days  → in window (should fire)
  //   GSTR-2B overdue        → excluded by REMINDED_KINDS (should NOT fire)
  //   GSTR-3B due today      → in window (should fire)
  //   (plus a far-out GSTR-1 covered by the subsequent completed-case check)
  await prisma.partnershipCase.createMany({
    data: [
      { caseCode: `GSTR1-${stamp}`,  kind: 'GSTR1',  clientId: client.id, period, status: 'IN_PROGRESS', dueDate: in2Days },
      { caseCode: `GSTR2B-${stamp}`, kind: 'GSTR2B', clientId: client.id, period, status: 'IN_PROGRESS', dueDate: yesterday },
      { caseCode: `GSTR3B-${stamp}`, kind: 'GSTR3B', clientId: client.id, period, status: 'IN_PROGRESS', dueDate: iso(today) },
    ],
  })

  const items = await computeUpcoming(prisma, { period, today: iso(today), clientIdFilter: [client.id] })
  check('Two returns in window (GSTR-1 due-soon, GSTR-3B due today; GSTR-2B deliberately excluded)', items.length, 2)
  const kinds = items.map((i) => i.kind).sort()
  check('Only GSTR-1 and GSTR-3B surfaced — GSTR-2B is not actionable', kinds.join(','), 'GSTR1,GSTR3B')

  const g1 = items.find((i) => i.kind === 'GSTR1')
  const g3 = items.find((i) => i.kind === 'GSTR3B')
  check('GSTR-1 state is due', g1?.state, 'due')
  check('GSTR-1 days_to_due = 2', g1?.daysToDue, 2)
  check('GSTR-3B state is due (today)', g3?.state, 'due')
  check('GSTR-3B days_to_due = 0', g3?.daysToDue, 0)
  check('Dedupe key is stable (contains clientId + kind + period + state)',
    (g1?.key.includes(client.id) && g1?.key.includes('GSTR1') && g1?.key.includes(period) && g1?.key.includes('due')) ?? false, true)

  // Completed GSTR-1 case drops out of the window.
  const g1Case = await prisma.partnershipCase.findFirst({ where: { caseCode: `GSTR1-${stamp}` } })
  await prisma.partnershipCase.update({ where: { id: g1Case!.id }, data: { status: 'COMPLETED' } })
  const items2 = await computeUpcoming(prisma, { period, today: iso(today), clientIdFilter: [client.id] })
  check('Completed case is excluded', items2.length, 1)
  check('Only GSTR-3B remains (GSTR-2B was never there to begin with)', items2[0]?.kind, 'GSTR3B')
  // Put it back for the scheduler check.
  await prisma.partnershipCase.update({ where: { id: g1Case!.id }, data: { status: 'IN_PROGRESS' } })

  // Scheduler path writes org-wide; filter result by our dedupe key prefix.
  const beforeCount = await prisma.notification.count({ where: { entityType: 'gst_reminder', entityId: { contains: `:${client.id}:` } } })
  await sendGstReminders(prisma)
  const afterCount = await prisma.notification.count({ where: { entityType: 'gst_reminder', entityId: { contains: `:${client.id}:` } } })
  check('Scheduler writes one notification per in-window item (2 new, GSTR-2B skipped)', afterCount - beforeCount, 2)

  // Second tick is a no-op.
  await sendGstReminders(prisma)
  const afterCount2 = await prisma.notification.count({ where: { entityType: 'gst_reminder', entityId: { contains: `:${client.id}:` } } })
  check('Second tick creates no duplicates', afterCount2, afterCount)

  // sendClientReminder refuses when SMTP is unconfigured in this test env.
  const hadSmtp = Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS)
  if (!hadSmtp) {
    let msg = ''
    try {
      await sendClientReminder(prisma, {
        clientId: client.id, kind: 'GSTR1', period, dueDate: in2Days,
        to: 'client@example.test', subject: 's', body: 'b',
      }, user.id)
    } catch (e) { msg = (e as Error).message }
    check('sendClientReminder throws when SMTP is unconfigured',
      /mail is not|smtp/i.test(msg) || msg.toLowerCase().includes('smtp'), true)
  }

  // Templating is stable + user-friendly.
  const subj = defaultReminderSubject({ clientName: 'ACME Pvt Ltd', kind: 'GSTR1', period: '2026-09', dueDate: in2Days })
  check('Default subject names the kind + period', subj.includes('GSTR-1') && subj.includes('2026-09'), true)
  const bod = defaultReminderBody({ clientName: 'ACME Pvt Ltd', kind: 'GSTR3B', period: '2026-09', dueDate: in2Days })
  check('Default body addresses the client by name', bod.includes('ACME Pvt Ltd'), true)
  check('Default body mentions GSTR-3B', bod.includes('GSTR-3B'), true)

  await cleanup(organisationId)
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
