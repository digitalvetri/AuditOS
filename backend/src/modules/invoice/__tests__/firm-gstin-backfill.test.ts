import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma, uid } from '../../../__tests__/helpers.js'
import { gstinCheckChar } from '../../gst/validate.js'
import { backfillFirmGstin, FIRM_GSTIN_BACKFILL_ACTION } from '../supply.js'

/**
 * Deploy backfill: an unset firm GSTIN is taken from the letterhead of the
 * most recent sent invoice that carries a valid one, audited; nothing valid
 * → left null; a GSTIN already set is never touched. Runs against an
 * organisation of its own so the shared firm row is not disturbed.
 */

const valid = (first14: string) => first14 + gstinCheckChar(first14)
const KA = valid('29AABCK1234F1Z')
const TN_OLD = valid('33AABCK1234F1Z')

let orgId = ''
let clientId = ''

async function invoice(date: string, status: string, gstin: string | null) {
  return prisma.invoice.create({
    data: {
      organisationId: orgId, clientId, invoiceDate: date, dueDate: date, status,
      invoiceNumber: status === 'draft' ? null : uid('BF'), totalPaise: 100_00, balanceDuePaise: 100_00, billingName: 'X',
      layoutConfig: { company: { name: 'Firm', gstin: gstin ?? '' } },
    },
  })
}

beforeAll(async () => {
  orgId = (await prisma.organisation.create({ data: { id: uid('org'), name: 'Backfill Firm' } })).id
  const ws = (await prisma.workSchedule.findFirst())?.id ?? (await prisma.workSchedule.create({ data: { organisationId: orgId, name: 'Std', standardStart: '09:30', standardEnd: '18:30' } })).id
  const emp = await prisma.employee.create({ data: { organisationId: orgId, employeeCode: uid('BF'), firstName: 'B', lastName: 'F', fullName: 'B F', email: `${uid('bf')}@x.local`, joiningDate: '2024-01-01', workScheduleId: ws } })
  clientId = (await prisma.client.create({ data: { organisationId: orgId, clientCode: uid('CLI'), companyName: 'Backfill Co', accountManagerId: emp.id, contactPerson: 'P', contactNumber: '9876543210', onboardingDate: '2024-01-01' } })).id
})
afterAll(async () => {
  await prisma.invoice.deleteMany({ where: { organisationId: orgId } })
  await prisma.$disconnect()
})

describe('firm GSTIN backfill', () => {
  it('nothing valid on any sent invoice (blank, bad checksum, only on a draft) → stays null, no audit row', async () => {
    await invoice('2026-01-10', 'sent', null)
    await invoice('2026-02-10', 'sent', '29AABCK1234F1ZX') // checksum wrong
    await invoice('2026-03-10', 'draft', KA)
    expect(await backfillFirmGstin(prisma, orgId)).toBeNull()
    expect((await prisma.organisation.findUniqueOrThrow({ where: { id: orgId } })).gstin).toBeNull()
    expect(await prisma.auditLog.count({ where: { entityId: orgId, action: FIRM_GSTIN_BACKFILL_ACTION } })).toBe(0)
  })

  it('takes the most recent sent invoice with a valid letterhead GSTIN, writes one audit row, and is idempotent', async () => {
    await invoice('2025-06-01', 'paid', TN_OLD)
    const latest = await invoice('2026-04-01', 'sent', KA)
    expect(await backfillFirmGstin(prisma, orgId)).toBe(KA)
    expect((await prisma.organisation.findUniqueOrThrow({ where: { id: orgId } })).gstin).toBe(KA)
    const rows = await prisma.auditLog.findMany({ where: { entityId: orgId, action: FIRM_GSTIN_BACKFILL_ACTION } })
    expect(rows).toHaveLength(1)
    expect(JSON.parse(rows[0].afterJson!)).toMatchObject({ gstin: KA, invoice_id: latest.id })

    // A second deploy changes nothing, and never overwrites a set GSTIN.
    await invoice('2026-05-01', 'sent', TN_OLD)
    expect(await backfillFirmGstin(prisma, orgId)).toBeNull()
    expect((await prisma.organisation.findUniqueOrThrow({ where: { id: orgId } })).gstin).toBe(KA)
    expect(await prisma.auditLog.count({ where: { entityId: orgId, action: FIRM_GSTIN_BACKFILL_ACTION } })).toBe(1)
  })
})
