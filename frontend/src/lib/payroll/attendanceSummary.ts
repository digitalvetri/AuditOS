/**
 * Build an AttendanceSummary for one employee over a payroll period.
 *
 * `payable_days` = calendar days in [period_start..period_end] (per §3).
 * `on_leave_days` = attendance rows with status='on_leave' in the period.
 * `absent_days`   = attendance rows with status='absent'.
 * `present_days`  = present + late + wfh + half_day (half_day counts as 1
 *                   here for attendance; the salary component doesn't
 *                   pro-rate half-days in this scaffold).
 * `lop_days`      = absent days not covered by an approved leave.
 *
 * Called by the payroll handler with pre-filtered attendance + leaves.
 */

import type { Attendance, LeaveRequest } from '@/data/models';
import { daysBetween } from '@/lib/dates';
import type { AttendanceSummary } from './calc';

export function summarize(
  attendance: Attendance[],
  approvedLeaves: LeaveRequest[],
  periodStart: string,
  periodEnd: string,
): AttendanceSummary {
  const payable_days = daysBetween(periodStart, periodEnd) + 1;
  const on_leave_days = attendance.filter((a) => a.status === 'on_leave').length;
  const absent_days = attendance.filter((a) => a.status === 'absent').length;
  const present_days = attendance.filter(
    (a) => a.status === 'present' || a.status === 'late' || a.status === 'wfh' || a.status === 'half_day',
  ).length;

  // Dates covered by an approved leave that falls in the period.
  const leaveDates = new Set<string>();
  for (const lr of approvedLeaves) {
    if (lr.status !== 'approved') continue;
    if (lr.end_date < periodStart || lr.start_date > periodEnd) continue;
    const from = lr.start_date > periodStart ? lr.start_date : periodStart;
    const to = lr.end_date < periodEnd ? lr.end_date : periodEnd;
    // Enumerate.
    const [sy, sm, sd] = from.split('-').map(Number);
    const [ey, em, ed] = to.split('-').map(Number);
    const cur = new Date(Date.UTC(sy, sm - 1, sd));
    const stop = new Date(Date.UTC(ey, em - 1, ed));
    while (cur.getTime() <= stop.getTime()) {
      leaveDates.add(
        `${cur.getUTCFullYear()}-${String(cur.getUTCMonth() + 1).padStart(2, '0')}-${String(cur.getUTCDate()).padStart(2, '0')}`,
      );
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
  }
  // LOP = absent rows whose date isn't covered by an approved leave.
  const lop_days = attendance.filter(
    (a) => a.status === 'absent' && !leaveDates.has(a.date),
  ).length;

  return { payable_days, present_days, on_leave_days, absent_days, lop_days };
}
