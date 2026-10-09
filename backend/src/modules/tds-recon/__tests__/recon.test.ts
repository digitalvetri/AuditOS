import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import ExcelJS from 'exceljs'
import { signToken } from '../../../platform/auth.js'
import { api, client, employee, login, org, prisma, seedRole, startServer, stopServer, uid } from '../../compliance/__tests__/fixtures.js'
import { matchTds, type MatchEntry } from '../match.js'
import { parseBooks, toPaise, toIso } from '../parse.js'

beforeAll(async () => {
  process.env.TDS_RECON_STORAGE_ROOT = mkdtempSync(path.join(tmpdir(), 'auditos-test-tdsrecon-'))
  await startServer()
})
afterAll(stopServer)

type Row = Record<string, any>
const e = (id: string, tan: string, section: string, amount: number, tds: number, date = '2025-06-15', name: string | null = null): MatchEntry => ({
  id, tan, name, section, date, quarter: 'Q1', amountPaid: BigInt(amount * 100), tds: BigInt(tds * 100),
})

describe('26AS matching', () => {
  it('matched / 26AS only / books only / difference', () => {
    const rows = matchTds(
      [e('a1', 'MUMA12345B', '194C', 100000, 2000), e('a2', 'MUMA12345B', '194C', 50000, 1000), e('a3', 'CHEC11111D', '194H', 30000, 1500), e('a4', 'DELB54321C', '194J', 200000, 20000, '2025-08-10', 'XYZ PRIVATE LIMITED')],
      [e('b1', 'MUMA12345B', '194C', 100000, 2000), e('b2', 'MUMA12345B', '194C', 50000, 900), e('b3', 'KOLB22222E', '194I', 60000, 6000), e('b4', '', '194J', 200000, 20000, '2025-08-10', 'XYZ Pvt Ltd')],
    )
    const by = (s: string) => rows.filter((r) => r.matchStatus === s)
    expect(by('verified').map((r) => [r.a26Id, r.booksId])).toEqual(expect.arrayContaining([['a1', 'b1'], ['a4', 'b4']]))
    expect(by('verified').find((r) => r.a26Id === 'a4')!.flags).toContain('tan_from_name')
    expect(by('variance')).toEqual([expect.objectContaining({ a26Id: 'a2', booksId: 'b2', mismatchFields: ['tds_amount'] })])
    expect(by('only_26as').map((r) => r.a26Id)).toEqual(['a3'])
    expect(by('only_books').map((r) => r.booksId)).toEqual(['b3'])
  })

  it('tolerance, and same TAN but different section is not paired', () => {
    const near = matchTds([e('a', 'MUMA12345B', '194C', 1000, 100)], [e('b', 'MUMA12345B', '194C', 1000.5, 100.5)], 100n)
    expect(near[0].matchStatus).toBe('verified')
    const strict = matchTds([e('a', 'MUMA12345B', '194C', 1000, 100)], [e('b', 'MUMA12345B', '194C', 1000.5, 100.5)], 0n)
    expect(strict[0]).toMatchObject({ matchStatus: 'variance', mismatchFields: ['tds_amount', 'amount_paid'] })
    const sec = matchTds([e('a', 'MUMA12345B', '194C', 1000, 100)], [e('b', 'MUMA12345B', '194J', 1000, 100)])
    expect(sec.map((r) => r.matchStatus).sort()).toEqual(['only_26as', 'only_books'])
  })

  it('parsers: Indian amounts and dates; books by loose headers', async () => {
    expect(toPaise('1,23,456.78')).toBe(12345678n)
    expect(toPaise('(12.5)')).toBe(-1250n)
    expect(toPaise('abc')).toBeNull()
    expect(toIso('03/04/2026')).toBe('2026-04-03')
    expect(toIso('5-Apr-26')).toBe('2026-04-05')
    const r = await parseBooks(Buffer.from('Party Name,TAN No,Sec,Amount Paid,TDS Amount,Date\nA,MUMA12345B,Sec 194-C,"1,000.00",20,15/06/2025\nTotal,,,1000,20,\nB,bad,194C,1,1,\n'), 'books.csv')
    expect(r.entries).toHaveLength(1)
    expect(r.entries[0]).toMatchObject({ tan: 'MUMA12345B', section: '194C', amountPaid: 100000n, tds: 2000n, date: '2025-06-15', quarter: 'Q1' })
    expect(r.skipped).toEqual([{ row: 4, reason: 'TAN BAD is not valid' }])
  })
})

const AS26 = [
  'Form 26AS^Annual Tax Statement',
  'PART A - Details of Tax Deducted at Source',
  '1^ABC LIMITED^MUMA12345B^150000.00^3000.00^3000.00',
  '1^194C^15-Jun-2025^F^20-Jul-2025^^100000.00^2000.00',
  '2^194C^15-Sep-2025^F^20-Oct-2025^^50000.00^1000.00',
  '2^XYZ PRIVATE LIMITED^DELB54321C^200000.00^20000.00^20000.00',
  '1^194J^10-Aug-2025^F^20-Sep-2025^^200000.00^20000.00',
  '3^ONLY IN 26AS LTD^CHEC11111D^30000.00^1500.00^1500.00',
  '1^194H^01-Oct-2025^U^^^30000.00^1500.00',
].join('\n')
const BOOKS = [
  'party,tan,section,amount,tds,date',
  'ABC Limited,MUMA12345B,194C,100000,2000,2025-06-15',
  'ABC Limited,MUMA12345B,194C,50000,900,2025-09-15',
  'XYZ Pvt Ltd,,194J,200000,20000,10/08/2025',
  'Books Only Co,KOLB22222E,194I,60000,6000,2025-11-01',
].join('\n')

function files(clientId: string, fy = '2025-26') {
  const f = new FormData()
  f.set('client_id', clientId)
  f.set('financial_year', fy)
  f.set('tolerance_paise', '100')
  f.set('file_26as', new Blob([AS26], { type: 'text/plain' }), '26AS.txt')
  f.set('file_books', new Blob([BOOKS], { type: 'text/csv' }), 'books.csv')
  return f
}

describe('26AS recon API', () => {
  it('uploads both files, matches, reviews, exports — scoped to the client', async () => {
    const o = await org()
    const staffEmp = await employee(o, 'Staff')
    const md = await login(o, 'md')
    const staff = await login(o, 'employee', staffEmp.id)
    const c = await client(o, 'Kilo Pvt Ltd', { accountManagerId: uid('emp') })

    const run = await api('/api/tds-recon/jobs', { method: 'POST', cookie: md.cookie, form: files(c.id) })
    expect(run.status).toBe(201)
    expect(run.body.data).toMatchObject({ status: 'matched', financial_year: '2025-26', counts: { matched: 2, difference: 1, only_26as: 1, only_books: 1 }, verified_count: 2, variance_count: 1, only_26as_count: 1, only_books_count: 1, books_file_name: 'books.csv' })
    expect(run.body.data.flags).toEqual(expect.arrayContaining(['TAN_FROM_NAME', 'UNBOOKED_CREDITS']))
    const jobId = run.body.data.id
    expect(await prisma.aaTds26AS.findFirst({ where: { clientId: c.id } })).toMatchObject({ assessmentYear: 2027, financialYear: '2025-26', sourceFormat: 'text' })

    const job = await api(`/api/tds-recon/jobs/${jobId}`, { cookie: md.cookie })
    expect(job.status).toBe(200)
    const rows = job.body.data.rows as Row[]
    expect(rows).toHaveLength(5)
    const diff = rows.find((r) => r.match_status === 'difference')!
    expect(diff).toMatchObject({ deductor_tan: 'MUMA12345B', section: '194C', quarter: 'Q2', as26: { amount_paid_paise: 5000000, tds_paise: 100000 }, books: { amount_paid_paise: 5000000, tds_paise: 90000 }, difference_paise: 10000, action_status: 'no_action', auditor_note: null })
    expect(rows.find((r) => r.match_status === 'only_26as')).toMatchObject({ deductor_tan: 'CHEC11111D', books: null, flags: ['status_u'] })
    expect(rows.find((r) => r.match_status === 'only_books')).toMatchObject({ deductor_tan: 'KOLB22222E', as26: null, difference_paise: -600000 })
    expect(((await api(`/api/tds-recon/jobs/${jobId}?match_status=matched`, { cookie: md.cookie })).body.data.rows as Row[]).length).toBe(2)

    const list = await api(`/api/tds-recon/jobs?client_id=${c.id}&financial_year=2025-26`, { cookie: md.cookie })
    expect(list.body.data.map((j: Row) => j.id)).toEqual([jobId])
    expect((await api(`/api/tds-recon/jobs?client_id=${c.id}&financial_year=2024-25`, { cookie: md.cookie })).body.data).toEqual([])

    // Re-running with the same files reuses the uploads
    const again = await api('/api/tds-recon/jobs', { method: 'POST', cookie: md.cookie, form: files(c.id) })
    expect(again.status).toBe(201)
    expect(await prisma.aaTds26AS.count({ where: { clientId: c.id } })).toBe(1)
    expect(await prisma.aaTdsBooks.count({ where: { clientId: c.id } })).toBe(1)

    // Reviewer notes
    expect((await api(`/api/tds-recon/rows/${diff.id}`, { method: 'PATCH', cookie: md.cookie, body: { action_status: 'nope' } })).status).toBe(400)
    const reviewed = await api(`/api/tds-recon/rows/${diff.id}`, { method: 'PATCH', cookie: md.cookie, body: { action_status: 'chase_deductor', auditor_note: 'Ask ABC to revise Q2' } })
    expect(reviewed.body.data).toMatchObject({ action_status: 'chase_deductor', auditor_note: 'Ask ABC to revise Q2' })

    // Export
    const xlsx = await api(`/api/tds-recon/jobs/${jobId}/export?format=xlsx`, { cookie: md.cookie })
    expect(xlsx.status).toBe(200)
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(xlsx.raw as unknown as ArrayBuffer)
    expect(wb.getWorksheet('Reconciliation')!.rowCount).toBe(6)
    expect(wb.getWorksheet('Summary')!.getRow(3).getCell(1).value).toBe('difference')
    const csv = await api(`/api/tds-recon/jobs/${jobId}/export?format=csv`, { cookie: md.cookie })
    expect(csv.headers.get('content-type')).toMatch(/text\/csv/)
    const text = csv.raw.toString('utf8')
    expect(text.split('\r\n')).toHaveLength(6)
    expect(text).toMatch(/Ask ABC to revise Q2/)

    // Validation
    const one = new FormData()
    one.set('client_id', c.id); one.set('financial_year', '2025-26')
    one.set('file_books', new Blob([BOOKS]), 'books.csv')
    expect((await api('/api/tds-recon/jobs', { method: 'POST', cookie: md.cookie, form: one })).status).toBe(400)
    const junk = files(c.id)
    junk.set('file_books', new Blob(['hello,world\n1,2\n']), 'books.csv')
    expect((await api('/api/tds-recon/jobs', { method: 'POST', cookie: md.cookie, form: junk })).status).toBe(422)

    // Scoping: staff not assigned to this client; no permission at all
    expect((await api(`/api/tds-recon/jobs/${jobId}`, { cookie: staff.cookie })).status).toBe(403)
    expect((await api(`/api/tds-recon/jobs?client_id=${c.id}`, { cookie: staff.cookie })).status).toBe(403)
    expect((await api(`/api/tds-recon/rows/${diff.id}`, { method: 'PATCH', cookie: staff.cookie, body: { auditor_note: 'x' } })).status).toBe(403)
    expect((await api('/api/tds-recon/jobs', { method: 'POST', cookie: staff.cookie, form: files(c.id) })).status).toBe(403)
    await prisma.client.update({ where: { id: c.id }, data: { accountManagerId: staffEmp.id } })
    expect((await api(`/api/tds-recon/jobs/${jobId}`, { cookie: staff.cookie })).status).toBe(200)
    const none = await seedRole('tds-recon-none', [{ permission: 'workstation.access', scope: 'organisation' }])
    const nu = await prisma.user.create({ data: { id: uid('u'), organisationId: o.id, email: `${uid('e')}@x.local`, passwordHash: 'x', roleId: none.id } })
    expect((await api(`/api/tds-recon/jobs/${jobId}`, { cookie: `ao_access=${signToken(nu.id)}` })).status).toBe(403)
  })
})
