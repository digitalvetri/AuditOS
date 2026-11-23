import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { createApp } from '../../../app.js'
import { signToken } from '../../../platform/auth.js'
import { prisma, setFirmGstin, uid } from '../../../__tests__/helpers.js'
import { setupRoles } from '../../../../prisma/setup-roles.js'
import { Prisma } from '@prisma/client'

/**
 * Invoice and quotation numbers set by an Admin: a prefix with {FY}, a
 * number to continue from (a firm moving in with 160 invoices), never one at
 * or below a number already issued, and the built-in series when unset.
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
  const emp = await prisma.employee.create({ data: { organisationId: orgId, employeeCode: uid('QC'), firstName: 'Q', lastName: 'C', fullName: 'Q C', email: `${uid('qc')}@x.local`, joiningDate: '2024-01-01', workScheduleId: wsId } })
  const u = await prisma.user.create({ data: { organisationId: orgId, email: emp.email, passwordHash: 'x', roleId: role.id, employeeId: emp.id } })
  cookie = `ao_access=${signToken(u.id)}`
  clientId = (await prisma.client.create({ data: { organisationId: orgId, clientCode: uid('CLI'), companyName: 'Quoted Co', accountManagerId: emp.id, contactPerson: 'P', contactNumber: '9876543210', onboardingDate: '2024-01-01' } })).id
})
afterAll(async () => {
  await prisma.organisation.updateMany({ data: { numberingConfig: Prisma.DbNull } })
  server.close(); await prisma.$disconnect()
})

async function sendNew(date: string) {
  const made = await api('/api/invoices', { method: 'POST', body: {
    client_id: clientId, invoice_date: date, terms: 'due_on_receipt', gst_applicable: false,
    items: [{ item_name: 'Accounting', quantity_centi: 100, rate_paise: 1_000_00, discount_percent: 0, gst_rate_percent: 0 }],
  } })
  expect(made.status, JSON.stringify(made.body)).toBe(201)
  const sent = await api(`/api/invoices/${made.body.id}/send`, { method: 'POST' })
  expect(sent.status, JSON.stringify(sent.body)).toBe(200)
  return (await api(`/api/invoices/${made.body.id}`)).body.invoice_number as string
}

describe('invoice and quotation numbers', () => {
  it('continues a {FY} series from the number the Admin sets, and refuses one already issued', async () => {
    await prisma.organisation.updateMany({ data: { numberingConfig: Prisma.DbNull } })
    const put = await api('/api/invoices/numbering', { method: 'PUT', body: {
      invoice: { prefix: 'JNS/{FY}/', digits: 3, next_number: 161 },
      quotation: { prefix: 'QT-{YYYY}-', digits: 4, next_number: 50 },
    } })
    expect(put.status, JSON.stringify(put.body)).toBe(200)
    expect(put.body.invoice.next_preview).toMatch(/^JNS\/20\d\d-\d\d\/161$/)

    expect(await sendNew('2026-11-20')).toBe('JNS/2026-27/161')
    expect(await sendNew('2026-11-21')).toBe('JNS/2026-27/162')

    const q = await api('/api/quotations', { method: 'POST', body: {
      client_id: clientId, subject: 'Audit', quote_date: '2026-11-20', valid_until: '2026-12-31',
      items: [{ description: 'Audit', quantity_centi: 100, unit_rate_paise: 1_000_00, gst_rate_percent: 18 }],
    } })
    expect(q.status, JSON.stringify(q.body)).toBe(201)
    expect(q.body.quotation_code).toBe('QT-2026-0050')
  })

  it('will not go back below a number already issued', async () => {
    const today = (await api('/api/invoices/numbering')).body.invoice.resolved_prefix as string
    // Issue one in today's series so there is something to collide with.
    await prisma.invoice.updateMany({ where: { invoiceNumber: 'JNS/2026-27/162' }, data: { invoiceNumber: `${today}162` } })
    const bad = await api('/api/invoices/numbering', { method: 'PUT', body: { invoice: { prefix: 'JNS/{FY}/', digits: 3, next_number: 100 } } })
    expect(bad.status).toBe(400)
  })

  it('without settings the series is the built-in INV-000001', async () => {
    await prisma.organisation.updateMany({ data: { numberingConfig: Prisma.DbNull } })
    expect(await sendNew('2026-11-22')).toMatch(/^INV-\d{6}$/)
  })
})
