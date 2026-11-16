import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { createApp } from '../../../app.js'
import { signToken } from '../../../platform/auth.js'
import { prisma, uid } from '../../../__tests__/helpers.js'
import { setupRoles } from '../../../../prisma/setup-roles.js'
import { inspectPdf } from '../lib/pdfInspect.js'
import { parseStatementPdf } from '../lib/statementParser.js'
import { AaTxnService } from '../services/AaTxnService.js'

/**
 * Bank statements: Axis's trailing "Init. Br" column, single-letter D/C
 * indicators, rows without a balance needing review, and a second Tally
 * export that must be confirmed and cannot double-post.
 */
type Cell = { x: number; t: string; right?: boolean }
async function pdf(lines: Cell[][]) {
  const doc = await PDFDocument.create()
  const f = await doc.embedFont(StandardFonts.Helvetica)
  const p = doc.addPage([842, 595])
  lines.forEach((cells, i) => cells.forEach((c) => {
    const w = f.widthOfTextAtSize(c.t, 8)
    p.drawText(c.t, { x: c.right ? c.x - w : c.x, y: 560 - i * 12, size: 8, font: f })
  }))
  return (await inspectPdf(Buffer.from(await doc.save()))).pages
}
const P = (n: bigint | null) => (n === null ? null : Number(n) / 100)

describe('statement layouts', () => {
  it('Axis: a column after Balance (Init. Br) does not swallow the balance', async () => {
    const hdr: Cell[] = [{ x: 30, t: 'Tran Date' }, { x: 90, t: 'Chq No' }, { x: 150, t: 'Particulars' }, { x: 520, t: 'Debit', right: true }, { x: 610, t: 'Credit', right: true }, { x: 700, t: 'Balance', right: true }, { x: 740, t: 'Init. Br' }]
    const r = (d: string, n: string, dr: string, cr: string, b: string): Cell[] => [{ x: 30, t: d }, { x: 150, t: n }, ...(dr ? [{ x: 520, t: dr, right: true }] : []), ...(cr ? [{ x: 610, t: cr, right: true }] : []), { x: 700, t: b, right: true }, { x: 740, t: '1234' }]
    const res = parseStatementPdf(await pdf([[{ x: 30, t: 'AXIS BANK LTD' }], hdr,
      r('01-04-2026', 'OPENING TRANSFER', '', '10,000.00', '10,000.00'),
      r('02-04-2026', 'UPI/P2M/ZOMATO', '450.00', '', '9,550.00'),
    ]))
    expect(res.rows.map((x) => [P(x.debitPaise), P(x.creditPaise), P(x.balancePaise), x.flags])).toEqual([[0, 10000, 10000, []], [450, 0, 9550, []]])
  })

  it('a single-letter D / C type column gives the right side', async () => {
    const hdr: Cell[] = [{ x: 30, t: 'Date' }, { x: 100, t: 'Narration' }, { x: 520, t: 'Amount', right: true }, { x: 560, t: 'Type' }, { x: 700, t: 'Balance', right: true }]
    const r = (d: string, n: string, a: string, t: string, b: string): Cell[] => [{ x: 30, t: d }, { x: 100, t: n }, { x: 520, t: a, right: true }, { x: 560, t }, { x: 700, t: b, right: true }]
    const res = parseStatementPdf(await pdf([hdr,
      r('01/04/2026', 'SALARY', '50,000.00', 'C', '60,000.00'),
      r('03/04/2026', 'RENT', '15,000.00', 'D', '45,000.00'),
      r('04/04/2026', 'ATM', '2,000.00', 'DR.', '43,000.00'),
    ]))
    expect(res.rows.map((x) => [P(x.debitPaise), P(x.creditPaise), x.flags])).toEqual([[0, 50000, []], [15000, 0, []], [2000, 0, []]])
  })
})

describe('review and export', () => {
  let server: Server
  let base = ''
  let orgId = ''
  let maker = ''
  let checker = ''
  let clientId = ''
  const BANK = 'test-bank-fixes'

  beforeAll(async () => {
    server = createApp().listen(0)
    await new Promise((r) => server.once('listening', r))
    const addr = server.address()
    base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
    orgId = (await prisma.organisation.create({ data: { id: uid('org'), name: 'Firm' } })).id
    await setupRoles(prisma, { force: true })
    const ws = await prisma.workSchedule.create({ data: { organisationId: orgId, name: 'Std', standardStart: '09:30', standardEnd: '18:30' } })
    const role = await prisma.role.findUniqueOrThrow({ where: { code: 'md' } })
    const mk = async () => {
      const emp = await prisma.employee.create({ data: { organisationId: orgId, employeeCode: uid('E'), firstName: 'A', lastName: 'B', fullName: 'A B', email: `${uid('u')}@x.local`, joiningDate: '2026-01-01', workScheduleId: ws.id } })
      return prisma.user.create({ data: { organisationId: orgId, email: emp.email, passwordHash: 'x', roleId: role.id, employeeId: emp.id } })
    }
    const a = await mk(); const b = await mk()
    maker = a.id; checker = `ao_access=${signToken(b.id)}`
    clientId = (await prisma.client.create({ data: { organisationId: orgId, clientCode: uid('CLI'), companyName: 'C', contactPerson: 'P', contactNumber: '9876543210', accountManagerId: a.employeeId!, onboardingDate: '2026-01-01' } })).id
    await prisma.aaBank.upsert({ where: { id: BANK }, update: {}, create: { id: BANK, key: 'axis', name: 'Axis Bank', order: 99 } })
  })
  afterAll(() => { server.close() })

  async function job(rows: Array<{ debit: bigint; credit: bigint; balance: bigint | null; ledger?: string }>, account = 'XXXX4321') {
    const acct = await prisma.aaBankAccount.create({ data: { organisationId: orgId, clientId, bankId: BANK, accountNumberMasked: account } })
    const doc = await prisma.aaSourceDocument.create({ data: { organisationId: orgId, clientId, uploadedByUserId: maker, bankId: BANK, bankAccountId: acct.id, originalFilename: 's.pdf', mimeType: 'application/pdf', fileSize: 1, fileSha256: uid('sha'), extractionPath: 'x', pageCount: 1, textLayerBytes: 1 } })
    const j = await prisma.aaJob.create({ data: { sourceDocumentId: doc.id, organisationId: orgId, clientId, createdByUserId: maker, status: 'extracted', progress: 100, bankLedgerName: 'Axis Bank A/c' } })
    for (const [i, r] of rows.entries()) {
      await prisma.aaBankTxn.create({ data: { jobId: j.id, organisationId: orgId, clientId, bankAccountId: acct.id, seq: i + 1, txnDate: `2026-04-0${i + 1}`, narration: `ROW ${i + 1}`, debitPaise: r.debit, creditPaise: r.credit, balancePaise: r.balance, fingerprint: uid('fp'), status: 'ok', flags: '', ledgerName: r.ledger ?? 'Sundry', original: {} } })
    }
    return j.id
  }

  it('a row with no balance needs review — it is not passed as ok', async () => {
    const id = await job([{ debit: 0n, credit: 1000_00n, balance: 1000_00n }, { debit: 100_00n, credit: 0n, balance: null }])
    await AaTxnService.recheck(id)
    const rows = await prisma.aaBankTxn.findMany({ where: { jobId: id }, orderBy: { seq: 'asc' } })
    expect(rows.map((r) => r.status)).toEqual(['ok', 'flagged'])
    expect(rows[1].flags).toContain('NO_BALANCE')
  })

  it('a second Tally export needs confirmation; the vouchers carry a stable reference and the account', async () => {
    const id = await job([{ debit: 0n, credit: 1000_00n, balance: 1000_00n }, { debit: 100_00n, credit: 0n, balance: 900_00n }])
    const approve = await fetch(`${base}/api/audit-automation/jobs/${id}/approve`, { method: 'POST', headers: { Cookie: checker } })
    expect(approve.status).toBe(200)
    const get = (q = '') => fetch(`${base}/api/audit-automation/jobs/${id}/export/tally.xml${q}`, { headers: { Cookie: checker } })
    const first = await get()
    expect(first.status).toBe(200)
    const xml1 = await first.text()
    const ids1 = [...xml1.matchAll(/REMOTEID="([^"]+)"/g)].map((m) => m[1])
    expect(ids1).toHaveLength(2)
    expect(xml1).toMatch(/<VOUCHERNUMBER>AXIS-4321\/20260401\/0001<\/VOUCHERNUMBER>/)

    const again = await get()
    expect(again.status).toBe(409)
    expect(((await again.json()) as any).error.code).toBe('already_exported')

    const confirmed = await get('?confirm=1')
    expect(confirmed.status).toBe(200)
    const ids2 = [...(await confirmed.text()).matchAll(/REMOTEID="([^"]+)"/g)].map((m) => m[1])
    expect(ids2).toEqual(ids1)
    expect(await prisma.aaExport.count({ where: { jobId: id } })).toBe(2)

    const detail = (await (await fetch(`${base}/api/audit-automation/jobs/${id}`, { headers: { Cookie: checker } })).json()) as any
    expect(detail.data.tally_exports).toHaveLength(2)
  })
})
