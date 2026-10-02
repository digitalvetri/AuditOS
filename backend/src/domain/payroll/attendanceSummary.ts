/**
 * Attendance summary for one employee over a payroll period.
 *
 *   payable_days  calendar days in [start..end]
 *   on_leave_days rows with status 'on_leave'
 *   absent_days   rows with status 'absent'
 *   present_days  present + late + wfh + half_day
 *   lop_days      absent days NOT covered by an approved leave
 */
import { daysBetween, enumerateDates } from '../../lib/dates.js'
import type { AttendanceSummary } from './calc.js'

export interface AttendanceRow { date: string; status: string }
export interface ApprovedLeaveRow { startDate: string; endDate: string; status: string }

export function summarize(
  attendance: AttendanceRow[],
  approvedLeaves: ApprovedLeaveRow[],
  periodStart: string,
  periodEnd: string,
): AttendanceSummary {
  const payable_days = daysBetween(periodStart, periodEnd) + 1
  const on_leave_days = attendance.filter((a) => a.status === 'on_leave').length
  const absent_days = attendance.filter((a) => a.status === 'absent').length
  const present_days = attendance.filter(
    (a) => a.status === 'present' || a.status === 'late' || a.status === 'wfh' || a.status === 'half_day',
  ).length

  const leaveDates = new Set<string>()
  for (const lr of approvedLeaves) {
    if (lr.status !== 'approved') continue
    if (lr.endDate < periodStart || lr.startDate > periodEnd) continue
    const from = lr.startDate > periodStart ? lr.startDate : periodStart
    const to = lr.endDate < periodEnd ? lr.endDate : periodEnd
    for (const d of enumerateDates(from, to)) leaveDates.add(d)
  }

  const lop_days = attendance.filter((a) => a.status === 'absent' && !leaveDates.has(a.date)).length

  return { payable_days, present_days, on_leave_days, absent_days, lop_days }
}
