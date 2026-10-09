import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { createApp } from '../../../app.js'
import { signToken } from '../../../platform/auth.js'
import { prisma, uid } from '../../../__tests__/helpers.js'
import { setupRoles } from '../../../../prisma/setup-roles.js'

/**
 * Client books routinely carry single amounts far above ₹2,14,74,836.47 —
 * the 32-bit paise ceiling the money columns used to have. A ₹30 crore
 * capital and plant, and a ₹25 crore sale, must save and report exactly.
 */

const CR = 100_00_000_00 // ₹1 crore in paise
const OPENING = 30 * CR // ₹30 crore = 3,00,00,00,000.00
const SALE = 25 * CR

let server: Server
let base = ''
let cookie = ''
let companyId = ''
let employeeId = ''
let orgId = ''
const L: Record<string, string> = {}
let voucherId = ''

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

async function ledger(name: string, groupName: string, opening = 0, type: 'dr' | 'cr' = 'dr') {
  const g = await prisma.bookkeepingGroup.findFirstOrThrow({ where: { tallyCompanyId: companyId, name: groupName } })
  const r = await api(`${C()}/ledgers`, { method: 'POST', body: { name, group_id: g.id, opening_balance_paise: opening, opening_balance_type: type } })
  expect(r.status, JSON.stringify(r.body)).toBe(201)
  return r.body.data.id as string
}

beforeAll(async () => {
  server = createApp().listen(0)
  await new Promise((r) => server.once('listening', r))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  orgId = (await prisma.organisation.findFirst({ where: { deletedAt: null } }))?.id ?? (await prisma.organisation.create({ data: { id: uid('org'), name: 'Firm' } })).id
  const wsId = (await prisma.workSchedule.findFirst())?.id ?? (await prisma.workSchedule.create({ data: { organisationId: orgId, name: 'Std', standardStart: '09:30', standardEnd: '18:30' } })).id
  await setupRoles(prisma, { force: true })
  const role = await prisma.role.findUniqueOrThrow({ where: { code: 'hr_admin' } })
  const emp = await prisma.employee.create({ data: { organisationId: orgId, employeeCode: uid('BG'), firstName: 'Big', lastName: 'Books', fullName: 'Big Books', email: `${uid('b')}@x.local`, joiningDate: '2025-01-01', workScheduleId: wsId } })
  employeeId = emp.id
  const u = await prisma.user.create({ data: { organisationId: orgId, email: emp.email, passwordHash: 'x', roleId: role.id, employeeId: emp.id } })
  cookie = `ao_access=${signToken(u.id)}`

  const c = await api('/api/bookkeeping/companies', { method: 'POST', body: { name: uid('Crore Co'), books_begin_from: '2025-04-01' } })
  expect(c.status, JSON.stringify(c.body)).toBe(201)
  companyId = c.body.data.id

  L.plant = await ledger('Plant & Machinery', 'Fixed Assets', OPENING, 'dr')
  L.capital = await ledger('Promoter Capital', 'Capital Account', OPENING, 'cr')
  L.bank = await ledger('Current Account', 'Bank Accounts')
  L.sales = await ledger('Project Sales', 'Sales Accounts')
})
afterAll(async () => { server.close(); await prisma.$disconnect() })

describe('crore-scale client books', () => {
  it('saves and reads back a ₹30 crore opening balance', async () => {
    const r = await api(`${C()}/ledgers/${L.capital}`)
    expect(r.status).toBe(200)
    expect(r.body.data.opening_balance_paise).toBe(OPENING)
    expect(r.body.data.opening_balance_type).toBe('cr')
  })

  it('posts a ₹25 crore voucher and reads it back exactly', async () => {
    const r = await api(`${C()}/vouchers`, {
      method: 'POST',
      body: {
        voucher_type_code: 'journal', date: '2025-06-15', narration: 'Turnkey project billing',
        entries: [
          { ledger_id: L.bank, entry_type: 'dr', amount_paise: SALE },
          { ledger_id: L.sales, entry_type: 'cr', amount_paise: SALE },
        ],
      },
    })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    voucherId = r.body.data.id
    expect(r.body.data.total_debit_paise).toBe(SALE)
    expect(r.body.data.total_credit_paise).toBe(SALE)
    expect(r.body.data.entries.map((e: { amount_paise: number }) => e.amount_paise)).toEqual([SALE, SALE])

    const list = await api(`${C()}/vouchers`)
    expect(list.status).toBe(200)
    expect(list.body.data.items.find((v: { id: string }) => v.id === voucherId).total_debit_paise).toBe(SALE)
  })

  it('the ledger statement carries the crore amounts', async () => {
    const r = await api(`${C()}/reports/ledger/${L.bank}?from=2025-04-01&to=2026-03-31`)
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body.data.debitPaise).toBe(SALE)
    expect(r.body.data.closingPaise).toBe(SALE)
    expect(r.body.data.rows[0].debit_paise).toBe(SALE)
  })

  it('the trial balance totals ₹55 crore on each side and balances', async () => {
    const r = await api(`${C()}/reports/trial-balance?from=2025-04-01&to=2026-03-31`)
    expect(r.status).toBe(200)
    const t = r.body.data.totals
    expect(t.openingDebitPaise).toBe(OPENING)
    expect(t.openingCreditPaise).toBe(OPENING)
    expect(t.closingDebitPaise).toBe(OPENING + SALE)
    expect(t.closingCreditPaise).toBe(OPENING + SALE)
    expect(t.differencePaise).toBe(0)
    expect(t.balanced).toBe(true)
  })

  it('P&L shows ₹25 crore income and profit', async () => {
    const r = await api(`${C()}/reports/profit-and-loss?from=2025-04-01&to=2026-03-31`)
    expect(r.status).toBe(200)
    expect(r.body.data.income.totalPaise).toBe(SALE)
    expect(r.body.data.expenses.totalPaise).toBe(0)
    expect(r.body.data.netProfitPaise).toBe(SALE)
  })

  it('the balance sheet balances at ₹55 crore', async () => {
    const r = await api(`${C()}/reports/balance-sheet?from=2025-04-01&to=2026-03-31`)
    expect(r.status).toBe(200)
    const s = r.body.data
    expect(s.assets.totalPaise).toBe(OPENING + SALE)
    expect(s.liabilities.totalPaise).toBe(OPENING)
    expect(s.netProfitPaise).toBe(SALE)
    expect(s.differencePaise).toBe(0)
    expect(s.balanced).toBe(true)
  })

  it('the day book reports the voucher at full value', async () => {
    const r = await api(`${C()}/reports/day-book?from=2025-04-01&to=2026-03-31`)
    expect(r.status).toBe(200)
    expect(r.body.data.totals.debit_paise).toBe(SALE)
  })

  it('altering the voucher records a before/after revision with the crore amounts', async () => {
    const r = await api(`${C()}/vouchers/${voucherId}`, {
      method: 'PATCH',
      body: {
        voucher_type_code: 'journal', date: '2025-06-15', narration: 'Turnkey project billing (revised)',
        entries: [
          { ledger_id: L.bank, entry_type: 'dr', amount_paise: SALE + 1 },
          { ledger_id: L.sales, entry_type: 'cr', amount_paise: SALE + 1 },
        ],
      },
    })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body.data.total_debit_paise).toBe(SALE + 1)
    const rev = await prisma.bookkeepingVoucherRevision.findFirstOrThrow({ where: { voucherId, action: 'updated' } })
    expect(JSON.parse(rev.beforeJson!).entries[0].amount_paise).toBe(SALE)
    expect(JSON.parse(rev.afterJson!).entries[0].amount_paise).toBe(SALE + 1)
  })

  it('a backup carries the amounts as JSON numbers and restores into a company that balances', async () => {
    const b = await api(`${C()}/data/backups`, { method: 'POST', body: { label: 'crore' } })
    expect(b.status, JSON.stringify(b.body)).toBe(201)
    const payload = await api(`${C()}/data/backups/${b.body.data.id}`)
    expect(payload.status).toBe(200)
    expect(payload.body.ledgers.find((l: { name: string }) => l.name === 'Promoter Capital').openingBalancePaise).toBe(OPENING)

    const restored = await api(`${C()}/data/backups/${b.body.data.id}/restore`, { method: 'POST', body: { new_company_name: uid('Crore Restored'), confirm: true } })
    expect(restored.status, JSON.stringify(restored.body)).toBe(201)
    expect(restored.body.data.vouchers_restored).toBe(1)
    const tb = await api(`/api/bookkeeping/companies/${restored.body.data.restored_company_id}/reports/trial-balance?to=2026-03-31`)
    expect(tb.body.data.totals.closingDebitPaise).toBe(OPENING + SALE + 1)
    expect(tb.body.data.totals.balanced).toBe(true)
  })
})

describe('crore-scale e-way bills', () => {
  it('generates and lists an e-way bill above ₹2.14 crore', async () => {
    const client = await prisma.client.create({
      data: {
        id: uid('cli'), organisationId: orgId, clientCode: uid('C'), companyName: 'Crore Traders',
        contactPerson: 'C', contactNumber: '9840011111', accountManagerId: employeeId, onboardingDate: '2026-01-01',
      },
    })
    const r = await api(`/api/clients/${client.id}/eway/generate`, {
      method: 'POST', body: { document_no: 'INV-CR-1', document_date: '2026-06-01', value: 30_00_00_000.5 },
    })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    expect(r.body.data.value_paise).toBe(30_00_00_000_50)
    const list = await api(`/api/clients/${client.id}/eway`)
    expect(list.status).toBe(200)
    expect(list.body.data.items[0].value_paise).toBe(30_00_00_000_50)
    const audit = await prisma.auditLog.findFirst({ where: { entityType: 'EwayBill', entityId: r.body.data.id } })
    expect(JSON.parse(audit!.afterJson!).valuePaise).toBe(30_00_00_000_50)
  })
})
