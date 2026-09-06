/**
 * Back-dated attendance seed — 30 days of realistic variance for a few
 * employees. Uses a seeded RNG so runs are stable and tests non-flaky.
 *
 * Rules honoured:
 *   - (employee_id, date) unique (skip weekends + 2nd/4th Sat)
 *   - Timestamps stored UTC; dates derived via istDateOf
 *   - IST office hours: check-in ~09:15–09:55, check-out ~18:00–19:00
 */

import type { Attendance, AttendanceStatus, LocationType } from '@/data/models';
import { addDays, istDateOf, istToday } from '@/lib/dates';
import { computeCheckOutStatus } from '@/lib/attendanceStatus';
import { mulberry32 } from '@/lib/rng';
import { employees } from './index';

const rand = mulberry32(20260906);
const HQ_ID = 'wl-hq';
const HQ_LAT = 13.0827;
const HQ_LON = 80.2707;

function auditable(createdBy: string | null = null) {
  const now = new Date().toISOString();
  return {
    created_at: now,
    updated_at: now,
    created_by: createdBy,
    updated_by: createdBy,
    deleted_at: null,
  };
}

/** IST HH:mm → UTC ISO string for a given IST date. */
function istToUTC(dateISO: string, hh: number, mm: number): string {
  // IST is UTC+05:30 — subtract to get UTC.
  const [y, m, d] = dateISO.split('-').map(Number);
  const utc = new Date(Date.UTC(y, m - 1, d, hh, mm) - 330 * 60_000);
  return utc.toISOString();
}

/** True for Mon..Fri; false for Sat/Sun. Skips 2nd + 4th Saturday off. */
function isWorkingDay(dateISO: string): boolean {
  const [y, m, d] = dateISO.split('-').map(Number);
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Sun
  if (day === 0) return false;
  if (day === 6) {
    // Saturday — 2nd/4th are off
    const nth = Math.ceil(d / 7);
    return !(nth === 2 || nth === 4);
  }
  return true;
}

function pickLocation(r: number): { type: LocationType; reason: string | null } {
  if (r < 0.75) return { type: 'office', reason: null };
  if (r < 0.9)
    return { type: 'client_site', reason: 'Field audit at client premises' };
  if (r < 0.97) return { type: 'remote', reason: 'Work from home' };
  return { type: 'field', reason: 'Statutory filing at Registrar office' };
}

export function buildAttendanceSeed(): Attendance[] {
  const rows: Attendance[] = [];
  const today = istToday();

  // Seed attendance for these three: MD, Manager, Employee. Skip HR/Fin so the
  // records table can also demonstrate "no data" for a subset when scoped.
  const targets = employees.filter((e) =>
    ['emp-md', 'emp-mgr', 'emp-exec'].includes(e.id),
  );

  for (let offset = 30; offset >= 1; offset--) {
    const dateISO = addDays(today, -offset);
    if (!isWorkingDay(dateISO)) continue;

    for (const emp of targets) {
      const r = rand();

      // 4% absent (missing check-in row)
      if (r < 0.04) {
        rows.push({
          id: `att-${emp.id}-${dateISO}`,
          employee_id: emp.id,
          date: dateISO,
          check_in_at: null,
          check_out_at: null,
          check_in_lat: null,
          check_in_long: null,
          check_in_accuracy_m: null,
          check_out_lat: null,
          check_out_long: null,
          check_out_accuracy_m: null,
          check_in_location_id: null,
          check_out_location_id: null,
          location_type: null,
          off_site_reason: null,
          worked_minutes: null,
          break_minutes: null,
          status: 'absent' as AttendanceStatus,
          source: 'manual',
          correction_status: 'none',
          device: null,
          ip: null,
          client_id: null,
          ...auditable(),
        });
        continue;
      }

      // Time-of-arrival: mostly on-time, 20% late-ish, 5% very late.
      const arrivalRoll = rand();
      const checkInMin =
        arrivalRoll < 0.75
          ? 555 + Math.floor(rand() * 25) // 09:15–09:39
          : arrivalRoll < 0.95
            ? 590 + Math.floor(rand() * 20) // 09:50–10:09 (Late)
            : 615 + Math.floor(rand() * 45); // 10:15–10:59 (very Late)
      const checkInHH = Math.floor(checkInMin / 60);
      const checkInMM = checkInMin % 60;

      // 3% missing check-out
      if (rand() < 0.03) {
        const checkInAt = istToUTC(dateISO, checkInHH, checkInMM);
        rows.push({
          id: `att-${emp.id}-${dateISO}`,
          employee_id: emp.id,
          date: dateISO,
          check_in_at: checkInAt,
          check_out_at: null,
          check_in_lat: HQ_LAT,
          check_in_long: HQ_LON,
          check_in_accuracy_m: 30,
          check_out_lat: null,
          check_out_long: null,
          check_out_accuracy_m: null,
          check_in_location_id: HQ_ID,
          check_out_location_id: null,
          location_type: 'office',
          off_site_reason: null,
          worked_minutes: null,
          break_minutes: null,
          status: 'missing_check_out',
          source: 'web_geo',
          correction_status: 'none',
          device: null,
          ip: null,
          client_id: null,
          ...auditable(),
        });
        continue;
      }

      // Normal day — check-in and check-out with realistic worked minutes.
      const checkOutMin = 1080 + Math.floor(rand() * 60); // 18:00–18:59
      const checkOutHH = Math.floor(checkOutMin / 60);
      const checkOutMM = checkOutMin % 60;
      const checkInAt = istToUTC(dateISO, checkInHH, checkInMM);
      const checkOutAt = istToUTC(dateISO, checkOutHH, checkOutMM);
      const { status, workedMinutes, breakMinutes } = computeCheckOutStatus(
        checkInAt,
        checkOutAt,
      );

      const loc = pickLocation(rand());
      const onSite = loc.type === 'office';

      rows.push({
        id: `att-${emp.id}-${dateISO}`,
        employee_id: emp.id,
        date: dateISO,
        check_in_at: checkInAt,
        check_out_at: checkOutAt,
        check_in_lat: onSite ? HQ_LAT : HQ_LAT + (rand() - 0.5) * 0.05,
        check_in_long: onSite ? HQ_LON : HQ_LON + (rand() - 0.5) * 0.05,
        check_in_accuracy_m: 30,
        check_out_lat: onSite ? HQ_LAT : HQ_LAT + (rand() - 0.5) * 0.05,
        check_out_long: onSite ? HQ_LON : HQ_LON + (rand() - 0.5) * 0.05,
        check_out_accuracy_m: 30,
        check_in_location_id: onSite ? HQ_ID : null,
        check_out_location_id: onSite ? HQ_ID : null,
        location_type: loc.type,
        off_site_reason: loc.reason,
        worked_minutes: workedMinutes,
        break_minutes: breakMinutes,
        status: loc.type === 'remote' ? 'wfh' : status,
        source: 'web_geo',
        correction_status: 'none',
        device: null,
        ip: null,
        client_id: null,
        ...auditable(),
      });
    }
  }

  // Sanity check — unique (employee_id, date)
  const seen = new Set<string>();
  for (const r of rows) {
    const key = `${r.employee_id}|${r.date}`;
    if (seen.has(key))
      throw new Error(`seed produced duplicate attendance for ${key}`);
    seen.add(key);
  }
  // Deterministic order — makes verify runs stable across the list handler.
  rows.sort((a, b) =>
    a.date === b.date
      ? a.employee_id.localeCompare(b.employee_id)
      : a.date.localeCompare(b.date),
  );
  return rows;
}

// Guarantee that istDateOf(...) usage doesn't shake off the seeded date.
export const _sanity = { istDateOf };
