/**
 * Who is on a payroll run, for which days, and on which salary structure.
 *
 * One helper shared by Calculate and both blocker checks (run detail and
 * Process), so the headcount, the blockers and the items cannot drift.
 *
 *   window     [max(joiningDate, periodStart) .. min(exitDate, periodEnd)].
 *              exitDate is the last paid day, inclusive.
 *   structure  the structure in force on the window's first day; failing
 *              that (structure entered after the joining date), the first
 *              one that starts inside the window. A mid-month revision is
 *              not split — the month is paid on the structure in force on
 *              the first employed day.
 */

export interface EmploymentWindow { start: string; end: string }

export function employmentWindow(
  periodStart: string, periodEnd: string, joiningDate: string, exitDate: string | null,
): EmploymentWindow | null {
  const start = joiningDate > periodStart ? joiningDate : periodStart
  const end = exitDate && exitDate < periodEnd ? exitDate : periodEnd
  return start <= end ? { start, end } : null
}

/**
 * Prisma `where` for the employees a run covers: joined by the period end,
 * not exited before it began, and either still active or leaving inside
 * the period. A leaver is often already deactivated (status inactive,
 * soft-deleted) by the time payroll runs; their final pro-rata month is
 * still owed, so an exitDate inside the period overrides both.
 */
export function payrollEmployeeWhere(periodStart: string, periodEnd: string) {
  return {
    joiningDate: { lte: periodEnd },
    // Owner staff records (the Admin login) are never on payroll.
    excludeFromHr: false,
    OR: [
      {
        deletedAt: null,
        status: { not: 'inactive' },
        OR: [{ exitDate: null }, { exitDate: { gte: periodStart } }],
      },
      { exitDate: { gte: periodStart, lte: periodEnd } },
    ],
  }
}

/** Structures that might overlap the period — narrow with pickStructure. */
export function periodStructureWhere(periodStart: string, periodEnd: string) {
  return {
    deletedAt: null,
    effectiveFrom: { lte: periodEnd },
    OR: [{ effectiveTo: null }, { effectiveTo: { gte: periodStart } }],
  }
}

interface StructureLike { effectiveFrom: string; effectiveTo: string | null }

export function pickStructure<T extends StructureLike>(structures: T[], window: EmploymentWindow): T | undefined {
  const overlapping = structures.filter(
    (s) => s.effectiveFrom <= window.end && (s.effectiveTo === null || s.effectiveTo >= window.start),
  )
  const inForce = overlapping
    .filter((s) => s.effectiveFrom <= window.start)
    .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1))[0]
  if (inForce) return inForce
  return overlapping.sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : 1))[0]
}
