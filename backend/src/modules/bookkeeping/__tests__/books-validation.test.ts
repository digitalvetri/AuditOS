import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma, uid } from '../../../__tests__/helpers.js'
import { startHarness, type Harness, type Staff } from '../../workstation/__tests__/ws-harness.js'
import { commitBatch, type ClassifiedBatch } from '../services/BookkeepingImportCommitService.js'

/**
 * Native books input checks:
 *  - altering a voucher onto another voucher's number is a clean 4xx, not a 500;
 *  - financial years may not overlap;
 *  - bill allocations are positive and never exceed their line;
 *  - an imported foreign-currency invoice keeps its currency, foreign amount and rate.
 */
let h: Harness
let md: Staff
let companyId = ''
const L: Record<string, string> = {}
const C = () => `/api/bookkeeping/companies/${companyId}`

async function ledger(name: string, groupName: string) {
  const g = await prisma.bookkeepingGroup.findFirstOrThrow({ where: { tallyCompanyId: companyId, name: groupName } })
  const r = await h.api(`${C()}/ledgers`, md.cookie, { method: 'POST', body: { name, group_id: g.id } })
  expect(r.status, JSON.stringify(r.body)).toBe(201)
  return (r.body.id ?? r.body.data?.id) as string
}

const journal = (date: string, amount: number, extra: Record<string, unknown> = {}, entryExtra: Record<string, unknown> = {}) => ({
  voucher_type_code: 'journal', date, ...extra,
  entries: [
    { ledger_id: L.party, entry_type: 'dr', amount_paise: amount, ...entryExtra },
    { ledger_id: L.sales, entry_type: 'cr', amount_paise: amount },
  ],
})

beforeAll(async () => {
  h = await startHarness()
  md = await h.staff('md')
  const client = await h.client(md.emp.id)
  const c = await h.api('/api/bookkeeping/companies', md.cookie, { method: 'POST', body: { name: uid('Checks Co'), books_begin_from: '2025-04-01', client_id: client.id } })
  expect(c.status, JSON.stringify(c.body)).toBe(201)
  companyId = c.body.id
  L.party = await ledger(uid('Acme Buyer'), 'Sundry Debtors')
  L.sales = await ledger(uid('Export Sales'), 'Sales Accounts')
})
afterAll(() => h?.close())

describe('altering a voucher to a number already taken', () => {
  it('answers 409 duplicate_voucher_number and leaves both vouchers as they were', async () => {
    const a = await h.api(`${C()}/vouchers`, md.cookie, { method: 'POST', body: journal('2025-06-01', 1000, { voucher_number: 'J-A' }) })
    const b = await h.api(`${C()}/vouchers`, md.cookie, { method: 'POST', body: journal('2025-06-02', 2000, { voucher_number: 'J-B' }) })
    expect(a.status, JSON.stringify(a.body)).toBe(201)
    expect(b.status).toBe(201)
    const bId = b.body.id ?? b.body.data?.id
    const r = await h.api(`${C()}/vouchers/${bId}`, md.cookie, { method: 'PATCH', body: journal('2025-06-02', 2500, { voucher_number: 'J-A' }) })
    expect(r.status).toBe(409)
    expect(JSON.stringify(r.body)).toContain('duplicate_voucher_number')
    const after = await prisma.bookkeepingVoucher.findUniqueOrThrow({ where: { id: bId } })
    expect(after.voucherNumber).toBe('J-B')
    expect(Number(after.grandTotalPaise)).toBe(2000)
    // Keeping its own number is fine.
    expect((await h.api(`${C()}/vouchers/${bId}`, md.cookie, { method: 'PATCH', body: journal('2025-06-02', 2500, { voucher_number: 'J-B' }) })).status).toBe(200)
  })
})

describe('financial years', () => {
  it('refuses a year that overlaps an existing one, and allows the next one', async () => {
    const bad = await h.api(`${C()}/financial-years`, md.cookie, { method: 'POST', body: { label: 'X-overlap', start_date: '2026-01-01', end_date: '2026-12-31' } })
    expect(bad.status).toBe(409)
    expect(JSON.stringify(bad.body)).toContain('overlapping_year')
    expect(await prisma.bookkeepingFinancialYear.count({ where: { tallyCompanyId: companyId, label: 'X-overlap' } })).toBe(0)
    const good = await h.api(`${C()}/financial-years`, md.cookie, { method: 'POST', body: { label: '2026-27', start_date: '2026-04-01', end_date: '2027-03-31' } })
    expect(good.status, JSON.stringify(good.body)).toBe(201)
  })
})

describe('bill allocations', () => {
  it('refuses a negative or zero allocation, and allocations above the line amount', async () => {
    const before = await prisma.bookkeepingVoucher.count({ where: { tallyCompanyId: companyId } })
    for (const allocs of [
      [{ bill_ref: 'INV-1', amount_paise: 99_999_900 }],
      [{ bill_ref: 'INV-1', amount_paise: 60_000 }, { bill_ref: 'INV-2', amount_paise: 50_000 }],
      [{ bill_ref: 'INV-1', amount_paise: -500 }],
      [{ bill_ref: 'INV-1', amount_paise: 0 }],
    ]) {
      const r = await h.api(`${C()}/vouchers`, md.cookie, { method: 'POST', body: journal('2025-07-01', 100_000, {}, { bill_allocations: allocs }) })
      expect(r.status, JSON.stringify(allocs)).toBeGreaterThanOrEqual(400)
      expect(r.status).toBeLessThan(500)
    }
    expect(await prisma.bookkeepingVoucher.count({ where: { tallyCompanyId: companyId } })).toBe(before)
    const ok = await h.api(`${C()}/vouchers`, md.cookie, {
      method: 'POST', body: journal('2025-07-01', 100_000, {}, { bill_allocations: [{ bill_ref: 'INV-1', amount_paise: 60_000 }, { bill_ref: 'INV-2', amount_paise: 40_000 }] }),
    })
    expect(ok.status, JSON.stringify(ok.body)).toBe(201)
  })
})

describe('imported foreign-currency invoice', () => {
  it('keeps the currency and rate on the voucher, and the foreign amount on the party line', async () => {
    const number = uid('EXP')
    const batch: ClassifiedBatch = {
      vouchers: [{
        rowNumber: 2, type: 'sales', date: '15/08/2025', invoiceOrBillNo: number, partyName: 'Acme', partyLedgerId: L.party,
        currency: 'USD', foreignAmountMinor: 100_000, exchangeRate: '83.25', totalPaise: 8_325_000, balanced: true,
        entries: [
          { side: 'dr', role: 'party', ledgerId: L.party, amountPaise: 8_325_000 },
          { side: 'cr', role: 'sales', ledgerId: L.sales, amountPaise: 8_325_000 },
        ],
      } as never],
      proposals: [], flags: [],
      totals: { rowsScanned: 1, rowsDerived: 1, totalPaise: 8_325_000, currencies: ['USD'] },
      classification: { 2: { existence: 'new' } as never },
      counts: { new: 1, unchanged: 0, changed: 0, skipped: 0 },
    }
    const mapping = await prisma.bookkeepingImportMapping.create({
      data: { tallyCompanyId: companyId, sheetName: 'Sheet1', target: 'sales', columnMapJson: {}, currencyAliasesJson: {} },
    })
    const r = await commitBatch(companyId, {
      target: 'sales' as never, fileName: 'export.xlsx', fileSha256: uid('sha'), mappingId: mapping.id, mappingVersion: 1,
      partyDecisions: [], changedRowDecisions: [], batch,
    }, md.userId)
    expect(r.errors).toEqual([])
    expect(r.vouchersCreated).toBe(1)
    const v = await prisma.bookkeepingVoucher.findFirstOrThrow({ where: { tallyCompanyId: companyId, voucherNumber: number }, include: { entries: true } })
    expect(v.currency).toBe('USD')
    expect(v.exchangeRate?.toString()).toBe('83.25')
    const party = v.entries.find((e) => e.ledgerId === L.party)!
    expect(party.currency).toBe('USD')
    expect(Number(party.foreignAmountMinor)).toBe(100_000)
    expect(party.exchangeRate?.toString()).toBe('83.25')
    // The INR side posts as before.
    expect(Number(party.amountPaise)).toBe(8_325_000)
  })
})
