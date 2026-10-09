/**
 * COMPLIANCE CALENDAR — data access shared by the routes and the scheduler.
 */
import type { ComplianceForm, ComplianceItem, DueDateExtension, PrismaClient } from '@prisma/client'
import { istDateOf, istToday, daysBetween } from '../../lib/dates.js'
import {
  dueFor, entityTypeOf, fyOfDate, fyStartYear, formEntityTypes, lateFeeEstimate, periodsOf, shiftFy,
  type EntityType, type FormRule,
} from './engine.js'

export const ITEM_STATUSES = ['not_started', 'documents_pending', 'in_progress', 'filed', 'not_applicable'] as const
export type ItemStatus = (typeof ITEM_STATUSES)[number]
export const CLOSED_STATUSES = new Set<string>(['filed', 'not_applicable'])

/** The caller's firm. Session carries no organisationId; the user row does. */
export async function orgOfUser(prisma: PrismaClient, userId: string): Promise<string> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { organisationId: true } })
  return u?.organisationId ?? ''
}

export const toRule = (f: ComplianceForm): FormRule => ({
  code: f.code, name: f.name, authority: f.authority, frequency: f.frequency, entityTypes: f.entityTypes,
  anchor: f.anchor, offsetMonths: f.offsetMonths, dueDay: f.dueDay, offsetDays: f.offsetDays, months: f.months,
  lateFeeNote: f.lateFeeNote,
})

export function formToApi(f: ComplianceForm) {
  return {
    code: f.code,
    name: f.name,
    authority: f.authority,
    frequency: f.frequency,
    entity_types: formEntityTypes(f),
    anchor: f.anchor,
    offset_months: f.offsetMonths,
    due_day: f.dueDay,
    offset_days: f.offsetDays,
    months: f.months,
    late_fee_note: f.lateFeeNote,
    description: f.description,
    source_url: f.sourceUrl,
    is_active: f.isActive,
    sort_order: f.sortOrder,
  }
}

export function extensionToApi(e: DueDateExtension) {
  return {
    id: e.id,
    form_code: e.formCode,
    period_key: e.periodKey,
    new_due_date: e.newDueDate,
    reference: e.reference,
    source_url: e.sourceUrl,
    entity_types: e.entityTypes ? e.entityTypes.split(',').filter(Boolean) : null,
    created_at: e.createdAt,
  }
}

/** Newest live extension for (form, period) that applies to this entity type. */
export function pickExtension(exts: DueDateExtension[], formCode: string, periodKey: string, entity: EntityType): DueDateExtension | null {
  const hits = exts
    .filter((e) => e.formCode === formCode && e.periodKey === periodKey && !e.deletedAt)
    .filter((e) => !e.entityTypes || e.entityTypes.split(',').map((s) => s.trim()).includes(entity))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
  return hits[0] ?? null
}

// ── generation ───────────────────────────────────────────────────────────────

/** FYs the scheduler keeps generated: the one just closed (its annual returns
 *  fall due now), the current one and the next. */
export function defaultFys(today: string): string[] {
  const cur = fyOfDate(today)
  return [shiftFy(cur, -1), cur, shiftFy(cur, 1)]
}

export interface GenerateResult { created: number; updated: number; revived: number }

/**
 * (Re)generate items for every active obligation (optionally one client / one
 * org) for the given FYs. Idempotent: inserts what is missing, refreshes only
 * `dueDate` / `periodLabel` on open rows (never status, filedOn, anchorDate),
 * and revives a soft-deleted row rather than colliding with the unique key.
 *
 * `explicit` = the caller named the FY. Otherwise (scheduler / PUT) a period
 * whose due date passed before the obligation was switched on is skipped —
 * nothing records whether the client filed it before the firm took it on.
 */
export async function generateItems(
  prisma: PrismaClient,
  opts: { fys: string[]; organisationId?: string; clientId?: string; actorUserId?: string | null; explicit?: boolean; today?: string },
): Promise<GenerateResult> {
  const obligations = await prisma.clientObligation.findMany({
    where: {
      isActive: true, deletedAt: null,
      ...(opts.organisationId ? { organisationId: opts.organisationId } : {}),
      ...(opts.clientId ? { clientId: opts.clientId } : {}),
    },
  })
  const result: GenerateResult = { created: 0, updated: 0, revived: 0 }
  if (!obligations.length) return result
  const forms = new Map((await prisma.complianceForm.findMany({ where: { isActive: true } })).map((f) => [f.code, f]))
  const clientIds = [...new Set(obligations.map((o) => o.clientId))]
  const live = new Set((await prisma.client.findMany({ where: { id: { in: clientIds }, deletedAt: null }, select: { id: true } })).map((c) => c.id))
  const existing = await prisma.complianceItem.findMany({
    where: { clientId: { in: clientIds }, formCode: { in: [...new Set(obligations.map((o) => o.formCode))] } },
  })
  const byKey = new Map(existing.map((i) => [`${i.clientId}|${i.formCode}|${i.periodKey}`, i]))
  // The AGM date entered on any AGM / AGM-anchored item of a client's FY
  // carries to the forms generated later for that FY.
  const agmForms = new Set([...forms.values()].filter((f) => f.anchor === 'agm').map((f) => f.code).concat('AGM'))
  const agmDate = new Map<string, string>()
  for (const i of existing) if (i.anchorDate && !i.deletedAt && agmForms.has(i.formCode)) agmDate.set(`${i.clientId}|${i.periodKey}`, i.anchorDate)

  for (const ob of obligations) {
    const form = forms.get(ob.formCode)
    if (!form || !live.has(ob.clientId)) continue
    const rule = toRule(form)
    const since = istDateOf(ob.createdAt)
    for (const fy of opts.fys) {
      for (const p of periodsOf(rule, fy)) {
        const prior = byKey.get(`${ob.clientId}|${ob.formCode}|${p.key}`)
        const anchor = prior?.anchorDate ?? (rule.anchor === 'agm' ? agmDate.get(`${ob.clientId}|${p.key}`) ?? null : null)
        const due = dueFor(rule, p, fy, anchor)
        if (!due) continue
        if (!prior) {
          if (!opts.explicit && due.statutory_due_date < since) continue
          await prisma.complianceItem.create({
            data: {
              organisationId: ob.organisationId, clientId: ob.clientId, formCode: ob.formCode,
              periodKey: p.key, periodLabel: p.label, dueDate: due.statutory_due_date,
              anchorDate: rule.anchor === 'agm' ? anchor : null,
              assignedEmployeeId: ob.assignedEmployeeId ?? null, createdBy: opts.actorUserId ?? null,
            },
          }).then(() => { result.created += 1 }).catch((e: { code?: string }) => {
            if (e.code !== 'P2002') throw e // a concurrent run made it first
          })
          continue
        }
        if (prior.deletedAt) {
          await prisma.complianceItem.update({
            where: { id: prior.id },
            data: { deletedAt: null, dueDate: due.statutory_due_date, periodLabel: p.label, updatedBy: opts.actorUserId ?? null },
          })
          result.revived += 1
          continue
        }
        if (!CLOSED_STATUSES.has(prior.status) && (prior.dueDate !== due.statutory_due_date || prior.periodLabel !== p.label)) {
          await prisma.complianceItem.update({ where: { id: prior.id }, data: { dueDate: due.statutory_due_date, periodLabel: p.label } })
          result.updated += 1
        }
      }
    }
  }
  return result
}

// ── suggestions ──────────────────────────────────────────────────────────────

/** Forms whose entity list names the type; 'any' forms only by a specific signal. */
export function suggestedForms(
  forms: ComplianceForm[],
  entity: EntityType,
  gst: { registrationType: string; filingFrequency: string; active: boolean } | null,
): { form_code: string; reason: string }[] {
  const out = new Map<string, string>()
  if (entity !== 'any') {
    for (const f of forms) {
      if (!f.isActive) continue
      const types = formEntityTypes(f)
      if (types.includes(entity)) out.set(f.code, `Applies to ${entity === 'firm' ? 'partnership firms' : entity === 'company' ? 'companies' : entity === 'llp' ? 'LLPs' : entity}`)
    }
    out.set('ADVANCE_TAX', 'Advance tax applies when the year\'s tax exceeds ₹10,000')
  }
  if (gst?.active) {
    if (gst.registrationType === 'composition') {
      out.set('CMP08', 'Composition GST registration')
      out.set('GSTR4', 'Composition GST registration')
    } else {
      if (gst.filingFrequency === 'quarterly') out.set('PMT06', 'Quarterly (QRMP) GST filer')
      out.set('GSTR9', 'Regular GST registration')
      out.set('GSTR9C', 'Regular GST registration (turnover above ₹5 crore)')
    }
  }
  const known = new Set(forms.filter((f) => f.isActive).map((f) => f.code))
  return [...out].filter(([code]) => known.has(code)).map(([form_code, reason]) => ({ form_code, reason }))
}

// ── items ────────────────────────────────────────────────────────────────────

export interface ItemContext {
  forms: Map<string, ComplianceForm>
  extensions: DueDateExtension[]
  clients: Map<string, { id: string; companyName: string; clientCode: string; businessType: string | null }>
  employees: Map<string, string>
  today: string
}

export function itemToApi(i: ComplianceItem, ctx: ItemContext) {
  const form = ctx.forms.get(i.formCode)
  const client = ctx.clients.get(i.clientId)
  const entity = entityTypeOf(client?.businessType)
  const ext = pickExtension(ctx.extensions, i.formCode, i.periodKey, entity)
  const due = ext?.newDueDate ?? i.dueDate
  const closed = CLOSED_STATUSES.has(i.status)
  const daysLeft = daysBetween(ctx.today, due)
  const agmForm = form?.anchor === 'agm'
  return {
    id: i.id,
    source: 'compliance' as 'compliance' | 'gst' | 'tds',
    read_only: false,
    client_id: i.clientId,
    client_name: client?.companyName ?? null,
    client_code: client?.clientCode ?? null,
    entity_type: entity,
    form_code: i.formCode,
    form_name: form?.name ?? i.formCode,
    authority: form?.authority ?? 'other',
    period_key: i.periodKey,
    period_label: i.periodLabel,
    statutory_due_date: i.dueDate,
    due_date: due,
    extension: ext ? { id: ext.id, new_due_date: ext.newDueDate, reference: ext.reference, source_url: ext.sourceUrl } : null,
    anchor_date: i.anchorDate,
    anchor_missing: agmForm && !i.anchorDate,
    anchor_note: agmForm && !i.anchorDate ? 'AGM date not entered' : null,
    status: i.status,
    assigned_employee_id: i.assignedEmployeeId,
    assigned_employee_name: i.assignedEmployeeId ? ctx.employees.get(i.assignedEmployeeId) ?? null : null,
    filed_on: i.filedOn,
    acknowledgement_no: i.acknowledgementNo,
    late_fee_paid_paise: i.lateFeePaidPaise === null ? null : Number(i.lateFeePaidPaise),
    notes: i.notes,
    days_left: closed ? null : daysLeft,
    overdue: !closed && due < ctx.today,
    late_fee_estimate: form ? lateFeeEstimate(form, due, { today: ctx.today, filedOn: i.filedOn, status: i.status }) : null,
    last_client_reminder_at: i.lastClientReminderAt,
    updated_at: i.updatedAt as Date | null,
    link: null as string | null,
  }
}
export type ItemApi = ReturnType<typeof itemToApi>

export async function buildContext(prisma: PrismaClient, organisationId: string, items: { clientId: string; assignedEmployeeId: string | null }[], today = istToday()): Promise<ItemContext> {
  const clientIds = [...new Set(items.map((i) => i.clientId))]
  const empIds = [...new Set(items.map((i) => i.assignedEmployeeId).filter((x): x is string => !!x))]
  const [forms, extensions, clients, employees] = await Promise.all([
    prisma.complianceForm.findMany(),
    prisma.dueDateExtension.findMany({ where: { organisationId, deletedAt: null } }),
    prisma.client.findMany({ where: { id: { in: clientIds } }, select: { id: true, companyName: true, clientCode: true, businessType: true } }),
    empIds.length ? prisma.employee.findMany({ where: { id: { in: empIds } }, select: { id: true, firstName: true, lastName: true } }) : [],
  ])
  return {
    forms: new Map(forms.map((f) => [f.code, f])),
    extensions,
    clients: new Map(clients.map((c) => [c.id, c])),
    employees: new Map(employees.map((e) => [e.id, [e.firstName, e.lastName].filter(Boolean).join(' ')])),
    today,
  }
}

/** Validate 'YYYY-MM-DD' as a real calendar date. */
export function isIsoDate(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false
  const [y, m, d] = v.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}

export { fyStartYear }
