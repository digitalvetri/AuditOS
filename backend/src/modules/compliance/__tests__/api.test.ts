import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { istToday } from '../../../lib/dates.js'
import { generateItems } from '../service.js'
import { migrateInc20aFromPartnership } from '../../../../prisma/seed-compliance.js'
import { onGstRegistrationGranted, onPrivateLimitedIncorporated, syncPrivateLimitedCompliance } from '../clockEvents.js'
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
    // Turnover-tiered (Notification 07/2023-CT): every tier in the note, no single amount.
    expect(gstr9.late_fee_estimate.note).toMatch(/^Estimate: by aggregate turnover/)
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

  it('INC_20A is seeded as a clock form with internal target 30 and statutory 180', async () => {
    const o = await org()
    const md = await login(o, 'md')
    const forms = (await api('/api/compliance/forms', { cookie: md.cookie })).body.data as Item[]
    const inc = forms.find((f) => f.code === 'INC_20A')
    expect(inc).toMatchObject({ anchor: 'event', frequency: 'event', authority: 'mca', entity_types: ['company'], offset_days: 180 })
  })

  it('migrateInc20aFromPartnership copies INC_20A rows into ComplianceItem idempotently', async () => {
    const o = await org()
    const emp = await employee(o, 'Mgr')
    const c = await client(o, 'PvtLtd Co', { businessType: 'Pvt Ltd', accountManagerId: emp.id })
    const caseRow = await prisma.partnershipCase.create({
      data: { caseCode: uid('PLCASE'), kind: 'PRIVATE_LIMITED', clientId: c.id, status: 'COMPLETED' },
    })
    await prisma.postRegistrationCompliance.create({
      data: {
        caseId: caseRow.id, clientId: c.id, code: 'INC_20A',
        triggerLabel: 'Date of Incorporation', triggerDate: '2026-05-01',
        offsetDays: 180, dueDate: '2026-10-28',
        assignedEmployeeId: emp.id, notes: 'From PartnershipCase',
      },
    })

    const first = await migrateInc20aFromPartnership(prisma)
    expect(first.migrated).toBeGreaterThanOrEqual(1)
    const items = await prisma.complianceItem.findMany({ where: { clientId: c.id, formCode: 'INC_20A' } })
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      anchorDate: '2026-05-01',
      dueDate: '2026-10-28',       // anchor + 180 days
      internalDueDate: '2026-05-31', // anchor + 30 days from seed
      status: 'not_started',
      notes: 'From PartnershipCase',
    })

    // Re-run → no change (@@unique on clientId+formCode+periodKey; update:{} leaves alone).
    const second = await migrateInc20aFromPartnership(prisma)
    expect(second.migrated).toBeGreaterThanOrEqual(1)
    const after = await prisma.complianceItem.findMany({ where: { clientId: c.id, formCode: 'INC_20A' } })
    expect(after).toHaveLength(1)
  })

  it('POST /clocks creates a GST_RULE_10A clock, enforces one-per-client, recomputes dates on anchor', async () => {
    const o = await org()
    const emp = await employee(o, 'Mgr')
    const md = await login(o, 'md')
    const c = await client(o, 'Clock Co', { businessType: 'Pvt Ltd', accountManagerId: emp.id })

    // Form is seeded as a clock (frequency='event', anchor='event').
    const forms = (await api('/api/compliance/forms', { cookie: md.cookie })).body.data as Item[]
    expect(forms.find((f) => f.code === 'GST_RULE_10A')).toMatchObject({ anchor: 'event', frequency: 'event', authority: 'gst' })

    // Reject a non-event form.
    const bad = await api('/api/compliance/clocks', { method: 'POST', cookie: md.cookie, body: { client_id: c.id, form_code: 'ITR_AUDIT' } })
    expect(bad.status).toBe(400)

    // Create with no anchor yet (registration applied, not granted).
    const created = await api('/api/compliance/clocks', { method: 'POST', cookie: md.cookie, body: { client_id: c.id, form_code: 'GST_RULE_10A', assigned_employee_id: emp.id } })
    expect(created.status).toBe(200)
    expect(created.body.data).toMatchObject({ form_code: 'GST_RULE_10A', anchor_date: null, assigned_employee_id: emp.id })
    // No trigger date → no real due date: not "due today", not overdue, flagged as needing the date.
    expect(created.body.data).toMatchObject({ needs_date: true, overdue: false, days_left: null, late_fee_estimate: null })
    const clockId = created.body.data.id as string
    const md2 = await login(o, 'md')
    const listed = ((await api(`/api/compliance/items?client_id=${c.id}`, { cookie: md2.cookie })).body.data as Item[]).find((i) => i.id === clockId)
    expect(listed).toMatchObject({ needs_date: true, overdue: false, days_left: null })

    // Second attempt for the same (client, form) conflicts.
    const dup = await api('/api/compliance/clocks', { method: 'POST', cookie: md.cookie, body: { client_id: c.id, form_code: 'GST_RULE_10A' } })
    expect(dup.status).toBe(409)

    // PATCH the anchor — statutory due = anchor + 30 days (offsetDays), internal = +15 (internalTargetDays from seed).
    const patched = await api(`/api/compliance/items/${clockId}`, { method: 'PATCH', cookie: md.cookie, body: { anchor_date: '2026-11-01' } })
    expect(patched.status).toBe(200)
    expect(patched.body.data).toMatchObject({ anchor_date: '2026-11-01', due_date: '2026-12-01', internal_due_date: '2026-11-16' })
  })

  it('evidence gate — a Rule 10A clock cannot be marked filed without evidence_ref or evidence_doc_id', async () => {
    const o = await org()
    const emp = await employee(o, 'Mgr')
    const md = await login(o, 'md')
    const c = await client(o, 'Evidence Co', { businessType: 'Pvt Ltd', accountManagerId: emp.id })
    const created = await api('/api/compliance/clocks', { method: 'POST', cookie: md.cookie, body: { client_id: c.id, form_code: 'GST_RULE_10A', anchor_date: '2026-11-01' } })
    expect(created.status).toBe(200)
    const id = created.body.data.id as string

    // Attempt 1: filed + filed_on, no evidence → 400 with field-specific error.
    const noEvidence = await api(`/api/compliance/items/${id}`, { method: 'PATCH', cookie: md.cookie, body: { status: 'filed', filed_on: istToday() } })
    expect(noEvidence.status).toBe(400)
    expect(noEvidence.body.error.details).toMatchObject({ evidence_ref: expect.stringContaining('portal acknowledgement') })

    // Attempt 2: same PATCH plus evidence_ref → 200, state transitions.
    const withRef = await api(`/api/compliance/items/${id}`, { method: 'PATCH', cookie: md.cookie, body: { status: 'filed', filed_on: istToday(), evidence_ref: 'ARN-AD3311261234567' } })
    expect(withRef.status).toBe(200)
    expect(withRef.body.data).toMatchObject({ status: 'filed', filed_on: istToday(), evidence_ref: 'ARN-AD3311261234567' })

    // Attach evidence first, then separately mark filed — also works.
    const other = await client(o, 'Two-Step Co', { businessType: 'Pvt Ltd', accountManagerId: emp.id })
    const c2 = await api('/api/compliance/clocks', { method: 'POST', cookie: md.cookie, body: { client_id: other.id, form_code: 'GST_RULE_10A', anchor_date: '2026-11-01' } })
    expect(c2.status).toBe(200)
    const id2 = c2.body.data.id as string
    // The evidence document must be a real, live document of THIS client.
    const cat = await prisma.documentCategory.findFirst({ where: { deletedAt: null } })
      ?? await prisma.documentCategory.create({ data: { organisationId: o.id, code: uid('cat'), name: 'Evidence' } })
    const doc = await prisma.clientDocument.create({ data: { clientId: other.id, categoryId: cat.id, name: 'REG-01 ack' } })
    const elsewhere = await prisma.clientDocument.create({ data: { clientId: c.id, categoryId: cat.id, name: 'Someone else\'s ack' } })
    const gone = await prisma.clientDocument.create({ data: { clientId: other.id, categoryId: cat.id, name: 'Deleted', deletedAt: new Date() } })
    for (const bad of ['cd-fake-doc-id', elsewhere.id, gone.id]) {
      const r = await api(`/api/compliance/items/${id2}`, { method: 'PATCH', cookie: md.cookie, body: { evidence_doc_id: bad } })
      expect(r.status).toBe(400)
      expect(r.body.error.details).toHaveProperty('evidence_doc_id')
    }
    const attach = await api(`/api/compliance/items/${id2}`, { method: 'PATCH', cookie: md.cookie, body: { evidence_doc_id: doc.id } })
    expect(attach.status).toBe(200)
    const close = await api(`/api/compliance/items/${id2}`, { method: 'PATCH', cookie: md.cookie, body: { status: 'filed', filed_on: istToday() } })
    expect(close.status).toBe(200)
    expect(close.body.data).toMatchObject({ status: 'filed', evidence_doc_id: doc.id })
  })

  it('onGstRegistrationGranted — creates the clock on new grant, skips exempt types, idempotent', async () => {
    const o = await org()
    const emp = await employee(o, 'Mgr')
    const c = await client(o, 'Rule10A Co', { businessType: 'Pvt Ltd', accountManagerId: emp.id })

    // Regular registration → clock created.
    const r1 = await onGstRegistrationGranted(prisma, {
      clientId: c.id, organisationId: o.id, registrationDate: '2026-11-01',
      registrationType: 'regular', assignedEmployeeId: emp.id, isNewGrant: true,
    })
    expect(r1.created).toBe(true)
    const items = await prisma.complianceItem.findMany({ where: { clientId: c.id, formCode: 'GST_RULE_10A' } })
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      anchorDate: '2026-11-01',
      dueDate: '2026-12-01',       // +30
      internalDueDate: '2026-11-16', // +15
      assignedEmployeeId: emp.id,
    })

    // Idempotent — second call on the same grant is a no-op.
    const r2 = await onGstRegistrationGranted(prisma, {
      clientId: c.id, organisationId: o.id, registrationDate: '2026-11-01',
      registrationType: 'regular', assignedEmployeeId: emp.id, isNewGrant: true,
    })
    expect(r2.created).toBe(false)
    expect(r2.skipped).toBe('already_exists')

    // Non-first grant (isNewGrant=false) is also a no-op — guards the PATCH
    // handler so routine edits don't resurrect a closed clock.
    const r3 = await onGstRegistrationGranted(prisma, {
      clientId: c.id, organisationId: o.id, registrationDate: '2026-11-01',
      registrationType: 'regular', assignedEmployeeId: emp.id, isNewGrant: false,
    })
    expect(r3.created).toBe(false)

    // Exempt type → no clock, no skip-as-already-exists.
    const other = await client(o, 'TDS Co', { businessType: 'Pvt Ltd', accountManagerId: emp.id })
    const r4 = await onGstRegistrationGranted(prisma, {
      clientId: other.id, organisationId: o.id, registrationDate: '2026-11-01',
      registrationType: 'non_resident', assignedEmployeeId: emp.id, isNewGrant: true,
    })
    expect(r4.created).toBe(false)
    expect(r4.skipped).toBe('exempt')
    expect(await prisma.complianceItem.count({ where: { clientId: other.id, formCode: 'GST_RULE_10A' } })).toBe(0)
  })

  it('inactive clients — generator skips them, clock hooks return client_inactive', async () => {
    const o = await org()
    const emp = await employee(o, 'Mgr')
    const md = await login(o, 'md')
    const c = await client(o, 'Departed Co', { businessType: 'Pvt Ltd', accountManagerId: emp.id })
    // Flip to inactive via the standard PATCH path — exercises the whole surface.
    const flip = await api(`/api/clients/${c.id}`, { method: 'PATCH', cookie: md.cookie, body: { status: 'inactive', exit_date: '2026-06-01' } })
    expect(flip.status).toBe(200)

    // Clock hook A — new GST registration grant for an inactive client → skipped, no row created.
    const r1 = await onGstRegistrationGranted(prisma, {
      clientId: c.id, organisationId: o.id, registrationDate: '2026-11-01',
      registrationType: 'regular', assignedEmployeeId: emp.id, isNewGrant: true,
    })
    expect(r1.created).toBe(false)
    expect(r1.skipped).toBe('client_inactive')
    expect(await prisma.complianceItem.count({ where: { clientId: c.id, formCode: 'GST_RULE_10A' } })).toBe(0)

    // Clock hook B — a stale PartnershipCase completion for an inactive client is also skipped.
    const caseRow = await prisma.partnershipCase.create({
      data: { caseCode: uid('PLCASE'), kind: 'PRIVATE_LIMITED', clientId: c.id, status: 'COMPLETED' },
    })
    await prisma.postRegistrationCompliance.create({
      data: {
        caseId: caseRow.id, clientId: c.id, code: 'INC_20A',
        triggerLabel: 'Date of Incorporation', triggerDate: '2026-05-01',
        offsetDays: 180, dueDate: '2026-10-28',
      },
    })
    const r2 = await onPrivateLimitedIncorporated(prisma, { caseId: caseRow.id })
    expect(r2.created).toBe(false)
    expect(r2.skipped).toBe('client_inactive')

    // generateItems — an obligation on an inactive client creates NOTHING on a fresh run.
    // Use a form that WOULD otherwise generate, and assert zero rows landed.
    await prisma.clientObligation.create({
      data: { organisationId: o.id, clientId: c.id, formCode: 'ITR_AUDIT', isActive: true, createdBy: md.id },
    })
    const before = await prisma.complianceItem.count({ where: { clientId: c.id, formCode: 'ITR_AUDIT' } })
    const result = await generateItems(prisma, { fys: ['2026-27'], organisationId: o.id, clientId: c.id, explicit: true })
    expect(result.created).toBe(0)
    const after = await prisma.complianceItem.count({ where: { clientId: c.id, formCode: 'ITR_AUDIT' } })
    expect(after).toBe(before)
  })

  it('syncPrivateLimitedCompliance — write-through on triggerDate, completedOn, assignee, notes', async () => {
    const o = await org()
    const emp = await employee(o, 'Mgr')
    const emp2 = await employee(o, 'Other')
    const c = await client(o, 'Sync Co', { businessType: 'Pvt Ltd', accountManagerId: emp.id })
    const caseRow = await prisma.partnershipCase.create({
      data: { caseCode: uid('PLCASE'), kind: 'PRIVATE_LIMITED', clientId: c.id, status: 'COMPLETED' },
    })
    const prc = await prisma.postRegistrationCompliance.create({
      data: {
        caseId: caseRow.id, clientId: c.id, code: 'INC_20A',
        triggerLabel: 'Date of Incorporation', triggerDate: '2026-05-01',
        offsetDays: 180, dueDate: '2026-10-28',
        assignedEmployeeId: emp.id, notes: 'initial',
      },
    })

    // Seed the mirrored ComplianceItem the same way #144's hook would.
    await onPrivateLimitedIncorporated(prisma, { caseId: caseRow.id })
    const before = await prisma.complianceItem.findFirst({ where: { clientId: c.id, formCode: 'INC_20A' } })
    expect(before).toMatchObject({ anchorDate: '2026-05-01', status: 'not_started', assignedEmployeeId: emp.id, notes: 'initial' })

    // 1) triggerDate move → ComplianceItem's anchor + due + internal all shift.
    await prisma.postRegistrationCompliance.update({
      where: { id: prc.id }, data: { triggerDate: '2026-06-01', dueDate: '2026-11-28', assignedEmployeeId: emp2.id, notes: 'updated' },
    })
    const r1 = await syncPrivateLimitedCompliance(prisma, { rowId: prc.id })
    expect(r1.skipped).toBeUndefined()
    const afterPatch = await prisma.complianceItem.findFirst({ where: { clientId: c.id, formCode: 'INC_20A' } })
    expect(afterPatch).toMatchObject({
      anchorDate: '2026-06-01',
      dueDate: '2026-11-28',       // anchor + 180
      internalDueDate: '2026-07-01', // anchor + 30
      assignedEmployeeId: emp2.id,
      notes: 'updated',
    })

    // 2) /complete flow → mirrored as status=filed with filedOn.
    await prisma.postRegistrationCompliance.update({
      where: { id: prc.id }, data: { completedOn: '2026-08-15', completedBy: 'u-x' },
    })
    await syncPrivateLimitedCompliance(prisma, { rowId: prc.id })
    const afterComplete = await prisma.complianceItem.findFirst({ where: { clientId: c.id, formCode: 'INC_20A' } })
    expect(afterComplete).toMatchObject({ status: 'filed', filedOn: '2026-08-15', filedBy: 'u-x' })

    // 3) /reopen flow → mirrored back to not_started.
    await prisma.postRegistrationCompliance.update({
      where: { id: prc.id }, data: { completedOn: null, completedBy: null },
    })
    await syncPrivateLimitedCompliance(prisma, { rowId: prc.id })
    const afterReopen = await prisma.complianceItem.findFirst({ where: { clientId: c.id, formCode: 'INC_20A' } })
    expect(afterReopen).toMatchObject({ status: 'not_started', filedOn: null, filedBy: null })

    // 4) Sync creates the mirror if it doesn't exist yet (edit on a row that
    //    predates the create hook). Delete the ComplianceItem and re-sync.
    await prisma.complianceItem.delete({ where: { id: afterReopen!.id } })
    const r4 = await syncPrivateLimitedCompliance(prisma, { rowId: prc.id })
    expect(r4.created).toBe(true)
    expect(await prisma.complianceItem.count({ where: { clientId: c.id, formCode: 'INC_20A' } })).toBe(1)

    // 5) Non-INC_20A code is a no-op.
    const adtc = await prisma.postRegistrationCompliance.create({
      data: {
        caseId: caseRow.id, clientId: c.id, code: 'ADTC',
        triggerLabel: 'Date of Incorporation', triggerDate: '2026-05-01',
        offsetDays: 30, dueDate: '2026-05-31',
      },
    })
    const r5 = await syncPrivateLimitedCompliance(prisma, { rowId: adtc.id })
    expect(r5.skipped).toBe('no_anchor')
    expect(await prisma.complianceItem.count({ where: { clientId: c.id, formCode: 'ADTC' } })).toBe(0)
  })

  it('onPrivateLimitedIncorporated — mirrors INC_20A row into ComplianceItem', async () => {
    const o = await org()
    const emp = await employee(o, 'Mgr')
    const c = await client(o, 'INC20A Co', { businessType: 'Pvt Ltd', accountManagerId: emp.id })
    const caseRow = await prisma.partnershipCase.create({
      data: { caseCode: uid('PLCASE'), kind: 'PRIVATE_LIMITED', clientId: c.id, status: 'COMPLETED' },
    })
    await prisma.postRegistrationCompliance.create({
      data: {
        caseId: caseRow.id, clientId: c.id, code: 'INC_20A',
        triggerLabel: 'Date of Incorporation', triggerDate: '2026-05-01',
        offsetDays: 180, dueDate: '2026-10-28', assignedEmployeeId: emp.id,
      },
    })

    const r = await onPrivateLimitedIncorporated(prisma, { caseId: caseRow.id })
    expect(r.created).toBe(true)
    const items = await prisma.complianceItem.findMany({ where: { clientId: c.id, formCode: 'INC_20A' } })
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ anchorDate: '2026-05-01', dueDate: '2026-10-28', internalDueDate: '2026-05-31' })

    // Idempotent
    const r2 = await onPrivateLimitedIncorporated(prisma, { caseId: caseRow.id })
    expect(r2.skipped).toBe('already_exists')
  })

  it('a corrected GST grant date moves the open Rule 10A clock — also across a year — and never a filed one', async () => {
    const o = await org()
    const emp = await employee(o, 'Mgr')
    const c = await client(o, 'Regrant Co', { businessType: 'Pvt Ltd', accountManagerId: emp.id })
    const grant = (registrationDate: string) => onGstRegistrationGranted(prisma, {
      clientId: c.id, organisationId: o.id, registrationDate, registrationType: 'regular', assignedEmployeeId: emp.id, isNewGrant: true,
    })
    expect((await grant('2026-11-11')).created).toBe(true)
    const moved = await grant('2026-11-14')
    expect(moved).toMatchObject({ created: false })
    let items = await prisma.complianceItem.findMany({ where: { clientId: c.id, formCode: 'GST_RULE_10A', deletedAt: null } })
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ anchorDate: '2026-11-14', dueDate: '2026-12-14', internalDueDate: '2026-11-29' })
    await grant('2027-01-02') // another calendar year: still the same clock
    items = await prisma.complianceItem.findMany({ where: { clientId: c.id, formCode: 'GST_RULE_10A', deletedAt: null } })
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ anchorDate: '2027-01-02', dueDate: '2027-02-01' })
    await prisma.complianceItem.update({ where: { id: items[0].id }, data: { status: 'filed', filedOn: '2027-01-20', evidenceRef: 'AA1' } })
    expect(await grant('2027-01-05')).toMatchObject({ created: false, skipped: 'already_exists' })
    expect(await prisma.complianceItem.findUniqueOrThrow({ where: { id: items[0].id } })).toMatchObject({ anchorDate: '2027-01-02', status: 'filed' })
  })

  it('seed moves an existing DIR-3 KYC rule to the 3-year, 30 June cycle and tidies its open items, once', async () => {
    const { seedCompliance } = await import('../../../../prisma/seed-compliance.js')
    // An existing DB still holding the old annual 30 September rule.
    await prisma.complianceForm.update({ where: { code: 'DIR3_KYC' }, data: { frequency: 'annual', anchor: 'fy_start', offsetMonths: 5, dueDay: 30, description: '30 September every year.' } })
    const o = await org()
    const c = await client(o, 'Kyc Pvt Ltd', { businessType: 'Pvt Ltd' })
    const mk = (periodKey: string, dueDate: string, status = 'not_started') => prisma.complianceItem.create({
      data: { organisationId: o.id, clientId: c.id, formCode: 'DIR3_KYC', periodKey, periodLabel: `FY ${periodKey}`, dueDate, status, ...(status === 'filed' ? { filedOn: '2025-09-20' } : {}) },
    })
    const old = await mk('2025-26', '2025-09-30', 'filed')     // the old regime: history
    const offYear = await mk('2026-27', '2026-09-30')          // no longer due
    const working = await mk('2028-29', '2028-09-30', 'in_progress') // someone is on it: kept, flagged by its date
    const cycle = await mk('2027-28', '2027-09-30')            // the cycle year: re-dated to 30 June 2028
    await seedCompliance(prisma)
    expect(await prisma.complianceForm.findUniqueOrThrow({ where: { code: 'DIR3_KYC' } })).toMatchObject({ frequency: 'triennial', anchor: 'fy_end', offsetMonths: 3, dueDay: 30 })
    const read = (id: string) => prisma.complianceItem.findUniqueOrThrow({ where: { id } })
    expect(await read(old.id)).toMatchObject({ dueDate: '2025-09-30', deletedAt: null })
    expect((await read(offYear.id)).deletedAt).not.toBeNull()
    expect(await read(working.id)).toMatchObject({ deletedAt: null, status: 'in_progress' })
    expect(await read(cycle.id)).toMatchObject({ dueDate: '2028-06-30', deletedAt: null })
    // A firm's own later edit to the rule survives the next seed.
    await prisma.complianceForm.update({ where: { code: 'DIR3_KYC' }, data: { offsetMonths: 4 } })
    await seedCompliance(prisma)
    expect((await prisma.complianceForm.findUniqueOrThrow({ where: { code: 'DIR3_KYC' } })).offsetMonths).toBe(4)
    await prisma.complianceForm.update({ where: { code: 'DIR3_KYC' }, data: { offsetMonths: 3 } })
  })
})

