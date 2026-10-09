import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma, uid } from '../../__tests__/helpers.js'
import { ensureLeaveBalances } from '../leaveBalances.js'

/** Mid-year joiners get the year's leave pro-rated by the months left. */

let orgId = ''
let wsId = ''
let casual = ''

beforeAll(async () => {
  orgId = (await prisma.organisation.create({ data: { id: uid('org'), name: 'Firm' } })).id
  wsId = (await prisma.workSchedule.create({ data: { organisationId: orgId, name: 'Std', standardStart: '09:30', standardEnd: '18:30' } })).id
  casual = (await prisma.leaveType.create({ data: { organisationId: orgId, code: uid('casual'), name: 'Casual', annualEntitlement: 12, accrual: 'monthly', carryForwardMax: 0, halfDayAllowed: true, minNoticeDays: 0, accrueDuringProbation: true } })).id
})
afterAll(async () => { await prisma.$disconnect() })

async function emp(joiningDate: string) {
  return prisma.employee.create({ data: { organisationId: orgId, employeeCode: uid('AO'), firstName: 'J', lastName: 'D', fullName: 'J D', email: `${uid('e')}@x.local`, joiningDate, workScheduleId: wsId } })
}
const entitled = async (employeeId: string, fy: string) =>
  (await prisma.leaveBalance.findUniqueOrThrow({ where: { employeeId_leaveTypeId_fiscalYearStart: { employeeId, leaveTypeId: casual, fiscalYearStart: fy } } })).entitled

describe('ensureLeaveBalances', () => {
  it('someone who joined before the year gets the full entitlement', async () => {
    const e = await emp('2024-06-01')
    await ensureLeaveBalances(prisma, [e], '2025-04-01')
    expect(await entitled(e.id, '2025-04-01')).toBe(12)
  })
  it('a February joiner gets two months’ worth (Feb + Mar)', async () => {
    const e = await emp('2026-02-10')
    await ensureLeaveBalances(prisma, [e], '2025-04-01')
    expect(await entitled(e.id, '2025-04-01')).toBe(2)
  })
  it('an October joiner gets half the year, and the next year in full', async () => {
    const e = await emp('2025-10-01')
    await ensureLeaveBalances(prisma, [e], '2025-04-01')
    expect(await entitled(e.id, '2025-04-01')).toBe(6)
    await ensureLeaveBalances(prisma, [e], '2026-04-01')
    expect(await entitled(e.id, '2026-04-01')).toBe(12)
  })
  it('rounds to half days', async () => {
    const e = await emp('2025-09-15') // 7 months of 12/yr = 7
    const t = await prisma.leaveType.create({ data: { organisationId: orgId, code: uid('earned'), name: 'Earned', annualEntitlement: 15, accrual: 'monthly', carryForwardMax: 0, halfDayAllowed: true, minNoticeDays: 0, accrueDuringProbation: true } })
    await ensureLeaveBalances(prisma, [e], '2025-04-01')
    const row = await prisma.leaveBalance.findUniqueOrThrow({ where: { employeeId_leaveTypeId_fiscalYearStart: { employeeId: e.id, leaveTypeId: t.id, fiscalYearStart: '2025-04-01' } } })
    expect(row.entitled).toBe(9) // 15 * 7/12 = 8.75 → 9
  })
})
