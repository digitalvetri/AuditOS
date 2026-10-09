import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { istToday } from '../../../lib/dates.js'
import { generateItems } from '../service.js'
import { api, client, employee, login, org, prisma, startServer, stopServer, uid } from './fixtures.js'

beforeAll(startServer)
afterAll(stopServer)

type Item = Record<string, any>

describe('compliance calendar API', () => {
  it('runs obligations → items → extensions → filing, scoped to the caller', async () => {
    const o = await org()
    const staffEmp = await employee(o, 'Staff')
    const otherEmp = await employee(o, 'Other')
    const md = await login(o, 'md')
    const staff = await login(o, 'employee', staffEmp.id)
    const a = await client(o, 'Alpha Private Limited', { businessType: 'Pvt Ltd', accountManagerId: staffEmp.id, email: 'alpha@client.test' })
    const b = await client(o, 'Beta LLP', { businessType: 'LLP', accountManagerId: otherEmp.id })

    // Catalogue
    const forms = await api('/api/compliance/forms', { cookie: md.cookie })
    expect(forms.status).toBe(200)
    expect(forms.body.data.map((f: Item) => f.code)).toEqual(expect.arrayContaining(['ITR_NON_AUDIT_BUSINESS', 'AOC4', 'PT_TN']))
    expect(forms.body.data.find((f: Item) => f.code === 'PMT06')).toMatchObject({ anchor: 'period_end', offset_months: 1, due_day: 25, months: '4,5,7,8,10,11,1,2' })
    // Editing the catalogue needs settings.manage on top of compliance.manage
    expect((await api('/api/compliance/forms/PT_TN', { method: 'PATCH', cookie: staff.cookie, body: { description: 'x' } })).status).toBe(403)
    const edited = await api('/api/compliance/forms/PT_TN', { method: 'PATCH', cookie: md.cookie, body: { late_fee_note: 'Penalty under TN Act', due_day: 99 } })
    expect(edited.status).toBe(400)
    expect((await api('/api/compliance/forms/PT_TN', { method: 'PATCH', cookie: md.cookie, body: { late_fee_note: 'Penalty under TN Act' } })).body.data.late_fee_note).toBe('Penalty under TN Act')

    // Obligations: suggestions follow the entity type
    const view = await api(`/api/compliance/clients/${a.id}/obligations`, { cookie: md.cookie })
    expect(view.body.data.client.entity_type).toBe('company')
    expect(view.body.data.obligations).toEqual([])
    expect(view.body.data.suggested.map((s: Item) => s.form_code)).toEqual(expect.arrayContaining(['AOC4', 'MGT7', 'ITR_AUDIT']))
    expect((await api(`/api/compliance/clients/${b.id}/obligations`, { cookie: md.cookie })).body.data.suggested.map((s: Item) => s.form_code)).toEqual(expect.arrayContaining(['LLP11', 'LLP8']))

    // PUT replaces the set and generates items
    expect((await api(`/api/compliance/clients/${a.id}/obligations`, { method: 'PUT', cookie: md.cookie, body: { forms: [{ form_code: 'NOPE' }] } })).status).toBe(400)
    const put = await api(`/api/compliance/clients/${a.id}/obligations`, {
      method: 'PUT', cookie: md.cookie,
      body: { forms: [{ form_code: 'AOC4' }, { form_code: 'MGT7' }, { form_code: 'GSTR9', remind_client: false }, { form_code: 'PF_ECR', assigned_employee_id: staffEmp.id }] },
    })
    expect(put.status).toBe(200)
    expect(put.body.data.obligations.map((x: Item) => x.form_code).sort()).toEqual(['AOC4', 'GSTR9', 'MGT7', 'PF_ECR'])
    expect(put.body.data.obligations.find((x: Item) => x.form_code === 'GSTR9').remind_client).toBe(false)
    expect(put.body.data.generated.created).toBeGreaterThan(0)
    const today = istToday()
    // Default generation skips what fell due before the obligation existed.
    expect(await prisma.complianceItem.count({ where: { clientId: a.id, dueDate: { lt: today } } })).toBe(0)
    const pf = await prisma.complianceItem.findFirst({ where: { clientId: a.id, formCode: 'PF_ECR' }, orderBy: { dueDate: 'asc' } })
    expect(pf?.assignedEmployeeId).toBe(staffEmp.id)

    // Removing an obligation drops its open future items; adding it back revives them.
    const pfBefore = await prisma.complianceItem.count({ where: { clientId: a.id, formCode: 'PF_ECR', deletedAt: null } })
    await api(`/api/compliance/clients/${a.id}/obligations`, { method: 'PUT', cookie: md.cookie, body: { forms: [{ form_code: 'AOC4' }, { form_code: 'MGT7' }, { form_code: 'GSTR9' }] } })
    expect(await prisma.complianceItem.count({ where: { clientId: a.id, formCode: 'PF_ECR', deletedAt: null } })).toBe(0)
    expect((await prisma.clientObligation.findFirst({ where: { clientId: a.id, formCode: 'PF_ECR' } }))?.isActive).toBe(false)
    const back = await api(`/api/compliance/clients/${a.id}/obligations`, { method: 'PUT', cookie: md.cookie, body: { forms: [{ form_code: 'AOC4' }, { form_code: 'MGT7' }, { form_code: 'GSTR9' }, { form_code: 'PF_ECR' }] } })
    expect(back.body.data.generated.revived).toBe(pfBefore)
    expect(await prisma.complianceItem.count({ where: { clientId: a.id, formCode: 'PF_ECR', deletedAt: null } })).toBe(pfBefore)

    // Explicit FY generation is idempotent
    const g1 = await api('/api/compliance/generate', { method: 'POST', cookie: md.cookie, body: { financial_year: '2024-25' } })
    expect(g1.status).toBe(200)
    expect(g1.body.data.created).toBe(3 + 12) // AOC4, MGT7, GSTR9 + 12 PF months
    const count = await prisma.complianceItem.count({ where: { clientId: a.id } })
    const g2 = await api('/api/compliance/generate', { method: 'POST', cookie: md.cookie, body: { financial_year: '2024-25' } })
    expect(g2.body.data).toMatchObject({ created: 0, updated: 0, revived: 0 })
    expect(await prisma.complianceItem.count({ where: { clientId: a.id } })).toBe(count)
    expect(await generateItems(prisma, { fys: ['2024-25'], clientId: a.id, explicit: true })).toEqual({ created: 0, updated: 0, revived: 0 })
    expect((await api('/api/compliance/generate', { method: 'POST', cookie: md.cookie, body: { financial_year: '2024-26' } })).status).toBe(400)

    // Items: filters, late fee, AGM flag
    const list = async (q: string, cookie = md.cookie) => {
      const r = await api(`/api/compliance/items?${q}`, { cookie })
      expect(r.status).toBe(200)
      return r.body.data as Item[]
    }
    const old = await list(`client_id=${a.id}&from=2025-04-01&to=2026-03-31`)
    const gstr9 = old.find((i) => i.form_code === 'GSTR9')!
    expect(gstr9).toMatchObject({ period_key: '2024-25', statutory_due_date: '2025-12-31', due_date: '2025-12-31', overdue: true, status: 'not_started', source: 'compliance', extension: null })
    expect(gstr9.late_fee_estimate.amount_paise).toBeGreaterThan(0)
    expect(gstr9.late_fee_estimate.note).toMatch(/^Estimate:/)
    const aoc = old.find((i) => i.form_code === 'AOC4')!
    expect(aoc).toMatchObject({ due_date: '2025-10-30', anchor_missing: true, anchor_note: 'AGM date not entered' })
    expect((await list(`client_id=${a.id}&form_code=PF_ECR&from=2025-04-01&to=2026-03-31`)).every((i) => i.form_code === 'PF_ECR')).toBe(true)
    expect((await list(`client_id=${a.id}&authority=mca&from=2025-04-01&to=2026-03-31`)).map((i) => i.form_code).sort()).toEqual(['AOC4', 'MGT7'])
    expect((await list(`client_id=${a.id}&overdue=1`)).every((i) => i.overdue)).toBe(true)
    expect((await list(`client_id=${a.id}&status=filed`))).toEqual([])
    expect((await api('/api/compliance/items?from=2025-13-01', { cookie: md.cookie })).status).toBe(400)

    // Extension replaces the due date for every client (entity-type limited ones only where they apply)
    expect((await api('/api/compliance/extensions', { method: 'POST', cookie: md.cookie, body: { form_code: 'GSTR9', period_key: '2024-25-Q1', new_due_date: '2026-01-15', reference: 'x' } })).status).toBe(400)
    const ext = await api('/api/compliance/extensions', { method: 'POST', cookie: md.cookie, body: { form_code: 'GSTR9', period_key: '2024-25', new_due_date: '2026-01-15', reference: 'CBIC Notification 1/2026', source_url: 'https://cbic.gov.in/x' } })
    expect(ext.status).toBe(201)
    const llpOnly = await api('/api/compliance/extensions', { method: 'POST', cookie: md.cookie, body: { form_code: 'AOC4', period_key: '2024-25', new_due_date: '2026-02-28', reference: 'MCA GC 2/2026', entity_types: ['llp'] } })
    expect(llpOnly.status).toBe(201)
    const afterExt = await list(`client_id=${a.id}&from=2026-01-01&to=2026-01-31`)
    expect(afterExt.find((i) => i.form_code === 'GSTR9')).toMatchObject({ statutory_due_date: '2025-12-31', due_date: '2026-01-15', extension: { reference: 'CBIC Notification 1/2026' } })
    expect((await list(`client_id=${a.id}&form_code=AOC4&from=2025-10-01&to=2025-10-31`))[0]).toMatchObject({ due_date: '2025-10-30', extension: null })
    expect((await api('/api/compliance/extensions', { cookie: md.cookie })).body.data.map((e: Item) => e.reference)).toEqual(expect.arrayContaining(['CBIC Notification 1/2026', 'MCA GC 2/2026']))
    expect((await api(`/api/compliance/extensions/${llpOnly.body.data.id}`, { method: 'DELETE', cookie: md.cookie })).status).toBe(204)
    expect((await api('/api/compliance/extensions', { cookie: md.cookie })).body.data.map((e: Item) => e.id)).not.toContain(llpOnly.body.data.id)

    // PATCH: filed needs filed_on; AGM date flows to siblings
    expect((await api(`/api/compliance/items/${gstr9.id}`, { method: 'PATCH', cookie: md.cookie, body: { status: 'filed' } })).status).toBe(400)
    expect((await api(`/api/compliance/items/${gstr9.id}`, { method: 'PATCH', cookie: md.cookie, body: { status: 'bogus' } })).status).toBe(400)
    const filed = await api(`/api/compliance/items/${gstr9.id}`, { method: 'PATCH', cookie: md.cookie, body: { status: 'filed', filed_on: '2026-01-10', acknowledgement_no: 'ARN123', late_fee_paid_paise: 0, notes: 'ok' } })
    expect(filed.status).toBe(200)
    expect(filed.body.data).toMatchObject({ status: 'filed', filed_on: '2026-01-10', acknowledgement_no: 'ARN123', overdue: false, days_left: null, late_fee_estimate: null, late_fee_paid_paise: 0 })
    const agm = await api(`/api/compliance/items/${aoc.id}`, { method: 'PATCH', cookie: md.cookie, body: { anchor_date: '2025-09-27' } })
    expect(agm.body.data).toMatchObject({ anchor_date: '2025-09-27', statutory_due_date: '2025-10-27', anchor_missing: false })
    const mgt = await prisma.complianceItem.findFirstOrThrow({ where: { clientId: a.id, formCode: 'MGT7', periodKey: '2024-25' } })
    expect(mgt).toMatchObject({ anchorDate: '2025-09-27', dueDate: '2025-11-26' })
    expect((await api(`/api/compliance/items/${gstr9.id}`, { method: 'PATCH', cookie: md.cookie, body: { anchor_date: '2025-09-27' } })).status).toBe(400)
    expect(await prisma.auditLog.count({ where: { entityId: gstr9.id, action: 'compliance_item.update' } })).toBeGreaterThan(0)

    // Client B's items, then scoping: staff sees only A (their client)
    await api(`/api/compliance/clients/${b.id}/obligations`, { method: 'PUT', cookie: md.cookie, body: { forms: [{ form_code: 'LLP11' }, { form_code: 'LLP8' }] } })
    await api('/api/compliance/generate', { method: 'POST', cookie: md.cookie, body: { financial_year: '2024-25' } })
    const bItem = await prisma.complianceItem.findFirstOrThrow({ where: { clientId: b.id, formCode: 'LLP11', periodKey: '2024-25' } })
    const staffAll = await list('from=2025-01-01&to=2027-12-31', staff.cookie)
    expect(staffAll.length).toBeGreaterThan(0)
    expect(new Set(staffAll.map((i) => i.client_id))).toEqual(new Set([a.id]))
    expect((await api(`/api/compliance/items?client_id=${b.id}`, { cookie: staff.cookie })).status).toBe(403)
    expect((await api(`/api/compliance/items/${bItem.id}`, { method: 'PATCH', cookie: staff.cookie, body: { status: 'in_progress' } })).status).toBe(403)
    expect((await api(`/api/compliance/clients/${b.id}/obligations`, { cookie: staff.cookie })).status).toBe(403)
    const mdAll = await list('from=2025-01-01&to=2027-12-31')
    expect(new Set(mdAll.map((i) => i.client_id))).toEqual(new Set([a.id, b.id]))
    // mine = assigned to me, or unassigned on a client I manage
    const mine = await list('mine=1&from=2025-01-01&to=2027-12-31', staff.cookie)
    expect(mine.length).toBe(staffAll.length)
    expect((await list('mine=1&from=2025-01-01&to=2027-12-31')).length).toBe(0) // md has no employee
    expect((await list(`assigned_to=${staffEmp.id}&from=2025-01-01&to=2027-12-31`)).every((i) => i.form_code === 'PF_ECR')).toBe(true)

    // Bulk by ids — out-of-scope ids are reported, not changed
    const pfs = (await list(`client_id=${a.id}&form_code=PF_ECR&from=2025-04-01&to=2025-07-31`)).map((i) => i.id)
    const bulk = await api('/api/compliance/items/bulk', { method: 'POST', cookie: staff.cookie, body: { ids: [...pfs, bItem.id], status: 'in_progress' } })
    expect(bulk.status).toBe(200)
    expect(bulk.body.data.updated).toBe(pfs.length)
    expect(bulk.body.data.results.find((r: Item) => r.id === bItem.id)).toMatchObject({ ok: false })
    expect((await prisma.complianceItem.findUniqueOrThrow({ where: { id: bItem.id } })).status).toBe('not_started')
    const bulkFiled = await api('/api/compliance/items/bulk', { method: 'POST', cookie: md.cookie, body: { ids: pfs.slice(0, 1), status: 'filed' } })
    expect(bulkFiled.body.data.results[0]).toMatchObject({ ok: false })

    // Bulk CSV — per-row results
    const csv = [
      'client_code,form_code,period_key,acknowledgement_no,filed_on',
      `${a.clientCode},PF_ECR,2025-03,ECR-1,2025-04-14`,
      `${b.clientCode},LLP11,2024-25,SRN-9,2025-05-29`,
      `NOPE,PF_ECR,2025-04,X,2025-05-14`,
      `${a.clientCode},PF_ECR,2025-05,X,14/06/2025`,
      `${a.clientCode},PF_ECR,1999-01,X,2025-05-14`,
    ].join('\n')
    const viaCsv = await api('/api/compliance/items/bulk', { method: 'POST', cookie: md.cookie, body: { csv } })
    expect(viaCsv.status).toBe(200)
    expect(viaCsv.body.data.results.map((r: Item) => r.ok)).toEqual([true, true, false, false, false])
    expect(viaCsv.body.data.results[2].error).toMatch(/client/i)
    expect(viaCsv.body.data.results[3].error).toMatch(/YYYY-MM-DD/)
    expect(await prisma.complianceItem.findFirstOrThrow({ where: { clientId: b.id, formCode: 'LLP11', periodKey: '2024-25' } })).toMatchObject({ status: 'filed', acknowledgementNo: 'SRN-9', filedOn: '2025-05-29' })
    // Staff cannot file another staff's client through the CSV
    const staffCsv = await api('/api/compliance/items/bulk', { method: 'POST', cookie: staff.cookie, body: { csv: `${b.clientCode},LLP8,2024-25,X,2025-10-29` } })
    expect(staffCsv.body.data.results[0]).toMatchObject({ ok: false })

    // Summary
    const sum = await api('/api/compliance/summary', { cookie: md.cookie })
    expect(sum.status).toBe(200)
    expect(sum.body.data.overdue).toBeGreaterThan(0)
    expect(sum.body.data.by_authority.mca.open).toBeGreaterThan(0)
    expect(sum.body.data).toHaveProperty('mine')
    const staffSum = await api('/api/compliance/summary', { cookie: staff.cookie })
    expect(staffSum.body.data.mine.open).toBe(staffSum.body.data.open)
  })

  it('merges GST and TDS due items read-only', async () => {
    const o = await org()
    const md = await login(o, 'md')
    const emp = await employee(o, 'Gst')
    const c = await client(o, 'Gamma Traders', { tan: 'CHEG12345B', accountManagerId: emp.id })
    await prisma.gstProfile.create({ data: { clientId: c.id, gstin: '33AAACG1234A1Z5', filingFrequency: 'monthly', assignedEmployeeId: emp.id, registrationDate: '2025-01-01' } })
    const plain = await api(`/api/compliance/items?client_id=${c.id}&from=2026-09-01&to=2026-11-30`, { cookie: md.cookie })
    expect(plain.body.data).toEqual([])
    const merged = await api(`/api/compliance/items?client_id=${c.id}&from=2026-09-01&to=2026-11-30&include=gst,tds`, { cookie: md.cookie })
    expect(merged.status).toBe(200)
    const rows = merged.body.data as Item[]
    const gst = rows.filter((r) => r.source === 'gst')
    const tds = rows.filter((r) => r.source === 'tds')
    expect(gst.length).toBeGreaterThan(0)
    expect(gst.every((r) => r.read_only && r.authority === 'gst' && r.due_date >= '2026-09-01' && r.due_date <= '2026-11-30')).toBe(true)
    expect(gst.map((r) => r.form_code)).toEqual(expect.arrayContaining(['GSTR1', 'GSTR3B']))
    expect(gst.find((r) => r.form_code === 'GSTR3B' && r.period_key === '2026-10')).toBeTruthy()
    expect(tds.find((r) => r.form_code === 'TDS_CHALLAN' && r.due_date === '2026-10-07')).toMatchObject({ read_only: true, assigned_employee_id: emp.id })
    // A completed GST case shows as filed
    await prisma.partnershipCase.create({ data: { caseCode: uid('GSTR3B'), kind: 'GSTR3B', clientId: c.id, period: '2026-09', status: 'COMPLETED' } })
    const again = (await api(`/api/compliance/items?client_id=${c.id}&from=2026-09-01&to=2026-11-30&include=gst`, { cookie: md.cookie })).body.data as Item[]
    expect(again.find((r) => r.form_code === 'GSTR3B' && r.period_key === '2026-09')).toMatchObject({ status: 'filed', overdue: false })
    expect(again.some((r) => r.source === 'tds')).toBe(false)
  })
})
