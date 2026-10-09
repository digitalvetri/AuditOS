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

  it('group parent, nature and P&L flag are frozen once a year is closed; renames are not', async () => {
    const indirect = await prisma.bookkeepingGroup.findFirstOrThrow({ where: { tallyCompanyId: companyId, name: 'Indirect Expenses' } })
    const direct = await prisma.bookkeepingGroup.findFirstOrThrow({ where: { tallyCompanyId: companyId, name: 'Direct Expenses' } })
    // A sub-group created before the close carries money through its ledger.
    const sub = await prisma.bookkeepingGroup.create({ data: { tallyCompanyId: companyId, name: uid('Admin Costs'), parentGroupId: indirect.id, nature: 'expenses', affectsPL: true } })
    await prisma.bookkeepingLedger.update({ where: { id: L.rent }, data: { groupId: sub.id } })

    const parent = await api(`${C()}/groups/${sub.id}`, { method: 'PATCH', body: { parent_group_id: direct.id } })
    expect(parent.status, JSON.stringify(parent.body)).toBe(422)
    expect(parent.body.error?.code).toBe('financial_year_closed')
    const flag = await api(`${C()}/groups/${sub.id}`, { method: 'PATCH', body: { affects_pl: false } })
    expect(flag.status).toBe(422)
    expect(flag.body.error?.code).toBe('financial_year_closed')
    const nature = await api(`${C()}/groups/${sub.id}`, { method: 'PATCH', body: { nature: 'assets' } })
    expect(nature.status).toBe(422)
    expect(nature.body.error?.code).toBe('financial_year_closed')

    const row = await prisma.bookkeepingGroup.findUniqueOrThrow({ where: { id: sub.id } })
    expect(row.parentGroupId).toBe(indirect.id)
    expect(row.affectsPL).toBe(true)
    expect(row.nature).toBe('expenses')

    // Re-sending the unchanged values with a rename is fine.
    const rename = await api(`${C()}/groups/${sub.id}`, { method: 'PATCH', body: { name: `${sub.name} (HO)`, parent_group_id: indirect.id, affects_pl: true, nature: 'expenses' } })
    expect(rename.status, JSON.stringify(rename.body)).toBe(200)
    expect(rename.body.data.name).toBe(`${sub.name} (HO)`)

    // A group carrying a ledger, or holding a sub-group, cannot be deleted.
    expect((await api(`${C()}/groups/${sub.id}`, { method: 'DELETE' })).status).toBe(400)
    const outer = await prisma.bookkeepingGroup.create({ data: { tallyCompanyId: companyId, name: uid('Outer'), parentGroupId: indirect.id, nature: 'expenses', affectsPL: true } })
    await prisma.bookkeepingGroup.create({ data: { tallyCompanyId: companyId, name: uid('Inner'), parentGroupId: outer.id, nature: 'expenses', affectsPL: true } })
    expect((await api(`${C()}/groups/${outer.id}`, { method: 'DELETE' })).status).toBe(400)
    expect((await prisma.bookkeepingGroup.findUniqueOrThrow({ where: { id: outer.id } })).deletedAt).toBeNull()

    await prisma.bookkeepingLedger.update({ where: { id: L.rent }, data: { groupId: indirect.id } })
  })

  it('groups can still be re-parented while no year is closed', async () => {
    const other = await api('/api/bookkeeping/companies', { method: 'POST', body: { name: uid('Open Co'), books_begin_from: '2025-04-01' } })
    expect(other.status).toBe(201)
    const oc = other.body.data.id as string
    const indirect = await prisma.bookkeepingGroup.findFirstOrThrow({ where: { tallyCompanyId: oc, name: 'Indirect Expenses' } })
    const direct = await prisma.bookkeepingGroup.findFirstOrThrow({ where: { tallyCompanyId: oc, name: 'Direct Expenses' } })
    const sub = await prisma.bookkeepingGroup.create({ data: { tallyCompanyId: oc, name: uid('Misc'), parentGroupId: indirect.id, nature: 'expenses', affectsPL: true } })
    const r = await api(`/api/bookkeeping/companies/${oc}/groups/${sub.id}`, { method: 'PATCH', body: { parent_group_id: direct.id } })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body.data.parent_group_id).toBe(direct.id)
  })

  it('an opening-balance import cannot change openings either', async () => {
    const r = await api(`${C()}/data/import/commit`, { method: 'POST', body: { entity: 'opening_balances', rows: [{ ledger: 'Owner Capital', amount: 2_000, dr_cr: 'cr' }] } })
    expect(r.status, JSON.stringify(r.body)).toBe(422)
    expect(r.body.error?.code).toBe('financial_year_closed')
    const row = await prisma.bookkeepingLedger.findUniqueOrThrow({ where: { id: L.capital } })
    expect(row.openingBalancePaise).toBe(100_000)
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

/**
 * Closing stock (Tally style): opening stock is debited to the P&L, the
 * closing stock at the year's weighted-average purchase cost is credited
 * to it and shown as a current asset. Ledger openings carry the opening
 * stock on the capital side (capital = cash + opening stock), as Tally
 * expects.
 *
 *   FY1: opening 10 @ ₹100 · purchase 10 @ ₹120 (May) · sale 5 @ ₹200 (June)
 *        average ₹110 → closing 15 = ₹1,650, gross profit ₹450
 *   FY2: opening 15 = ₹1,650 · sale 5 @ ₹200 (May 2026) · purchase 10 @ ₹200 (Aug)
 *        at 30 June: average ₹110 → closing 10 = ₹1,100, gross profit ₹450
 *        full year: average (1,650 + 2,000) / 25 = ₹146 → closing 20 = ₹2,920,
 *        gross profit 1,000 − 2,000 − 1,650 + 2,920 = ₹270 (the average
 *        restarts each year, so FY1's cost never leaks into FY2's)
 */
describe('Closing stock reaches the P&L and the balance sheet', () => {
  let sc = ''
  let itemId = ''
  let scFy1 = ''
  const S: Record<string, string> = {}
  const SC = () => `/api/bookkeeping/companies/${sc}`

  async function sLedger(name: string, groupName: string, opening = 0, type: 'dr' | 'cr' = 'dr') {
    const g = await prisma.bookkeepingGroup.findFirstOrThrow({ where: { tallyCompanyId: sc, name: groupName } })
    const r = await api(`${SC()}/ledgers`, { method: 'POST', body: { name, group_id: g.id, opening_balance_paise: opening, opening_balance_type: type } })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
    return r.body.data.id as string
  }
  async function trade(code: 'purchase' | 'sales', date: string, qtyMilli: number, ratePaise: number) {
    const amount = Math.round((qtyMilli * ratePaise) / 1000)
    const purchase = code === 'purchase'
    const r = await api(`${SC()}/vouchers`, {
      method: 'POST',
      body: {
        voucher_type_code: code, date,
        entries: purchase
          ? [{ ledger_id: S.purchases, entry_type: 'dr', amount_paise: amount }, { ledger_id: S.cash, entry_type: 'cr', amount_paise: amount }]
          : [{ ledger_id: S.cash, entry_type: 'dr', amount_paise: amount }, { ledger_id: S.sales, entry_type: 'cr', amount_paise: amount }],
        items: [{ stock_item_id: itemId, direction: purchase ? 'in' : 'out', qty_milli: qtyMilli, rate_paise: ratePaise }],
      },
    })
    expect(r.status, JSON.stringify(r.body)).toBe(201)
  }
  async function pl(from: string, to: string) {
    const r = await api(`${SC()}/reports/profit-and-loss?from=${from}&to=${to}`)
    expect(r.status).toBe(200)
    return r.body.data
  }
  async function sheet(from: string, to: string) {
    const r = await api(`${SC()}/reports/balance-sheet?from=${from}&to=${to}`)
    expect(r.status).toBe(200)
    return r.body.data
  }
  const closingStockLine = (s: any) => {
    const ca = s.assets.groups.find((g: any) => g.groupName === 'Current Assets')
    return ca?.ledgers.find((l: any) => l.ledgerName === 'Closing Stock')?.amountPaise
  }

  beforeAll(async () => {
    const c = await api('/api/bookkeeping/companies', { method: 'POST', body: { name: uid('Stock Co'), books_begin_from: '2025-04-01' } })
    expect(c.status, JSON.stringify(c.body)).toBe(201)
    sc = c.body.data.id
    scFy1 = (await prisma.bookkeepingFinancialYear.findFirstOrThrow({ where: { tallyCompanyId: sc } })).id
    expect((await api(`${SC()}/financial-years`, { method: 'POST', body: { label: '2026-27', start_date: '2026-04-01', end_date: '2027-03-31' } })).status).toBe(201)

    S.cash = await sLedger('Shop Cash', 'Cash-in-Hand', 500_000, 'dr')
    S.capital = await sLedger('Proprietor Capital', 'Capital Account', 600_000, 'cr')
    S.purchases = await sLedger('Widget Purchases', 'Purchase Accounts')
    S.sales = await sLedger('Widget Sales', 'Sales Accounts')

    const item = await api(`${SC()}/inventory/items`, { method: 'POST', body: { name: 'Widget', opening_qty_milli: 10_000, opening_rate_paise: 10_000 } })
    expect(item.status, JSON.stringify(item.body)).toBe(201)
    itemId = item.body.data.id

    await trade('purchase', '2025-05-10', 10_000, 12_000)
    await trade('sales', '2025-06-10', 5_000, 20_000)
    await trade('sales', '2026-05-10', 5_000, 20_000)
    await trade('purchase', '2026-08-10', 10_000, 20_000)
  })

  it('the year-1 P&L debits opening stock and credits closing stock', async () => {
    const p = await pl('2025-04-01', '2025-09-30')
    expect(p.openingStockPaise).toBe(100_000)
    expect(p.closingStockPaise).toBe(165_000)
    // Sales 1,00,000 − purchases 1,20,000 − opening 1,00,000 + closing 1,65,000.
    expect(p.grossProfitPaise).toBe(45_000)
    // = sales less 5 units at the ₹1,100 average cost.
    expect(p.grossProfitPaise).toBe(100_000 - 5 * 11_000)
    expect(p.netProfitPaise).toBe(45_000)
    // Stock never counts as revenue or as an expense ledger.
    expect(p.income.totalPaise).toBe(100_000)
    expect(p.expenses.totalPaise).toBe(120_000)
  })

  it('a month P&L opens with the stock held at the end of the previous month', async () => {
    const p = await pl('2025-06-01', '2025-06-30')
    expect(p.openingStockPaise).toBe(220_000)
    expect(p.closingStockPaise).toBe(165_000)
    expect(p.grossProfitPaise).toBe(45_000)
  })

  it('the balance sheet shows closing stock under current assets and balances mid-year', async () => {
    for (const from of ['2025-04-01', '2025-09-01']) {
      const s = await sheet(from, '2025-09-30')
      expectBalanced(s)
      expect(closingStockLine(s)).toBe(165_000)
      expect(s.assets.totalPaise).toBe(480_000 + 165_000)
      expect(s.netProfitPaise).toBe(45_000)
      expect(s.retainedEarningsPaise).toBe(0)
    }
  })

  it('the next year opens with last year’s closing stock and still balances', async () => {
    const p = await pl('2026-04-01', '2026-06-30')
    expect(p.openingStockPaise).toBe(165_000)
    expect(p.closingStockPaise).toBe(110_000)
    expect(p.grossProfitPaise).toBe(45_000)

    const s = await sheet('2026-04-01', '2026-06-30')
    expectBalanced(s)
    expect(closingStockLine(s)).toBe(110_000)
    expect(s.assets.totalPaise).toBe(580_000 + 110_000)
    expect(s.retainedEarningsPaise).toBe(45_000)
    expect(s.netProfitPaise).toBe(45_000)
  })

  it('the year-2 average restarts from the year’s opening stock', async () => {
    const p = await pl('2026-04-01', '2027-03-31')
    expect(p.openingStockPaise).toBe(165_000)
    expect(p.closingStockPaise).toBe(292_000)
    expect(p.grossProfitPaise).toBe(27_000)
    // = sales less 5 units at the year's ₹146 average cost.
    expect(p.grossProfitPaise).toBe(100_000 - 5 * 14_600)

    const s = await sheet('2026-04-01', '2027-03-31')
    expectBalanced(s)
    expect(closingStockLine(s)).toBe(292_000)
    expect(s.assets.totalPaise).toBe(380_000 + 292_000)
    expect(s.retainedEarningsPaise).toBe(45_000)
    expect(s.netProfitPaise).toBe(27_000)
  })

  it('the trial balance counts the opening stock and balances', async () => {
    const r = await api(`${SC()}/reports/trial-balance?to=2027-03-31`)
    expect(r.body.data.totals.openingStockPaise).toBe(100_000)
    expect(r.body.data.totals.balanced).toBe(true)
  })

  it('opening stock is frozen once a year is closed', async () => {
    expect((await api(`${SC()}/financial-years/${scFy1}/close`, { method: 'PATCH' })).status).toBe(200)
    const r = await api(`${SC()}/inventory/items/${itemId}/opening`, { method: 'PUT', body: { qty_milli: 50_000, rate_paise: 10_000 } })
    expect(r.status, JSON.stringify(r.body)).toBe(422)
    expect(r.body.error?.code).toBe('financial_year_closed')
    const same = await api(`${SC()}/inventory/items/${itemId}/opening`, { method: 'PUT', body: { qty_milli: 10_000, rate_paise: 10_000 } })
    expect(same.status, JSON.stringify(same.body)).toBe(200)
    const created = await api(`${SC()}/inventory/items`, { method: 'POST', body: { name: 'Gadget', opening_qty_milli: 1_000, opening_rate_paise: 5_000 } })
    expect(created.status).toBe(422)
    expect(created.body.error?.code).toBe('financial_year_closed')
    expectBalanced(await sheet('2026-04-01', '2026-06-30'))
  })
})

describe('amounts above the 32-bit paise limit', () => {
  it('a ₹30 crore opening balance gets a clear 422, not a 500', async () => {
    const g = (await api(`${C()}/groups`)).body.data.items.find((x: { name: string }) => x.name === 'Capital Account')
    const r = await api(`${C()}/ledgers`, { method: 'POST', body: { name: 'Big Capital', group_id: g.id, opening_balance_paise: 30_00_00_000_00, opening_balance_type: 'cr' } })
    expect(r.status).toBe(422)
    expect(r.body.error.code).toBe('amount_too_large')
  })
})
