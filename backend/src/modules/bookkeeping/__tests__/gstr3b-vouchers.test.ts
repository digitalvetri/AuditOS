import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { createApp } from '../../../app.js'
import { signToken } from '../../../platform/auth.js'
import { prisma, uid } from '../../../__tests__/helpers.js'
import { setupRoles } from '../../../../prisma/setup-roles.js'

/**
 * GSTR-3B in Books comes from the sales, purchase, credit-note and
 * debit-note vouchers of the period — never from the GST ledgers' net
 * movement, which every GST payment and set-off journal disturbs.
 *
 * May 2026, by hand:
 *   sales B2B   ₹1,00,000 + CGST 9,000 + SGST 9,000
 *   sales B2C   ₹2,00,000 + IGST 36,000 (inter-state)
 *   purchase    ₹50,000   + CGST 4,500 + SGST 4,500
 *   credit note ₹10,000   + CGST 900   + SGST 900  (reduces outward)
 *   April CGST ₹3,000 paid (payment voucher)      — must not count
 *   set-off journal Dr Output CGST / Cr Input CGST ₹4,500 — must not count
 * 3.1(a) taxable 2,90,000; output CGST 8,100, SGST 8,100, IGST 36,000;
 * ITC CGST 4,500, SGST 4,500; net CGST 3,600, SGST 3,600, IGST 36,000.
 */

const R = (rupees: number) => rupees * 100

let server: Server
let base = ''
let cookie = ''
let companyId = ''
const L: Record<string, string> = {}

async function api(path: string, opts: { method?: string; body?: unknown } = {}) {
  const res = await fetch(`${base}${path}`, {
    method: opts.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  const text = await res.text()
  let body: unknown = null
  try { body = text ? JSON.parse(text) : null } catch { body = text }
  return { status: res.status, body: body as any }
}
const C = () => `/api/bookkeeping/companies/${companyId}`
const e = (ledger_id: string, entry_type: 'dr' | 'cr', amount_paise: number, extra: Record<string, unknown> = {}) => ({ ledger_id, entry_type, amount_paise, ...extra })

async function ledger(name: string, groupName: string, extra: Record<string, unknown> = {}) {
  const g = await prisma.bookkeepingGroup.findFirstOrThrow({ where: { tallyCompanyId: companyId, name: groupName } })
  const r = await api(`${C()}/ledgers`, { method: 'POST', body: { name, group_id: g.id, ...extra } })
  expect(r.status, JSON.stringify(r.body)).toBe(201)
  return r.body.data.id as string
}
async function post(body: Record<string, unknown>) {
  const r = await api(`${C()}/vouchers`, { method: 'POST', body })
  expect(r.status, JSON.stringify(r.body)).toBe(201)
}

beforeAll(async () => {
  server = createApp().listen(0)
  await new Promise((r) => server.once('listening', r))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  const orgId = (await prisma.organisation.findFirst({ where: { deletedAt: null } }))?.id ?? (await prisma.organisation.create({ data: { id: uid('org'), name: 'Firm' } })).id
  const wsId = (await prisma.workSchedule.findFirst())?.id ?? (await prisma.workSchedule.create({ data: { organisationId: orgId, name: 'Std', standardStart: '09:30', standardEnd: '18:30' } })).id
  await setupRoles(prisma, { force: true })
  const role = await prisma.role.findUniqueOrThrow({ where: { code: 'hr_admin' } })
  const emp = await prisma.employee.create({ data: { organisationId: orgId, employeeCode: uid('G3'), firstName: 'Gst', lastName: 'Three', fullName: 'Gst Three', email: `${uid('g3')}@x.local`, joiningDate: '2025-01-01', workScheduleId: wsId } })
  const u = await prisma.user.create({ data: { organisationId: orgId, email: emp.email, passwordHash: 'x', roleId: role.id, employeeId: emp.id } })
  cookie = `ao_access=${signToken(u.id)}`

  const c = await api('/api/bookkeeping/companies', { method: 'POST', body: { name: uid('Kaveri Textiles'), books_begin_from: '2026-04-01', gstin: '33AAACK1234F1Z5', state: 'Tamil Nadu' } })
  expect(c.status, JSON.stringify(c.body)).toBe(201)
  companyId = c.body.data.id
  const fys = await api(`${C()}/financial-years`)
  if (!fys.body.data.items.some((f: { label: string }) => f.label === '2026-27')) {
    const fy = await api(`${C()}/financial-years`, { method: 'POST', body: { label: '2026-27', start_date: '2026-04-01', end_date: '2027-03-31' } })
    expect(fy.status, JSON.stringify(fy.body)).toBe(201)
  }

  L.cash = await ledger('Cash', 'Cash-in-Hand')
  L.bank = await ledger('HDFC Bank CA', 'Bank Accounts')
  L.cust = await ledger('Lakshmi Stores', 'Sundry Debtors', { gstin: '33AABCL1234M1Z2', state: 'Tamil Nadu' })
  L.supp = await ledger('Ramco Yarns', 'Sundry Creditors', { gstin: '33AAACR5678K1Z9' })
  const gl = await prisma.bookkeepingLedger.findMany({ where: { tallyCompanyId: companyId } })
  for (const l of gl) L[l.name] = l.id
  for (const n of ['Sales', 'Purchases', 'Input CGST', 'Input SGST', 'Output CGST', 'Output SGST', 'Output IGST']) expect(L[n], n).toBeTruthy()

  await post({ voucher_type_code: 'sales', date: '2026-05-05', party_ledger_id: L.cust, place_of_supply: '33',
    entries: [e(L.cust, 'dr', R(118000), { is_party_ledger: true }), e(L.Sales, 'cr', R(100000)), e(L['Output CGST'], 'cr', R(9000)), e(L['Output SGST'], 'cr', R(9000))] })
  await post({ voucher_type_code: 'sales', date: '2026-05-10', place_of_supply: '29',
    entries: [e(L.cash, 'dr', R(236000)), e(L.Sales, 'cr', R(200000)), e(L['Output IGST'], 'cr', R(36000))] })
  await post({ voucher_type_code: 'purchase', date: '2026-05-15', party_ledger_id: L.supp, place_of_supply: '33',
    entries: [e(L.Purchases, 'dr', R(50000)), e(L['Input CGST'], 'dr', R(4500)), e(L['Input SGST'], 'dr', R(4500)), e(L.supp, 'cr', R(59000))] })
  await post({ voucher_type_code: 'credit_note', date: '2026-05-20', party_ledger_id: L.cust, place_of_supply: '33',
    entries: [e(L.Sales, 'dr', R(10000)), e(L['Output CGST'], 'dr', R(900)), e(L['Output SGST'], 'dr', R(900)), e(L.cust, 'cr', R(11800))] })
  await post({ voucher_type_code: 'payment', date: '2026-05-20', narration: 'CGST for April paid',
    entries: [e(L['Output CGST'], 'dr', R(3000)), e(L.bank, 'cr', R(3000))] })
  await post({ voucher_type_code: 'journal', date: '2026-05-31', narration: 'ITC set-off',
    entries: [e(L['Output CGST'], 'dr', R(4500)), e(L['Input CGST'], 'cr', R(4500))] })
})
afterAll(async () => { server.close(); await prisma.$disconnect() })

describe('Books GSTR-3B from vouchers', () => {
  it('May 2026: taxable ₹2,90,000, output CGST ₹8,100, ITC CGST ₹4,500, net CGST ₹3,600 — payments and set-off ignored', async () => {
    const r = await api(`${C()}/gst/gstr3b?from=2026-05-01&to=2026-05-31`)
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    const d = r.body.data
    expect(d.outwardTaxableSupplies).toMatchObject({ taxableValuePaise: R(290000), cgstPaise: R(8100), sgstPaise: R(8100), igstPaise: R(36000) })
    expect(d.itcAvailable).toMatchObject({ cgstPaise: R(4500), sgstPaise: R(4500), igstPaise: 0, totalPaise: R(9000) })
    expect(d.netPayable).toMatchObject({ cgstPaise: R(3600), sgstPaise: R(3600), igstPaise: R(36000), totalPaise: R(43200) })
    expect(d.inwardSupplies.taxableValuePaise).toBe(R(50000))
  })

  it('the GST summary card agrees: output ₹52,200, input ₹9,000, outward taxable ₹2,90,000', async () => {
    const r = await api(`${C()}/gst/summary?from=2026-05-01&to=2026-05-31`)
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    const d = r.body.data
    expect(d.output.totalPaise).toBe(R(52200))
    expect(d.input.totalPaise).toBe(R(9000))
    expect(d.outwardTaxableValuePaise).toBe(R(290000))
    expect(d.net.cgstPaise).toBe(R(3600))
  })
})
