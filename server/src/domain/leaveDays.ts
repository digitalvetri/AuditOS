/**
 * Working-days computation with the §3 sandwich rule.
 *
 * A holiday or weekly off counts as leave only when it sits BETWEEN two
 * working days that are themselves inside the requested range. Off days that
 * bookend the range do not count.
 *
 * Server-authoritative: the client may preview a number, but this function
 * decides what is stored.
 */
import { enumerateDates } from '../lib/dates.js'

export interface ScheduleShape {
  workingDays: number[] // ISO weekday numbers 1..7
  alternateSaturdayOff: boolean
}

export interface WorkingDaysInput {
  startISO: string
  endISO: string
  halfDay: boolean
  schedule: ScheduleShape
  holidayDates: Set<string>
}

function isoWeekday(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number)
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay() // 0=Sun
  return day === 0 ? 7 : day
}

function nthOfMonth(iso: string): number {
  return Math.ceil(Number(iso.split('-')[2]) / 7)
}

export function isWorkingDay(iso: string, schedule: ScheduleShape, holidayDates: Set<string>): boolean {
  const wd = isoWeekday(iso)
  let working = schedule.workingDays.includes(wd)
  if (working && wd === 6 && schedule.alternateSaturdayOff) {
    const n = nthOfMonth(iso)
    if (n === 2 || n === 4) working = false
  }
  if (working && holidayDates.has(iso)) working = false
  return working
}

/** Returns NaN for an invalid half-day request (multi-day range). */
export function computeWorkingDays(input: WorkingDaysInput): number {
  const { startISO, endISO, halfDay, schedule, holidayDates } = input
  const dates = enumerateDates(startISO, endISO)
  if (dates.length === 0) return 0

  const cls = dates.map((iso) => ({ iso, isWorking: isWorkingDay(iso, schedule, holidayDates) }))

  if (halfDay) {
    if (dates.length !== 1) return NaN
    return cls[0].isWorking ? 0.5 : 0
  }

  const workingIdx = cls.map((c, i) => (c.isWorking ? i : -1)).filter((i) => i >= 0)
  if (workingIdx.length === 0) return 0

  let total = workingIdx.length
  const first = workingIdx[0]
  const last = workingIdx[workingIdx.length - 1]
  for (let i = 0; i < cls.length; i++) {
    if (cls[i].isWorking) continue
    if (i > first && i < last) total += 1
  }
  return total
}
