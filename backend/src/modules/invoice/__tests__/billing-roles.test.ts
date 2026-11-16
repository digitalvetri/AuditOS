import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { createApp } from '../../../app.js'
import { signToken } from '../../../platform/auth.js'
import { prisma, setFirmGstin, uid } from '../../../__tests__/helpers.js'
import { setupRoles } from '../../../../prisma/setup-roles.js'

/**
 * Billing powers by role (roles from setupRoles):
 *  - Associate and Intern draft and send invoices for their clients, record
 *    payments and draft credit notes;
 *  - issuing / cancelling a credit note, cancelling an invoice and approving a
 *    quotation take a Senior Associate (or a partner);
 *  - a refund takes a partner, and is capped at the cash actually received:
 *    the TDS portion is paid back only with an explicit, audited include_tds.
 */

type Code = 'md' | 'dept_manager' | 'employee' | 'intern'
let server: Server
let base = ''
let orgId = ''
let wsId = ''
let clientId = ''
const who: Record<Code, string> = {} as never

async function api(path: string, cookie: string, opts: { method?: string; body?: unknown } = {}) {
  const res = await fetch(`${base}${path}`, {
    method: opts.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  const text = await res.text()
  let j: any = null
  try { j = text ? JSON.parse(text) : null } catch { j = text }
  return { status: res.status, body: j && typeof j === 'object' && 'data' in j ? j.data : j }
}

async function staff(code: Code) {
  const role = await prisma.role.findUniqueOrThrow({ where: { code } })
  const emp = await prisma.employee.create({
    data: {
      organisationId: orgId, employeeCode: uid('BR'), firstName: 'B', lastName: code, fullName: uid(`B ${code}`),
      email: `${uid('br')}@x.local`, joiningDate: '2025-01-01', status: 'active', workScheduleId: wsId,
    },
  })
  const u = await prisma.user.create({ data: { organisationId: orgId, email: emp.email, passwordHash: 'x', roleId: role.id, employeeId: emp.id } })
  return { emp, cookie: `ao_access=${signToken(u.id)}` }
}

/** A sent ₹11,800 invoice on the shared client, raised by `cookie`. */
async function sentInvoice(cookie: string) {
  const r = await api('/api/invoices', cookie, {
    method: 'POST',
    body: {
      client_id: clientId, invoice_date: '2026-09-01', terms: 'net_15', place_of_supply: 'Tamil Nadu', is_inter_state: false,
      items: [{ item_name: 'Audit fee', hsn_sac: '998221', quantity_centi: 100, rate_paise: 10_000_00, gst_rate_percent: 18 }],
    },
  })
  expect(r.status, JSON.stringify(r.body)).toBe(201)
  const s = await api(`/api/invoices/${r.body.id}/send`, cookie, { method: 'POST' })
  expect(s.status, JSON.stringify(s.body)).toBe(200)
  return s.body as { id: string }
}

async function draftCredit(cookie: string, invoiceId: string, taxable = 10_000_00) {
  const r = await api('/api/credit-notes', cookie, {
    method: 'POST',
    body: { invoice_id: invoiceId, note_date: '2026-09-12', reason: 'fee_reduction', lines: [{ description: 'Fee waived', sac_code: '998222', taxable_paise: taxable, gst_rate: 18 }] },
  })
  expect(r.status, JSON.stringify(r.body)).toBe(201)
  return r.body.id as string
}

beforeAll(async () => {
  server = createApp().listen(0)
  await new Promise((r) => server.once('listening', r))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  orgId = (await prisma.organisation.create({ data: { id: uid('org'), name: 'Firm' } })).id
  wsId = (await prisma.workSchedule.create({ data: { id: uid('ws'), organisationId: orgId, name: 'Std', standardStart: '09:30', standardEnd: '18:30' } })).id
  await setupRoles(prisma, { force: true })
  await setFirmGstin()
  const people = {
    md: await staff('md'), dept_manager: await staff('dept_manager'), employee: await staff('employee'), intern: await staff('intern'),
  }
  for (const k of Object.keys(people) as Code[]) who[k] = people[k].cookie
  // The Associate manages the client; the Intern is second staff.
  clientId = (await prisma.client.create({
    data: {
      organisationId: orgId, clientCode: uid('CLI'), companyName: 'Billing Roles Co', contactPerson: 'P', contactNumber: '9876543210',
      onboardingDate: '2026-01-01', accountManagerId: people.employee.emp.id, secondaryManagerId: people.intern.emp.id,
    },
  })).id
})
afterAll(() => server?.close())

describe('day-to-day billing stays with Associate and Intern', () => {
  it('they draft, send, take payment and draft a credit note on their client', async () => {
    for (const code of ['employee', 'intern'] as const) {
      const inv = await sentInvoice(who[code])
      const p = await api(`/api/invoices/${inv.id}/payments`, who[code], { method: 'POST', body: { amount_paise: 5_000_00, paid_on: '2026-09-10' } })
      expect(p.status, code).toBe(200)
      await draftCredit(who[code], inv.id, 1_000_00)
    }
  })
})

describe('credit notes, cancellation and quotation approval: Senior Associate and above', () => {
  it('Associate and Intern are refused, and nothing changes', async () => {
    for (const code of ['employee', 'intern'] as const) {
      const inv = await sentInvoice(who.employee)
      const cn = await draftCredit(who.employee, inv.id, 1_000_00)
      expect((await api(`/api/credit-notes/${cn}/issue`, who[code], { method: 'POST' })).status, code).toBe(403)
      expect((await prisma.creditNote.findUniqueOrThrow({ where: { id: cn } })).status).toBe('draft')

      expect((await api(`/api/invoices/${inv.id}/cancel`, who[code], { method: 'POST', body: { reason: 'x' } })).status, code).toBe(403)
      expect((await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })).status).not.toBe('cancelled')

      const q = await prisma.quotation.create({ data: { organisationId: orgId, quotationCode: uid('QT'), clientId, subject: 'Audit', quoteDate: '2026-08-01', validUntil: '2026-12-31', status: 'sent' } })
      expect((await api(`/api/quotations/${q.id}/accept`, who[code], { method: 'POST', body: {} })).status, code).toBe(403)
      expect((await api(`/api/quotations/${q.id}/reject`, who[code], { method: 'POST', body: { reason: 'x' } })).status, code).toBe(403)
      expect((await prisma.quotation.findUniqueOrThrow({ where: { id: q.id } })).status).toBe('sent')
    }
  })

  it('an issued credit note cannot be cancelled by an Associate', async () => {
    const inv = await sentInvoice(who.employee)
    const cn = await draftCredit(who.employee, inv.id, 1_000_00)
    expect((await api(`/api/credit-notes/${cn}/issue`, who.dept_manager, { method: 'POST' })).status).toBe(200)
    expect((await api(`/api/credit-notes/${cn}/cancel`, who.employee, { method: 'POST', body: { reason: 'x' } })).status).toBe(403)
    expect((await prisma.creditNote.findUniqueOrThrow({ where: { id: cn } })).status).toBe('issued')
    expect((await api(`/api/credit-notes/${cn}/cancel`, who.dept_manager, { method: 'POST', body: { reason: 'x' } })).status).toBe(200)
  })

  it('a Senior Associate issues, cancels and approves', async () => {
    const inv = await sentInvoice(who.employee)
    const cn = await draftCredit(who.employee, inv.id, 1_000_00)
    expect((await api(`/api/credit-notes/${cn}/issue`, who.dept_manager, { method: 'POST' })).status).toBe(200)
    const other = await sentInvoice(who.employee)
    expect((await api(`/api/invoices/${other.id}/cancel`, who.dept_manager, { method: 'POST', body: { reason: 'raised twice' } })).status).toBe(200)
    const q = await prisma.quotation.create({ data: { organisationId: orgId, quotationCode: uid('QT'), clientId, subject: 'Audit', quoteDate: '2026-08-01', validUntil: '2026-12-31', status: 'sent' } })
    expect((await api(`/api/quotations/${q.id}/accept`, who.dept_manager, { method: 'POST', body: {} })).status).toBe(200)
  })
})

describe('refunds: partners only, capped at cash received', () => {
  /** Paid ₹10,800 cash + ₹1,000 TDS, then fully credited: ₹11,800 due back. */
  async function fullyCredited() {
    const inv = await sentInvoice(who.employee)
    const p = await api(`/api/invoices/${inv.id}/payments`, who.employee, { method: 'POST', body: { amount_paise: 10_800_00, tds_paise: 1_000_00, paid_on: '2026-09-10' } })
    expect(p.status).toBe(200)
    const cn = await draftCredit(who.employee, inv.id)
    expect((await api(`/api/credit-notes/${cn}/issue`, who.dept_manager, { method: 'POST' })).status).toBe(200)
    return inv.id
  }

  it('Associate, Intern and Senior Associate cannot record or remove a refund', async () => {
    const id = await fullyCredited()
    for (const code of ['employee', 'intern', 'dept_manager'] as const) {
      expect((await api(`/api/invoices/${id}/refunds`, who[code], { method: 'POST', body: { amount_paise: 100_00 } })).status, code).toBe(403)
    }
    expect(await prisma.invoiceRefund.count({ where: { invoiceId: id } })).toBe(0)
    const ok = await api(`/api/invoices/${id}/refunds`, who.md, { method: 'POST', body: { amount_paise: 100_00 } })
    expect(ok.status).toBe(200)
    const refundId = ok.body.refunds[0].id
    expect((await api(`/api/invoices/${id}/refunds/${refundId}`, who.dept_manager, { method: 'DELETE' })).status).toBe(403)
    expect((await prisma.invoiceRefund.findUniqueOrThrow({ where: { id: refundId } })).deletedAt).toBeNull()
  })

  it('the TDS portion is not paid back in cash unless a partner says include_tds, which is audited', async () => {
    const id = await fullyCredited()
    const over = await api(`/api/invoices/${id}/refunds`, who.md, { method: 'POST', body: { amount_paise: 11_800_00 } })
    expect(over.status).toBe(422)
    expect(over.body.error.code).toBe('refund_exceeds_cash')
    expect(await prisma.invoiceRefund.count({ where: { invoiceId: id, deletedAt: null } })).toBe(0)

    const cash = await api(`/api/invoices/${id}/refunds`, who.md, { method: 'POST', body: { amount_paise: 10_800_00 } })
    expect(cash.status).toBe(200)
    // Cumulative: the next rupee would be TDS.
    const more = await api(`/api/invoices/${id}/refunds`, who.md, { method: 'POST', body: { amount_paise: 1_00 } })
    expect(more.status).toBe(422)
    expect(more.body.error.code).toBe('refund_exceeds_cash')

    const tds = await api(`/api/invoices/${id}/refunds`, who.md, { method: 'POST', body: { amount_paise: 1_000_00, include_tds: true, note: 'Deductor revised the return' } })
    expect(tds.status, JSON.stringify(tds.body)).toBe(200)
    expect(tds.body.refunded_paise).toBe(11_800_00)
    const audit = await prisma.auditLog.findFirst({ where: { action: 'invoice_refund.recorded', entityId: id }, orderBy: { seq: 'desc' } })
    expect(JSON.parse(audit!.afterJson!).include_tds).toBe(true)
    // Still never beyond what is due back.
    expect((await api(`/api/invoices/${id}/refunds`, who.md, { method: 'POST', body: { amount_paise: 1_00, include_tds: true } })).body.error.code).toBe('refund_exceeds_due')
  })
})
