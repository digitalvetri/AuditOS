/**
 * Working-days computation with the §3 "sandwich rule".
 *
 *   A holiday or weekly off is counted as leave ONLY when it falls between
 *   two approved leave days with NO working day in between. A holiday
 *   adjacent to a leave block is not counted.
 *
 * Algorithm (server-authoritative; UI reuses the same fn for the preview):
 *   1. Enumerate calendar dates in [start..end].
 *   2. Classify each: working | off (weekend / holiday).
 *   3. For each `off` day, count it iff BOTH:
 *        - the preceding contiguous run of (off | working-inside-request)
 *          leads back to a working-inside-request day
 *        - AND the following contiguous run does the same forward.
 *      Runs of only `off` days at either end of the range don't count.
 *
 * Half-day = 0.5 (only when the type allows and the request is single-day).
 *
 * Truth table (single 5-day work week Mon–Fri, no other holidays):
 *   Mon..Fri                          → 5.0
 *   Fri..Mon                          → 2.0   (Sat/Sun bookend, not sandwiched)
 *   Mon..Wed with Tue = holiday       → 3.0   (Tue is between two working
 *                                              days IN the request)
 *   Mon + Fri (Wed = holiday)         → covered by two separate requests;
 *                                              this fn only sees one range
 *   Mon..Mon (single day, half-day)   → 0.5
 *   Sat (weekend)                     → 0.0
 *   Fri..Mon with Fri=holiday+Mon=off → 0.0   (only off days present)
 */

import type { Holiday, WorkSchedule } from '@/data/models';

export interface WorkingDaysInput {
  startISO: string; // 'YYYY-MM-DD'
  endISO: string; // 'YYYY-MM-DD'
  halfDay: boolean;
  schedule: WorkSchedule;
  holidays: Holiday[];
}

interface DayClassification {
  iso: string;
  isWorking: boolean; // per WorkSchedule + holiday check
}

/** ISO weekday: 1..7 where 1=Mon, 7=Sun. */
function isoWeekday(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Sun..6=Sat
  return day === 0 ? 7 : day;
}

function nthOfMonth(iso: string): number {
  const [, , d] = iso.split('-').map(Number);
  return Math.ceil(d / 7);
}

function enumerateDates(startISO: string, endISO: string): string[] {
  const out: string[] = [];
  const [sy, sm, sd] = startISO.split('-').map(Number);
  const [ey, em, ed] = endISO.split('-').map(Number);
  const cur = new Date(Date.UTC(sy, sm - 1, sd));
  const end = new Date(Date.UTC(ey, em - 1, ed));
  while (cur.getTime() <= end.getTime()) {
    const y = cur.getUTCFullYear();
    const m = String(cur.getUTCMonth() + 1).padStart(2, '0');
    const d = String(cur.getUTCDate()).padStart(2, '0');
    out.push(`${y}-${m}-${d}`);
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

function classify(dates: string[], schedule: WorkSchedule, holidays: Holiday[]): DayClassification[] {
  const holidaySet = new Set(holidays.map((h) => h.date));
  return dates.map((iso) => {
    const wd = isoWeekday(iso);
    const inSchedule = schedule.working_days.includes(wd);
    // Standard: Sat is working unless alternate_saturday_off + 2nd/4th Sat.
    let working = inSchedule;
    if (working && wd === 6 && schedule.alternate_saturday_off) {
      const n = nthOfMonth(iso);
      if (n === 2 || n === 4) working = false;
    }
    if (working && holidaySet.has(iso)) working = false;
    return { iso, isWorking: working };
  });
}

/**
 * Working days in [start..end] the sandwich rule counts as leave.
 * Non-working days sandwiched between working-inside-range days count.
 */
export function computeWorkingDays(input: WorkingDaysInput): number {
  const { startISO, endISO, halfDay, schedule, holidays } = input;
  const dates = enumerateDates(startISO, endISO);
  if (dates.length === 0) return 0;

  const cls = classify(dates, schedule, holidays);

  // Half-day only permitted for a single-day request. Enforce here so callers
  // don't get "0.5 across 5 days" by accident.
  if (halfDay) {
    if (dates.length !== 1) return NaN;
    return cls[0].isWorking ? 0.5 : 0;
  }

  // Working days always count.
  let total = 0;
  const idxOfWorking = cls
    .map((c, i) => (c.isWorking ? i : -1))
    .filter((i) => i >= 0);
  if (idxOfWorking.length === 0) return 0;

  for (const c of cls) if (c.isWorking) total += 1;

  // Sandwich rule: off day counts iff there's a working day at some earlier
  // position AND some later position, within the range.
  const firstWorking = idxOfWorking[0];
  const lastWorking = idxOfWorking[idxOfWorking.length - 1];
  for (let i = 0; i < cls.length; i++) {
    if (cls[i].isWorking) continue;
    if (i > firstWorking && i < lastWorking) total += 1;
  }

  return total;
}
