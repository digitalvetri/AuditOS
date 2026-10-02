/**
 * Pure derivations behind the home dashboard: filing progress, deadlines and
 * the morning-brief insights. Everything here is computed from API payloads
 * the page already fetched — no invented figures.
 *
 * GST source: the return-case store (`/api/gst/client-dashboard`), the same
 * one the GST pages show, so the dashboard and those pages never disagree.
 * The returns being filed this month are the PREVIOUS month's period (e.g.
 * September's GSTR-1/3B fall due in October), so that is the period we read.
 */
import type { ClientDashboardResponse, ClientDashboardCell } from '@/modules/workstation/gst/api';
import type { TdsOverview } from '@/modules/tds/api';
import type { SummaryResponse } from '@/modules/paymentSummary/api';

/** 'YYYY-MM-DD' for today in IST, whatever the browser's timezone. */
export function istToday(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(now);
}

export function addDaysISO(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 'YYYY-MM' of the month before `iso`. */
export function previousPeriod(iso: string): string {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

export function periodName(period: string): string {
  const [y, m] = period.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-IN', { month: 'long', timeZone: 'UTC' });
}

// ── GST ────────────────────────────────────────────────────────────────────

export type ReturnKind = 'GSTR-1' | 'GSTR-3B';
export interface ReturnCell extends ClientDashboardCell { kind: ReturnKind; client_id: string; client: string }

/**
 * The returns the firm files for the period: GSTR-1 and GSTR-3B per client.
 * GSTR-2B is a statement the portal generates, not a return we file, so it
 * is left out of every count.
 */
export function returnCells(d: ClientDashboardResponse | undefined): ReturnCell[] {
  if (!d) return [];
  return d.clients.flatMap((c) => [
    c.gstr1 ? { ...c.gstr1, kind: 'GSTR-1' as const, client_id: c.client_id, client: c.name } : null,
    c.gstr3b ? { ...c.gstr3b, kind: 'GSTR-3B' as const, client_id: c.client_id, client: c.name } : null,
  ].filter((x): x is ReturnCell => x !== null));
}

export interface FilingStats { total: number; filed: number; inProgress: number; atRisk: number; progress: number }

/** filed = case completed; at risk = past its due date and not completed; the rest are in progress. */
export function filingStats(cells: ReturnCell[]): FilingStats {
  const filed = cells.filter((c) => c.state === 'done').length;
  const atRisk = cells.filter((c) => c.state === 'overdue').length;
  const total = cells.length;
  return { total, filed, atRisk, inProgress: total - filed - atRisk, progress: total ? filed / total : 0 };
}

// ── Deadlines ──────────────────────────────────────────────────────────────

export interface Deadline {
  key: string;
  date: string;
  title: string;
  tag: 'GST' | 'TDS';
  done: number;
  total: number;
  href: string;
}

/**
 * Upcoming and overdue deadlines, grouped by (return, due date):
 *   GST — every GSTR-1/3B cell for the period, done vs total per due date.
 *   TDS — open items (challans, returns, certificates) per label and due date;
 *         the board only lists what is still open, so `done` is 0.
 */
export function deadlines(cells: ReturnCell[], period: string, tds: TdsOverview | undefined, today: string, horizonDays = 30): Deadline[] {
  const until = addDaysISO(today, horizonDays);
  const groups = new Map<string, Deadline>();

  for (const c of cells) {
    if (!c.due_date) continue;
    const key = `gst-${c.kind}-${c.due_date}`;
    const g = groups.get(key) ?? {
      key, date: c.due_date, tag: 'GST' as const, done: 0, total: 0,
      title: `${c.kind} · ${periodName(period)}`,
      href: '/workstation/services/registration/gst/dashboard',
    };
    g.total += 1;
    if (c.state === 'done') g.done += 1;
    groups.set(key, g);
  }

  for (const row of tds?.rows ?? []) {
    for (const item of row.open_items) {
      const key = `tds-${item.label}-${item.due}`;
      const g = groups.get(key) ?? {
        key, date: item.due, tag: 'TDS' as const, done: 0, total: 0, title: item.label,
        href: '/workstation/services/tds',
      };
      g.total += 1;
      groups.set(key, g);
    }
  }

  return [...groups.values()]
    // Overdue groups that are not finished stay on the list; finished or far-off ones drop.
    .filter((g) => g.done < g.total && g.date <= until)
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** How many open items fall due within `days` days from today (inclusive), overdue excluded. */
export function dueWithin(list: Deadline[], today: string, days: number): number {
  const until = addDaysISO(today, days);
  return list.filter((d) => d.date >= today && d.date <= until).reduce((s, d) => s + (d.total - d.done), 0);
}

// ── Insights (morning brief) ───────────────────────────────────────────────

export type InsightTone = 'danger' | 'warning' | 'success' | 'info';
export interface Insight { key: string; tone: InsightTone; title: string; detail: string; cta: string; href: string }

export function buildInsights(input: {
  money?: SummaryResponse;
  gst?: { stats: FilingStats; period: string };
  tds?: TdsOverview;
  dueSoon?: { count: number; firstDate: string | null };
  pendingCount?: number;
  absent?: number;
  formatMoney: (paise: number) => string;
  formatDay: (iso: string) => string;
}): Insight[] {
  const out: Insight[] = [];
  const m = input.money;
  if (m && m.totals.overdue_paise > 0) {
    const overdueClients = m.clients.filter((c) => c.overdue_paise > 0).sort((a, b) => b.overdue_paise - a.overdue_paise);
    out.push({
      key: 'overdue', tone: 'danger',
      title: `${input.formatMoney(m.totals.overdue_paise)} overdue across ${overdueClients.length} client${overdueClients.length === 1 ? '' : 's'}`,
      detail: overdueClients[0] ? `Largest: ${overdueClients[0].client_name}` : 'Past their due date',
      cta: 'Follow up', href: '/hrms/payment-summary',
    });
  }
  if (input.gst && input.gst.stats.atRisk > 0) {
    out.push({
      key: 'gst-risk', tone: 'danger',
      title: `${input.gst.stats.atRisk} GST return${input.gst.stats.atRisk === 1 ? ' is' : 's are'} overdue`,
      detail: `${periodName(input.gst.period)} period · ${input.gst.stats.filed} of ${input.gst.stats.total} filed`,
      cta: 'Open GST', href: '/workstation/services/registration/gst/dashboard',
    });
  }
  const tdsOverdue = input.tds?.rows.filter((r) => r.overdue > 0).length ?? 0;
  if (tdsOverdue > 0) {
    out.push({
      key: 'tds', tone: 'warning',
      title: `${tdsOverdue} client${tdsOverdue === 1 ? ' has' : 's have'} overdue TDS work`,
      detail: 'Challans, returns or certificates past due',
      cta: 'Open TDS', href: '/workstation/services/tds',
    });
  }
  if (input.dueSoon && input.dueSoon.count > 0) {
    out.push({
      key: 'due-soon', tone: 'warning',
      title: `${input.dueSoon.count} filing${input.dueSoon.count === 1 ? '' : 's'} due this week`,
      detail: input.dueSoon.firstDate ? `First one on ${input.formatDay(input.dueSoon.firstDate)}` : 'Within the next 7 days',
      cta: 'See deadlines', href: '#deadlines',
    });
  }
  if (input.pendingCount && input.pendingCount > 0) {
    out.push({
      key: 'pending', tone: 'info',
      title: `${input.pendingCount} item${input.pendingCount === 1 ? '' : 's'} waiting for your approval`,
      detail: 'Leave, expenses, corrections and expiring records',
      cta: 'Review', href: '#approvals',
    });
  }
  if (input.absent && input.absent > 0) {
    out.push({
      key: 'absent', tone: 'info',
      title: `${input.absent} ${input.absent === 1 ? 'person has' : 'people have'} not checked in`,
      detail: 'Today’s attendance so far',
      cta: 'Attendance', href: '/hrms/attendance',
    });
  }
  return out.slice(0, 3);
}

// ── Money formatting ───────────────────────────────────────────────────────

/** ₹ in lakh / crore shorthand for axes and headlines: ₹45K, ₹1.2L, ₹2.3Cr. */
export function inrCompact(paise: number): string {
  const r = paise / 100;
  const abs = Math.abs(r);
  if (abs >= 1e7) return `₹${trim(r / 1e7)}Cr`;
  if (abs >= 1e5) return `₹${trim(r / 1e5)}L`;
  if (abs >= 1e3) return `₹${trim(r / 1e3)}K`;
  return `₹${Math.round(r)}`;
}
function trim(n: number): string {
  return (Math.round(n * 10) / 10).toString();
}
