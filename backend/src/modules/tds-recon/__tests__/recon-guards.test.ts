import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { api, client, login, org, startServer, stopServer } from '../../compliance/__tests__/fixtures.js'
import { matchTds, type MatchEntry } from '../match.js'
import { read26ASHeader } from '../parse.js'

/**
 * 26AS recon guards:
 *  - a 26AS whose PAN or year is not the client's / the period chosen is refused;
 *  - without a readable header the run goes ahead, flagged HEADER_UNVERIFIED;
 *  - 194J in the books pairs with 194JA / 194JB in 26AS (same TAN and amounts),
 *    flagged "section differs".
 */
beforeAll(async () => {
  process.env.TDS_RECON_STORAGE_ROOT = mkdtempSync(path.join(tmpdir(), 'auditos-test-tdsrecon-guards-'))
  await startServer()
})
afterAll(stopServer)

const e = (id: string, tan: string, section: string, amount: number, tds: number): MatchEntry => ({
  id, tan, name: null, section, date: '2025-08-10', quarter: 'Q2', amountPaid: BigInt(amount * 100), tds: BigInt(tds * 100),
})

describe('section families', () => {
  it('pairs 194J with 194JB for the same TAN and amounts, flagged', () => {
    const rows = matchTds([e('a', 'DELB54321C', '194JB', 200000, 20000)], [e('b', 'DELB54321C', '194J', 200000, 20000)])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ matchStatus: 'verified', a26Id: 'a', booksId: 'b', mismatchFields: ['section'] })
    expect(rows[0].flags).toContain('section_differs')
  })

  it('does not pair across TANs, across amounts, or outside the 194J family', () => {
    expect(matchTds([e('a', 'DELB54321C', '194JB', 200000, 20000)], [e('b', 'MUMA12345B', '194J', 200000, 20000)]).map((r) => r.matchStatus).sort()).toEqual(['only_26as', 'only_books'])
    expect(matchTds([e('a', 'DELB54321C', '194JB', 200000, 20000)], [e('b', 'DELB54321C', '194J', 150000, 15000)]).map((r) => r.matchStatus).sort()).toEqual(['only_26as', 'only_books'])
    expect(matchTds([e('a', 'DELB54321C', '194C', 200000, 20000)], [e('b', 'DELB54321C', '194J', 200000, 20000)]).map((r) => r.matchStatus).sort()).toEqual(['only_26as', 'only_books'])
  })

  it('an exact-section match is never taken by the family pass', () => {
    const rows = matchTds(
      [e('a1', 'DELB54321C', '194J', 200000, 20000), e('a2', 'DELB54321C', '194JB', 200000, 20000)],
      [e('b1', 'DELB54321C', '194J', 200000, 20000)],
    )
    expect(rows.find((r) => r.booksId === 'b1')).toMatchObject({ a26Id: 'a1', mismatchFields: [] })
    expect(rows.find((r) => r.a26Id === 'a2')!.matchStatus).toBe('only_26as')
  })
})

describe('26AS header', () => {
  it('reads PAN and year from TRACES text and PDF-style lines', () => {
    expect(read26ASHeader('Permanent Account Number (PAN)^AABCK1234F^Current Status of PAN^Active^Financial Year^2025-26^Assessment Year^2026-27'))
      .toEqual({ pan: 'AABCK1234F', fy: '2025-26' })
    expect(read26ASHeader('Permanent Account Number (PAN) AABCK1234F Current Status of PAN Active Assessment Year 2026-27'))
      .toEqual({ pan: 'AABCK1234F', fy: '2025-26' })
    expect(read26ASHeader('PAN: AABCK1234F  Tax Year 2026-27')).toEqual({ pan: 'AABCK1234F', fy: '2026-27' })
    expect(read26ASHeader('Form 26AS^Annual Tax Statement')).toEqual({ pan: null, fy: null })
  })
})

const LINES = [
  '1^ABC LIMITED^MUMA12345B^150000.00^3000.00^3000.00',
  '1^194C^15-Jun-2025^F^20-Jul-2025^^100000.00^2000.00',
]
const BOOKS = 'party,tan,section,amount,tds,date\nABC Limited,MUMA12345B,194C,100000,2000,2025-06-15\n'
function form(clientId: string, as26: string, fy = '2025-26') {
  const f = new FormData()
  f.set('client_id', clientId)
  f.set('financial_year', fy)
  f.set('file_26as', new Blob([as26], { type: 'text/plain' }), '26AS.txt')
  f.set('file_books', new Blob([BOOKS], { type: 'text/csv' }), 'books.csv')
  return f
}

describe('POST /api/tds-recon/jobs', () => {
  it('refuses another PAN or another year, accepts the right one, flags a headerless file', async () => {
    const o = await org()
    const md = await login(o, 'md')
    const c = await client(o, 'Kappa Pvt Ltd', { pan: 'AABCK1234F' })
    const head = (pan: string, fy: string, ay: string) => `Permanent Account Number (PAN)^${pan}^Current Status of PAN^Active^Financial Year^${fy}^Assessment Year^${ay}`

    const otherPan = await api('/api/tds-recon/jobs', { method: 'POST', cookie: md.cookie, form: form(c.id, [head('ZZZPZ9999Z', '2025-26', '2026-27'), ...LINES].join('\n')) })
    expect(otherPan.status).toBe(422)
    expect(JSON.stringify(otherPan.body)).toContain('ZZZPZ9999Z')

    const otherYear = await api('/api/tds-recon/jobs', { method: 'POST', cookie: md.cookie, form: form(c.id, [head('AABCK1234F', '2024-25', '2025-26'), ...LINES].join('\n')) })
    expect(otherYear.status).toBe(422)

    const right = await api('/api/tds-recon/jobs', { method: 'POST', cookie: md.cookie, form: form(c.id, [head('AABCK1234F', '2025-26', '2026-27'), ...LINES].join('\n')) })
    expect(right.status, JSON.stringify(right.body)).toBe(201)
    expect(right.body.data.flags).not.toContain('HEADER_UNVERIFIED')

    const bare = await api('/api/tds-recon/jobs', { method: 'POST', cookie: md.cookie, form: form(c.id, ['Form 26AS^Annual Tax Statement', ...LINES].join('\n')) })
    expect(bare.status).toBe(201)
    expect(bare.body.data.flags).toContain('HEADER_UNVERIFIED')
  })
})
