import { prisma, alive } from '../../lib/prisma.js'
import type { Session } from '../../platform/auth.js'
import type { Scope } from '../../platform/rbac/matrix.js'
import { taskScopeWhere } from './service.js'
import { normaliseStatus } from './engine.js'

/**
 * Task reporting — dashboard tiles, employee work-time summaries and the
 * period/dimension reports.
 *
 * Every figure is a database aggregate over Task and TaskTimeSession inside
 * the caller's scope. Nothing is counted in the browser, and a task that is
 * still running contributes its banked minutes only — the live tick belongs
 * to the UI, never to a report.
 */

export interface ReportFilters {
  from?: string
  to?: string
  employeeId?: string
  status?: string
  priority?: string
  clientId?: string
  clientServiceId?: string
}

/** Statuses as stored, including the legacy vocabulary on older rows. */
const STORED = {
  pending: ['pending', 'open'],
  in_progress: ['in_progress'],
  paused: ['paused', 'blocked'],
  completed: ['completed', 'done'],
  cancelled: ['cancelled'],
}
const CLOSED = [...STORED.completed, ...STORED.cancelled]

async function baseWhere(session: Session, scope: Scope, f: ReportFilters) {
  const scopeWhere = await taskScopeWhere(session, scope)
  return {
    ...alive,
    ...scopeWhere,
    ...(f.employeeId ? { assignedEmployeeId: f.employeeId } : {}),
    ...(f.priority && f.priority !== 'all' ? { priority: f.priority } : {}),
    ...(f.clientId ? { clientId: f.clientId } : {}),
    ...(f.clientServiceId ? { clientServiceId: f.clientServiceId } : {}),
    ...(f.status && f.status !== 'all' ? { status: { in: STORED[f.status as keyof typeof STORED] ?? [f.status] } } : {}),
    ...(f.from || f.to
      ? {
          createdAt: {
            ...(f.from ? { gte: new Date(`${f.from}T00:00:00Z`) } : {}),
            ...(f.to ? { lte: new Date(`${f.to}T23:59:59Z`) } : {}),
          },
        }
      : {}),
  }
}

export const TaskReports = {
  /**
   * The dashboard. One count per status plus the time aggregates, all
   * computed by the database — the browser receives numbers, not rows.
   */
  async dashboard(session: Session, scope: Scope, f: ReportFilters = {}) {
    const where = await baseWhere(session, scope, f)
    const today = new Date().toISOString().slice(0, 10)

    const [byStatus, overdue, totals, completedAgg, employees, byPriority, estimateAgg] = await Promise.all([
      prisma.task.groupBy({ by: ['status'], where, _count: { _all: true } }),
      prisma.task.count({ where: { ...where, dueDate: { lt: today, not: null }, status: { notIn: CLOSED } } }),
      prisma.task.aggregate({ where, _sum: { actualMinutes: true, totalPauseMinutes: true }, _count: { _all: true } }),
      prisma.task.aggregate({
        where: { ...where, status: { in: STORED.completed } },
        _avg: { actualMinutes: true }, _sum: { actualMinutes: true }, _count: { _all: true },
      }),
      prisma.task.findMany({ where: { ...where, status: { notIn: CLOSED } }, select: { assignedEmployeeId: true }, distinct: ['assignedEmployeeId'] }),
      prisma.task.groupBy({ by: ['priority'], where, _count: { _all: true } }),
      prisma.task.aggregate({ where: { ...where, estimatedMinutes: { not: null } }, _sum: { estimatedMinutes: true, actualMinutes: true } }),
    ])

    const counts: Record<string, number> = { pending: 0, in_progress: 0, paused: 0, completed: 0, cancelled: 0 }
    for (const row of byStatus) counts[normaliseStatus(row.status)] += row._count._all

    return {
      period: { from: f.from ?? null, to: f.to ?? null },
      totals: {
        total: totals._count._all,
        pending: counts.pending,
        in_progress: counts.in_progress,
        paused: counts.paused,
        completed: counts.completed,
        cancelled: counts.cancelled,
        overdue,
        active_employees: employees.length,
        total_work_minutes: totals._sum.actualMinutes ?? 0,
        total_pause_minutes: totals._sum.totalPauseMinutes ?? 0,
        average_completion_minutes: Math.round(completedAgg._avg.actualMinutes ?? 0),
        completed_work_minutes: completedAgg._sum.actualMinutes ?? 0,
      },
      by_priority: ['urgent', 'high', 'medium', 'low'].map((p) => ({
        priority: p,
        count: byPriority.find((r) => r.priority === p)?._count._all ?? 0,
      })),
      by_status: Object.entries(counts).map(([status, count]) => ({ status, count })),
      estimated_vs_actual: {
        estimated_minutes: estimateAgg._sum.estimatedMinutes ?? 0,
        actual_minutes: estimateAgg._sum.actualMinutes ?? 0,
        variance_minutes: (estimateAgg._sum.actualMinutes ?? 0) - (estimateAgg._sum.estimatedMinutes ?? 0),
      },
    }
  },

  /**
   * Employee-wise work time. One grouped query for the counts and one for
   * the time — never a query per employee.
   */
  async byEmployee(session: Session, scope: Scope, f: ReportFilters = {}) {
    const where = await baseWhere(session, scope, f)
    const today = new Date().toISOString().slice(0, 10)

    const [grouped, overdueRows, employees] = await Promise.all([
      prisma.task.groupBy({
        by: ['assignedEmployeeId', 'status'],
        where,
        _count: { _all: true },
        _sum: { actualMinutes: true, estimatedMinutes: true },
      }),
      prisma.task.groupBy({
        by: ['assignedEmployeeId'],
        where: { ...where, dueDate: { lt: today, not: null }, status: { notIn: CLOSED } },
        _count: { _all: true },
      }),
      prisma.employee.findMany({
        where: { deletedAt: null },
        select: { id: true, fullName: true, employeeCode: true, department: { select: { name: true } } },
      }),
    ])

    const nameOf = new Map(employees.map((e) => [e.id, e]))
    const overdueOf = new Map(overdueRows.map((r) => [r.assignedEmployeeId, r._count._all]))
    const acc = new Map<string, {
      employee_id: string; employee_name: string; employee_code: string; department: string | null
      total: number; pending: number; in_progress: number; paused: number; completed: number; cancelled: number
      overdue: number; work_minutes: number; estimated_minutes: number
    }>()

    for (const row of grouped) {
      const id = row.assignedEmployeeId
      if (!acc.has(id)) {
        const e = nameOf.get(id)
        acc.set(id, {
          employee_id: id,
          employee_name: e?.fullName ?? 'Unknown',
          employee_code: e?.employeeCode ?? '',
          department: e?.department?.name ?? null,
          total: 0, pending: 0, in_progress: 0, paused: 0, completed: 0, cancelled: 0,
          overdue: overdueOf.get(id) ?? 0, work_minutes: 0, estimated_minutes: 0,
        })
      }
      const r = acc.get(id)!
      const bucket = normaliseStatus(row.status)
      r.total += row._count._all
      r[bucket] += row._count._all
      r.work_minutes += row._sum.actualMinutes ?? 0
      r.estimated_minutes += row._sum.estimatedMinutes ?? 0
    }

    return Array.from(acc.values())
      .map((r) => ({
        ...r,
        average_task_minutes: r.completed > 0 ? Math.round(r.work_minutes / r.completed) : 0,
        variance_minutes: r.estimated_minutes > 0 ? r.work_minutes - r.estimated_minutes : null,
      }))
      .sort((a, b) => b.work_minutes - a.work_minutes)
  },

  /** Client-wise or project-wise roll-up — the same shape, one grouping key. */
  async byDimension(session: Session, scope: Scope, dimension: 'client' | 'project', f: ReportFilters = {}) {
    const where = await baseWhere(session, scope, f)
    const key = dimension === 'client' ? 'clientId' : 'clientServiceId'
    const grouped = await prisma.task.groupBy({
      by: [key as 'clientId' | 'clientServiceId', 'status'],
      where,
      _count: { _all: true },
      _sum: { actualMinutes: true, estimatedMinutes: true },
    })
    const ids = Array.from(new Set(grouped.map((g) => (g as Record<string, unknown>)[key] as string | null).filter((x): x is string => Boolean(x))))
    const labels = new Map<string, string>()
    if (dimension === 'client' && ids.length) {
      const rows = await prisma.client.findMany({ where: { id: { in: ids } }, select: { id: true, companyName: true } })
      for (const r of rows) labels.set(r.id, r.companyName)
    } else if (ids.length) {
      const rows = await prisma.clientService.findMany({
        where: { id: { in: ids } },
        select: { id: true, service: { select: { name: true } }, client: { select: { companyName: true } } },
      })
      for (const r of rows) labels.set(r.id, `${r.service.name} — ${r.client.companyName}`)
    }

    const acc = new Map<string, { id: string | null; label: string; total: number; completed: number; work_minutes: number; estimated_minutes: number }>()
    for (const g of grouped) {
      const id = ((g as Record<string, unknown>)[key] as string | null) ?? null
      const k = id ?? '__none__'
      if (!acc.has(k)) acc.set(k, { id, label: id ? labels.get(id) ?? 'Unknown' : 'Unassigned', total: 0, completed: 0, work_minutes: 0, estimated_minutes: 0 })
      const r = acc.get(k)!
      r.total += g._count._all
      if (normaliseStatus(g.status) === 'completed') r.completed += g._count._all
      r.work_minutes += g._sum.actualMinutes ?? 0
      r.estimated_minutes += g._sum.estimatedMinutes ?? 0
    }
    return Array.from(acc.values()).sort((a, b) => b.work_minutes - a.work_minutes)
  },

  /**
   * Estimated vs actual, per completed task. Reported as a time comparison —
   * it is deliberately not framed as a performance score.
   */
  async estimatedVsActual(session: Session, scope: Scope, f: ReportFilters = {}) {
    const where = await baseWhere(session, scope, f)
    const rows = await prisma.task.findMany({
      where: { ...where, status: { in: STORED.completed }, estimatedMinutes: { not: null } },
      select: {
        id: true, title: true, estimatedMinutes: true, actualMinutes: true, completedAt: true, priority: true,
        assignedEmployee: { select: { id: true, fullName: true } },
      },
      orderBy: { completedAt: 'desc' },
      take: 500,
    })
    const items = rows.map((r) => ({
      task_id: r.id,
      title: r.title,
      employee_id: r.assignedEmployee.id,
      employee_name: r.assignedEmployee.fullName,
      priority: r.priority,
      estimated_minutes: r.estimatedMinutes!,
      actual_minutes: r.actualMinutes,
      variance_minutes: r.actualMinutes - r.estimatedMinutes!,
      completed_at: r.completedAt?.toISOString() ?? null,
    }))
    return {
      items,
      totals: {
        count: items.length,
        estimated_minutes: items.reduce((s, r) => s + r.estimated_minutes, 0),
        actual_minutes: items.reduce((s, r) => s + r.actual_minutes, 0),
        under: items.filter((r) => r.variance_minutes < 0).length,
        over: items.filter((r) => r.variance_minutes > 0).length,
        on_estimate: items.filter((r) => r.variance_minutes === 0).length,
      },
      note: 'A time comparison between the estimate set at assignment and the tracked work time. It is not a performance rating.',
    }
  },

  /**
   * Work logged per calendar day, from the SESSIONS rather than the tasks —
   * so a task spanning three days shows up on all three.
   */
  async timesheet(session: Session, scope: Scope, f: ReportFilters = {}) {
    const scopeWhere = await taskScopeWhere(session, scope)
    const sessions = await prisma.taskTimeSession.findMany({
      where: {
        endedAt: { not: null },
        ...(f.employeeId ? { employeeId: f.employeeId } : {}),
        ...(f.from ? { startedAt: { gte: new Date(`${f.from}T00:00:00Z`) } } : {}),
        ...(f.to ? { endedAt: { lte: new Date(`${f.to}T23:59:59Z`) } } : {}),
        task: { ...alive, ...scopeWhere },
      },
      select: {
        startedAt: true, endedAt: true, durationMinutes: true, employeeId: true,
        task: { select: { id: true, title: true } },
        employee: { select: { fullName: true } },
      },
      orderBy: { startedAt: 'asc' },
      take: 5000,
    })
    const byDay = new Map<string, { date: string; minutes: number; sessions: number; employees: Set<string> }>()
    for (const s of sessions) {
      const day = s.startedAt.toISOString().slice(0, 10)
      if (!byDay.has(day)) byDay.set(day, { date: day, minutes: 0, sessions: 0, employees: new Set() })
      const d = byDay.get(day)!
      d.minutes += s.durationMinutes ?? Math.round((s.endedAt!.getTime() - s.startedAt.getTime()) / 60_000)
      d.sessions += 1
      d.employees.add(s.employeeId)
    }
    return {
      days: Array.from(byDay.values()).map((d) => ({ date: d.date, minutes: d.minutes, sessions: d.sessions, employees: d.employees.size })),
      total_minutes: Array.from(byDay.values()).reduce((s, d) => s + d.minutes, 0),
    }
  },
}
