import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Server } from 'node:http'

// SMTP is never configured in tests; the success path needs a fake mailer.
vi.mock('../../../lib/mailer.js', () => ({
  mailConfigured: () => true,
  sendMail: vi.fn(async () => 'msg-test-1'),
}))

import { createApp } from '../../../app.js'
import { signToken } from '../../../platform/auth.js'
import { prisma, uid } from '../../../__tests__/helpers.js'
import { setupRoles } from '../../../../prisma/setup-roles.js'
import { computeUpcoming } from '../reminders.js'
import { today } from '../service.js'
import {
  createRuleResolver, kindsOwed, resolverFrom, stateGroupOf,
} from '../dueDate.js'

/**
 * GST fixes: reminder mail lock + scope, one due-date engine with overrides
 * and QRMP state groups, GSTR-2B monthly for QRMP, older overdue periods,
 * IST "today", and composition dealers owing none of GSTR-1/2B/3B.
 */

let orgId = ''
let wsId = ''
const createdRuleIds: string[] = []
const createdOverrideIds: string[] = []

async function makeClient(opts: {
  frequency: 'monthly' | 'quarterly'
  gstin?: string
  registrationType?: string
  assignedEmployeeId?: string
  email?: string
}) {
  const code = uid('GSTFIX')
  const client = await prisma.client.create({
    data: {
      organisationId: orgId, clientCode: code, companyName: code,
      contactPerson: 'Contact', contactNumber: '9999999999', email: opts.email ?? `${code.toLowerCase()}@client.test`,
      accountManagerId: 'am-1', status: 'active', onboardingDate: '2026-01-01',
    },
  })
  await prisma.gstProfile.create({
    data: {
      clientId: client.id, gstin: opts.gstin ?? '33AAACT1234A1Z5', registrationStatus: 'active',
      filingFrequency: opts.frequency, assignedEmployeeId: opts.assignedEmployeeId ?? 'emp-gst-fix',
      registrationType: opts.registrationType ?? 'regular',
    },
  })
  return client.id
}

beforeAll(async () => {
  orgId = (await prisma.organisation.findFirst({ where: { deletedAt: null } }))?.id
    ?? (await prisma.organisation.create({ data: { id: uid('org'), name: 'GST fixes firm' } })).id
  wsId = (await prisma.workSchedule.findFirst())?.id
    ?? (await prisma.workSchedule.create({ data: { organisationId: orgId, name: 'Std', standardStart: '09:30', standardEnd: '18:30' } })).id
  // QRMP Category Y rule, as seeded by prisma/seed-gst.ts.
  const y = await prisma.gstDueDateRule.findFirst({
    where: { kind: 'GSTR3B', filingFrequency: 'quarterly', stateGroup: 'Y', effectiveFrom: null, deletedAt: null },
  })
  if (!y) {
    createdRuleIds.push((await prisma.gstDueDateRule.create({
      data: { kind: 'GSTR3B', filingFrequency: 'quarterly', stateGroup: 'Y', effectiveFrom: null, dueDay: 24, note: 'test' },
    })).id)
  }
})

afterAll(async () => {
  if (createdRuleIds.length) await prisma.gstDueDateRule.deleteMany({ where: { id: { in: createdRuleIds } } })
  if (createdOverrideIds.length) await prisma.gstDueDateOverride.deleteMany({ where: { id: { in: createdOverrideIds } } })
})

// ── 2 / 3: the single rule engine ─────────────────────────────────────────

describe('due-date engine', () => {
  const rules = [
    { kind: 'GSTR3B', filingFrequency: 'quarterly', stateGroup: null, effectiveFrom: null, dueDay: 22 },
    { kind: 'GSTR3B', filingFrequency: 'quarterly', stateGroup: 'X', effectiveFrom: null, dueDay: 22 },
    { kind: 'GSTR3B', filingFrequency: 'quarterly', stateGroup: 'Y', effectiveFrom: null, dueDay: 24 },
    { kind: 'GSTR2B', filingFrequency: 'monthly', stateGroup: null, effectiveFrom: null, dueDay: 16 },
  ]

  it('maps GSTIN state codes (and names) to CBIC state groups', () => {
    expect(stateGroupOf({ gstin: '07AAACT1234A1Z5' })).toBe('Y') // Delhi
    expect(stateGroupOf({ gstin: '09AAACT1234A1Z5' })).toBe('Y') // Uttar Pradesh
    expect(stateGroupOf({ gstin: '38AAACT1234A1Z5' })).toBe('Y') // Ladakh
    expect(stateGroupOf({ gstin: '33AAACT1234A1Z5' })).toBe('X') // Tamil Nadu
    expect(stateGroupOf({ gstin: '27AAACT1234A1Z5' })).toBe('X') // Maharashtra
    expect(stateGroupOf({ gstin: '97AAACT1234A1Z5' })).toBeNull()
    expect(stateGroupOf({ gstin: '', state: 'West Bengal' })).toBe('Y')
  })

  it('QRMP GSTR-3B: Category Y states → 24th, X → 22nd, unknown → the all-states row', () => {
    const r = resolverFrom(rules, [])
    expect(r.resolve('2026-12', 'GSTR3B', 'quarterly', 'Y')).toBe('2027-01-24')
    expect(r.resolve('2026-12', 'GSTR3B', 'quarterly', 'X')).toBe('2027-01-22')
    expect(r.resolve('2026-12', 'GSTR3B', 'quarterly', null)).toBe('2027-01-22')
  })

  it('GSTR-2B uses the seeded 16th, not the old hard-coded 14th', () => {
    expect(resolverFrom(rules, []).resolve('2026-09', 'GSTR2B', 'monthly')).toBe('2026-10-16')
  })

  it('a CBIC override beats the rule (loaded from the database)', async () => {
    const o = await prisma.gstDueDateOverride.create({
      data: { kind: 'GSTR3B', filingFrequency: null, period: '2031-03', dueDate: '2031-04-30', cbicNotification: 'test' },
    })
    createdOverrideIds.push(o.id)
    const r = await createRuleResolver(prisma)
    expect(r.resolve('2031-03', 'GSTR3B', 'monthly')).toBe('2031-04-30')
    expect(r.resolve('2031-03', 'GSTR3B', 'quarterly', 'Y')).toBe('2031-04-30')
    expect(r.resolve('2031-02', 'GSTR3B', 'monthly')).toBe('2031-03-20')
  })
})

// ── 4 / 7: what is owed ───────────────────────────────────────────────────

describe('kindsOwed', () => {
  it('QRMP filers owe GSTR-2B every month, GSTR-1/3B only at quarter end', () => {
    expect(kindsOwed({ filingFrequency: 'quarterly' }, '2026-10')).toEqual(['GSTR2B'])
    expect(kindsOwed({ filingFrequency: 'quarterly' }, '2026-12')).toEqual(['GSTR1', 'GSTR2B', 'GSTR3B'])
    expect(kindsOwed({ filingFrequency: 'monthly' }, '2026-10')).toEqual(['GSTR1', 'GSTR2B', 'GSTR3B'])
  })
  it('composition dealers owe none of the three', () => {
    expect(kindsOwed({ filingFrequency: 'quarterly', registrationType: 'composition' }, '2026-12')).toEqual([])
  })
})

describe('computeUpcoming', () => {
  it('reminds a QRMP filer of GSTR-2B outside the quarter-end month', async () => {
    const id = await makeClient({ frequency: 'quarterly' })
    const items = await computeUpcoming(prisma, { today: '2026-11-13', clientIdFilter: [id] })
    expect(items.map((i) => [i.kind, i.period, i.dueDate, i.state])).toEqual([
      ['GSTR2B', '2026-10', '2026-11-16', 'due'],
    ])
  })

  it('a Category Y QRMP filer’s GSTR-3B falls due on the 24th', async () => {
    const id = await makeClient({ frequency: 'quarterly', gstin: '07AAACT1234A1Z5' })
    const items = await computeUpcoming(prisma, { today: '2027-01-22', clientIdFilter: [id] })
    expect(items.find((i) => i.kind === 'GSTR3B')).toMatchObject({ period: '2026-12', dueDate: '2027-01-24', state: 'due', daysToDue: 2 })
  })

  it('composition dealers get no GSTR-1/2B/3B reminders', async () => {
    const id = await makeClient({ frequency: 'monthly', registrationType: 'composition' })
    expect(await computeUpcoming(prisma, { today: '2026-10-21', clientIdFilter: [id] })).toEqual([])
  })

  it('keeps an older period whose case is still open; drops completed or untracked ones', async () => {
    const id = await makeClient({ frequency: 'monthly' })
    await prisma.partnershipCase.create({
      data: { caseCode: uid('G3B'), kind: 'GSTR3B', clientId: id, period: '2026-05', status: 'IN_PROGRESS' },
    })
    await prisma.partnershipCase.create({
      data: { caseCode: uid('G1'), kind: 'GSTR1', clientId: id, period: '2026-05', status: 'COMPLETED' },
    })
    // Outside the 12-month lookback.
    await prisma.partnershipCase.create({
      data: { caseCode: uid('G3B'), kind: 'GSTR3B', clientId: id, period: '2025-06', status: 'IN_PROGRESS' },
    })
    const items = await computeUpcoming(prisma, { today: '2026-10-09', clientIdFilter: [id] })
    expect(items.map((i) => `${i.kind}:${i.period}:${i.state}`).sort()).toEqual([
      'GSTR1:2026-09:due',
      'GSTR3B:2026-05:overdue',
    ])
    expect(items[0]).toMatchObject({ kind: 'GSTR3B', period: '2026-05', dueDate: '2026-06-20' })
  })
})

// ── 6: IST, not UTC ───────────────────────────────────────────────────────

describe('IST date', () => {
  it('after midnight IST (still the previous day in UTC) the IST date is used', async () => {
    const id = await makeClient({ frequency: 'monthly' })
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date('2026-10-11T19:00:00Z')) // 00:30 IST on 12 Oct
      expect(today()).toBe('2026-10-12')
      const items = await computeUpcoming(prisma, { clientIdFilter: [id] })
      // GSTR-1 for Sep was due 11 Oct: overdue in IST (UTC would say "due today").
      expect(items.find((i) => i.kind === 'GSTR1')).toMatchObject({ period: '2026-09', state: 'overdue', daysToDue: -1 })
    } finally {
      vi.useRealTimers()
    }
  })
})

// ── 1: reminder mail is scoped and recipient-locked ───────────────────────

describe('POST /api/gst/reminders/send', () => {
  let server: Server
  let base = ''
  let assigned: { emp: { id: string; email: string }; cookie: string }
  let other: { emp: { id: string; email: string }; cookie: string }
  let clientId = ''
  const contactEmail = `${uid('owner')}@client.test`

  async function api(path: string, opts: { method?: string; cookie?: string; body?: unknown } = {}) {
    const res = await fetch(`${base}${path}`, {
      method: opts.method ?? 'GET',
      headers: { 'Content-Type': 'application/json', ...(opts.cookie ? { Cookie: opts.cookie } : {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    })
    const text = await res.text()
    let body: unknown = null
    try { body = text ? JSON.parse(text) : null } catch { body = text }
    return { status: res.status, body: body as any }
  }

  async function staff(code: string) {
    const r = await prisma.role.findUniqueOrThrow({ where: { code } })
    const emp = await prisma.employee.create({ data: { organisationId: orgId, employeeCode: uid('GF'), firstName: 'S', lastName: code, fullName: `S ${code}`, email: `${uid('s')}@firm.local`, joiningDate: '2026-01-01', workScheduleId: wsId } })
    const u = await prisma.user.create({ data: { organisationId: orgId, email: emp.email, passwordHash: 'x', roleId: r.id, employeeId: emp.id } })
    return { emp, cookie: `ao_access=${signToken(u.id)}` }
  }

  const send = (cookie: string, extra: Record<string, unknown> = {}) => api('/api/gst/reminders/send', {
    method: 'POST', cookie,
    body: { client_id: clientId, kind: 'GSTR3B', period: '2026-09', due_date: '2026-10-20', ...extra },
  })

  beforeAll(async () => {
    server = createApp().listen(0)
    await new Promise((r) => server.once('listening', r))
    const addr = server.address()
    base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
    await setupRoles(prisma, { force: true })
    assigned = await staff('employee')
    other = await staff('employee')
    clientId = await makeClient({ frequency: 'monthly', assignedEmployeeId: assigned.emp.id })
    await prisma.clientContact.create({ data: { clientId, name: 'Owner', phone: '9999999999', email: contactEmail } })
  })
  afterAll(() => { server.close() })

  it('an unassigned employee cannot send or fetch the template', async () => {
    expect((await send(other.cookie)).status).toBe(403)
    const t = await api(`/api/gst/reminders/template?client_id=${clientId}&kind=GSTR3B&period=2026-09&due_date=2026-10-20`, { cookie: other.cookie })
    expect(t.status).toBe(403)
  })

  it('refuses a `to` that is not on record for the client', async () => {
    const r = await send(assigned.cookie, { to: 'victim@elsewhere.test' })
    expect(r.status).toBe(422)
    expect(r.body.error.code).toBe('recipient_not_on_record')
    const list = await send(assigned.cookie, { to: `${contactEmail},victim@elsewhere.test` })
    expect(list.body.error.code).toBe('recipient_not_on_record')
  })

  it('refuses more than 5 cc, and cc outside client contacts / firm staff', async () => {
    const six = Array.from({ length: 6 }, (_, i) => `x${i}@firm.local`)
    const many = await send(assigned.cookie, { cc: six })
    expect(many.status).toBe(422)
    expect(many.body.error.code).toBe('too_many_cc')
    const outsider = await send(assigned.cookie, { cc: [other.emp.email, 'stranger@elsewhere.test'] })
    expect(outsider.status).toBe(422)
    expect(outsider.body.error.code).toBe('cc_not_allowed')
  })

  it('sends to a client contact with staff cc, and audits the recipients', async () => {
    const r = await send(assigned.cookie, { to: contactEmail.toUpperCase(), cc: [other.emp.email] })
    expect(r.status).toBe(201)
    expect(r.body.data).toMatchObject({ to: contactEmail, cc: [other.emp.email.toLowerCase()] })
    const audit = await prisma.auditLog.findFirst({
      where: { action: 'gst.reminder.sent', entityId: clientId },
      orderBy: { createdAt: 'desc' },
    })
    expect(audit).not.toBeNull()
    const after = JSON.parse(audit!.afterJson!)
    expect(after.to).toBe(contactEmail)
    expect(after.cc).toEqual([other.emp.email.toLowerCase()])
  })

  it('a blank `to` defaults to the client record’s email', async () => {
    const r = await send(assigned.cookie)
    expect(r.status).toBe(201)
    const client = await prisma.client.findUniqueOrThrow({ where: { id: clientId } })
    expect(r.body.data.to).toBe(client.email)
  })
})

// ── 8: s.17(5) hint is whole-word, on the ledger head, never the supplier ──

describe('s.17(5) blocked-credit hint', () => {
  it('matches the ledger head by whole word and ignores supplier names', async () => {
    const { itcFor } = await import('../../audit-automation/services/GstMatchingService.js')
    const base = {
      supplierGstin: '33AAACT1234A1Z5', invoiceNumber: 'INV-1', invoiceDate: '2026-04-10',
      taxableValue: 100000, igst: 18000, cgst: 0, sgst: 0, cess: 0,
    }
    const two = { ...base, supplierName: 'City Medical Buildings Personal Care' }
    expect(itcFor('matched', two, { ...base, glCode: 'Purchases' }).cls).toBe('eligible')
    expect(itcFor('matched', two, { ...base, glCode: 'Carpet purchase' }).cls).toBe('eligible')
    const hit = itcFor('matched', two, { ...base, glCode: 'Motor Car Expenses' })
    expect(hit.cls).toBe('blocked')
    expect(hit.reason).toMatch(/Confirm/)
  })
})
