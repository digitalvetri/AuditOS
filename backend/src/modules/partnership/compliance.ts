/**
 * POST-REGISTRATION COMPLIANCE — Private Limited and LLP.
 *
 * Separate from the registration checklist: it starts once a registration
 * case is marked COMPLETED. Each rule for the case's kind (catalogue below)
 * gets one PostRegistrationCompliance row (never two: the table is unique on
 * caseId + code, and creation skips existing rows). The due date is trigger
 * date + offset days; the status and days remaining are worked out from the
 * due date and today (IST) on every read, so they are always current.
 *
 *   GET   /api/post-registration-compliance            list + summary (filters: kind, status, case_id)
 *   PATCH /api/post-registration-compliance/:id        trigger date / label / offset / assignee / notes
 *   POST  /api/post-registration-compliance/:id/complete   { completed_on, completed_by_employee_id?, notes? }
 *   POST  /api/post-registration-compliance/:id/reopen
 *
 * The case screens, the LLP Dashboard, the Private Limited compliance tab and
 * the main Dashboard all read this one endpoint — one source of truth.
 */
import { Router } from 'express'
import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { ApiError, handler, ok } from '../../lib/http.js'
import { requireSession, type Session } from '../../platform/auth.js'
import { writeAudit } from '../../platform/audit.js'
import { assertCanSeeClient, clientScopeWhere, requireWorkstation } from '../../platform/workstation/scope.js'
import type { Scope } from '../../platform/rbac/matrix.js'
import { employeeMap } from '../../api/workstation.serialize.js'
import { body, FieldErrors } from '../workstation/validate.js'
import { addDays, logActivity, today } from './service.js'

const READ = ['workstation.service.read', 'workstation.service.manage'] as const
const MANAGE = ['workstation.service.manage'] as const

/** Registration kinds that have post-registration compliance. */
export const COMPLIANCE_KINDS = ['PRIVATE_LIMITED', 'LLP'] as const
export type ComplianceKind = (typeof COMPLIANCE_KINDS)[number]
export const hasCompliance = (kind: string): kind is ComplianceKind => (COMPLIANCE_KINDS as readonly string[]).includes(kind)

/**
 * When reminder notifications go out, until the compliance is completed:
 *  - `everyDays`: every N days after the trigger date (and on the due date);
 *  - `daysBefore`: when N days are left (e.g. 20, 10, 3), on the due date,
 *    then every `overdueEveryDays` while overdue.
 */
export type ReminderRule = { everyDays: number } | { daysBefore: number[]; overdueEveryDays: number }

export interface ComplianceRule {
  /** Stored on the row as `code` — the compliance type. */
  code: string
  kind: ComplianceKind
  label: string
  title: string
  description: string
  /** Due = trigger date + offsetDays (calendar days). */
  offsetDays: number
  /** "Due Soon" from this many days before the due date. */
  dueSoonDays: number
  /** The trigger date's label. */
  triggerLabel: string
  /** The trigger is always the Date of Incorporation — its label is fixed. */
  fromIncorporation: boolean
  /** The trigger date starts as the Date of Incorporation (still editable). */
  prefillIncorporation: boolean
  reminder: ReminderRule
}

/**
 * The catalogue. A new compliance is one more entry here — the rows, status,
 * reminders, dashboards and history pick it up without other changes.
 *
 * Private Limited: INC-20A is statutory (declaration for commencement of
 * business within 180 days of incorporation). ADTC is the customer's 30-day
 * reminder; it starts from the Date of Incorporation but its date, label and
 * offset stay correctable per company (defaults via ADTC_OFFSET_DAYS /
 * ADTC_TRIGGER_LABEL) until its statutory basis is confirmed.
 *
 * LLP: Form 3 — information about the initial LLP Agreement, within 30 days
 * of incorporation.
 */
export const POST_REG_RULES: ComplianceRule[] = [
  {
    code: 'INC_20A', kind: 'PRIVATE_LIMITED', label: 'INC-20A', title: 'Declaration for Commencement of Business',
    description: 'Declaration that subscribers have paid for their shares, before the company commences business.',
    offsetDays: 180, dueSoonDays: 30, triggerLabel: 'Date of Incorporation', fromIncorporation: true, prefillIncorporation: true,
    reminder: { everyDays: positiveInt(process.env.INC20A_REMINDER_EVERY_DAYS) ?? 20 },
  },
  {
    code: 'ADTC', kind: 'PRIVATE_LIMITED', label: 'ADTC', title: 'ADTC — 30-day compliance',
    description: '30-day compliance after incorporation.',
    offsetDays: positiveInt(process.env.ADTC_OFFSET_DAYS) ?? 30, dueSoonDays: 7,
    triggerLabel: process.env.ADTC_TRIGGER_LABEL?.trim() || 'Date of Incorporation', fromIncorporation: false, prefillIncorporation: true,
    reminder: { everyDays: positiveInt(process.env.ADTC_REMINDER_EVERY_DAYS) ?? 7 },
  },
  {
    code: 'LLP_FORM_3_INITIAL', kind: 'LLP', label: 'LLP Form 3', title: 'LLP Form 3 – Initial LLP Agreement',
    description: 'Filing information regarding the initial LLP Agreement after incorporation.',
    offsetDays: 30, dueSoonDays: positiveInt(process.env.LLP_FORM3_DUE_SOON_DAYS) ?? 7,
    triggerLabel: 'Date of Incorporation', fromIncorporation: true, prefillIncorporation: true,
    reminder: { daysBefore: [20, 10, 3], overdueEveryDays: 7 },
  },
]
export const RULE = new Map(POST_REG_RULES.map((r) => [r.code, r]))
export const rulesFor = (kind: string) => POST_REG_RULES.filter((r) => r.kind === kind)

function positiveInt(v: string | undefined): number | undefined {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 && n <= 3650 ? n : undefined
}

export const COMPLIANCE_STATUSES = ['NOT_STARTED', 'UPCOMING', 'DUE_SOON', 'DUE_TODAY', 'OVERDUE', 'COMPLETED'] as const
export type ComplianceStatus = (typeof COMPLIANCE_STATUSES)[number]

/** Whole days from `from` to `to` (both 'YYYY-MM-DD'). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)
}

/** Status and days remaining for a row, as of `now` ('YYYY-MM-DD'). */
export function complianceState(row: { code: string; dueDate: string | null; completedOn: string | null }, now = today()): { status: ComplianceStatus; daysRemaining: number | null } {
  if (row.completedOn) return { status: 'COMPLETED', daysRemaining: null }
  if (!row.dueDate) return { status: 'NOT_STARTED', daysRemaining: null }
  const d = daysBetween(now, row.dueDate)
  const soon = RULE.get(row.code)?.dueSoonDays ?? 7
  return { status: d < 0 ? 'OVERDUE' : d === 0 ? 'DUE_TODAY' : d <= soon ? 'DUE_SOON' : 'UPCOMING', daysRemaining: d }
}

type ReminderRow = { code: string; triggerDate: string | null; dueDate: string | null; completedOn: string | null }

/**
 * The reminder that applies on `now`, as a key unique to its period ('due',
 * 'p3', 't10', 'o0'…) — the job sends each key once. Null when nothing is due.
 */
export function reminderKey(row: ReminderRow, now = today()): string | null {
  const rule = RULE.get(row.code)
  if (!rule || row.completedOn || !row.triggerDate || !row.dueDate) return null
  const left = daysBetween(now, row.dueDate)
  if (left === 0) return 'due'
  const r = rule.reminder
  if ('everyDays' in r) {
    const period = Math.floor(daysBetween(row.triggerDate, now) / r.everyDays)
    return period >= 1 ? `p${period}` : null
  }
  if (left < 0) return `o${Math.floor((-left - 1) / r.overdueEveryDays)}`
  const hit = [...r.daysBefore].sort((a, b) => a - b).find((d) => left <= d)
  return hit === undefined ? null : `t${hit}`
}

/**
 * When the next reminder notification goes out ('YYYY-MM-DD'). Null once
 * completed or while there is no trigger date.
 */
export function nextReminder(row: ReminderRow, now = today()): string | null {
  const rule = RULE.get(row.code)
  if (!rule || row.completedOn || !row.triggerDate) return null
  const r = rule.reminder
  if ('everyDays' in r) {
    const elapsed = daysBetween(row.triggerDate, now)
    const next = addDays(row.triggerDate, elapsed < r.everyDays ? r.everyDays : (Math.floor(elapsed / r.everyDays) + 1) * r.everyDays)
    return row.dueDate && row.dueDate >= now && row.dueDate < next ? row.dueDate : next
  }
  if (!row.dueDate) return null
  const ahead = [...r.daysBefore.map((d) => addDays(row.dueDate!, -d)), row.dueDate].filter((d) => d > now).sort()
  if (ahead.length) return ahead[0]
  if (row.dueDate === now) return addDays(now, 1)
  const late = daysBetween(row.dueDate, now) // ≥ 1
  return addDays(row.dueDate, 1 + (Math.floor((late - 1) / r.overdueEveryDays) + 1) * r.overdueEveryDays)
}

const plural = (n: number) => `${n} day${n === 1 ? '' : 's'}`

/** "LLP Form 3 for Silverline Legal LLP is due in 20 days." — null when there is nothing to say. */
export function reminderMessage(label: string, name: string, state: { status: ComplianceStatus; daysRemaining: number | null }): string | null {
  const d = state.daysRemaining
  if (state.status === 'COMPLETED' || d === null) return null
  if (d < 0) return `${label} for ${name} is overdue by ${plural(-d)}.`
  if (d === 0) return `${label} for ${name} is due today.`
  return `${label} for ${name} is due in ${plural(d)}.`
}

/**
 * Create the case's compliance rows if they are missing — called when a
 * Private Limited / LLP case becomes COMPLETED (and to backfill cases
 * completed before this existed). Existing rows are never touched except to
 * fill in a missing Date of Incorporation when one is given — so editing,
 * re-completing or refreshing never duplicates or resets them.
 */
export async function ensurePostRegistrationCompliances(caseId: string, opts: { incorporationDate?: string | null; userId?: string | null } = {}) {
  const c = await prisma.partnershipCase.findFirst({
    where: { id: caseId, kind: { in: [...COMPLIANCE_KINDS] }, status: 'COMPLETED', deletedAt: null },
    select: { id: true, clientId: true, kind: true, assignedEmployeeId: true },
  })
  if (!c) return 0
  const rules = rulesFor(c.kind)
  const inc = opts.incorporationDate ?? null
  const created = await prisma.postRegistrationCompliance.createMany({
    skipDuplicates: true,
    data: rules.map((r) => {
      const trigger = r.prefillIncorporation ? inc : null
      return {
        caseId: c.id, clientId: c.clientId, code: r.code, triggerLabel: r.triggerLabel, offsetDays: r.offsetDays,
        triggerDate: trigger, dueDate: trigger ? addDays(trigger, r.offsetDays) : null,
        assignedEmployeeId: c.assignedEmployeeId,
        createdBy: opts.userId ?? null, updatedBy: opts.userId ?? null,
      }
    }),
  })
  if (inc) {
    // A completion that names the incorporation date fills it in if it was missing.
    for (const r of rules.filter((x) => x.prefillIncorporation)) {
      await prisma.postRegistrationCompliance.updateMany({
        where: { caseId: c.id, code: r.code, triggerDate: null },
        data: { triggerDate: inc, dueDate: addDays(inc, r.offsetDays), updatedBy: opts.userId ?? null },
      })
    }
  }
  return created.count
}

/** Backfill: completed Private Limited / LLP cases (in scope) that have no compliance rows yet. */
async function backfill(caseWhere: Prisma.PartnershipCaseWhereInput) {
  const cases = await prisma.partnershipCase.findMany({
    where: { ...caseWhere, status: 'COMPLETED', postRegCompliances: { none: {} } },
    select: { id: true }, take: 200,
  })
  for (const c of cases) await ensurePostRegistrationCompliances(c.id)
}

const include = {
  case: {
    select: {
      id: true, kind: true, caseCode: true, status: true, completedAt: true, registrationNumber: true, assignedEmployeeId: true,
      client: { select: { id: true, companyName: true } },
    },
  },
} as const
type Row = Prisma.PostRegistrationComplianceGetPayload<{ include: typeof include }>

/** Names for the assignee / completed-by of a page of rows — two queries, whatever the page size. */
async function people(rows: Row[]) {
  const emps = await employeeMap(rows.flatMap((r) => [r.assignedEmployeeId ?? r.case.assignedEmployeeId, r.completedByEmployeeId]))
  const userIds = [...new Set(rows.filter((r) => r.completedOn && !r.completedByEmployeeId && r.completedBy).map((r) => r.completedBy!))]
  const users = userIds.length
    ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, email: true, employee: { select: { fullName: true } } } })
    : []
  const userName = new Map(users.map((u) => [u.id, u.employee?.fullName ?? u.email]))
  return {
    employee: (id: string | null | undefined) => (id ? { id, name: emps.get(id)?.full_name ?? id } : null),
    user: (id: string | null | undefined) => (id ? userName.get(id) ?? null : null),
  }
}
type People = Awaited<ReturnType<typeof people>>

function toApi(r: Row, now: string, p: People) {
  const rule = RULE.get(r.code)
  const st = complianceState(r, now)
  const label = rule?.label ?? r.code
  const byEmployee = p.employee(r.completedByEmployeeId)
  return {
    id: r.id,
    code: r.code,
    kind: r.case.kind,
    label,
    title: rule?.title ?? r.code,
    description: rule?.description ?? null,
    case: { id: r.case.id, code: r.case.caseCode, status: r.case.status, registration_completed_at: r.case.completedAt },
    client: { id: r.case.client.id, name: r.case.client.companyName },
    registration_number: r.case.registrationNumber,
    trigger_date: r.triggerDate,
    trigger_label: r.triggerLabel,
    trigger_editable_label: !rule?.fromIncorporation,
    offset_days: r.offsetDays,
    due_date: r.dueDate,
    days_remaining: st.daysRemaining,
    status: st.status,
    due_soon_days: rule?.dueSoonDays ?? 7,
    reminder_every_days: rule && 'everyDays' in rule.reminder ? rule.reminder.everyDays : null,
    next_reminder: nextReminder(r, now),
    reminder_message: reminderMessage(label, r.case.client.companyName, st),
    assigned_to: p.employee(r.assignedEmployeeId ?? r.case.assignedEmployeeId),
    completed_on: r.completedOn,
    completed_by: byEmployee ?? (r.completedOn && r.completedBy ? { id: null, name: p.user(r.completedBy) ?? 'Unknown' } : null),
    notes: r.notes,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
  }
}

async function scopeWhere(session: Session, scope: Scope, kind?: ComplianceKind): Promise<Prisma.PartnershipCaseWhereInput> {
  return { deletedAt: null, kind: kind ?? { in: [...COMPLIANCE_KINDS] }, ...(await clientScopeWhere(session, scope)) }
}

async function loadRow(session: Session, scope: Scope, id: string) {
  const r = await prisma.postRegistrationCompliance.findFirst({ where: { id, case: { deletedAt: null } }, include })
  if (!r) throw ApiError.notFound('Compliance not found.')
  await assertCanSeeClient(session, scope, r.clientId)
  return r
}

async function respondItem(res: Parameters<typeof ok>[0], r: Row) {
  ok(res, { item: toApi(r, today(), await people([r])) })
}

/** An employee id, validated; undefined = absent, null = cleared. */
async function employeeField(e: FieldErrors, field: string, v: unknown): Promise<string | null | undefined> {
  if (v === undefined) return undefined
  if (v === null || v === '') return null
  if (typeof v !== 'string' || !(await prisma.employee.findFirst({ where: { id: v, deletedAt: null }, select: { id: true } }))) {
    e.add(field, 'Employee not found.')
    return undefined
  }
  return v
}

export const postRegistrationRouter = Router()

postRegistrationRouter.get('/', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...READ)
  const kindQ = typeof req.query.kind === 'string' ? req.query.kind.toUpperCase() : ''
  if (kindQ && !hasCompliance(kindQ)) throw ApiError.badRequest(`kind must be one of ${COMPLIANCE_KINDS.join(', ')}.`)
  const kind = kindQ ? (kindQ as ComplianceKind) : undefined
  const caseWhere = await scopeWhere(session, scope, kind)
  const caseId = typeof req.query.case_id === 'string' ? req.query.case_id : undefined
  await backfill(caseId ? { ...caseWhere, id: caseId } : caseWhere)

  const rows = await prisma.postRegistrationCompliance.findMany({
    where: { case: { ...caseWhere, ...(caseId ? { id: caseId } : {}) } },
    include,
    orderBy: [{ dueDate: 'asc' }, { code: 'asc' }],
    take: 2000,
  })
  const now = today()
  const p = await people(rows)
  const all = rows.map((r) => toApi(r, now, p))
  const summary = {
    total: all.length,
    not_started: all.filter((x) => x.status === 'NOT_STARTED').length,
    upcoming: all.filter((x) => x.status === 'UPCOMING').length,
    due_soon: all.filter((x) => x.status === 'DUE_SOON').length,
    due_today: all.filter((x) => x.status === 'DUE_TODAY').length,
    overdue: all.filter((x) => x.status === 'OVERDUE').length,
    completed: all.filter((x) => x.status === 'COMPLETED').length,
  }
  const want = typeof req.query.status === 'string' ? req.query.status.toUpperCase() : ''
  // Open items first, most urgent at the top; completed ones last, newest first.
  const rank: Record<ComplianceStatus, number> = { OVERDUE: 0, DUE_TODAY: 1, DUE_SOON: 2, UPCOMING: 3, NOT_STARTED: 4, COMPLETED: 5 }
  const items = all
    .filter((x) => !want || x.status === want)
    .sort((a, b) => rank[a.status] - rank[b.status]
      || (a.status === 'COMPLETED' ? (b.completed_on ?? '').localeCompare(a.completed_on ?? '') : (a.due_date ?? '9').localeCompare(b.due_date ?? '9')))
  ok(res, {
    today: now,
    summary,
    items,
    rules: POST_REG_RULES.filter((r) => !kind || r.kind === kind).map((r) => ({
      code: r.code, kind: r.kind, label: r.label, title: r.title, description: r.description, offset_days: r.offsetDays,
      due_soon_days: r.dueSoonDays, trigger_label: r.triggerLabel,
      reminder_every_days: 'everyDays' in r.reminder ? r.reminder.everyDays : null,
    })),
  })
}))

/** A 'YYYY-MM-DD' that is a real date; undefined = absent, null = cleared. */
function dateField(e: FieldErrors, field: string, v: unknown): string | null | undefined {
  if (v === undefined) return undefined
  if (v === null || v === '') return null
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) { e.add(field, 'Enter a valid date.'); return undefined }
  return v
}

postRegistrationRouter.patch('/:id', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...MANAGE)
  const r = await loadRow(session, scope, req.params.id)
  const rule = RULE.get(r.code)
  const b = body(req)
  const e = new FieldErrors()
  const trigger = dateField(e, 'trigger_date', b.trigger_date)
  if (trigger && trigger > addDays(today(), 366)) e.add('trigger_date', 'That date is too far in the future.')
  let label: string | undefined
  if (b.trigger_label !== undefined) {
    if (rule?.fromIncorporation) e.add('trigger_label', `${rule.label} always counts from the Date of Incorporation.`)
    else label = e.str('trigger_label', b.trigger_label, { max: 120 }) ?? undefined
  }
  let offset: number | undefined
  if (b.offset_days !== undefined) {
    const n = Number(b.offset_days)
    if (!Number.isInteger(n) || n < 1 || n > 3650) e.add('offset_days', 'Days must be a whole number from 1 to 3650.')
    else offset = n
  }
  const notes = b.notes === undefined ? undefined : (e.str('notes', b.notes, { max: 2000, required: false }) ?? null)
  const assignee = await employeeField(e, 'assigned_employee_id', b.assigned_employee_id)
  e.throwIfAny()

  const nextTrigger = trigger === undefined ? r.triggerDate : trigger
  const nextOffset = offset ?? r.offsetDays
  const updated = await prisma.postRegistrationCompliance.update({
    where: { id: r.id },
    data: {
      ...(trigger !== undefined ? { triggerDate: trigger } : {}),
      ...(label !== undefined ? { triggerLabel: label } : {}),
      ...(offset !== undefined ? { offsetDays: offset } : {}),
      ...(notes !== undefined ? { notes } : {}),
      ...(assignee !== undefined ? { assignedEmployeeId: assignee } : {}),
      dueDate: nextTrigger ? addDays(nextTrigger, nextOffset) : null,
      updatedBy: session.userId,
    },
    include,
  })
  const name = rule?.label ?? r.code
  if (trigger !== undefined && trigger !== r.triggerDate) await logActivity(r.caseId, session, 'compliance.trigger_changed', `${name}: ${updated.triggerLabel} ${r.triggerDate ?? '—'} → ${trigger ?? '—'} (due ${updated.dueDate ?? '—'})`)
  if (offset !== undefined && offset !== r.offsetDays) await logActivity(r.caseId, session, 'compliance.offset_changed', `${name}: due ${offset} days after the trigger (was ${r.offsetDays})`)
  if (label !== undefined && label !== r.triggerLabel) await logActivity(r.caseId, session, 'compliance.trigger_label_changed', `${name}: counts from "${label}"`)
  if (assignee !== undefined && assignee !== r.assignedEmployeeId) {
    const who = (await employeeMap([assignee])).get(assignee ?? '')?.full_name ?? 'nobody'
    await logActivity(r.caseId, session, 'compliance.assigned', `${name}: assigned to ${who}`)
  }
  await writeAudit({
    actorUserId: session.userId, action: 'post_registration_compliance.update', entityType: 'post_registration_compliance', entityId: r.id,
    before: { triggerDate: r.triggerDate, triggerLabel: r.triggerLabel, offsetDays: r.offsetDays, dueDate: r.dueDate, notes: r.notes, assignedEmployeeId: r.assignedEmployeeId },
    after: { triggerDate: updated.triggerDate, triggerLabel: updated.triggerLabel, offsetDays: updated.offsetDays, dueDate: updated.dueDate, notes: updated.notes, assignedEmployeeId: updated.assignedEmployeeId },
    req,
  })
  await respondItem(res, updated)
}))

postRegistrationRouter.post('/:id/complete', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...MANAGE)
  const r = await loadRow(session, scope, req.params.id)
  const e = new FieldErrors()
  const b = body(req)
  const on = dateField(e, 'completed_on', b.completed_on ?? today())
  const by = await employeeField(e, 'completed_by_employee_id', b.completed_by_employee_id)
  const notes = b.notes === undefined ? undefined : (e.str('notes', b.notes, { max: 2000, required: false }) ?? null)
  if (on && on > today()) e.add('completed_on', 'The completion date cannot be in the future.')
  if (on && r.triggerDate && on < r.triggerDate) e.add('completed_on', `The completion date is before the ${r.triggerLabel}.`)
  e.throwIfAny()
  if (!on) throw ApiError.badRequest('Enter the completion date.', { completed_on: 'Enter the completion date.' })
  const updated = await prisma.postRegistrationCompliance.update({ where: { id: r.id }, data: { completedOn: on, completedBy: session.userId, completedByEmployeeId: by ?? session.employeeId ?? null, ...(notes !== undefined ? { notes } : {}), updatedBy: session.userId }, include })
  const name = RULE.get(r.code)?.label ?? r.code
  await logActivity(r.caseId, session, 'compliance.completed', `${name} completed on ${on}${r.dueDate ? ` (due ${r.dueDate})` : ''}`)
  await writeAudit({ actorUserId: session.userId, action: 'post_registration_compliance.complete', entityType: 'post_registration_compliance', entityId: r.id, before: { completedOn: r.completedOn }, after: { completedOn: on, completedByEmployeeId: updated.completedByEmployeeId }, req })
  await respondItem(res, updated)
}))

postRegistrationRouter.post('/:id/reopen', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...MANAGE)
  const r = await loadRow(session, scope, req.params.id)
  if (!r.completedOn) throw ApiError.badRequest('This compliance is not completed.')
  const updated = await prisma.postRegistrationCompliance.update({ where: { id: r.id }, data: { completedOn: null, completedBy: null, completedByEmployeeId: null, updatedBy: session.userId }, include })
  const name = RULE.get(r.code)?.label ?? r.code
  await logActivity(r.caseId, session, 'compliance.reopened', `${name} reopened (was completed on ${r.completedOn})`)
  await writeAudit({ actorUserId: session.userId, action: 'post_registration_compliance.reopen', entityType: 'post_registration_compliance', entityId: r.id, before: { completedOn: r.completedOn }, after: { completedOn: null }, req })
  await respondItem(res, updated)
}))
