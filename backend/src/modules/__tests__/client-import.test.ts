import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import ExcelJS from 'exceljs'
import { createApp } from '../../app.js'
import { signToken } from '../../platform/auth.js'
import { prisma, uid } from '../../__tests__/helpers.js'
import { setupRoles } from '../../../prisma/setup-roles.js'
import { gstinCheckChar } from '../gst/validate.js'
import { entityTypeOf } from '../compliance/engine.js'
import { BUSINESS_TYPES } from '../workstation/clients.shared.js'

/**
 * Client import from Excel (dry run, duplicates, all-or-nothing), the paged
 * client list, bulk actions and export.
 */

let server: Server
let base = ''
let orgId = ''
let wsId = ''

async function api(path: string, opts: { method?: string; cookie?: string; body?: unknown } = {}) {
  const res = await fetch(`${base}${path}`, {
    method: opts.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', ...(opts.cookie ? { Cookie: opts.cookie } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  const text = await res.text()
  let body: unknown = null
  try { body = text ? JSON.parse(text) : null } catch { body = text }
  return { status: res.status, body: body as any, headers: res.headers }
}

async function staff(code: string) {
  const r = await prisma.role.findUnique({ where: { code } }) ?? await prisma.role.create({ data: { code, name: code } })
  const emp = await prisma.employee.create({ data: { organisationId: orgId, employeeCode: uid('AO'), firstName: 'S', lastName: code, fullName: `S ${code}`, email: `${uid('s')}@x.local`, joiningDate: '2026-01-01', workScheduleId: wsId } })
  const u = await prisma.user.create({ data: { organisationId: orgId, email: emp.email, passwordHash: 'x', roleId: r.id, employeeId: emp.id } })
  return { emp, cookie: `ao_access=${signToken(u.id)}` }
}

// Unique, well-formed identifiers per call.
let n = 0
const L = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
function pan() {
  n += 1
  const k = Date.now() % 100000 + n * 7
  const a = L[k % 24], b = L[Math.floor(k / 24) % 24], c = L[Math.floor(k / 576) % 24]
  return `AA${a}${b}${c}${String(1000 + (n % 9000)).slice(-4)}F`
}
function gstinFor(p: string) {
  const first14 = `33${p}1Z`
  return first14 + gstinCheckChar(first14)
}

const HEAD = ['Company Name *', 'Legal Name', 'Business Type', 'PAN', 'GSTIN', 'TAN', 'CIN / LLPIN', 'Email', 'Contact Person *', 'Contact Number *', 'Address', 'Account Manager * (employee code or email)', 'Onboarding Date (YYYY-MM-DD)']
type Row = Partial<Record<'company' | 'legal' | 'type' | 'pan' | 'gstin' | 'tan' | 'cin' | 'email' | 'person' | 'phone' | 'address' | 'am' | 'date', string>>

async function xlsx(rows: Row[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Clients')
  ws.addRow(HEAD)
  for (const r of rows) {
    ws.addRow([r.company ?? '', r.legal ?? '', r.type ?? '', r.pan ?? '', r.gstin ?? '', r.tan ?? '', r.cin ?? '', r.email ?? '', r.person ?? '', r.phone ?? '', r.address ?? '', r.am ?? '', r.date ?? ''])
  }
  return Buffer.from(await wb.xlsx.writeBuffer() as ArrayBuffer)
}

async function upload(buf: Buffer, cookie: string, dryRun: boolean, name = 'clients.xlsx') {
  const form = new FormData()
  form.append('dry_run', dryRun ? 'true' : 'false')
  form.append('file', new Blob([buf]), name)
  const res = await fetch(`${base}/api/clients/import`, { method: 'POST', headers: { Cookie: cookie }, body: form })
  const text = await res.text()
  let body: unknown = null
  try { body = text ? JSON.parse(text) : null } catch { body = text }
  return { status: res.status, body: body as any }
}

let admin: Awaited<ReturnType<typeof staff>>
let associate: Awaited<ReturnType<typeof staff>>
let other: Awaited<ReturnType<typeof staff>>

beforeAll(async () => {
  server = createApp().listen(0)
  await new Promise((r) => server.once('listening', r))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  orgId = (await prisma.organisation.findFirst({ where: { deletedAt: null } }))?.id ?? (await prisma.organisation.create({ data: { id: uid('org'), name: 'Firm' } })).id
  wsId = (await prisma.workSchedule.findFirst())?.id ?? (await prisma.workSchedule.create({ data: { organisationId: orgId, name: 'Std', standardStart: '09:30', standardEnd: '18:30' } })).id
  await setupRoles(prisma, { force: true })
  admin = await staff('hr_admin')
  associate = await staff('employee')
  other = await staff('employee')
})
afterAll(async () => { server.close(); await prisma.$disconnect() })

const good = (over: Row = {}): Row => {
  const p = pan()
  return { company: uid('Import Co'), type: 'Private Limited Company', pan: p, gstin: gstinFor(p), person: 'Priya', phone: '9876543210', am: admin.emp.employeeCode, ...over }
}

describe('client import', () => {
  it('every template business type maps to a real entity type', () => {
    for (const t of BUSINESS_TYPES) expect(entityTypeOf(t), t).not.toBe('any')
  })

  it('serves the template with the expected headings', async () => {
    const res = await fetch(`${base}/api/clients/import/template`, { headers: { Cookie: admin.cookie } })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('spreadsheetml')
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(await res.arrayBuffer())
    const ws = wb.getWorksheet('Clients')!
    expect(ws.getRow(1).getCell(1).value).toBe('Company Name *')
    expect(ws.getCell('C2').dataValidation?.type).toBe('list')
    expect(wb.getWorksheet('Lists')?.state).toBe('hidden')
  })

  it('dry run reports per-row errors and creates nothing', async () => {
    const before = await prisma.client.count()
    const p = pan()
    const res = await upload(await xlsx([
      good(),
      good({ pan: 'BADPAN', gstin: '' }),
      good({ gstin: gstinFor(p).slice(0, 14) + (gstinFor(p)[14] === 'A' ? 'B' : 'A'), pan: p }),
      good({ person: '', phone: '12345' }),
      good({ am: 'nobody@nowhere.local' }),
      good({ type: 'Spaceship' }),
      good({ tan: 'XX1', cin: 'nope' }),
      { company: '', person: '', phone: '', am: '', address: 'Somewhere' },
      good({ email: 'Bad@', date: '31/03/2026' }),
    ]), admin.cookie, true)
    expect(res.status).toBe(200)
    const d = res.body.data
    expect(d.dry_run).toBe(true)
    expect(d.total).toBe(9)
    const errs = (row: number) => d.rows.find((r: any) => r.row === row).errors
    expect(errs(2)).toEqual({})
    expect(errs(3).pan).toMatch(/PAN/)
    expect(errs(4).gstin).toMatch(/check character/)
    expect(errs(5).contact_person).toBeTruthy()
    expect(errs(5).contact_number).toBeTruthy()
    expect(errs(6).account_manager).toMatch(/No active employee/)
    expect(errs(7).business_type).toBeTruthy()
    expect(errs(8).tan).toBeTruthy()
    expect(errs(8).cin).toBeTruthy()
    expect(errs(9).company_name).toBeTruthy()
    expect(errs(10).email).toBeTruthy()
    expect(errs(10).onboarding_date).toBeUndefined()
    expect(d.valid).toBe(1)
    expect(await prisma.client.count()).toBe(before)
  })

  it('detects duplicates against existing clients and within the file', async () => {
    const existing = pan()
    await prisma.client.create({ data: { organisationId: orgId, clientCode: uid('CLI'), companyName: 'Already Here', contactPerson: 'P', contactNumber: '9876543210', accountManagerId: admin.emp.id, onboardingDate: '2026-01-01', pan: existing } })
    const twice = pan()
    const res = await upload(await xlsx([
      good({ pan: existing, gstin: gstinFor(existing) }),
      good({ pan: twice, gstin: gstinFor(twice) }),
      good({ pan: twice, gstin: gstinFor(twice) }),
    ]), admin.cookie, true)
    expect(res.status).toBe(200)
    const rows = res.body.data.rows
    expect(rows[0].errors.pan).toMatch(/Already Here already has this PAN/)
    expect(rows[1].errors).toEqual({})
    expect(rows[2].errors.pan).toMatch(/Same PAN as row 3/)
    expect(rows[2].errors.gstin).toMatch(/Same GSTIN as row 3/)
  })

  it('does not name a duplicate the caller cannot see', async () => {
    const hidden = pan()
    await prisma.client.create({ data: { organisationId: orgId, clientCode: uid('CLI'), companyName: 'Secret Co', contactPerson: 'P', contactNumber: '9876543210', accountManagerId: other.emp.id, onboardingDate: '2026-01-01', pan: hidden } })
    const res = await upload(await xlsx([good({ pan: hidden, gstin: '', am: associate.emp.employeeCode })]), associate.cookie, true)
    expect(res.status).toBe(200)
    expect(res.body.data.rows[0].errors.pan).toBe('A client with this PAN already exists.')
  })

  it('an Associate can import only clients assigned to themselves', async () => {
    const res = await upload(await xlsx([good({ am: admin.emp.email })]), associate.cookie, true)
    expect(res.body.data.rows[0].errors.account_manager).toMatch(/assigned to you/)
  })

  it('a real import creates every row, through the same path as Add Client', async () => {
    const rows = [good({ tan: 'CHEK09876B', cin: 'U74999TN2020PTC123456', date: '2025-04-01', legal: 'Legal Name Pvt Ltd', email: 'A@B.COM', address: 'Chennai' }), good({ am: admin.emp.email }), good()]
    const res = await upload(await xlsx(rows), admin.cookie, false)
    expect(res.status).toBe(201)
    expect(res.body.data.created).toBe(3)
    const codes = res.body.data.clients.map((c: any) => c.client_id)
    expect(new Set(codes).size).toBe(3)
    const first = await prisma.client.findFirstOrThrow({ where: { id: res.body.data.clients[0].id }, include: { contacts: true } })
    expect(first.status).toBe('onboarding')
    expect(first.tan).toBe('CHEK09876B')
    expect(first.onboardingDate).toBe('2025-04-01')
    expect(first.legalName).toBe('Legal Name Pvt Ltd')
    expect(first.email).toBe('a@b.com')
    expect(first.contacts.filter((c) => c.isPrimary)).toHaveLength(1)
    const audit = await prisma.auditLog.findMany({ where: { action: 'client.import', actorUserId: { not: null } }, orderBy: { createdAt: 'desc' }, take: 1 })
    expect(audit[0]?.afterJson).toContain(codes[0])
  })

  it('is all-or-nothing: one bad row means no client is created', async () => {
    const before = await prisma.client.count()
    const res = await upload(await xlsx([good(), good(), good({ phone: '000' })]), admin.cookie, false)
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('import_invalid')
    expect(res.body.error.details.invalid).toBe(1)
    expect(await prisma.client.count()).toBe(before)
  })

  it('reads a CSV with the same headings', async () => {
    const r = good()
    const csv = `${HEAD.map((h) => `"${h}"`).join(',')}\n"${r.company}",,${r.type},${r.pan},${r.gstin},,,,${r.person},${r.phone},,${r.am},`
    const res = await upload(Buffer.from(csv), admin.cookie, true, 'clients.csv')
    expect(res.status).toBe(200)
    expect(res.body.data.rows[0].errors).toEqual({})
  })

  it('needs the client-create permission', async () => {
    const finance = await staff(uid('no_grants'))
    const res = await upload(await xlsx([good()]), finance.cookie, true)
    expect(res.status).toBe(403)
  })
})

describe('client list paging, bulk and export', () => {
  const ids: string[] = []
  beforeAll(async () => {
    for (const name of ['Zeta Paged', 'Alpha Paged', 'Mike Paged']) {
      ids.push((await prisma.client.create({ data: { organisationId: orgId, clientCode: uid('CLI'), companyName: `${name} ${uid('x')}`, contactPerson: 'P', contactNumber: '9876543210', accountManagerId: associate.emp.id, onboardingDate: '2026-01-01', status: 'active' } })).id)
    }
  })

  it('stays an unpaged list without page params', async () => {
    const r = await api('/api/clients', { cookie: admin.cookie })
    expect(r.status).toBe(200)
    expect(r.body.data.page).toBeUndefined()
    expect(r.body.data.count).toBe(r.body.data.items.length)
  })

  it('pages, sorts and counts the total', async () => {
    const r = await api('/api/clients?q=Paged&page=1&page_size=2&sort=company_name&order=asc&facets=1', { cookie: admin.cookie })
    expect(r.status).toBe(200)
    expect(r.body.data.items).toHaveLength(2)
    expect(r.body.data.count).toBe(3)
    expect(r.body.data.page_size).toBe(2)
    expect(r.body.data.items[0].company_name).toMatch(/^Alpha/)
    expect(r.body.data.items[1].company_name).toMatch(/^Mike/)
    expect(r.body.data.facets.total).toBeGreaterThanOrEqual(3)
    const p2 = await api('/api/clients?q=Paged&page=2&page_size=2&sort=company_name&order=desc', { cookie: admin.cookie })
    expect(p2.body.data.items[0].company_name).toMatch(/^Alpha/)
  })

  it('mine=1 and ids= narrow the list', async () => {
    const mine = await api('/api/clients?mine=1&q=Paged', { cookie: associate.cookie })
    expect(mine.body.data.count).toBe(3)
    const one = await api(`/api/clients?ids=${ids[0]}`, { cookie: admin.cookie })
    expect(one.body.data.items.map((c: any) => c.id)).toEqual([ids[0]])
  })

  it('bulk-assigns an account manager (Admin only) and audits each change', async () => {
    expect((await api('/api/clients/bulk', { method: 'POST', cookie: associate.cookie, body: { ids, action: 'assign_account_manager', account_manager_id: other.emp.id } })).status).toBe(403)
    const r = await api('/api/clients/bulk', { method: 'POST', cookie: admin.cookie, body: { ids, action: 'assign_account_manager', account_manager_id: other.emp.id } })
    expect(r.status).toBe(200)
    expect(r.body.data.updated).toBe(3)
    const rows = await prisma.client.findMany({ where: { id: { in: ids } } })
    expect(rows.every((c) => c.accountManagerId === other.emp.id)).toBe(true)
    expect(await prisma.auditLog.count({ where: { action: 'client.update', entityId: { in: ids } } })).toBeGreaterThanOrEqual(3)
  })

  it('bulk status change is refused for a client outside the caller\'s scope', async () => {
    // The clients now belong to `other`; the associate no longer sees them.
    const r = await api('/api/clients/bulk', { method: 'POST', cookie: associate.cookie, body: { ids, action: 'set_status', status: 'inactive' } })
    expect(r.status).toBe(403)
    const ok = await api('/api/clients/bulk', { method: 'POST', cookie: other.cookie, body: { ids, action: 'set_status', status: 'inactive' } })
    expect(ok.status).toBe(200)
    expect((await prisma.client.findMany({ where: { id: { in: ids } } })).every((c) => c.status === 'inactive')).toBe(true)
    const bad = await api('/api/clients/bulk', { method: 'POST', cookie: other.cookie, body: { ids, action: 'set_status', status: 'gone' } })
    expect(bad.status).toBe(400)
  })

  it('exports the filtered list as xlsx', async () => {
    const res = await fetch(`${base}/api/clients/export?q=Paged&sort=company_name`, { headers: { Cookie: admin.cookie } })
    expect(res.status).toBe(200)
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(await res.arrayBuffer())
    const ws = wb.getWorksheet('Clients')!
    expect(ws.rowCount).toBe(4)
    expect(String(ws.getRow(2).getCell(2).value)).toMatch(/^Alpha/)
  })
})
