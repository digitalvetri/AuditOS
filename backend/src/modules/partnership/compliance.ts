/**
 * PRIVATE LIMITED — POST-REGISTRATION COMPLIANCE.
 *
 * When a Private Limited registration case is marked COMPLETED, each rule
 * below gets one PostRegistrationCompliance row (never two: the table is
 * unique on caseId + code, and creation skips existing rows). The due date
 * is trigger date + offset days; the status is worked out from the due date
 * and today (IST) on every read, so "days remaining" is always current.
 *
 *   GET   /api/post-registration-compliance            list + summary (filters: status, case_id)
 *   PATCH /api/post-registration-compliance/:id        trigger date / label / offset / notes
 *   POST  /api/post-registration-compliance/:id/complete   { completed_on }
 *   POST  /api/post-registration-compliance/:id/reopen
 *
 * The Private Limited case screen and the main Dashboard both read this one
 * endpoint — one source of truth.
 */
import { Router } from 'express'
import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { ApiError, handler, ok } from '../../lib/http.js'
import { requireSession, type Session } from '../../platform/auth.js'
import { writeAudit } from '../../platform/audit.js'
import { assertCanSeeClient, clientScopeWhere, requireWorkstation } from '../../platform/workstation/scope.js'
import type { Scope } from '../../platform/rbac/matrix.js'
import { body, FieldErrors } from '../workstation/validate.js'
import { addDays, logActivity, today } from './service.js'

const READ = ['workstation.service.read', 'workstation.service.manage'] as const
const MANAGE = ['workstation.service.manage'] as const

export interface ComplianceRule {
  code: string
  label: string
  title: string
  /** Due = trigger date + offsetDays. */
  offsetDays: number
  /** "Due Soon" from this many days before the due date. */
  dueSoonDays: number
  /** The trigger date's label. */
  triggerLabel: string
  /** The trigger is always the Date of Incorporation — its label is fixed. */
  fromIncorporation: boolean
  /** The trigger date starts as the Date of Incorporation (still editable). */
  prefillIncorporation: boolean
  /** A reminder notification goes out every this many days after the trigger, until completed. */
  reminderEveryDays: number
}

/**
 * The rules. INC-20A is statutory: declaration for commencement of business
 * within 180 days of incorporation. ADTC is the customer's 30-day reminder;
 * its trigger date starts as the Date of Incorporation so it is tracked from
 * completion, but its date, label and offset stay correctable per company
 * (and the defaults via ADTC_OFFSET_DAYS / ADTC_TRIGGER_LABEL) until the
 * statutory basis is confirmed.
 */
export const POST_REG_RULES: ComplianceRule[] = [
  {
    code: 'INC_20A', label: 'INC-20A', title: 'Declaration for Commencement of Business',
    offsetDays: 180, dueSoonDays: 30, triggerLabel: 'Date of Incorporation', fromIncorporation: true, prefillIncorporation: true,
    reminderEveryDays: positiveInt(process.env.INC20A_REMINDER_EVERY_DAYS) ?? 20,
  },
  {
    code: 'ADTC', label: 'ADTC', title: 'ADTC — 30-day compliance',
    offsetDays: positiveInt(process.env.ADTC_OFFSET_DAYS) ?? 30, dueSoonDays: 7,
    triggerLabel: process.env.ADTC_TRIGGER_LABEL?.trim() || 'Date of Incorporation', fromIncorporation: false, prefillIncorporation: true,
    reminderEveryDays: positiveInt(process.env.ADTC_REMINDER_EVERY_DAYS) ?? 7,
  },
]
export const RULE = new Map(POST_REG_RULES.map((r) => [r.code, r]))

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

/**
 * When the next reminder notification goes out ('YYYY-MM-DD'): the next
 * multiple of the rule's interval after the trigger date, or the due date if
 * that comes first. Null once completed or while there is no trigger date.
 */
export function nextReminder(row: { code: string; triggerDate: string | null; dueDate: string | null; completedOn: string | null }, now = today()): string | null {
  const every = RULE.get(row.code)?.reminderEveryDays
  if (!every || row.completedOn || !row.triggerDate) return null
  const elapsed = daysBetween(row.triggerDate, now)
  const next = addDays(row.triggerDate, elapsed < every ? every : (Math.floor(elapsed / every) + 1) * every)
  return row.dueDate && row.dueDate >= now && row.dueDate < next ? row.dueDate : next
}

/**
 * Create the case's compliance rows if they are missing — called when a
 * Private Limited case becomes COMPLETED (and to backfill cases completed
 * before this existed). Existing rows are never touched except to fill in a
 * missing Date of Incorporation when one is given.
 */
export async function ensurePostRegistrationCompliances(caseId: string, opts: { incorporationDate?: string | null; userId?: string | null } = {}) {
  const c = await prisma.partnershipCase.findFirst({ where: { id: caseId, kind: 'PRIVATE_LIMITED', status: 'COMPLETED', deletedAt: null }, select: { id: true, clientId: true } })
  if (!c) return 0
  const inc = opts.incorporationDate ?? null
  const created = await prisma.postRegistrationCompliance.createMany({
    skipDuplicates: true,
    data: POST_REG_RULES.map((r) => {
      const trigger = r.prefillIncorporation ? inc : null
      return {
        caseId: c.id, clientId: c.clientId, code: r.code, triggerLabel: r.triggerLabel, offsetDays: r.offsetDays,
        triggerDate: trigger, dueDate: trigger ? addDays(trigger, r.offsetDays) : null,
        createdBy: opts.userId ?? null, updatedBy: opts.userId ?? null,
      }
    }),
  })
  if (inc) {
    // A completion that names the incorporation date fills it in if it was missing.
    for (const r of POST_REG_RULES.filter((x) => x.prefillIncorporation)) {
      await prisma.postRegistrationCompliance.updateMany({
        where: { caseId: c.id, code: r.code, triggerDate: null },
        data: { triggerDate: inc, dueDate: addDays(inc, r.offsetDays), updatedBy: opts.userId ?? null },
      })
    }
  }
  return created.count
}

/** Backfill: completed Private Limited cases (in scope) that are missing a rule's row. */
async function backfill(caseWhere: Prisma.PartnershipCaseWhereInput) {
  const cases = await prisma.partnershipCase.findMany({
    where: { ...caseWhere, status: 'COMPLETED', postRegCompliances: { none: {} } },
    select: { id: true }, take: 200,
  })
  for (const c of cases) await ensurePostRegistrationCompliances(c.id)
}

type Row = Prisma.PostRegistrationComplianceGetPayload<{ include: { case: { select: { id: true; caseCode: true; status: true; completedAt: true; client: { select: { id: true; companyName: true } } } } } }>

function toApi(r: Row, now: string) {
  const rule = RULE.get(r.code)
  const st = complianceState(r, now)
  return {
    id: r.id,
    code: r.code,
    label: rule?.label ?? r.code,
    title: rule?.title ?? r.code,
    case: { id: r.case.id, code: r.case.caseCode, registration_completed_at: r.case.completedAt },
    client: { id: r.case.client.id, name: r.case.client.companyName },
    trigger_date: r.triggerDate,
    trigger_label: r.triggerLabel,
    trigger_editable_label: !rule?.fromIncorporation,
    offset_days: r.offsetDays,
    due_date: r.dueDate,
    days_remaining: st.daysRemaining,
    status: st.status,
    due_soon_days: rule?.dueSoonDays ?? 7,
    reminder_every_days: rule?.reminderEveryDays ?? null,
    next_reminder: nextReminder(r, now),
    completed_on: r.completedOn,
    notes: r.notes,
    updated_at: r.updatedAt,
  }
}

const include = { case: { select: { id: true, caseCode: true, status: true, completedAt: true, client: { select: { id: true, companyName: true } } } } } as const

async function scopeWhere(session: Session, scope: Scope): Promise<Prisma.PartnershipCaseWhereInput> {
  return { deletedAt: null, kind: 'PRIVATE_LIMITED', ...(await clientScopeWhere(session, scope)) }
}

async function loadRow(session: Session, scope: Scope, id: string) {
  const r = await prisma.postRegistrationCompliance.findFirst({ where: { id, case: { deletedAt: null } }, include })
  if (!r) throw ApiError.notFound('Compliance not found.')
  await assertCanSeeClient(session, scope, r.clientId)
  return r
}

export const postRegistrationRouter = Router()

postRegistrationRouter.get('/', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...READ)
  const caseWhere = await scopeWhere(session, scope)
  const caseId = typeof req.query.case_id === 'string' ? req.query.case_id : undefined
  await backfill(caseId ? { ...caseWhere, id: caseId } : caseWhere)

  const rows = await prisma.postRegistrationCompliance.findMany({
    where: { case: { ...caseWhere, ...(caseId ? { id: caseId } : {}) } },
    include,
    orderBy: [{ dueDate: 'asc' }, { code: 'asc' }],
    take: 2000,
  })
  const now = today()
  const all = rows.map((r) => toApi(r, now))
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
    rules: POST_REG_RULES.map((r) => ({ code: r.code, label: r.label, title: r.title, offset_days: r.offsetDays, due_soon_days: r.dueSoonDays, trigger_label: r.triggerLabel, reminder_every_days: r.reminderEveryDays })),
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
      dueDate: nextTrigger ? addDays(nextTrigger, nextOffset) : null,
      updatedBy: session.userId,
    },
    include,
  })
  const name = rule?.label ?? r.code
  if (trigger !== undefined && trigger !== r.triggerDate) await logActivity(r.caseId, session, 'compliance.trigger_changed', `${name}: ${updated.triggerLabel} ${r.triggerDate ?? '—'} → ${trigger ?? '—'} (due ${updated.dueDate ?? '—'})`)
  if (offset !== undefined && offset !== r.offsetDays) await logActivity(r.caseId, session, 'compliance.offset_changed', `${name}: due ${offset} days after the trigger (was ${r.offsetDays})`)
  if (label !== undefined && label !== r.triggerLabel) await logActivity(r.caseId, session, 'compliance.trigger_label_changed', `${name}: counts from "${label}"`)
  await writeAudit({
    actorUserId: session.userId, action: 'post_registration_compliance.update', entityType: 'post_registration_compliance', entityId: r.id,
    before: { triggerDate: r.triggerDate, triggerLabel: r.triggerLabel, offsetDays: r.offsetDays, dueDate: r.dueDate, notes: r.notes },
    after: { triggerDate: updated.triggerDate, triggerLabel: updated.triggerLabel, offsetDays: updated.offsetDays, dueDate: updated.dueDate, notes: updated.notes },
    req,
  })
  ok(res, { item: toApi(updated, today()) })
}))

postRegistrationRouter.post('/:id/complete', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...MANAGE)
  const r = await loadRow(session, scope, req.params.id)
  const e = new FieldErrors()
  const on = dateField(e, 'completed_on', body(req).completed_on ?? today())
  if (on && on > today()) e.add('completed_on', 'The completion date cannot be in the future.')
  if (on && r.triggerDate && on < r.triggerDate) e.add('completed_on', `The completion date is before the ${r.triggerLabel}.`)
  e.throwIfAny()
  if (!on) throw ApiError.badRequest('Enter the completion date.', { completed_on: 'Enter the completion date.' })
  const updated = await prisma.postRegistrationCompliance.update({ where: { id: r.id }, data: { completedOn: on, completedBy: session.userId, updatedBy: session.userId }, include })
  const name = RULE.get(r.code)?.label ?? r.code
  await logActivity(r.caseId, session, 'compliance.completed', `${name} completed on ${on}${r.dueDate ? ` (due ${r.dueDate})` : ''}`)
  await writeAudit({ actorUserId: session.userId, action: 'post_registration_compliance.complete', entityType: 'post_registration_compliance', entityId: r.id, before: { completedOn: r.completedOn }, after: { completedOn: on }, req })
  ok(res, { item: toApi(updated, today()) })
}))

postRegistrationRouter.post('/:id/reopen', handler(async (req, res) => {
  const session = requireSession(req)
  const scope = requireWorkstation(session, ...MANAGE)
  const r = await loadRow(session, scope, req.params.id)
  if (!r.completedOn) throw ApiError.badRequest('This compliance is not completed.')
  const updated = await prisma.postRegistrationCompliance.update({ where: { id: r.id }, data: { completedOn: null, completedBy: null, updatedBy: session.userId }, include })
  const name = RULE.get(r.code)?.label ?? r.code
  await logActivity(r.caseId, session, 'compliance.reopened', `${name} reopened (was completed on ${r.completedOn})`)
  await writeAudit({ actorUserId: session.userId, action: 'post_registration_compliance.reopen', entityType: 'post_registration_compliance', entityId: r.id, before: { completedOn: r.completedOn }, after: { completedOn: null }, req })
  ok(res, { item: toApi(updated, today()) })
}))
