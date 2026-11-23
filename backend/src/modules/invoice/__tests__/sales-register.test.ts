import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import ExcelJS from 'exceljs'
import { api, client, login, org, prisma, startServer, stopServer, uid } from '../../compliance/__tests__/fixtures.js'
import { fyMonths, isFy } from '../sales-register.js'

/**
 * Sales register: issued invoices of a FY month by month with the GST split,
 * less credit notes; drafts left out, cancelled listed at zero. FY 2041-42
 * keeps these rows apart from other suites.
 */
beforeAll(startServer)
afterAll(stopServer)

describe('fyMonths / isFy', () => {
  it('runs April to March', () => {
    expect(fyMonths('2026-27')).toEqual([
      '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11', '2026-12', '2027-01', '2027-02', '2027-03',
    ])
    expect(isFy('2026-27')).toBe(true)
    expect(isFy('2026-28')).toBe(false)
  })
})

describe('GET /api/invoices/sales-register', () => {
  it('totals the year month by month and exports it', async () => {
    const o = await org()
    const c = await client(o, 'Register Client')
    const md = await login(o, 'md')
    const inv = (n: string, date: string, status: string, inter: boolean, taxable: number) => prisma.invoice.create({
      data: {
        organisationId: o.id, clientId: c.id, invoiceNumber: n, invoiceDate: date, dueDate: date, status, isInterState: inter,
        billingName: 'Register Client', taxablePaise: taxable,
        cgstPaise: inter ? 0 : taxable * 0.09, sgstPaise: inter ? 0 : taxable * 0.09, igstPaise: inter ? taxable * 0.18 : 0, totalPaise: taxable * 1.18,
      },
    })
    const a = await inv(uid('SR'), '2041-04-10', 'paid', false, 100_000)
    await inv(uid('SR'), '2041-04-20', 'sent', true, 50_000)
    await inv(uid('SR'), '2041-05-02', 'cancelled', false, 70_000)
    await prisma.invoice.create({ data: { organisationId: o.id, clientId: c.id, invoiceDate: '2041-05-03', dueDate: '2041-05-03', status: 'draft', taxablePaise: 999 } })
    await prisma.creditNote.create({
      data: {
        organisationId: o.id, invoiceId: a.id, clientId: c.id, creditNoteNumber: uid('CN'), noteDate: '2041-05-15', reason: 'discount', linesJson: [],
        status: 'issued', taxablePaise: 10_000, cgstPaise: 900, sgstPaise: 900, totalPaise: 11_800,
      },
    })

    const r = await api('/api/invoices/sales-register?fy=2041-42', { cookie: md.cookie })
    expect(r.status).toBe(200)
    const reg = r.body.data
    const apr = reg.months[0]
    expect(apr).toMatchObject({ month: '2041-04', invoices: 2, sales: { taxable: 150_000, cgst: 9_000, sgst: 9_000, igst: 9_000, total: 177_000 } })
    const may = reg.months[1]
    expect(may).toMatchObject({ invoices: 1, credit_notes: 1, sales: { taxable: 0 }, net: { taxable: -10_000, total: -11_800 } })
    expect(reg.totals.net).toMatchObject({ taxable: 140_000, total: 165_200 })
    expect(reg.rows.map((x: { kind: string; status: string }) => `${x.kind}:${x.status}`)).toEqual(['invoice:paid', 'invoice:sent', 'invoice:cancelled', 'credit_note:issued'])

    expect((await api('/api/invoices/sales-register?fy=2041-43', { cookie: md.cookie })).status).toBe(400)

    const x = await api('/api/invoices/sales-register/export?fy=2041-42', { cookie: md.cookie })
    expect(x.status).toBe(200)
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(x.raw as unknown as ArrayBuffer)
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Month-wise', 'Invoices'])
    expect(wb.getWorksheet('Invoices')!.rowCount).toBe(5)
  })
})
