import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { createApp } from '../../../app.js'
import { signToken } from '../../../platform/auth.js'
import { prisma, uid } from '../../../__tests__/helpers.js'
import { setupRoles } from '../../../../prisma/setup-roles.js'

/**
 * Three ways the books used to lose integrity:
 *   1. the balance sheet only carried the selected period's profit, so it
 *      went out of balance in month/quarter view and from year 2 on;
 *   2. a closed financial year could still be changed by alter, cancel and
 *      ledger master edits;
 *   3. deleting a ledger with postings silently dropped its money from
 *      every report.
 */

let server: Server
let base = ''
let cookie = ''
let companyId = ''
let fy1Id = ''
const L: Record<string, string> = {}
const V: Record<string, string> = {}

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

async function journal(date: string, dr: string, cr: string, amount: number) {
  const r = await api(`${C()}/vouchers`, {
    method: 'POST',
    body: {
      voucher_type_code: 'journal', date,
      entries: [
        { ledger_id: dr, entry_type: 'dr', amount_paise: amount },
        { ledger_id: cr, entry_type: 'cr', amount_paise: amount },
      ],
    },
  })
  expect(r.status, JSON.stringify(r.body)).toBe(201)
  return r.body.data.id as string
}

async function bs(from: string, to: string) {
  const r = await api(`${C()}/reports/balance-sheet?from=${from}&to=${to}`)
  expect(r.status).toBe(200)
  return r.body.data
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
  const emp = await prisma.employee.create({ data: { organisationId: orgId, employeeCode: uid('AO'), firstName: 'A', lastName: 'Admin', fullName: 'A Admin', email: `${uid('a')}@x.local`, joiningDate: '2025-01-01', workScheduleId: wsId } })
  const u = await prisma.user.create({ data: { organisationId: orgId, email: emp.email, passwordHash: 'x', roleId: role.id, employeeId: emp.id } })
  cookie = `ao_access=${signToken(u.id)}`

  const c = await api('/api/bookkeeping/companies', { method: 'POST', body: { name: uid('Integrity Co'), books_begin_from: '2025-04-01' } })
  expect(c.status, JSON.stringify(c.body)).toBe(201)
  companyId = c.body.data.id
  fy1Id = (await prisma.bookkeepingFinancialYear.findFirstOrThrow({ where: { tallyCompanyId: companyId } })).id
  const fy2 = await api(`${C()}/financial-years`, { method: 'POST', body: { label: '2026-27', start_date: '2026-04-01', end_date: '2027-03-31' } })
  expect(fy2.status).toBe(201)

  L.cash = await ledger('Cash Till', 'Cash-in-Hand', 100_000, 'dr')
  L.capital = await ledger('Owner Capital', 'Capital Account', 100_000, 'cr')
  L.sales = await ledger('Shop Sales', 'Sales Accounts')
  L.rent = await ledger('Office Rent', 'Indirect Expenses')

  V.fy1Sale = await journal('2025-06-15', L.cash, L.sales, 50_000)
  V.fy1Rent = await journal('2025-09-10', L.rent, L.cash, 10_000)
  V.fy2Sale = await journal('2026-05-10', L.cash, L.sales, 20_000)
})
afterAll(async () => { server.close(); await prisma.$disconnect() })

function expectBalanced(sheet: any) {
  const right = sheet.liabilities.totalPaise + (sheet.retainedEarningsPaise ?? 0) + sheet.netProfitPaise
  expect(sheet.assets.totalPaise).toBe(right)
  expect(sheet.differencePaise).toBe(0)
  expect(sheet.balanced).toBe(true)
}

describe('Balance sheet carries all accumulated profit', () => {
  it('a month view inside year 1 balances and shows year-to-date profit', async () => {
    const sheet = await bs('2025-09-01', '2025-09-30')
    expectBalanced(sheet)
    expect(sheet.assets.totalPaise).toBe(140_000)
    expect(sheet.netProfitPaise).toBe(40_000)
    expect(sheet.retainedEarningsPaise).toBe(0)
  })

  it('a date in year 2 balances: last year’s profit is retained, this year’s is current', async () => {
    for (const from of ['2026-04-01', '2026-06-01']) {
      const sheet = await bs(from, '2026-06-30')
      expectBalanced(sheet)
      expect(sheet.assets.totalPaise).toBe(160_000)
      expect(sheet.retainedEarningsPaise).toBe(40_000)
      expect(sheet.netProfitPaise).toBe(20_000)
      expect(sheet.fyStart).toBe('2026-04-01')
    }
  })
})

describe('A closed financial year cannot be changed', () => {
  beforeAll(async () => {
    const r = await api(`${C()}/financial-years/${fy1Id}/close`, { method: 'PATCH' })
    expect(r.status).toBe(200)
  })

  it('the balance sheet still balances after closing', async () => {
    expectBalanced(await bs('2026-04-01', '2026-06-30'))
  })

  it('a voucher in the closed year cannot be altered, even into an open year', async () => {
    for (const date of ['2025-06-20', '2026-06-20']) {
      const r = await api(`${C()}/vouchers/${V.fy1Sale}`, {
        method: 'PATCH',
        body: {
          date,
          entries: [
            { ledger_id: L.cash, entry_type: 'dr', amount_paise: 99_000 },
            { ledger_id: L.sales, entry_type: 'cr', amount_paise: 99_000 },
          ],
        },
      })
      expect(r.status, date).toBe(422)
      expect(r.body.error?.code ?? r.body.code).toBe('financial_year_closed')
    }
  })

  it('a voucher in the closed year cannot be cancelled', async () => {
    const r = await api(`${C()}/vouchers/${V.fy1Rent}/cancel`, { method: 'POST', body: { reason: 'oops' } })
    expect(r.status).toBe(422)
    const v = await prisma.bookkeepingVoucher.findUniqueOrThrow({ where: { id: V.fy1Rent } })
    expect(v.status).toBe('active')
  })

  it('a voucher in an open year can still be altered and cancelled', async () => {
    const v = await journal('2026-07-01', L.rent, L.cash, 1_000)
    const a = await api(`${C()}/vouchers/${v}`, {
      method: 'PATCH',
      body: { date: '2026-07-02', entries: [
        { ledger_id: L.rent, entry_type: 'dr', amount_paise: 2_000 },
        { ledger_id: L.cash, entry_type: 'cr', amount_paise: 2_000 },
      ] },
    })
    expect(a.status, JSON.stringify(a.body)).toBe(200)
    expect((await api(`${C()}/vouchers/${v}/cancel`, { method: 'POST', body: {} })).status).toBe(200)
  })

  it('opening balances and groups are frozen once a year is closed; names are not', async () => {
    const opening = await api(`${C()}/ledgers/${L.cash}`, { method: 'PATCH', body: { opening_balance_paise: 1 } })
    expect(opening.status).toBe(422)
    const side = await api(`${C()}/ledgers/${L.cash}`, { method: 'PATCH', body: { opening_balance_type: 'cr' } })
    expect(side.status).toBe(422)
    const bank = await prisma.bookkeepingGroup.findFirstOrThrow({ where: { tallyCompanyId: companyId, name: 'Bank Accounts' } })
    const group = await api(`${C()}/ledgers/${L.cash}`, { method: 'PATCH', body: { group_id: bank.id } })
    expect(group.status).toBe(422)
    // A form that re-sends the unchanged values along with a rename is fine.
    const rename = await api(`${C()}/ledgers/${L.cash}`, { method: 'PATCH', body: { name: 'Cash Box', opening_balance_paise: 100_000, opening_balance_type: 'dr' } })
    expect(rename.status, JSON.stringify(rename.body)).toBe(200)
    const row = await prisma.bookkeepingLedger.findUniqueOrThrow({ where: { id: L.cash } })
    expect(row.openingBalancePaise).toBe(100_000)
    expect(row.name).toBe('Cash Box')
  })
})

describe('A ledger carrying money cannot be deleted', () => {
  it('refuses a ledger with voucher entries', async () => {
    const r = await api(`${C()}/ledgers/${L.sales}`, { method: 'DELETE' })
    expect(r.status).toBe(409)
    expect(r.body.error?.code ?? r.body.code).toBe('ledger_in_use')
    const row = await prisma.bookkeepingLedger.findUniqueOrThrow({ where: { id: L.sales } })
    expect(row.deletedAt).toBeNull()
  })

  it('refuses a ledger with an opening balance', async () => {
    const loan = await ledger('Old Loan', 'Loans (Liability)', 5_000, 'cr')
    const deposit = await ledger('Old Deposit', 'Current Assets', 5_000, 'dr')
    expect((await api(`${C()}/ledgers/${loan}`, { method: 'DELETE' })).status).toBe(409)
    expect((await api(`${C()}/ledgers/${deposit}`, { method: 'DELETE' })).status).toBe(409)
  })

  it('refuses a ledger whose only entries sit on a cancelled voucher', async () => {
    const misc = await ledger('Sundry Misc', 'Indirect Expenses')
    const v = await journal('2026-08-01', misc, L.cash, 500)
    expect((await api(`${C()}/vouchers/${v}/cancel`, { method: 'POST', body: {} })).status).toBe(200)
    expect((await api(`${C()}/ledgers/${misc}`, { method: 'DELETE' })).status).toBe(409)
  })

  it('still deletes an unused ledger', async () => {
    const id = await ledger('Typo Ledger', 'Indirect Expenses')
    expect((await api(`${C()}/ledgers/${id}`, { method: 'DELETE' })).status).toBe(204)
  })

  it('the trial balance still balances', async () => {
    const r = await api(`${C()}/reports/trial-balance?to=2027-03-31`)
    expect(r.body.data.totals.balanced).toBe(true)
  })
})
