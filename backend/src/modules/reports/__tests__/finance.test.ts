import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { createApp } from '../../../app.js'
import { signToken } from '../../../platform/auth.js'
import { prisma, uid } from '../../../__tests__/helpers.js'
import { setupRoles } from '../../../../prisma/setup-roles.js'
import { computeProfitability, computeUtilisation, costRatePerHour, fyWindow, monthsBetween } from '../finance.js'

/**
 * Finance MIS. The fixture lives in May 2031 so no other test's invoices or
 * sessions fall in the period, and assertions pick out this fixture's own
 * client / employees regardless.
 *
 *   invoice    taxable ₹1,00,000 (+18% GST), linked to the client service
 *   credit     issued, taxable ₹10,000          → fees ₹90,000
 *   E1         explicit cost rate ₹500/h, 120 min → ₹1,000
 *   E2         no rate; CTC ₹60,000/month ÷ 200 = ₹300/h, 90 min → ₹450
 *   ignored    an open session, a session in June, a deleted salary row,
 *              a salary structure effective after the period
 */

let server: Server
let base = ''
let orgId = ''
let wsId = ''
let superCookie = ''
let associateCookie = ''
let adminCookie = ''
let clientId = ''
let clientServiceId = ''
let e1 = ''
let e2 = ''

const FROM = '2031-05-01'
const TO = '2031-05-31'

async function get(path: string, cookie: string) {
  const res = await fetch(`${base}${path}`, { headers: { Cookie: cookie } })
  return res
}

async function getJson(path: string, cookie = superCookie) {
  const res = await get(path, cookie)
  const body = await res.json() as { data?: any; error?: any }
  return { status: res.status, body: body.data ?? body }
}

async function employee(extra: Record<string, unknown> = {}) {
  return prisma.employee.create({
    data: {
      organisationId: orgId, employeeCode: uid('FE'), firstName: 'F', lastName: 'E', fullName: `Fin ${uid('e')}`,
      email: `${uid('f')}@x.local`, joiningDate: '2030-01-01', workScheduleId: wsId, ...extra,
    },
  })
}

async function cookieFor(roleCode: string) {
  const r = await prisma.role.findUniqueOrThrow({ where: { code: roleCode } })
  const emp = await employee()
  const u = await prisma.user.create({ data: { organisationId: orgId, email: emp.email, passwordHash: 'x', roleId: r.id, employeeId: emp.id } })
  return `ao_access=${signToken(u.id)}`
}

beforeAll(async () => {
  server = createApp().listen(0)
  await new Promise((r) => server.once('listening', r))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  orgId = (await prisma.organisation.findFirst({ where: { deletedAt: null } }))?.id ?? (await prisma.organisation.create({ data: { id: uid('org'), name: 'Firm' } })).id
  wsId = (await prisma.workSchedule.findFirst())?.id ?? (await prisma.workSchedule.create({ data: { organisationId: orgId, name: 'Std', standardStart: '09:30', standardEnd: '18:30' } })).id
  await setupRoles(prisma, { force: true })
  superCookie = await cookieFor('md')
  associateCookie = await cookieFor('employee')
  adminCookie = await cookieFor('hr_admin')

  const E1 = await employee({ costRatePaisePerHour: 500_00 })
  const E2 = await employee()
  e1 = E1.id
  e2 = E2.id
  await prisma.salaryStructure.createMany({
    data: [
      { employeeId: e2, effectiveFrom: '2030-01-01', effectiveTo: '2030-12-31', monthlyCtcPaise: 40_000_00 },
      { employeeId: e2, effectiveFrom: '2031-01-01', monthlyCtcPaise: 60_000_00 },
      // Deleted, and later than the live one: must be ignored.
      { employeeId: e2, effectiveFrom: '2031-03-01', monthlyCtcPaise: 99_000_00, deletedAt: new Date() },
      // After the period end: must be ignored.
      { employeeId: e2, effectiveFrom: '2031-07-01', monthlyCtcPaise: 90_000_00 },
    ],
  })

  clientId = (await prisma.client.create({
    data: {
      organisationId: orgId, clientCode: uid('FCL'), companyName: 'Profit Co', accountManagerId: e1,
      contactPerson: 'P', contactNumber: '9876543210', onboardingDate: '2030-01-01',
    },
  })).id
  const service = await prisma.service.create({ data: { organisationId: orgId, code: uid('SVC'), name: `Statutory audit ${uid('s')}` } })
  clientServiceId = (await prisma.clientService.create({ data: { clientId, serviceId: service.id, assignedEmployeeId: e1 } })).id

  const inv = await prisma.invoice.create({
    data: {
      organisationId: orgId, invoiceNumber: uid('FIN'), clientId, invoiceDate: '2031-05-10', dueDate: '2031-05-25', status: 'sent',
      subtotalPaise: 1_00_000_00, taxablePaise: 1_00_000_00, cgstPaise: 9_000_00, sgstPaise: 9_000_00, totalPaise: 1_18_000_00,
      amountPaidPaise: 50_000_00, tdsDeductedPaise: 10_000_00, balanceDuePaise: 58_000_00, clientServiceId,
      items: { create: [{ itemName: 'Audit fee', taxableAmountPaise: 1_00_000_00, totalAmountPaise: 1_18_000_00 }] },
    },
  })
  // A draft in the period: never counts.
  await prisma.invoice.create({
    data: { organisationId: orgId, clientId, invoiceDate: '2031-05-11', dueDate: '2031-05-11', status: 'draft', taxablePaise: 7_77_777, totalPaise: 9_17_777, clientServiceId },
  })
  await prisma.creditNote.create({
    data: {
      organisationId: orgId, invoiceId: inv.id, clientId, noteDate: '2031-05-20', reason: 'fee_reduction', status: 'issued',
      taxablePaise: 10_000_00, cgstPaise: 900_00, sgstPaise: 900_00, totalPaise: 11_800_00, linesJson: [],
    },
  })
  await prisma.invoicePayment.create({
    data: {
      organisationId: orgId, invoiceId: inv.id, clientId, amountPaise: 50_000_00, paidOn: '2031-05-25',
      tdsPaise: 10_000_00, tdsSection: '194J', tdsCertificateReceived: false,
    },
  })

  const task = await prisma.task.create({ data: { clientId, clientServiceId, title: 'Vouching', assignedEmployeeId: e1, status: 'in_progress' } })
  const at = (iso: string) => new Date(iso)
  await prisma.taskTimeSession.createMany({
    data: [
      { taskId: task.id, employeeId: e1, startedAt: at('2031-05-12T04:00:00Z'), endedAt: at('2031-05-12T06:00:00Z'), durationMinutes: 120, closedBy: 'pause' },
      { taskId: task.id, employeeId: e2, startedAt: at('2031-05-13T04:00:00Z'), endedAt: at('2031-05-13T05:30:00Z'), durationMinutes: 90, closedBy: 'pause' },
      // Open: not counted.
      { taskId: task.id, employeeId: e1, startedAt: at('2031-05-14T04:00:00Z') },
      // Outside the period (IST 1 June): not counted.
      { taskId: task.id, employeeId: e1, startedAt: at('2031-05-31T19:00:00Z'), endedAt: at('2031-05-31T20:00:00Z'), durationMinutes: 60, closedBy: 'pause' },
    ],
  })
  await prisma.attendance.createMany({
    data: [
      { employeeId: e1, date: '2031-05-12', status: 'present', workedMinutes: 480 },
      { employeeId: e1, date: '2031-05-13', status: 'present', workedMinutes: 480 },
    ],
  })
})

afterAll(async () => {
  // Leave nothing that references the fixture employees: other suites
  // (payroll) delete every employee and would hit these foreign keys.
  const ids = [e1, e2].filter(Boolean)
  await prisma.taskTimeSession.deleteMany({ where: { employeeId: { in: ids } } })
  await prisma.taskAuditLog.deleteMany({ where: { task: { clientId } } })
  await prisma.task.deleteMany({ where: { clientId } })
  await prisma.attendance.deleteMany({ where: { employeeId: { in: ids } } })
  await prisma.salaryStructure.deleteMany({ where: { employeeId: { in: ids } } })
  server.close()
  await prisma.$disconnect()
})

describe('pure helpers', () => {
  it('cost rate: explicit rate wins, else latest live salary structure ÷ 200, else 0', () => {
    expect(costRatePerHour({ costRatePaisePerHour: 750_00 }, [{ effectiveFrom: '2020-01-01', monthlyCtcPaise: 1 }], '2031-05-31')).toBe(750_00)
    expect(costRatePerHour({ costRatePaisePerHour: null }, [
      { effectiveFrom: '2030-01-01', monthlyCtcPaise: 40_000_00 },
      { effectiveFrom: '2031-01-01', monthlyCtcPaise: 60_000_00 },
      { effectiveFrom: '2031-03-01', monthlyCtcPaise: 99_000_00, deletedAt: new Date() },
      { effectiveFrom: '2031-07-01', monthlyCtcPaise: 90_000_00 },
    ], '2031-05-31')).toBe(300_00)
    expect(costRatePerHour({ costRatePaisePerHour: null }, [{ effectiveFrom: '2031-01-01', monthlyCtcPaise: 33_333 }], '2031-05-31')).toBe(167)
    expect(costRatePerHour({ costRatePaisePerHour: null }, [], '2031-05-31')).toBe(0)
  })

  it('profitability and utilisation arithmetic', () => {
    const rows = computeProfitability(new Map([['c', 90_000_00]]), [
      { key: 'c', employeeId: 'a', minutes: 120 },
      { key: 'c', employeeId: 'b', minutes: 90 },
      { key: 'd', employeeId: 'a', minutes: 30 },
    ], new Map([['a', 500_00], ['b', 300_00]]))
    const c = rows.find((r) => r.key === 'c')!
    expect(c).toMatchObject({ feesPaise: 90_000_00, minutes: 210, hours: 3.5, timeCostPaise: 1_450_00, marginPaise: 88_550_00, marginPercent: 98.4 })
    expect(rows.find((r) => r.key === 'd')).toMatchObject({ feesPaise: 0, timeCostPaise: 250_00, marginPaise: -250_00, marginPercent: null })

    const u = computeUtilisation(
      [{ employeeId: 'a', month: '2031-05', minutes: 120 }, { employeeId: 'b', month: '2031-05', minutes: 90 }],
      [{ employeeId: 'a', month: '2031-05', minutes: 960 }],
    )
    expect(u.find((r) => r.employeeId === 'a')).toMatchObject({ taskHours: 2, attendanceHours: 16, utilisationPercent: 12.5 })
    expect(u.find((r) => r.employeeId === 'b')).toMatchObject({ taskHours: 1.5, attendanceHours: 0, utilisationPercent: null })
  })

  it('periods', () => {
    expect(monthsBetween('2031-11-15', '2032-02-01')).toEqual(['2031-11', '2031-12', '2032-01', '2032-02'])
    expect(fyWindow('2031-32')).toEqual({ from: '2031-04-01', to: '2032-03-31' })
    expect(fyWindow('2031-33')).toBeNull()
  })
})

describe('GET /api/reports/finance', () => {
  it('is refused without org-scope reports.finance / reports.all', async () => {
    expect((await get('/api/reports/finance', associateCookie)).status).toBe(403)
    expect((await get(`/api/reports/finance/profitability-client?from=${FROM}&to=${TO}`, associateCookie)).status).toBe(403)
    expect((await get(`/api/reports/finance/utilisation?from=${FROM}&to=${TO}&format=csv`, associateCookie)).status).toBe(403)
  })

  it('lists the catalogue for Super Admin and Admin', async () => {
    const r = await getJson('/api/reports/finance')
    expect(r.status).toBe(200)
    expect(r.body.items.map((i: { key: string }) => i.key)).toContain('tds-receivable')
    expect((await getJson('/api/reports/finance', adminCookie)).status).toBe(200)
    expect((await getJson('/api/reports/finance/nope', adminCookie)).status).toBe(404)
  })

  it('profitability by client: fees less credit notes, less time at cost', async () => {
    const r = await getJson(`/api/reports/finance/profitability-client?from=${FROM}&to=${TO}`)
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ report: 'profitability-client', from: FROM, to: TO })
    const row = r.body.rows.find((x: { client_id: string }) => x.client_id === clientId)
    expect(row).toMatchObject({
      client: 'Profit Co',
      fees_paise: 90_000_00,
      hours: 3.5,
      time_cost_paise: 1_000_00 + 450_00,
      margin_paise: 90_000_00 - 1_450_00,
      margin_percent: 98.4,
    })
  })

  it('profitability by engagement: the client service carries the same fees and time', async () => {
    const r = await getJson(`/api/reports/finance/profitability-engagement?from=${FROM}&to=${TO}`)
    const row = r.body.rows.find((x: { id: string }) => x.id === clientServiceId)
    expect(row).toMatchObject({ kind: 'client_service', fees_paise: 90_000_00, hours: 3.5, time_cost_paise: 1_450_00 })
    // Billed in the period, so not unbilled.
    const u = await getJson(`/api/reports/finance/unbilled?from=${FROM}&to=${TO}`)
    expect(u.body.rows.find((x: { client_service_id: string }) => x.client_service_id === clientServiceId)).toBeUndefined()
  })

  it('utilisation: closed task minutes over attendance minutes', async () => {
    const r = await getJson(`/api/reports/finance/utilisation?from=${FROM}&to=${TO}`)
    const one = r.body.rows.find((x: { employee_id: string }) => x.employee_id === e1)
    expect(one).toMatchObject({ month: '2031-05', task_hours: 2, attendance_hours: 16, utilisation_percent: 12.5 })
    const two = r.body.rows.find((x: { employee_id: string }) => x.employee_id === e2)
    expect(two).toMatchObject({ month: '2031-05', task_hours: 1.5, attendance_hours: 0, utilisation_percent: null })
  })

  it('revenue, collections, DSO and TDS receivable for the fixture client', async () => {
    const byClient = await getJson(`/api/reports/finance/revenue-by-client?from=${FROM}&to=${TO}&client_id=${clientId}`)
    expect(byClient.body.rows).toHaveLength(1)
    expect(byClient.body.rows[0]).toMatchObject({
      fees_paise: 90_000_00, total_invoiced_paise: 1_18_000_00, cash_collected_paise: 50_000_00,
      tds_paise: 10_000_00, credited_paise: 11_800_00, outstanding_paise: 1_18_000_00 - 50_000_00 - 10_000_00 - 11_800_00,
    })
    const months = await getJson(`/api/reports/finance/revenue-by-month?from=${FROM}&to=${TO}&client_id=${clientId}`)
    expect(months.body.rows[0]).toMatchObject({ month: '2031-05', invoice_count: 1, fees_paise: 90_000_00, gst_paise: 18_000_00 - 1_800_00 })

    const dso = await getJson(`/api/reports/finance/dso?from=${FROM}&to=${TO}&client_id=${clientId}`)
    // Closing 46,200 / revenue 1,06,200 × 31 days.
    expect(dso.body.totals.dso_days).toBe(Math.round((46_200 / 1_06_200) * 31 * 10) / 10)
    expect(dso.body.totals.avg_days_to_collect).toBe(15)

    const tds = await getJson(`/api/reports/finance/tds-receivable?fy=2031-32&client_id=${clientId}`)
    expect(tds.body).toMatchObject({ from: '2031-04-01', to: '2032-03-31' })
    expect(tds.body.rows[0]).toMatchObject({
      fy: '2031-32', tds_paise: 10_000_00, payment_count: 1, certificates_received: 0, certificates_pending: 1,
      pending_amount_paise: 10_000_00, sections: '194J', reconciled_26as: false,
    })
  })

  it('downloads CSV and XLSX', async () => {
    const csv = await get(`/api/reports/finance/profitability-client?from=${FROM}&to=${TO}&format=csv`, superCookie)
    expect(csv.status).toBe(200)
    expect(csv.headers.get('content-type')).toMatch(/text\/csv/)
    expect(csv.headers.get('content-disposition')).toBe(`attachment; filename="profitability-client_${FROM}_${TO}.csv"`)
    const text = await csv.text()
    expect(text).toContain('Fees (ex-GST) (Rs)')
    expect(text).toContain('Profit Co,90000,3.50,1450,88550,98.40')

    const xlsx = await get(`/api/reports/finance/revenue-by-month?from=${FROM}&to=${TO}&format=xlsx`, superCookie)
    expect(xlsx.status).toBe(200)
    expect(xlsx.headers.get('content-type')).toMatch(/spreadsheetml/)
    expect(xlsx.headers.get('content-disposition')).toBe(`attachment; filename="revenue-by-month_${FROM}_${TO}.xlsx"`)
    const buf = Buffer.from(await xlsx.arrayBuffer())
    expect(buf.subarray(0, 2).toString()).toBe('PK')
  })
})
