/**
 * ARTICLESHIP REGISTER — the firm's articled assistants under the CA
 * Regulations, 1988.
 *
 * Leave: an articled assistant may take leave up to ONE-SIXTH of the period of
 * training actually served. Leave beyond that extends the training: the
 * excess days are added to the training end date. "Leave taken" is the
 * approved leave in the leave module (any type, LOP included — ICAI counts
 * every absence) that falls inside the training period; a request straddling
 * the start or end counts in proportion to the days inside.
 *
 * "Period actually served" runs from the training start to today (capped at
 * the training end) while the training is active, and is the whole period
 * once it has ended. Calendar days, as ICAI counts them.
 *
 * The result is written to ArticledTraining.excessLeaveDays /
 * extendedTrainingEnd — on every read of the register, after a leave is
 * approved or cancelled, and whenever HR edits the record.
 *
 * Forms: 102 (registration of articles), 103 (commencement — due within 30
 * days of the training start), 108 (completion / termination) and 109
 * (transfer). sendArticleshipFormAlerts tells HR once per missing form.
 */
import type { ArticledTraining, PrismaClient } from '@prisma/client'
import { addDays, daysBetween, istToday } from '../../lib/dates.js'
import { prisma as defaultPrisma } from '../../lib/prisma.js'
import { notifyPermissionHolders } from '../../platform/notify.js'

type Db = Pick<PrismaClient, 'articledTraining' | 'leaveRequest'>

export const FORM_103_DUE_DAYS = 30
const FORM_103_WARN_DAYS = 7

export interface LeaveSpan { startDate: string; endDate: string; computedWorkingDays: number }

export interface ArticleshipLeave {
  served_days: number
  /** floor(served / 6). */
  leave_allowed_days: number
  /** On the whole period — what the assistant may take by the end. */
  leave_allowed_full_term_days: number
  leave_taken_days: number
  excess_leave_days: number
  extended_training_end: string | null
}

/** Pure: the leave position of one training record as at `today`. */
export function computeArticleshipLeave(
  t: { trainingStart: string; trainingEnd: string; status: string },
  leaves: LeaveSpan[],
  today: string,
): ArticleshipLeave {
  const start = t.trainingStart
  const end = t.trainingEnd < start ? start : t.trainingEnd
  const servedEnd = t.status === 'active' ? (today < end ? today : end) : end
  const served = servedEnd < start ? 0 : daysBetween(start, servedEnd) + 1
  const fullTerm = daysBetween(start, end) + 1

  let taken = 0
  for (const l of leaves) {
    const from = l.startDate > start ? l.startDate : start
    const to = l.endDate < end ? l.endDate : end
    if (to < from) continue
    const span = daysBetween(l.startDate, l.endDate) + 1
    const inside = daysBetween(from, to) + 1
    taken += span > 0 ? l.computedWorkingDays * Math.min(1, inside / span) : 0
  }
  taken = Math.round(taken * 10) / 10
  const allowed = Math.floor(served / 6)
  const excess = Math.max(0, Math.ceil(taken - allowed - 1e-9))
  return {
    served_days: served,
    leave_allowed_days: allowed,
    leave_allowed_full_term_days: Math.floor(fullTerm / 6),
    leave_taken_days: taken,
    excess_leave_days: excess,
    extended_training_end: excess > 0 ? addDays(end, excess) : null,
  }
}

export type FormState = 'filed' | 'due' | 'overdue' | 'not_due'

export interface ArticleshipForms {
  form102: { date: string | null; state: FormState }
  form103: { date: string | null; state: FormState; due_date: string }
  form108: { date: string | null; state: FormState }
  form109: { date: string | null; state: FormState }
  /** Human-readable list of what is missing, for the register. */
  alerts: string[]
}

/** Pure: which ICAI forms are filed, due or overdue. */
export function articleshipForms(t: Pick<ArticledTraining,
  'trainingStart' | 'status' | 'form102Date' | 'form103Date' | 'form108Date' | 'form109Date'>, today: string): ArticleshipForms {
  const due103 = addDays(t.trainingStart, FORM_103_DUE_DAYS)
  const form103: FormState = t.form103Date ? 'filed'
    : today > due103 ? 'overdue'
      : today >= t.trainingStart ? 'due' : 'not_due'
  const ended = t.status === 'completed' || t.status === 'terminated'
  const form108: FormState = t.form108Date ? 'filed' : ended ? 'due' : 'not_due'
  const form109: FormState = t.form109Date ? 'filed' : t.status === 'transferred' ? 'due' : 'not_due'
  const form102: FormState = t.form102Date ? 'filed' : 'due'
  const alerts: string[] = []
  if (form102 !== 'filed') alerts.push('Form 102 (registration) date not recorded')
  if (form103 === 'overdue') alerts.push(`Form 103 overdue — was due by ${due103}`)
  else if (form103 === 'due') alerts.push(`Form 103 due by ${due103}`)
  if (form108 === 'due') alerts.push(`Form 108 due — training ${t.status}`)
  if (form109 === 'due') alerts.push('Form 109 due — articles transferred')
  return {
    form102: { date: t.form102Date, state: form102 },
    form103: { date: t.form103Date, state: form103, due_date: due103 },
    form108: { date: t.form108Date, state: form108 },
    form109: { date: t.form109Date, state: form109 },
    alerts,
  }
}

/**
 * Recompute and store excessLeaveDays / extendedTrainingEnd for one articled
 * employee. Writes only when something changed. Returns the computed leave
 * position, or null when the employee has no training record.
 */
export async function recomputeArticleship(employeeId: string, db: Db = defaultPrisma, today = istToday()) {
  const t = await db.articledTraining.findUnique({ where: { employeeId } })
  if (!t || t.deletedAt) return null
  const leaves = await db.leaveRequest.findMany({
    where: { employeeId, status: 'approved', deletedAt: null, endDate: { gte: t.trainingStart }, startDate: { lte: t.trainingEnd } },
    select: { startDate: true, endDate: true, computedWorkingDays: true },
  })
  const leave = computeArticleshipLeave(t, leaves, today)
  let row = t
  if (t.excessLeaveDays !== leave.excess_leave_days || t.extendedTrainingEnd !== leave.extended_training_end) {
    row = await db.articledTraining.update({
      where: { id: t.id },
      data: { excessLeaveDays: leave.excess_leave_days, extendedTrainingEnd: leave.extended_training_end },
    })
  }
  return { training: row, leave }
}

/** For hooks on the leave path: never throws, never blocks the leave action. */
export async function recomputeArticleshipQuietly(employee: { id: string; type: string }) {
  if (employee.type !== 'articled') return
  try { await recomputeArticleship(employee.id) } catch (e) {
    console.error('[articleship] recompute', e instanceof Error ? e.message : e)
  }
}

/**
 * Daily: tell everyone who manages employees about a missing ICAI form —
 * Form 103 within a week of its 30-day deadline (and once more when it is
 * overdue), Form 108 / 109 once the training has ended / been transferred.
 * Each alert fires once: the notification itself is the record.
 */
export async function sendArticleshipFormAlerts(db: PrismaClient, today = istToday()): Promise<number> {
  const rows = await db.articledTraining.findMany({
    where: { deletedAt: null, employee: { deletedAt: null } },
    include: { employee: { select: { id: true, fullName: true } } },
  })
  let sent = 0
  for (const t of rows) {
    const f = articleshipForms(t, today)
    const due: { key: string; title: string; body: string }[] = []
    if (t.status === 'active' && f.form103.state === 'overdue') {
      due.push({ key: 'form103:overdue', title: `Form 103 overdue — ${t.employee.fullName}`, body: `Form 103 (commencement of articles) was due by ${f.form103.due_date}. Record the filing date in the Articleship register.` })
    } else if (t.status === 'active' && f.form103.state === 'due' && daysBetween(today, f.form103.due_date) <= FORM_103_WARN_DAYS) {
      due.push({ key: 'form103:due', title: `Form 103 due — ${t.employee.fullName}`, body: `Form 103 (commencement of articles) is due by ${f.form103.due_date}.` })
    }
    if (f.form108.state === 'due') {
      due.push({ key: 'form108', title: `Form 108 due — ${t.employee.fullName}`, body: `Training is ${t.status}: file Form 108 and record its date in the Articleship register.` })
    }
    if (f.form109.state === 'due') {
      due.push({ key: 'form109', title: `Form 109 due — ${t.employee.fullName}`, body: 'Articles were transferred: file Form 109 and record its date in the Articleship register.' })
    }
    for (const d of due) {
      const entityId = `articleship:${t.id}:${d.key}`
      const seen = await db.notification.findFirst({ where: { entityType: 'articleship_form', entityId }, select: { id: true } })
      if (seen) continue
      await notifyPermissionHolders('employee.manage', {
        type: 'articleship.form_due', module: 'system', title: d.title, body: d.body,
        entityType: 'articleship_form', entityId, actionUrl: '/hrms/articleship',
      })
      sent++
    }
  }
  return sent
}
