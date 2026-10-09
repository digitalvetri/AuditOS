/**
 * GST and TDS rows merged READ-ONLY into GET /api/compliance/items.
 *
 * Neither rule set is copied here: GST due dates come from the GST module's
 * rule resolver (`createRuleResolver` + `kindsOwed` + `stateGroupOf`, the same
 * calls `computeUpcoming` makes) and case status from PartnershipCase; TDS
 * items come from `buildOverview`, the TDS board's own engine (open items of
 * ended periods only — what the TDS module itself tracks).
 */
import type { PrismaClient } from '@prisma/client'
import { addDays, daysBetween } from '../../lib/dates.js'
import { createRuleResolver, kindsOwed, stateGroupOf, type FilingFrequency, type ReturnKind } from '../gst/dueDate.js'
import { buildOverview } from '../tds/overview.js'
import { fyOfDate, shiftFy, fyStartYear } from './engine.js'
import type { ItemApi } from './service.js'

const GST_LABEL: Record<ReturnKind, string> = { GSTR1: 'GSTR-1', GSTR2B: 'GSTR-2B / IMS', GSTR3B: 'GSTR-3B' }
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const MAX_MONTHS = 36

function monthsBetween(fromYm: string, toYm: string): string[] {
  const out: string[] = []
  let [y, m] = fromYm.split('-').map(Number)
  const [ty, tm] = toYm.split('-').map(Number)
  while ((y < ty || (y === ty && m <= tm)) && out.length < MAX_MONTHS) {
    out.push(`${y}-${String(m).padStart(2, '0')}`)
    m += 1
    if (m > 12) { m = 1; y += 1 }
  }
  return out
}

function base(today: string, due: string, closed: boolean) {
  return {
    statutory_due_date: due, due_date: due, extension: null, anchor_date: null, anchor_missing: false, anchor_note: null,
    days_left: closed ? null : daysBetween(today, due), overdue: !closed && due < today, late_fee_estimate: null,
    filed_on: null, acknowledgement_no: null, late_fee_paid_paise: null, notes: null, last_client_reminder_at: null,
    updated_at: null, read_only: true,
  }
}

export async function gstRows(
  prisma: PrismaClient,
  opts: { clientIds: string[] | 'ALL'; organisationId: string; from: string; to: string; today: string; employees: Map<string, string> },
): Promise<ItemApi[]> {
  const profiles = await prisma.gstProfile.findMany({
    where: {
      deletedAt: null, active: true,
      client: { organisationId: opts.organisationId, deletedAt: null },
      ...(opts.clientIds === 'ALL' ? {} : { clientId: { in: opts.clientIds } }),
    },
    include: { client: { select: { id: true, companyName: true, clientCode: true } } },
  })
  if (!profiles.length) return []
  // A return FOR month M falls due in M+1 (or later when overridden), so
  // start two months before `from`.
  const periods = monthsBetween(addDays(`${opts.from.slice(0, 7)}-01`, -45).slice(0, 7), opts.to.slice(0, 7))
  const cases = await prisma.partnershipCase.findMany({
    where: { deletedAt: null, kind: { in: ['GSTR1', 'GSTR2B', 'GSTR3B'] }, period: { in: periods }, clientId: { in: profiles.map((p) => p.clientId) } },
    select: { id: true, clientId: true, kind: true, period: true, status: true, dueDate: true },
  })
  const caseByKey = new Map(cases.map((c) => [`${c.clientId}::${c.kind}::${c.period}`, c]))
  const resolver = await createRuleResolver(prisma)
  const staleBefore = addDays(opts.today, -31)
  const out: ItemApi[] = []
  for (const p of profiles) {
    const reg = p.registrationDate && /^\d{4}-\d{2}/.test(p.registrationDate) ? p.registrationDate.slice(0, 7) : null
    for (const period of periods) {
      if (reg && period < reg) continue
      for (const kind of kindsOwed(p, period)) {
        const c = caseByKey.get(`${p.clientId}::${kind}::${period}`)
        const due = c?.dueDate ?? resolver.resolve(period, kind, p.filingFrequency as FilingFrequency, stateGroupOf(p))
        if (!due || due < opts.from || due > opts.to) continue
        // Like computeUpcoming: an old period with no case is not guessed at.
        if (!c && due < staleBefore) continue
        const done = c?.status === 'COMPLETED'
        const [y, m] = period.split('-').map(Number)
        out.push({
          ...base(opts.today, due, done),
          id: `gst:${p.clientId}:${kind}:${period}`,
          source: 'gst',
          client_id: p.clientId, client_name: p.client.companyName, client_code: p.client.clientCode, entity_type: 'any',
          form_code: kind, form_name: GST_LABEL[kind], authority: 'gst',
          period_key: period, period_label: `${MON[m - 1]} ${y}`,
          status: done ? 'filed' : c ? 'in_progress' : 'not_started',
          assigned_employee_id: p.assignedEmployeeId ?? null,
          assigned_employee_name: p.assignedEmployeeId ? opts.employees.get(p.assignedEmployeeId) ?? null : null,
          link: `/workstation/services/registration/gst/clients/${p.clientId}`,
        } as ItemApi)
      }
    }
  }
  return out
}

export async function tdsRows(
  prisma: PrismaClient,
  opts: { clientIds: string[] | 'ALL'; organisationId: string; from: string; to: string; today: string; employees: Map<string, string> },
): Promise<ItemApi[]> {
  let ids = opts.clientIds
  if (ids === 'ALL') {
    ids = (await prisma.client.findMany({ where: { organisationId: opts.organisationId, deletedAt: null }, select: { id: true } })).map((c) => c.id)
  }
  if (!ids.length) return []
  // A Q4 return is due 31 May of the following FY, so start one FY earlier.
  const first = shiftFy(fyOfDate(opts.from), -1)
  const last = fyOfDate(opts.to)
  const fys: string[] = []
  for (let y = fyStartYear(first); y <= fyStartYear(last) && fys.length < 4; y++) fys.push(shiftFy(first, y - fyStartYear(first)))
  const out: ItemApi[] = []
  for (const fy of fys) {
    const rows = await buildOverview(prisma, ids, fy, opts.today)
    for (const r of rows) {
      for (const i of r.open_items) {
        if (i.due < opts.from || i.due > opts.to) continue
        const code = i.kind === 'challan' ? 'TDS_CHALLAN' : i.kind === 'return' ? `TDS_${i.formType}` : `TDS_FORM_${i.formType}`
        out.push({
          ...base(opts.today, i.due, false),
          id: `tds:${r.client_id}:${r.tan}:${fy}:${i.kind}:${i.period}:${i.formType ?? ''}`,
          source: 'tds',
          client_id: r.client_id, client_name: r.client_name, client_code: r.client_code, entity_type: 'any',
          form_code: code, form_name: `${i.label}${r.tan ? ` (TAN ${r.tan})` : ''}`, authority: 'income_tax',
          period_key: `${fy}:${i.period}`, period_label: i.period.length === 7 ? i.period : `${i.period} FY ${fy}`,
          status: i.state === 'in_progress' ? 'in_progress' : 'not_started',
          assigned_employee_id: r.account_manager_id,
          assigned_employee_name: opts.employees.get(r.account_manager_id) ?? r.account_manager,
          link: `/workstation/services/tds?client=${r.client_id}&fy=${fy}${r.tan ? `&tan=${r.tan}` : ''}`,
        } as ItemApi)
      }
    }
  }
  return out
}
