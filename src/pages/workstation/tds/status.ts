/**
 * TDS status engine — derives what is due from the statutory calendar and
 * what the firm has recorded (TdsRecord rows). Replaces the old hash-based
 * placeholders. Pure functions; `today` is injectable for tests.
 *
 * Calendar (config.ts, marked [VERIFY] there):
 *   challan      7th of next month; March deductions → 30 April
 *   return       Q1 31 Jul · Q2 31 Oct · Q3 31 Jan · Q4 31 May
 *   Form 16A/27D 15 days after that quarter's return due date
 *   Form 16      15 June after the FY (needs Q4 24Q filed)
 *   notices      checked at least every NOTICE_CHECK_INTERVAL_DAYS
 */
import type { TdsData, TdsRecord } from '@/modules/tds/api';
import { NOTICE_CHECK_INTERVAL_DAYS } from './config';

export type SubServiceStatusKey =
  | 'not_registered' | 'applied' | 'active' | 'due' | 'overdue' | 'in_progress'
  | 'filed' | 'unpaid' | 'paid' | 'issued' | 'pending' | 'not_applicable';

export interface SubServiceStatus {
  key: SubServiceStatusKey;
  label: string;
  detail?: string;
  greyed?: boolean;
  greyedReason?: string;
}

export type Quarter = 'Q1' | 'Q2' | 'Q3' | 'Q4';
export const QUARTERS: Quarter[] = ['Q1', 'Q2', 'Q3', 'Q4'];

/** One thing that should exist for the FY — a month's challan, a quarter's return, a certificate. */
export interface ExpectedItem {
  kind: 'challan' | 'return' | 'certificate';
  period: string;
  formType: string | null;
  label: string;
  due: string;                 // YYYY-MM-DD
  record: TdsRecord | null;
  state: 'done' | 'in_progress' | 'due' | 'overdue';
  fy: string;
}

const pad = (n: number) => String(n).padStart(2, '0');
const iso = (y: number, m0: number, d: number) => {
  const dt = new Date(y, m0, d);
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
};
export const todayIso = (d = new Date()) => iso(d.getFullYear(), d.getMonth(), d.getDate());
export const fmtDate = (s: string) =>
  new Date(`${s}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
const fyStart = (fy: string) => Number(fy.split('-')[0]);

/** Deduction months of the FY, 'YYYY-MM', Apr → Mar. */
export function fyMonths(fy: string): string[] {
  const y = fyStart(fy);
  return Array.from({ length: 12 }, (_, i) => {
    const m0 = (3 + i) % 12;
    return `${m0 < 3 ? y + 1 : y}-${pad(m0 + 1)}`;
  });
}
export function monthLabel(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' });
}
export function challanDue(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  return m === 3 ? iso(y, 3, 30) : iso(y, m, 7); // m is 1-based → m = next month's 0-based index
}
const monthEnd = (ym: string) => { const [y, m] = ym.split('-').map(Number); return iso(y, m, 0); };

const Q_END: Record<Quarter, [number, number]> = { Q1: [0, 5], Q2: [0, 8], Q3: [0, 11], Q4: [1, 2] }; // [yearOffset, month0]
export function quarterEnd(q: Quarter, fy: string): string {
  const [off, m0] = Q_END[q];
  return iso(fyStart(fy) + off, m0 + 1, 0);
}
export function returnDue(q: Quarter, fy: string): string {
  const y = fyStart(fy);
  return { Q1: iso(y, 6, 31), Q2: iso(y, 9, 31), Q3: iso(y + 1, 0, 31), Q4: iso(y + 1, 4, 31) }[q];
}
export function certificateDue(period: string, fy: string): string {
  if (period === 'FY') return iso(fyStart(fy) + 1, 5, 15);
  const r = returnDue(period as Quarter, fy);
  const d = new Date(`${r}T00:00:00`);
  return iso(d.getFullYear(), d.getMonth(), d.getDate() + 15);
}

function stateOf(record: TdsRecord | null, due: string, today: string): ExpectedItem['state'] {
  if (record?.status === 'done') return 'done';
  if (record?.status === 'in_progress') return 'in_progress';
  return today > due ? 'overdue' : 'due';
}

const find = (rs: TdsRecord[], kind: string, fy: string, period: string, form: string | null) =>
  rs.find((r) => r.kind === kind && r.fy === fy && r.period === period && (r.form_type ?? null) === form) ?? null;

/** Challans for every deduction month that has ended (or already has a record). */
export function expectedChallans(data: TdsData, fy: string, today = todayIso()): ExpectedItem[] {
  return fyMonths(fy)
    .map((ym) => {
      const record = find(data.records, 'challan', fy, ym, null);
      if (!record && monthEnd(ym) >= today) return null;
      const due = challanDue(ym);
      return { kind: 'challan', period: ym, formType: null, label: monthLabel(ym), due, record, state: stateOf(record, due, today), fy } as ExpectedItem;
    })
    .filter((x): x is ExpectedItem => !!x);
}

/** Every (form × quarter) return whose quarter has ended (or already has a record). */
export function expectedReturns(data: TdsData, fy: string, today = todayIso()): ExpectedItem[] {
  const out: ExpectedItem[] = [];
  for (const form of data.profile.return_forms) {
    for (const q of QUARTERS) {
      const record = find(data.records, 'return', fy, q, form);
      if (!record && quarterEnd(q, fy) >= today) continue;
      const due = returnDue(q, fy);
      out.push({ kind: 'return', period: q, formType: form, label: `${form} · ${q}`, due, record, state: stateOf(record, due, today), fy });
    }
  }
  return out;
}

/** Certificates owed for filed returns: 26Q/27Q → 16A, 27EQ → 27D (quarterly), 24Q Q4 → Form 16 (annual). */
export function expectedCertificates(data: TdsData, fy: string, today = todayIso()): ExpectedItem[] {
  const out: ExpectedItem[] = [];
  const filed = data.records.filter((r) => r.kind === 'return' && r.fy === fy && r.status === 'done');
  for (const r of filed) {
    const form = r.form_type === '24Q' ? (r.period === 'Q4' ? '16' : null) : r.form_type === '27EQ' ? '27D' : '16A';
    if (!form) continue;
    const period = form === '16' ? 'FY' : r.period!;
    const record = find(data.records, 'certificate', fy, period, form);
    const due = certificateDue(period, fy);
    const label = form === '16' ? `Form 16 · FY ${fy}` : `Form ${form} · ${period} (${r.form_type})`;
    out.push({ kind: 'certificate', period, formType: form, label, due, record, state: stateOf(record, due, today), fy });
  }
  return out;
}

export function lastNoticeCheck(data: TdsData): string | null {
  return data.records.filter((r) => r.kind === 'notice_check' && r.event_date)
    .map((r) => r.event_date!).sort().at(-1) ?? null;
}

function rollup(items: ExpectedItem[], doneKey: SubServiceStatusKey, doneLabel: string, emptyLabel: string): SubServiceStatus {
  if (items.length === 0) return { key: 'active', label: emptyLabel };
  const overdue = items.filter((i) => i.state === 'overdue');
  if (overdue.length) {
    return { key: 'overdue', label: overdue.length === 1 ? `${overdue[0].label} overdue` : `${overdue.length} overdue`, detail: `oldest due ${fmtDate(overdue[0].due)}` };
  }
  const wip = items.filter((i) => i.state === 'in_progress');
  if (wip.length) return { key: 'in_progress', label: `${wip[0].label} in progress` };
  const due = items.filter((i) => i.state === 'due');
  if (due.length) return { key: 'due', label: `${due[0].label} due`, detail: `by ${fmtDate(due[0].due)}` };
  return { key: doneKey, label: doneLabel };
}

const noTan: SubServiceStatus = { key: 'not_applicable', label: '—', greyed: true, greyedReason: 'No TAN — record it under TDS Registration' };

export function registrationStatus(data: TdsData): SubServiceStatus {
  if (data.active_tan) return { key: 'active', label: `TAN ${data.active_tan}`, detail: 'Registered' };
  const reg = data.records.find((r) => r.kind === 'registration' && r.status === 'done');
  if (reg) return { key: 'applied', label: 'Applied · awaiting allotment', detail: reg.reference ? `Ack ${reg.reference}` : undefined };
  return { key: 'not_registered', label: 'Not registered', detail: 'Apply Form 49B on Protean TIN' };
}

export function challanStatus(data: TdsData, fy: string, today = todayIso()): SubServiceStatus {
  if (!data.active_tan) return noTan;
  const s = rollup(expectedChallans(data, fy, today), 'paid', 'All months paid', 'No month closed yet');
  return s.key === 'due' ? { ...s, key: 'unpaid' } : s;
}

export function returnFilingStatus(data: TdsData, fy: string, today = todayIso()): SubServiceStatus {
  if (!data.active_tan) return noTan;
  return rollup(expectedReturns(data, fy, today), 'filed', 'All quarters filed', 'No quarter closed yet');
}

export function correctionStatus(data: TdsData): SubServiceStatus {
  if (!data.active_tan) return noTan;
  if (!data.any_filed_return) {
    return { key: 'not_applicable', label: '—', greyed: true, greyedReason: 'No filed return to correct yet' };
  }
  const open = data.records.filter((r) => r.kind === 'correction' && r.status !== 'done').length;
  return open ? { key: 'in_progress', label: `${open} open correction${open > 1 ? 's' : ''}` } : { key: 'active', label: 'No open corrections' };
}

export function form16Status(data: TdsData, fy: string, today = todayIso()): SubServiceStatus {
  if (!data.active_tan) return noTan;
  if (!data.any_filed_return) {
    return { key: 'not_applicable', label: '—', greyed: true, greyedReason: 'Needs a filed return first (TRACES)' };
  }
  const s = rollup(expectedCertificates(data, fy, today), 'issued', 'All certificates issued', 'Nothing to issue this FY yet');
  return s.key === 'due' ? { ...s, key: 'pending' } : s;
}

export function noticesStatus(data: TdsData, today = todayIso()): SubServiceStatus {
  if (!data.active_tan) return noTan;
  const open = data.records.filter((r) => r.kind === 'notice' && r.status !== 'done').length;
  const last = lastNoticeCheck(data);
  const stale = !last || (new Date(`${today}T00:00:00`).getTime() - new Date(`${last}T00:00:00`).getTime()) / 86_400_000 > NOTICE_CHECK_INTERVAL_DAYS;
  const checked = last ? `last checked ${fmtDate(last)}` : 'never checked';
  if (open) return { key: 'overdue', label: `${open} open default${open > 1 ? 's' : ''}`, detail: checked };
  if (stale) return { key: 'due', label: 'Check due', detail: checked };
  return { key: 'active', label: checked };
}

// ── Interest & late fee (computed guidance — the firm still enters what it paid) ──

const monthIndex = (isoDate: string) => { const [y, m] = isoDate.split('-').map(Number); return y * 12 + (m - 1); };
const rupees = (n: number) => Math.ceil(n);

/**
 * Interest u/s 201(1A)(ii) on a late challan: 1.5% per month or part of a
 * month, from the date of deduction to the date of deposit. The record
 * keeps the deduction MONTH, not the day, so this assumes deduction on the
 * 1st — the maximum; exact interest needs the actual deduction dates.
 * Null when the challan was on time or there is nothing to compute.
 */
export function challanInterest(r: TdsRecord): { amount: number; months: number } | null {
  if (r.kind !== 'challan' || !r.period || !r.event_date || !r.amount_tax) return null;
  if (r.event_date <= challanDue(r.period)) return null;
  const months = monthIndex(r.event_date) - monthIndex(`${r.period}-01`) + 1;
  return { months, amount: rupees(r.amount_tax * 0.015 * months) };
}

/** Challan TDS deposited for the months of one quarter — the 234E cap. */
export function quarterTds(data: TdsData, fy: string, q: Quarter): number {
  const qMonths = fyMonths(fy).slice(QUARTERS.indexOf(q) * 3, QUARTERS.indexOf(q) * 3 + 3);
  return data.records
    .filter((r) => r.kind === 'challan' && r.fy === fy && qMonths.includes(r.period ?? ''))
    .reduce((sum, r) => sum + (r.amount_tax ?? 0), 0);
}

/**
 * Late filing fee u/s 234E: ₹200 per day from the day after the due date
 * until filing (or today, if still unfiled), capped at the TDS for the
 * quarter. The cap uses challans recorded for the quarter's months.
 */
export function lateFee234E(data: TdsData, item: ExpectedItem, today = todayIso()):
  { amount: number; days: number; capped: boolean } | null {
  if (item.kind !== 'return') return null;
  const end = item.record?.status === 'done' && item.record.event_date ? item.record.event_date : today;
  const days = Math.round((new Date(`${end}T00:00:00`).getTime() - new Date(`${item.due}T00:00:00`).getTime()) / 86_400_000);
  if (days <= 0) return null;
  const cap = quarterTds(data, item.fy, item.period as Quarter);
  const raw = days * 200;
  // No challans recorded → no cap is knowable; show the uncapped figure.
  return cap > 0 && raw > cap ? { amount: cap, days, capped: true } : { amount: raw, days, capped: false };
}
