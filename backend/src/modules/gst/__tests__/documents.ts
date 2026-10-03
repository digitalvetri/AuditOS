/**
 * GST documents + drafts — upload-flow + draft rendering.
 *
 *   - uploadGstDocument stores the file, creates ClientDocument + v1
 *     version row with the "[REG-06] …" name prefix.
 *   - For a registration_cert upload: a 30-day display reminder task is
 *     opened, assigned to the client's account manager, due_date set to
 *     today + 30. Idempotent — a second upload reuses the open task.
 *   - For any other doc_type: no task opens.
 *   - listGstDocuments decodes the prefix back into a doc_type and
 *     returns rows newest-first.
 *   - renderDraft('welcome_letter') produces subject + body that includes
 *     the client name, GSTIN, and the 30-day display instruction.
 *
 * Run:  npx tsx src/modules/gst/__tests__/documents.ts
 */
import '../../../lib/env.js'
import { PrismaClient } from '@prisma/client'
import {
  GST_DOC_CATEGORY_CODE,
  listGstDocuments, renderDraft, uploadGstDocument,
} from '../documents.js'

const prisma = new PrismaClient()
const PREFIX = 'FIXTURE-GST-DOC-'
let passed = 0
const failures: string[] = []

function check(name: string, actual: unknown, expected: unknown) {
  if (actual === expected) { passed++; console.log(`  ✓ ${name}`); return }
  failures.push(`${name}: expected ${String(expected)}, got ${String(actual)}`)
  console.error(`  ✗ ${name} — expected ${String(expected)}, got ${String(actual)}`)
}

async function cleanup(organisationId: string) {
  const clients = await prisma.client.findMany({ where: { organisationId, companyName: { startsWith: PREFIX } } })
  const clientIds = clients.map((c) => c.id)
  if (clientIds.length === 0) return
  await prisma.task.deleteMany({ where: { clientId: { in: clientIds } } })
  await prisma.clientDocumentVersion.deleteMany({ where: { document: { clientId: { in: clientIds } } } })
  await prisma.clientDocument.deleteMany({ where: { clientId: { in: clientIds } } })
  await prisma.gstProfile.deleteMany({ where: { clientId: { in: clientIds } } })
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } })
}

async function suite() {
  const user = await prisma.user.findFirst({ where: { role: { code: 'md' } } })
  if (!user) throw new Error('No MD-role user available.')
  const organisationId = user.organisationId
  await cleanup(organisationId)

  const stamp = Date.now()
  const client = await prisma.client.create({
    data: {
      organisationId,
      clientCode: `${PREFIX}${stamp}`,
      companyName: `${PREFIX}${stamp}`,
      contactPerson: 'Test',
      contactNumber: '9999999999',
      email: 'test@example.test',
      accountManagerId: user.employeeId ?? user.id,
      status: 'active',
      onboardingDate: new Date().toISOString().slice(0, 10),
    },
  })
  await prisma.gstProfile.create({
    data: {
      clientId: client.id,
      gstin: '33AAACT1234A1Z5',
      registrationStatus: 'active',
      filingFrequency: 'monthly',
      assignedEmployeeId: user.employeeId ?? user.id,
      registrationDate: '2026-10-01',
      state: 'Tamil Nadu',
    },
  })

  // Upload #1 — registration cert → opens 30-day task.
  const fileBuf = Buffer.from('%PDF-1.4\n% fake fixture pdf\n', 'utf8')
  const up1 = await uploadGstDocument(prisma, {
    clientId: client.id,
    docType: 'registration_cert',
    file: { buffer: fileBuf, originalname: 'reg-06.pdf', size: fileBuf.length },
    label: 'Original certificate',
    reference: 'AA3304240012345',
  }, { userId: user.id, employeeId: user.employeeId ?? null })

  check('Upload returned a documentId', typeof up1.documentId, 'string')
  check('Name is prefixed with REG-06', up1.name.startsWith('[REG-06] '), true)
  check('Reference flows into the name', up1.name.includes('AA3304240012345'), true)
  check('30-day task opened for registration cert', typeof up1.thirtyDayTaskId, 'string')

  const task = await prisma.task.findFirst({ where: { id: up1.thirtyDayTaskId ?? undefined } })
  check('Task is assigned to the account manager', task?.assignedEmployeeId, user.employeeId ?? user.id)
  check('Task priority is medium', task?.priority, 'medium')
  check('Task status is open', task?.status, 'open')
  const dueMs = task?.dueDate ? Date.parse(`${task.dueDate}T00:00:00Z`) - Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`) : 0
  const dueDays = Math.round(dueMs / 86_400_000)
  check('Task due date is +30 days from today', dueDays, 30)

  // Upload #2 — same client, another registration cert → task is reused.
  const up2 = await uploadGstDocument(prisma, {
    clientId: client.id,
    docType: 'registration_cert',
    file: { buffer: fileBuf, originalname: 'reg-06-v2.pdf', size: fileBuf.length },
  }, { userId: user.id, employeeId: user.employeeId ?? null })
  check('Second cert upload reuses the open task (no duplicate)', up2.thirtyDayTaskId, up1.thirtyDayTaskId)
  const openTaskCount = await prisma.task.count({
    where: { clientId: client.id, status: { in: ['open', 'pending', 'in_progress'] }, title: { startsWith: 'Confirm GST certificate displayed' } },
  })
  check('Only one open display-reminder task exists', openTaskCount, 1)

  // Upload #3 — non-cert → no new task.
  const up3 = await uploadGstDocument(prisma, {
    clientId: client.id,
    docType: 'notice_order',
    file: { buffer: fileBuf, originalname: 'notice.pdf', size: fileBuf.length },
    label: 'DRC-01 reply',
  }, { userId: user.id, employeeId: user.employeeId ?? null })
  check('Non-cert upload does NOT create a task', up3.thirtyDayTaskId, null)

  // List returns the three docs with decoded doc_types.
  const list = await listGstDocuments(prisma, client.id)
  check('List returns 3 docs', list.length, 3)
  const types = list.map((d) => d.doc_type).sort()
  check('Types decoded from name prefixes', types.join(','), 'notice_order,registration_cert,registration_cert')
  check('Newest first (last upload = notice_order on top)', list[0].doc_type, 'notice_order')

  // Draft — subject names GSTIN, body includes 30-day display line.
  const draft = await renderDraft(prisma, { clientId: client.id, template: 'welcome_letter' })
  check('Draft subject contains GSTIN', draft.subject.includes('33AAACT1234A1Z5'), true)
  check('Draft body mentions the client name', draft.body.includes(`${PREFIX}${stamp}`), true)
  check('Draft body carries the 30-day display instruction', /30 days/i.test(draft.body) && /display/i.test(draft.body), true)
  check('Draft returns the client email', draft.recipient_email, 'test@example.test')

  // Category was auto-created with the right code.
  const cat = await prisma.documentCategory.findFirst({ where: { code: GST_DOC_CATEGORY_CODE } })
  check('GST documents category exists', !!cat, true)

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
