/**
 * Pure status computation. No I/O. Reused by handlers, seed and tests.
 *
 * Rules (§3):
 *   late_after:       09:45 IST → status Late
 *   half_day_below:   4.0 worked hours
 *   absent_below:     1.0 worked hour
 *   break_minutes:    60 (auto-deducted if session > 6h)
 *
 * Status precedence (spec silent — advisor-suggested):
 *   absent > half_day > late > present
 * Single winning status per row; no multi-status field.
 */

import type { AttendanceStatus } from '@/data/models';
import { compareHHMM, istTimeOf } from './dates';

const LATE_AFTER = '09:45';
const HALF_DAY_HOURS = 4;
const ABSENT_HOURS = 1;
const BREAK_MIN = 60;
const BREAK_APPLIES_AFTER_MIN = 6 * 60;

export interface StatusResult {
  status: AttendanceStatus;
  workedMinutes: number;
  breakMinutes: number;
}

/**
 * Compute status when checking OUT (both timestamps present).
 * Break-deduction lives here so read handlers stay pure display.
 */
export function computeCheckOutStatus(
  checkInAt: string,
  checkOutAt: string,
): StatusResult {
  const rawMin = Math.max(
    0,
    Math.round((new Date(checkOutAt).getTime() - new Date(checkInAt).getTime()) / 60_000),
  );
  const breakMinutes = rawMin > BREAK_APPLIES_AFTER_MIN ? BREAK_MIN : 0;
  const workedMinutes = Math.max(0, rawMin - breakMinutes);
  const workedHours = workedMinutes / 60;

  const late = compareHHMM(istTimeOf(checkInAt), LATE_AFTER) > 0;

  let status: AttendanceStatus;
  if (workedHours < ABSENT_HOURS) status = 'absent';
  else if (workedHours < HALF_DAY_HOURS) status = 'half_day';
  else if (late) status = 'late';
  else status = 'present';

  return { status, workedMinutes, breakMinutes };
}

/**
 * Status at the moment of check-IN. No worked hours yet — only Late vs Present.
 */
export function computeCheckInStatus(checkInAt: string): AttendanceStatus {
  const late = compareHHMM(istTimeOf(checkInAt), LATE_AFTER) > 0;
  return late ? 'late' : 'present';
}
