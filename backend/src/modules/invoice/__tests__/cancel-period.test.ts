import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { createApp } from '../../../app.js'
import { signToken } from '../../../platform/auth.js'
import { prisma, setFirmGstin, uid } from '../../../__tests__/helpers.js'
import { setupRoles } from '../../../../prisma/setup-roles.js'
import { istToday } from '../../../lib/dates.js'
import { gstr1DueDate } from '../service.js'

/**
 * A sent invoice from an earlier FY, or past the GSTR-1 due date of its month
 * (11th of the next month), is reversed by a credit note, not cancelled — a
 * cancel would drop it from past-period reports after it was returned.
 */

let server: Server
let base = ''
let cookie = ''
let clientId = ''

async function api(path: string, opts: { method?: string; body?: unknown } = {}) {
  const res = await fetch(`${base}${path}`, {
    method: opts.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  const text = await res.text()
  let body: unknown = null
  try { body = text ? JSON.parse(text) : null } catch { body = text }
  const b = body as { data?: unknown } | null
  return { status: res.status, body: (b && typeof b === 'object' && 'data' in b ? b.data : body) as any }
}
async function invoice(date: string, send: boolean) {
  const r = await api('/api/invoices', { method: 'POST', body: {
    client_id: clientId, invoice_date: date, terms: 'net_15', place_of_supply: 'Tamil Nadu',
    items: [{ item_name: 'Fee', hsn_sac: '998221', quantity_centi: 100, rate_paise: 1_000_00, gst_rate_percent: 18 }],
  } })
  expect(r.status).toBe(201)
  if (send) expect((await api(`/api/invoices/${r.body.id}/send`, { method: 'POST' })).status).toBe(200)
  return r.body.id as string
}

beforeAll(async () => {
  server = createApp().listen(0)
  await new Promise((r) => server.once('listening', r))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  const orgId = (await prisma.organisation.findFirst({ where: { deletedAt: null } }))?.id ?? (await prisma.organisation.create({ data: { id: uid('org'), name: 'Firm' } })).id
  const wsId = (await prisma.workSchedule.findFirst())?.id ?? (await prisma.workSchedule.create({ data: { organisationId: orgId, name: 'Std', standardStart: '09:30', standardEnd: '18:30' } })).id
  await setupRoles(prisma, { force: true })
  await setFirmGstin()
  const role = await prisma.role.findUniqueOrThrow({ where: { code: 'hr_admin' } })
  const emp = await prisma.employee.create({ data: { organisationId: orgId, employeeCode: uid('CP'), firstName: 'C', lastName: 'P', fullName: 'C P', email: `${uid('cp')}@x.local`, joiningDate: '2024-01-01', workScheduleId: wsId } })
  const u = await prisma.user.create({ data: { organisationId: orgId, email: emp.email, passwordHash: 'x', roleId: role.id, employeeId: emp.id } })
  cookie = `ao_access=${signToken(u.id)}`
  clientId = (await prisma.client.create({ data: { organisationId: orgId, clientCode: uid('CLI'), companyName: 'Cancel Co', accountManagerId: emp.id, contactPerson: 'P', contactNumber: '9876543210', onboardingDate: '2024-01-01' } })).id
})
afterAll(async () => { server.close(); await prisma.$disconnect() })

describe('cancel vs the GSTR-1 period', () => {
  it('GSTR-1 due date is the 11th of the next month: 10 May 2024 → 11 Jun 2024; 5 Dec 2026 → 11 Jan 2027', () => {
    expect(gstr1DueDate('2024-05-10')).toBe('2024-06-11')
    expect(gstr1DueDate('2026-12-05')).toBe('2027-01-11')
  })

  it('a sent invoice of 10 May 2024 cannot be cancelled (409 cancel_needs_credit_note) and stays sent', async () => {
    const id = await invoice('2024-05-10', true)
    const r = await api(`/api/invoices/${id}/cancel`, { method: 'POST', body: { reason: 'late' } })
    expect(r.status).toBe(409)
    expect(r.body.error.code).toBe('cancel_needs_credit_note')
    expect(r.body.error.message).toContain('credit note')
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id } })).status).toBe('sent')
  })

  it("today's sent invoice can still be cancelled; an old draft (no number) always can", async () => {
    expect((await api(`/api/invoices/${await invoice(istToday(), true)}/cancel`, { method: 'POST', body: {} })).status).toBe(200)
    expect((await api(`/api/invoices/${await invoice('2024-05-10', false)}/cancel`, { method: 'POST', body: {} })).status).toBe(200)
  })
})
