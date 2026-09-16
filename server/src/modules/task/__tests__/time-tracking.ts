/**
 * TASK MODULE — verification suite (spec §32, §33).
 *
 * Runs against the dev database using FIXTURE-prefixed tasks that are removed
 * before and after the run, so it never touches real work. The clock is
 * injected at exact minutes: the arithmetic under test is the engine's, not
 * the wall clock's.
 *
 * Run:  npm --prefix server run test:tasks
 */
import '../../../lib/env.js'
import { PrismaClient } from '@prisma/client'
import type { Session } from '../../../platform/auth.js'
import { TaskService } from '../service.js'
import { TaskReports } from '../reports.js'
import {
  startTask, pauseTask, resumeTask, completeTask, cancelTask, reopenTask,
  isOverdue, normaliseStatus, type TaskActor,
} from '../engine.js'

const prisma = new PrismaClient()
const FIXTURE = 'FIXTURE-TASK'

let passed = 0
const failures: string[] = []

function check(name: string, actual: unknown, expected: unknown) {
  if (actual === expected) { passed++; console.log(`  ✓ ${name}`); return }
  failures.push(`${name}\n      expected ${String(expected)}\n      actual   ${String(actual)}`)
  console.error(`  ✗ ${name} — expected ${String(expected)}, got ${String(actual)}`)
}

async function checkThrows(name: string, fn: () => Promise<unknown>, fragment: string) {
  try {
    await fn()
    failures.push(`${name} — expected a rejection, got success`)
    console.error(`  ✗ ${name} — expected a rejection`)
  } catch (err) {
    const code = (err as { code?: string })?.code ?? ''
    const msg = err instanceof Error ? err.message : String(err)
    if (code.includes(fragment) || msg.toLowerCase().includes(fragment.toLowerCase())) {
      passed++; console.log(`  ✓ ${name}`)
    } else {
      failures.push(`${name} — rejected with "${code}: ${msg}", expected ${fragment}`)
      console.error(`  ✗ ${name} — rejected with "${code}: ${msg}"`)
    }
  }
}

/** A clock fixed to a given wall-clock time on a fixed day. */
const DAY = '2026-09-10'
const at = (hhmm: string) => new Date(`${DAY}T${hhmm}:00.000Z`)

async function sessionFor(email: string): Promise<Session> {
  const user = await prisma.user.findFirst({
    where: { email },
    include: { role: { include: { permissions: { include: { permission: true } } } } },
  })
  if (!user) throw new Error(`user ${email} not found — run the seed first`)
  return {
    userId: user.id, email: user.email, roleId: user.roleId,
    roleCode: user.role.code as Session['roleCode'], roleName: user.role.name,
    grants: user.role.permissions.map((rp) => ({
      permission: rp.permission.code, scope: rp.scope as Session['grants'][number]['scope'],
    })),
    employeeId: user.employeeId,
    departmentId: null,
    employeeFullName: null,
  }
}

async function cleanup() {
  const tasks = await prisma.task.findMany({ where: { title: { startsWith: FIXTURE } }, select: { id: true } })
  const ids = tasks.map((t) => t.id)
  if (!ids.length) return
  await prisma.taskTimeSession.deleteMany({ where: { taskId: { in: ids } } })
  await prisma.taskAuditLog.deleteMany({ where: { taskId: { in: ids } } })
  await prisma.task.deleteMany({ where: { id: { in: ids } } })
  await prisma.notification.deleteMany({ where: { entityType: 'Task', entityId: { in: ids } } })
}

async function newTask(manager: Session, employeeId: string, title: string, extra: Partial<{ dueDate: string; estimatedMinutes: number; priority: string }> = {}) {
  const created = await TaskService.create(manager, {
    title: `${FIXTURE} ${title}`,
    description: 'Created by the Task module verification suite.',
    assignedEmployeeId: employeeId,
    priority: extra.priority ?? 'high',
    dueDate: extra.dueDate ?? '2026-12-31',
    estimatedMinutes: extra.estimatedMinutes ?? null,
  })
  return created.task
}

async function main() {
  const manager = await sessionFor('ravi@auditos.local')          // md — manages
  const employeeUser = await prisma.user.findFirst({
    where: { role: { code: 'employee' }, employeeId: { not: null } },
    select: { email: true, employeeId: true },
  })
  if (!employeeUser?.employeeId) throw new Error('no employee user with an employee record — run the seed first')
  const employee = await sessionFor(employeeUser.email)
  const employeeId = employeeUser.employeeId
  const managerActor: TaskActor = { session: manager, canManage: true }
  const employeeActor: TaskActor = { session: employee, canManage: false }

  await cleanup()
  try {
    // ══ §33 — the required time calculation ═══════════════════════════
    console.log('\n§33 Required time test — start 10:00, pause 10:30, resume 10:45, complete 11:30')
    const t1 = await newTask(manager, employeeId, 'Timed task', { estimatedMinutes: 120 })
    check('Task starts life pending', t1.status, 'pending')
    check('Assignment is recorded against the employee', t1.assigned_employee_id, employeeId)
    check('No time is tracked before it starts', t1.actual_minutes, 0)

    await startTask(t1.id, employeeActor, at('10:00'))
    await pauseTask(t1.id, employeeActor, at('10:30'))
    await resumeTask(t1.id, employeeActor, at('10:45'))
    await completeTask(t1.id, employeeActor, null, at('11:30'))

    const done1 = (await TaskService.get(manager, 'organisation', t1.id)).task
    check('Elapsed = 90 minutes', done1.elapsed_minutes, 90)
    check('Pause = 15 minutes', done1.pause_minutes, 15)
    check('Actual work = 75 minutes', done1.actual_minutes, 75)
    check('Status is completed', done1.status, 'completed')
    check('Two work sessions were recorded', done1.session_count, 2)
    check('Estimated vs actual variance = −45 minutes', done1.variance_minutes, -45)

    // ══ §12 / §33 — three sessions ════════════════════════════════════
    console.log('\nMultiple work sessions — 10:00→10:20, 10:30→11:00, 11:15→11:45')
    const t2 = await newTask(manager, employeeId, 'Three sessions')
    await startTask(t2.id, employeeActor, at('10:00'))
    await pauseTask(t2.id, employeeActor, at('10:20'))
    await resumeTask(t2.id, employeeActor, at('10:30'))
    await pauseTask(t2.id, employeeActor, at('11:00'))
    await resumeTask(t2.id, employeeActor, at('11:15'))
    await completeTask(t2.id, employeeActor, null, at('11:45'))

    const done2 = (await TaskService.get(manager, 'organisation', t2.id)).task
    check('20 + 30 + 30 = 80 minutes of actual work', done2.actual_minutes, 80)
    check('Elapsed = 105 minutes', done2.elapsed_minutes, 105)
    check('Pause = 25 minutes', done2.pause_minutes, 25)
    check('Three work sessions were kept, not overwritten', done2.session_count, 3)

    const detail2 = await TaskService.get(manager, 'organisation', t2.id)
    check('Every session is closed', detail2.sessions.every((s) => !s.open), true)
    check('Session durations are 20, 30, 30', detail2.sessions.map((s) => s.duration_minutes).join(','), '20,30,30')

    // ══ Duplicate / out-of-order requests ═════════════════════════════
    console.log('\nDuplicate and out-of-order requests')
    const t3 = await newTask(manager, employeeId, 'Duplicate clicks')
    await startTask(t3.id, employeeActor, at('09:00'))
    await startTask(t3.id, employeeActor, at('09:01'))   // double-clicked Start
    const afterDoubleStart = await TaskService.get(manager, 'organisation', t3.id)
    check('A double-clicked Start makes exactly one session', afterDoubleStart.sessions.length, 1)
    check('Still in progress after a duplicate start', afterDoubleStart.task.status, 'in_progress')

    await pauseTask(t3.id, employeeActor, at('09:30'))
    await pauseTask(t3.id, employeeActor, at('09:31'))   // double-clicked Pause
    const afterDoublePause = (await TaskService.get(manager, 'organisation', t3.id)).task
    check('A duplicate Pause does not add time', afterDoublePause.actual_minutes, 30)
    check('Status stays paused', afterDoublePause.status, 'paused')

    await completeTask(t3.id, employeeActor, null, at('10:00'))
    await completeTask(t3.id, employeeActor, null, at('10:05'))   // double-clicked Complete
    const afterDoubleComplete = (await TaskService.get(manager, 'organisation', t3.id)).task
    check('A duplicate Complete does not change the totals', afterDoubleComplete.actual_minutes, 30)
    check('Completion time is not moved by the second click', afterDoubleComplete.elapsed_minutes, 60)

    await checkThrows('A completed task cannot be started again',
      () => startTask(t3.id, employeeActor, at('10:10')), 'invalid_transition')
    await checkThrows('A completed task cannot be edited',
      () => TaskService.update(manager, 'organisation', t3.id, { title: 'nope' }), 'completed_immutable')

    // ══ One running task per employee ═════════════════════════════════
    console.log('\nConcurrency')
    const t4 = await newTask(manager, employeeId, 'First running')
    const t5 = await newTask(manager, employeeId, 'Second running')
    await startTask(t4.id, employeeActor, at('12:00'))
    await checkThrows('An employee cannot run two tasks at once',
      () => startTask(t5.id, employeeActor, at('12:05')), 'another_task_running')
    await pauseTask(t4.id, employeeActor, at('12:10'))
    await startTask(t5.id, employeeActor, at('12:10'))
    check('After pausing the first, the second starts',
      (await TaskService.get(manager, 'organisation', t5.id)).task.status, 'in_progress')
    await pauseTask(t5.id, employeeActor, at('12:20'))

    // ══ A running task survives a refresh / re-login ══════════════════
    console.log('\nRestoring a running task from the database')
    const t6 = await newTask(manager, employeeId, 'Survives refresh')
    await startTask(t6.id, employeeActor, at('14:00'))
    const reloaded = await TaskService.get(employee, 'self', t6.id)
    check('A running task reports itself as running', reloaded.task.running, true)
    check('The open session start time comes back from the database',
      reloaded.task.current_session_started_at, at('14:00').toISOString())
    check('Exactly one session is open', reloaded.sessions.filter((s) => s.open).length, 1)
    await completeTask(t6.id, employeeActor, null, at('14:25'))
    check('Time survives the round trip: 25 minutes',
      (await TaskService.get(manager, 'organisation', t6.id)).task.actual_minutes, 25)

    // ══ Permissions ═══════════════════════════════════════════════════
    console.log('\nPermissions and scoping')
    const otherEmployee = await prisma.employee.findFirst({
      where: { deletedAt: null, id: { not: employeeId }, status: { not: 'inactive' } }, select: { id: true },
    })
    if (otherEmployee) {
      const foreign = await newTask(manager, otherEmployee.id, 'Someone else’s task')
      await checkThrows('An employee cannot open a task assigned to someone else',
        () => TaskService.get(employee, 'self', foreign.id), 'not_found')
      await checkThrows('An employee cannot start someone else’s task',
        () => startTask(foreign.id, employeeActor, at('15:00')), 'forbidden')
      const mine = await TaskService.list(employee, 'self', {})
      check('An employee’s list contains only their own tasks',
        mine.items.every((t) => t.assigned_employee_id === employeeId), true)
      check('A manager sees the other employee’s task too',
        (await TaskService.list(manager, 'organisation', { q: FIXTURE, limit: 200 })).items.some((t) => t.id === foreign.id), true)
    }

    // ══ Cancel, reopen, reassign ══════════════════════════════════════
    console.log('\nCancel, reopen and reassign')
    const t7 = await newTask(manager, employeeId, 'To be cancelled')
    await startTask(t7.id, employeeActor, at('16:00'))
    await checkThrows('An employee cannot cancel a task that is running',
      () => cancelTask(t7.id, employeeActor, 'changed my mind', at('16:10')), 'forbidden')
    await cancelTask(t7.id, managerActor, 'Client withdrew the request', at('16:20'))
    const cancelled = (await TaskService.get(manager, 'organisation', t7.id)).task
    check('Cancelled task keeps the work already tracked', cancelled.actual_minutes, 20)
    check('Cancel reason is stored', cancelled.cancel_reason, 'Client withdrew the request')
    await checkThrows('A cancelled task cannot simply be resumed',
      () => resumeTask(t7.id, employeeActor, at('16:30')), 'invalid_transition')
    await checkThrows('An employee cannot reopen a cancelled task',
      () => reopenTask(t7.id, employeeActor), 'forbidden')
    await reopenTask(t7.id, managerActor, 'Client came back')
    const reopened = (await TaskService.get(manager, 'organisation', t7.id)).task
    check('A manager can reopen it', reopened.status, 'paused')
    check('Reopening does not erase recorded work', reopened.actual_minutes, 20)

    if (otherEmployee) {
      const t8 = await newTask(manager, employeeId, 'To be reassigned')
      await startTask(t8.id, employeeActor, at('17:00'))
      await TaskService.reassign(manager, 'organisation', t8.id, otherEmployee.id, 'Workload balancing')
      const reassigned = await TaskService.get(manager, 'organisation', t8.id)
      check('Reassignment moves the task', reassigned.task.assigned_employee_id, otherEmployee.id)
      check('Reassignment closes the running session', reassigned.sessions.every((s) => !s.open), true)
      check('Work already done stays with the task', reassigned.sessions.length, 1)
      check('Audit trail records the reassignment',
        reassigned.timeline.some((e) => e.action === 'task_reassigned'), true)
    }

    // ══ Overdue is a display state ════════════════════════════════════
    console.log('\nOverdue')
    check('Past due and pending is overdue', isOverdue('2020-01-01', 'pending', '2026-09-10'), true)
    check('Past due and in progress is overdue', isOverdue('2020-01-01', 'in_progress', '2026-09-10'), true)
    check('Past due but completed is not overdue', isOverdue('2020-01-01', 'completed', '2026-09-10'), false)
    check('Past due but cancelled is not overdue', isOverdue('2020-01-01', 'cancelled', '2026-09-10'), false)
    check('No due date is never overdue', isOverdue(null, 'pending', '2026-09-10'), false)
    const overdueTask = await newTask(manager, employeeId, 'Overdue one', { dueDate: '2020-01-01' })
    check('An overdue task is flagged but keeps its real status', overdueTask.status, 'pending')
    const overdueList = await TaskService.list(manager, 'organisation', { overdueOnly: true, limit: 200 })
    check('It appears in the overdue filter', overdueList.items.some((t) => t.id === overdueTask.id), true)
    check('It is marked overdue on the row',
      overdueList.items.find((t) => t.id === overdueTask.id)?.overdue, true)

    // ══ Audit trail ═══════════════════════════════════════════════════
    console.log('\nAudit trail')
    const trail = await TaskService.get(manager, 'organisation', t1.id)
    const actions = trail.timeline.map((e) => e.action)
    for (const expected of ['task_created', 'task_assigned', 'task_started', 'task_paused', 'task_resumed', 'task_completed']) {
      check(`Timeline records ${expected}`, actions.includes(expected), true)
    }
    check('Timeline is in chronological order',
      trail.timeline.every((e, i) => i === 0 || e.at >= trail.timeline[i - 1].at), true)

    // ══ Reports ═══════════════════════════════════════════════════════
    console.log('\nReports')
    const dash = await TaskReports.dashboard(manager, 'organisation', {})
    check('Dashboard counts something', dash.totals.total > 0, true)
    check('Dashboard work minutes are a real sum', dash.totals.total_work_minutes >= 75 + 80, true)
    check('Dashboard counts the overdue task', dash.totals.overdue >= 1, true)

    const byEmployee = await TaskReports.byEmployee(manager, 'organisation', {})
    const mineRow = byEmployee.find((r) => r.employee_id === employeeId)
    check('Employee report includes the assignee', Boolean(mineRow), true)
    check('Employee work time is at least the two completed tasks',
      (mineRow?.work_minutes ?? 0) >= 155, true)

    const eva = await TaskReports.estimatedVsActual(manager, 'organisation', {})
    const evaRow = eva.items.find((r) => r.task_id === t1.id)
    check('Estimated vs actual lists the estimated task', Boolean(evaRow), true)
    check('Estimated vs actual variance is −45', evaRow?.variance_minutes, -45)
    check('Estimated vs actual is labelled as a time comparison',
      eva.note.includes('not a performance rating'), true)

    const sheet = await TaskReports.timesheet(manager, 'organisation', { from: DAY, to: DAY })
    check('Timesheet reports work on the fixture day', sheet.total_minutes > 0, true)

    // ══ Employees cannot enter time ═══════════════════════════════════
    console.log('\nNo manual duration entry')
    const t9 = await newTask(manager, employeeId, 'No manual time')
    await TaskService.update(manager, 'organisation', t9.id, { notes: 'trying to set time' })
    const untouched = (await TaskService.get(manager, 'organisation', t9.id)).task
    check('Editing a task cannot set actual time', untouched.actual_minutes, 0)
    check('Editing a task cannot set a start time', untouched.started_at, null)
    check('Legacy statuses normalise on read', normaliseStatus('open'), 'pending')
    check('Legacy done normalises to completed', normaliseStatus('done'), 'completed')
  } finally {
    await cleanup()
    await prisma.$disconnect()
  }

  console.log(`\n${passed} checks passed, ${failures.length} failed`)
  if (failures.length) {
    console.error('\nFAILURES:\n  ' + failures.join('\n  '))
    process.exit(1)
  }
}

main().catch((err) => { console.error(err); process.exit(1) })
