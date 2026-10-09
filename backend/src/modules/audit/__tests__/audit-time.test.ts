import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { createApp } from '../../../app.js'
import { signToken } from '../../../platform/auth.js'
import { prisma, uid } from '../../../__tests__/helpers.js'
import { setupRoles } from '../../../../prisma/setup-roles.js'

/**
 * Time on audits: a task may be linked to an audit file of its own client;
 * the file's Overview shows the time logged on linked tasks; engagement
 * profitability costs that time against the audit file's fees. Also the
 * audit list's per-file `mine` counts and invoice link validation.
 */

let server: Server
let base = ''
let orgId = ''
let wsId = ''
let cookie = ''
let meId = ''
let clientId = ''
let otherClientId = ''
let auditId = ''
let otherAuditId = ''

async function api(p: string, opts: { method?: string; body?: unknown } = {}) {
  const res = await fetch(`${base}${p}`, {
    method: opts.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  const text = await res.text()
  return { status: res.status, body: (text ? JSON.parse(text) : null) as any }
}

async function client(name: string) {
  return (await prisma.client.create({ data: { organisationId: orgId, clientCode: uid('CLI'), companyName: name, contactPerson: 'P', contactNumber: '9876543210', accountManagerId: meId, onboardingDate: '2026-01-01' } })).id
}
async function auditFile(cid: string) {
  return (await prisma.auditEngagement.create({ data: { organisationId: orgId, auditCode: uid('AUD'), clientId: cid, financialYear: '2025-26', auditType: 'statutory', title: 'Statutory audit', status: 'fieldwork' } })).id
}

beforeAll(async () => {
  server = createApp().listen(0)
  await new Promise((r) => server.once('listening', r))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  orgId = (await prisma.organisation.findFirst({ where: { deletedAt: null } }))?.id ?? (await prisma.organisation.create({ data: { id: uid('org'), name: 'Firm' } })).id
  wsId = (await prisma.workSchedule.findFirst())?.id ?? (await prisma.workSchedule.create({ data: { organisationId: orgId, name: 'Std', standardStart: '09:30', standardEnd: '18:30' } })).id
  await setupRoles(prisma, { force: true })
  const role = await prisma.role.findUniqueOrThrow({ where: { code: 'md' } })
  const emp = await prisma.employee.create({ data: { organisationId: orgId, employeeCode: uid('AT'), firstName: 'A', lastName: 'T', fullName: `A T ${uid('n')}`, email: `${uid('a')}@x.local`, joiningDate: '2026-01-01', workScheduleId: wsId, costRatePaisePerHour: 600_00 } })
  meId = emp.id
  const u = await prisma.user.create({ data: { organisationId: orgId, email: emp.email, passwordHash: 'x', roleId: role.id, employeeId: emp.id } })
  cookie = `ao_access=${signToken(u.id)}`
  clientId = await client('Audit Time Co')
  otherClientId = await client('Other Co')
  auditId = await auditFile(clientId)
  otherAuditId = await auditFile(otherClientId)
})
afterAll(async () => { server.close() })

describe('task ↔ audit file', () => {
  let taskId = ''

  it('links a task to an audit file of the same client only', async () => {
    const bad = await api('/api/tasks', { method: 'POST', body: { title: 'Vouching', assigned_employee_id: meId, priority: 'medium', due_date: '2031-05-30', client_id: clientId, audit_engagement_id: otherAuditId } })
    expect(bad.status).toBe(400)
    const noClient = await api('/api/tasks', { method: 'POST', body: { title: 'Vouching', assigned_employee_id: meId, priority: 'medium', due_date: '2031-05-30', audit_engagement_id: auditId } })
    expect(noClient.status).toBe(400)
    const okr = await api('/api/tasks', { method: 'POST', body: { title: 'Vouching', assigned_employee_id: meId, priority: 'medium', due_date: '2031-05-30', client_id: clientId, audit_engagement_id: auditId } })
    expect(okr.status).toBe(201)
    taskId = okr.body.data.task.id
    expect(okr.body.data.task.audit_engagement_id).toBe(auditId)
  })

  it('re-checks the link when the client changes, and can clear it', async () => {
    const moved = await api(`/api/tasks/${taskId}`, { method: 'PATCH', body: { client_id: otherClientId } })
    expect(moved.status).toBe(400)
    const cleared = await api(`/api/tasks/${taskId}`, { method: 'PATCH', body: { audit_engagement_id: null } })
    expect(cleared.status).toBe(200)
    expect(cleared.body.data.task.audit_engagement_id).toBeNull()
    const relinked = await api(`/api/tasks/${taskId}`, { method: 'PATCH', body: { audit_engagement_id: auditId } })
    expect(relinked.body.data.task.audit_engagement_id).toBe(auditId)
  })

  it('shows time logged on the audit file and costs it in engagement profitability', async () => {
    const at = (iso: string) => new Date(iso)
    await prisma.taskTimeSession.createMany({
      data: [
        { taskId, employeeId: meId, startedAt: at('2031-05-12T04:00:00Z'), endedAt: at('2031-05-12T06:00:00Z'), durationMinutes: 120, closedBy: 'pause' },
        { taskId, employeeId: meId, startedAt: at('2031-05-13T04:00:00Z'), endedAt: at('2031-05-13T04:30:00Z'), durationMinutes: 30, closedBy: 'pause' },
        { taskId, employeeId: meId, startedAt: at('2031-05-14T04:00:00Z') }, // open: not counted
      ],
    })
    const file = await api(`/api/audits/${auditId}`)
    expect(file.status).toBe(200)
    expect(file.body.data.time_logged).toEqual({ minutes: 150, linked_tasks: 1 })

    await prisma.invoice.create({
      data: {
        organisationId: orgId, invoiceNumber: uid('AINV'), clientId, invoiceDate: '2031-05-20', dueDate: '2031-05-30', status: 'sent',
        subtotalPaise: 50_000_00, taxablePaise: 50_000_00, totalPaise: 59_000_00, balanceDuePaise: 59_000_00, auditEngagementId: auditId,
        items: { create: [{ itemName: 'Audit fee', taxableAmountPaise: 50_000_00, totalAmountPaise: 59_000_00 }] },
      },
    })
    const rep = await api(`/api/reports/finance/profitability-engagement?from=2031-05-01&to=2031-05-31`)
    expect(rep.status).toBe(200)
    const row = rep.body.data.rows.find((r: any) => r.id === auditId)
    expect(row).toMatchObject({ kind: 'audit_engagement', fees_paise: 50_000_00, hours: 2.5, time_cost_paise: 1_500_00, margin_paise: 48_500_00 })
  })
})

describe('audit list mine counts', () => {
  it('counts papers to prepare and review notes waiting on me, only with mine=1', async () => {
    await prisma.auditTeamMember.create({ data: { engagementId: auditId, employeeId: meId, role: 'senior' } })
    const paper = await prisma.auditWorkingPaper.create({ data: { engagementId: auditId, ref: uid('Z'), section: 'execution', title: 'Revenue', assignedTo: meId, status: 'in_progress' } })
    await prisma.auditWorkingPaper.create({ data: { engagementId: auditId, ref: uid('Z'), section: 'execution', title: 'Done', assignedTo: meId, status: 'prepared' } })
    await prisma.auditReviewNote.create({ data: { engagementId: auditId, workingPaperId: paper.id, note: 'Tie to GL', raisedBy: 'someone' } })
    await prisma.auditReviewNote.create({ data: { engagementId: auditId, note: 'Explain', raisedBy: meId, status: 'responded' } })
    await prisma.auditReviewNote.create({ data: { engagementId: auditId, note: 'Cleared', raisedBy: meId, status: 'cleared' } })

    const mine = await api('/api/audits?mine=1')
    const row = mine.body.data.items.find((i: any) => i.id === auditId)
    expect(row.mine).toEqual({ working_papers_to_prepare: 1, review_notes_waiting: 2, review_notes_to_respond: 1, review_notes_to_clear: 1 })
    const all = await api('/api/audits')
    expect(all.body.data.items.find((i: any) => i.id === auditId).mine).toBeUndefined()
  })
})

describe('invoice links', () => {
  it('refuses an audit file or engagement of another client', async () => {
    const svc = await prisma.service.create({ data: { organisationId: orgId, code: uid('SVC'), name: 'Other svc' } })
    const otherCs = await prisma.clientService.create({ data: { clientId: otherClientId, serviceId: svc.id, assignedEmployeeId: meId } })
    const body = (extra: Record<string, unknown>) => ({
      client_id: clientId, invoice_date: '2031-05-20', items: [{ item_name: 'Fee', quantity_centi: 100, rate_paise: 1_000_00, gst_rate_percent: 18 }], ...extra,
    })
    expect((await api('/api/invoices', { method: 'POST', body: body({ audit_engagement_id: otherAuditId }) })).status).toBe(400)
    expect((await api('/api/invoices', { method: 'POST', body: body({ client_service_id: otherCs.id }) })).status).toBe(400)
    const okr = await api('/api/invoices', { method: 'POST', body: body({ audit_engagement_id: auditId }) })
    expect(okr.status).toBe(201)
    expect(okr.body.data.audit_engagement_id).toBe(auditId)
  })
})
