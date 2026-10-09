import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { createApp } from '../../../app.js'
import { signToken } from '../../../platform/auth.js'
import { prisma, uid } from '../../../__tests__/helpers.js'
import { setupRoles } from '../../../../prisma/setup-roles.js'
import { backfillReceiptNumbers, receiptNumberFor } from '../payments.js'

/**
 * Receipt numbers: 'RCT-000001', stored when the payment is recorded,
 * allocated atomically (concurrent payments never share one), backfilled for
 * old rows with the number their receipt already showed, and printed on the
 * receipt PDF.
 */

let server: Server
let base = ''
let orgId = ''
let clientId = ''
let cookie = ''

async function api(p: string, opts: { method?: string; body?: unknown } = {}) {
  const res = await fetch(`${base}${p}`, {
    method: opts.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  const text = await res.text()
  return { status: res.status, body: (text ? JSON.parse(text) : null) as any, headers: res.headers }
}

async function sentInvoice(totalPaise: number) {
  return prisma.invoice.create({
    data: {
      organisationId: orgId, invoiceNumber: uid('RINV'), clientId, invoiceDate: '2026-05-10', dueDate: '2026-05-25', status: 'sent',
      subtotalPaise: totalPaise, taxablePaise: totalPaise, totalPaise, balanceDuePaise: totalPaise,
      items: { create: [{ itemName: 'Fee', taxableAmountPaise: totalPaise, totalAmountPaise: totalPaise }] },
    },
  })
}

const num = (s: string) => Number(s.slice(4))

beforeAll(async () => {
  server = createApp().listen(0)
  await new Promise((r) => server.once('listening', r))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  orgId = (await prisma.organisation.findFirst({ where: { deletedAt: null } }))?.id ?? (await prisma.organisation.create({ data: { id: uid('org'), name: 'Firm' } })).id
  const wsId = (await prisma.workSchedule.findFirst())?.id ?? (await prisma.workSchedule.create({ data: { organisationId: orgId, name: 'Std', standardStart: '09:30', standardEnd: '18:30' } })).id
  await setupRoles(prisma, { force: true })
  const role = await prisma.role.findUniqueOrThrow({ where: { code: 'md' } })
  const emp = await prisma.employee.create({ data: { organisationId: orgId, employeeCode: uid('RC'), firstName: 'R', lastName: 'C', fullName: `R C ${uid('n')}`, email: `${uid('r')}@x.local`, joiningDate: '2026-01-01', workScheduleId: wsId } })
  const u = await prisma.user.create({ data: { organisationId: orgId, email: emp.email, passwordHash: 'x', roleId: role.id, employeeId: emp.id } })
  cookie = `ao_access=${signToken(u.id)}`
  clientId = (await prisma.client.create({ data: { organisationId: orgId, clientCode: uid('CLI'), companyName: 'Receipt Co', contactPerson: 'P', contactNumber: '9876543210', accountManagerId: emp.id, onboardingDate: '2026-01-01' } })).id
})
afterAll(async () => { server.close() })

describe('receipt numbers', () => {
  it('backfills old payments with the number their receipt already showed, oldest first, idempotently', async () => {
    const inv = await sentInvoice(10_000_00)
    const old = []
    for (let i = 0; i < 3; i++) {
      old.push(await prisma.invoicePayment.create({
        data: { organisationId: orgId, invoiceId: inv.id, clientId, amountPaise: 100_00, paidOn: '2026-05-11', createdAt: new Date(Date.UTC(2020, 0, 1 + i)) },
      }))
    }
    // The number each receipt showed before numbers were stored (derived).
    const shown = await Promise.all(old.map((p) => receiptNumberFor(p)))
    const takenBefore = new Set((await prisma.invoicePayment.findMany({ where: { receiptNumber: { in: shown } }, select: { receiptNumber: true } })).map((p) => p.receiptNumber))
    await backfillReceiptNumbers(prisma)
    const stored = await prisma.invoicePayment.findMany({ where: { id: { in: old.map((p) => p.id) } }, orderBy: { createdAt: 'asc' } })
    const numbers = stored.map((p) => p.receiptNumber!)
    expect(numbers.every((n) => /^RCT-\d{6}$/.test(n))).toBe(true)
    // The printed number is kept wherever it was still free.
    shown.forEach((n, i) => { if (!takenBefore.has(n)) expect(numbers[i]).toBe(n) })
    const all = await prisma.invoicePayment.findMany({ where: { receiptNumber: { not: null } }, select: { receiptNumber: true } })
    expect(new Set(all.map((p) => p.receiptNumber)).size).toBe(all.length)
    expect(await backfillReceiptNumbers(prisma)).toBe(0)
    expect(await prisma.invoicePayment.count({ where: { receiptNumber: null } })).toBe(0)
  })

  it('assigns a unique number to each payment recorded at once, and lists it', async () => {
    const a = await sentInvoice(10_000_00)
    const b = await sentInvoice(10_000_00)
    const before = await prisma.invoicePayment.count()
    const rs = await Promise.all([a, b, a, b].map((inv) => api(`/api/invoices/${inv.id}/payments`, { method: 'POST', body: { amount_paise: 1_000_00, paid_on: '2026-05-12', mode: 'upi' } })))
    for (const r of rs) expect(r.status).toBe(200)
    const rows = await prisma.invoicePayment.findMany({ where: { invoiceId: { in: [a.id, b.id] } } })
    const numbers = rows.map((p) => p.receiptNumber!)
    expect(numbers.every((n) => /^RCT-\d{6}$/.test(n))).toBe(true)
    expect(new Set(numbers).size).toBe(4)
    expect(Math.min(...numbers.map(num))).toBeGreaterThan(before)

    const list = await api(`/api/invoices/${a.id}/payments`)
    const listed = list.body.data.items.map((p: any) => p.receipt_number).sort()
    expect(listed).toEqual(rows.filter((p) => p.invoiceId === a.id).map((p) => p.receiptNumber).sort())
  })

  it('prints the stored number on the receipt PDF', async () => {
    const inv = await sentInvoice(5_000_00)
    await api(`/api/invoices/${inv.id}/payments`, { method: 'POST', body: { amount_paise: 1_000_00, paid_on: '2026-05-12' } })
    const p = await prisma.invoicePayment.findFirstOrThrow({ where: { invoiceId: inv.id } })
    // Stored number wins even where a derived one would differ.
    await prisma.invoicePayment.update({ where: { id: p.id }, data: { receiptNumber: 'RCT-777777' } })
    const link = await api(`/api/invoices/${inv.id}/payments/${p.id}/receipt-url`)
    expect(link.status).toBe(200)
    const pdf = await fetch(`${base}${link.body.data.url}`)
    expect(pdf.status).toBe(200)
    expect(pdf.headers.get('content-disposition')).toContain('RCT-777777.pdf')
  })
})
