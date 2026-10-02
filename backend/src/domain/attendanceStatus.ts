/**
 * Pure attendance status computation (§3). No I/O — reused by the check-in /
 * check-out handlers, the correction approver and the seed.
 *
 *   late_after:     09:45 IST → Late
 *   half_day_below: 4.0 worked hours
 *   absent_below:   1.0 worked hour
 *   break_minutes:  60, auto-deducted when the session exceeds 6h
 *
 * Precedence: absent > half_day > late > present. One winning status per row.
 */
import { compareHHMM, istTimeOf } from '../lib/dates.js'

export type AttendanceStatus =
  | 'present' | 'late' | 'absent' | 'half_day' | 'wfh'
  | 'on_leave' | 'missing_check_in' | 'missing_check_out'

const LATE_AFTER = '09:45'
const HALF_DAY_HOURS = 4
const ABSENT_HOURS = 1
const BREAK_MIN = 60
const BREAK_APPLIES_AFTER_MIN = 6 * 60

export interface StatusResult {
  status: AttendanceStatus
  workedMinutes: number
  breakMinutes: number
}

export function computeCheckOutStatus(checkInAt: string | Date, checkOutAt: string | Date): StatusResult {
  const rawMin = Math.max(
    0,
    Math.round((new Date(checkOutAt).getTime() - new Date(checkInAt).getTime()) / 60_000),
  )
  const breakMinutes = rawMin > BREAK_APPLIES_AFTER_MIN ? BREAK_MIN : 0
  const workedMinutes = Math.max(0, rawMin - breakMinutes)
  const workedHours = workedMinutes / 60
  const late = compareHHMM(istTimeOf(checkInAt), LATE_AFTER) > 0

  let status: AttendanceStatus
  if (workedHours < ABSENT_HOURS) status = 'absent'
  else if (workedHours < HALF_DAY_HOURS) status = 'half_day'
  else if (late) status = 'late'
  else status = 'present'

  return { status, workedMinutes, breakMinutes }
}

export function computeCheckInStatus(checkInAt: string | Date): AttendanceStatus {
  return compareHHMM(istTimeOf(checkInAt), LATE_AFTER) > 0 ? 'late' : 'present'
}
