/**
 * Per-client signals for the Clients list and the Client 360 panel, joined
 * client-side from a fixed number of firm-wide calls (never one per row):
 *
 *   money  ← /api/payment-summary            (only for payment_summary.read)
 *   gst    ← /api/gst/client-dashboard × 6    (the last six return periods)
 *   tds    ← /api/tds/overview                (current financial year)
 *
 * Nothing here is invented: when a source isn't available for the viewer's
 * role, the signal is simply absent.
 */
import type { ClientDashboardResponse, ClientDashboardCell } from '@/modules/workstation/gst/api';
import type { TdsOverview, TdsOverviewRow } from '@/modules/tds/api';
import type { ClientSummary } from '@/modules/paymentSummary/api';
import type { ClientListItem } from '@/modules/workstation/types';

/** The `count` return periods ending with the month before `todayISO`, oldest first. */
export function lastPeriods(todayISO: string, count = 6): string[] {
  const y = Number(todayISO.slice(0, 4));
  const m = Number(todayISO.slice(5, 7)) - 1; // previous month, 1-based → this is already "minus one"
  const out: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const idx = y * 12 + (m - 1) - i;
    out.push(`${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`);
  }
  return out;
}

export type PeriodState = 'filed' | 'overdue' | 'pending' | 'none';

/**
 * One period's GSTR-1 + GSTR-3B for one client, as a single dot:
 *   filed   — every return for the period is completed
 *   overdue — any return is past due and not completed
 *   pending — open, not yet due
 *   none    — nothing due that period (e.g. quarterly filer's off-month)
 */
export function periodState(cells: (ClientDashboardCell | null)[]): PeriodState {
  const real = cells.filter((c): c is ClientDashboardCell => !!c);
  if (!real.length) return 'none';
  if (real.some((c) => c.state === 'overdue')) return 'overdue';
  if (real.every((c) => c.state === 'done')) return 'filed';
  return 'pending';
}

export interface GstHistory {
  periods: string[];
  /** client_id → period → { strip state, raw cells } */
  byClient: Map<string, Map<string, { state: PeriodState; gstr1: ClientDashboardCell | null; gstr3b: ClientDashboardCell | null }>>;
}

export function gstHistory(periods: string[], responses: (ClientDashboardResponse | undefined)[]): GstHistory {
  const byClient: GstHistory['byClient'] = new Map();
  responses.forEach((r, i) => {
    if (!r) return;
    for (const c of r.clients) {
      const row = byClient.get(c.client_id) ?? new Map();
      row.set(periods[i], { state: periodState([c.gstr1, c.gstr3b]), gstr1: c.gstr1, gstr3b: c.gstr3b });
      byClient.set(c.client_id, row);
    }
  });
  return { periods, byClient };
}

export interface Health { score: number; reasons: string[] }

/**
 * A 0–100 health score — a quick triage signal, not an audit opinion:
 *   start at 100
 *   − 25  money overdue on any invoice
 *   − 10  per GST period with an overdue return in the last six (max − 40)
 *   − 15  TDS work overdue
 *   − 10  client status is "pending documents" or "service due"
 * Returns null when no source could be read for this client.
 */
export function clientHealth(input: {
  client: ClientListItem;
  money?: ClientSummary;
  gst?: Map<string, { state: PeriodState }>;
  tds?: TdsOverviewRow[];
  knows: { money: boolean; gst: boolean; tds: boolean };
}): Health | null {
  const { client, money, gst, tds, knows } = input;
  if (!knows.money && !knows.gst && !knows.tds) return null;
  let score = 100;
  const reasons: string[] = [];
  if (money && money.overdue_paise > 0) { score -= 25; reasons.push('Payment overdue'); }
  const gstOverdue = gst ? [...gst.values()].filter((p) => p.state === 'overdue').length : 0;
  if (gstOverdue) { score -= Math.min(40, gstOverdue * 10); reasons.push(`${gstOverdue} GST period${gstOverdue === 1 ? '' : 's'} overdue`); }
  if (tds?.some((r) => r.overdue > 0)) { score -= 15; reasons.push('TDS work overdue'); }
  if (client.status === 'pending_documents' || client.status === 'service_due') {
    score -= 10; reasons.push(client.status === 'pending_documents' ? 'Documents pending' : 'Service due');
  }
  return { score: Math.max(0, score), reasons };
}

export function tdsRowsFor(tds: TdsOverview | undefined, clientId: string): TdsOverviewRow[] {
  return tds?.rows.filter((r) => r.client_id === clientId) ?? [];
}
