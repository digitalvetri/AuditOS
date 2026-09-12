/**
 * TDS config rows.
 *
 * Spec §4 rule: "All due dates and thresholds are CONFIG ROWS. Zero date
 * literals in component code." This file is that config. It will move to
 * server-side effective-dated rows when the backend engine lands; for now
 * the shape is the same, the values live here, and components only read
 * them through the helpers exported below.
 *
 * Every date rule is marked [VERIFY] where the spec flagged it.
 */

export interface ChallanDueRule {
  /** Zero-based month index of the deduction month */
  deductionMonth: number;
  /** Day of the following month by which the challan is due. */
  dueDayOfNextMonth: number;
  /** Optional note when the rule differs from the default (e.g. March). */
  note?: string;
}

export const CHALLAN_DUE_DAY_DEFAULT = 7; // [VERIFY]

/** March deductions have a different deadline. [VERIFY current rule] */
export const CHALLAN_DUE_RULES: ChallanDueRule[] = [
  { deductionMonth: 2 /* March */, dueDayOfNextMonth: 30, note: 'March differs — 30th of April [VERIFY]' },
];

export interface QuarterlyReturnDue {
  quarter: 'Q1' | 'Q2' | 'Q3' | 'Q4';
  /** Month of the FY that ends the quarter (calendar month, 0-based). */
  endMonth: number;
  /** Day of the month AFTER the quarter end by which the return is due. */
  dueDayOfNextQuarter: number;
  /** How many months after quarter end. */
  monthsAfterEnd: number;
}

/** Quarterly return dues (24Q / 26Q / 27Q / 27EQ). [VERIFY]. */
export const QUARTERLY_RETURN_DUE: QuarterlyReturnDue[] = [
  { quarter: 'Q1', endMonth: 5,  monthsAfterEnd: 1, dueDayOfNextQuarter: 31 }, // Jun end → Jul 31
  { quarter: 'Q2', endMonth: 8,  monthsAfterEnd: 1, dueDayOfNextQuarter: 31 }, // Sep end → Oct 31
  { quarter: 'Q3', endMonth: 11, monthsAfterEnd: 1, dueDayOfNextQuarter: 31 }, // Dec end → Jan 31
  { quarter: 'Q4', endMonth: 2,  monthsAfterEnd: 2, dueDayOfNextQuarter: 31 }, // Mar end → May 31
];

/** Form 16A quarterly, after the return is processed. [VERIFY]. */
export const FORM_16A_DUE_DAYS_AFTER_QUARTER_END = 45;

/** Form 16 annually, after Q4. [VERIFY]. */
export const FORM_16_DUE_DAY = 15;
export const FORM_16_DUE_MONTH = 5; // June, 0-based

/** Weekly notice check cadence — the "walk the list once a week" rule. */
export const NOTICE_CHECK_INTERVAL_DAYS = 7;

/** Registration allotment window — how long the firm should expect to wait
 *  before the TAN is issued after Form 49B is filed. [VERIFY]. */
export const REGISTRATION_ALLOTMENT_DAYS = 15;

/** Form 49B portal character limits — over-length triggers a warn (not
 *  silent truncation) per spec §3.1. [VERIFY current portal limits]. */
export const FORM_49B_LIMITS = {
  responsiblePersonName: 75,
  flatDoorBlockNo: 25,
  buildingName: 25,
  roadStreet: 50,
  areaLocality: 25,
  cityDistrict: 25,
  pinCode: 6,
} as const;

/** TAN format: 4 letters, 5 digits, 1 letter — e.g. CHEK09876B. */
export const TAN_PATTERN = /^[A-Z]{4}[0-9]{5}[A-Z]$/;

/** Registration acknowledgement is a 14-digit number. */
export const REG_ACK_PATTERN = /^[0-9]{14}$/;

/**
 * India financial year runs Apr–Mar. Given a date, return the FY it falls
 * in as "YYYY-YY" (e.g. "2026-27" for April 2026 – March 2027).
 */
export function fyLabelForDate(d: Date): string {
  const m = d.getMonth();
  const startYear = m >= 3 ? d.getFullYear() : d.getFullYear() - 1;
  const endYear = (startYear + 1) % 100;
  return `${startYear}-${String(endYear).padStart(2, '0')}`;
}

/** All FY labels from onboarding cutoff to next year, most-recent first. */
export function fyRange(startYear = 2020, extraFuture = 1): string[] {
  const now = new Date();
  const currentStart = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  const end = currentStart + extraFuture;
  const labels: string[] = [];
  for (let y = end; y >= startYear; y--) {
    const to = (y + 1) % 100;
    labels.push(`${y}-${String(to).padStart(2, '0')}`);
  }
  return labels;
}

/** Given an FY label like "2026-27", return the quarter that the given date
 *  falls in — or null if the date isn't inside that FY. */
export function quarterForDateInFy(d: Date, fyLabel: string): 'Q1' | 'Q2' | 'Q3' | 'Q4' | null {
  const parts = fyLabel.split('-');
  const fyStart = Number(parts[0]);
  const start = new Date(fyStart, 3, 1);            // Apr 1
  const end = new Date(fyStart + 1, 2, 31, 23, 59); // Mar 31
  if (d < start || d > end) return null;
  const m = d.getMonth();
  if (m >= 3 && m <= 5) return 'Q1';
  if (m >= 6 && m <= 8) return 'Q2';
  if (m >= 9 && m <= 11) return 'Q3';
  return 'Q4';
}

/** Return the human-readable due date for a given quarterly return under
 *  the given FY. */
export function returnDueLabel(quarter: 'Q1' | 'Q2' | 'Q3' | 'Q4', fyLabel: string): string {
  const rule = QUARTERLY_RETURN_DUE.find((r) => r.quarter === quarter);
  if (!rule) return '—';
  const fyStart = Number(fyLabel.split('-')[0]);
  const qEndYear = quarter === 'Q4' ? fyStart + 1 : fyStart;
  const dueMonth = rule.endMonth + rule.monthsAfterEnd;
  const dueYear = qEndYear + Math.floor(dueMonth / 12);
  const monthName = new Date(dueYear, dueMonth % 12, rule.dueDayOfNextQuarter)
    .toLocaleString('en-IN', { month: 'short' });
  return `${rule.dueDayOfNextQuarter} ${monthName} ${dueYear}`;
}

/** Return the human-readable challan due for a given deduction month + year. */
export function challanDueLabel(deductionMonth: number, year: number): string {
  const rule = CHALLAN_DUE_RULES.find((r) => r.deductionMonth === deductionMonth);
  const day = rule?.dueDayOfNextMonth ?? CHALLAN_DUE_DAY_DEFAULT;
  const dueMonth = deductionMonth === 2 ? 3 : deductionMonth + 1;
  const dueYear = deductionMonth === 11 ? year + 1 : year;
  const monthName = new Date(dueYear, dueMonth, day).toLocaleString('en-IN', { month: 'short' });
  return `${day} ${monthName} ${dueYear}`;
}
