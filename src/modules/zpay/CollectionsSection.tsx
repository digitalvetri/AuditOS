/**
 * The Collections card (docs/zoho-payments/README.md §6.1).
 *
 * Renders inside the Accounts page as a tab. Four tiles at the top —
 * COLLECTED · MATCHED · UNMATCHED · REFUNDED — then a per-entity
 * breakdown, then the flagged row for the unmatched count that will
 * eventually link to the Matching queue (step 5).
 *
 * The month navigator moves in whole IST months. Everything on this
 * screen reads local tables; the API endpoint never touches Zoho on
 * render — spec §3 is explicit and the tiles staying honest matters
 * more than freshness (the sync button in Settings is where fresh
 * comes from).
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { inr, fmtDateTime } from '@/lib/format';
import { zpayApi, type EntityFilter } from './api';

function ymKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function monthLabel(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1, 1));
  return d.toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function shiftMonth(ym: string, delta: number): string {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return ymKey(d);
}

export function CollectionsSection({ onGoToMatching }: { onGoToMatching?: () => void }) {
  const [period, setPeriod] = useState<string>(() => ymKey(new Date()));
  const [entity, setEntity] = useState<EntityFilter>('all');

  const q = useQuery({
    queryKey: ['zpay', 'collections', period, entity],
    queryFn: () => zpayApi.collections(period, entity),
  });

  const showingCurrent = useMemo(() => period === ymKey(new Date()), [period]);

  return (
    <section className="space-y-6">
      <header className="flex items-baseline justify-between gap-4 flex-wrap">
        <div>
          <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">
            Accounts / Collections
          </div>
          <h2 className="text-18 font-medium text-neutral-900 mt-1">
            Zoho Payments — {monthLabel(period)}
          </h2>
          <p className="text-12 text-neutral-500 mt-1">
            Local read only — cards render from synced data, never from Zoho.
            Use Settings → Integrations → Zoho Payments to trigger a sync.
          </p>
        </div>
        <div className="flex items-center gap-2 text-13">
          <button
            type="button"
            className="h-8 px-2 border border-neutral-300 rounded text-neutral-700 hover:text-neutral-900"
            onClick={() => setPeriod(shiftMonth(period, -1))}
          >
            ◂
          </button>
          <span className="min-w-[110px] text-center font-medium">
            {monthLabel(period)}
          </span>
          <button
            type="button"
            className="h-8 px-2 border border-neutral-300 rounded text-neutral-700 hover:text-neutral-900 disabled:opacity-40"
            onClick={() => setPeriod(shiftMonth(period, +1))}
            disabled={showingCurrent}
            title={showingCurrent ? 'Current month' : ''}
          >
            ▸
          </button>
        </div>
      </header>

      <div className="border-b border-neutral-200 flex items-center gap-4 flex-wrap">
        <EntityTab id="all" active={entity === 'all'} onClick={() => setEntity('all')}>All</EntityTab>
        <EntityTab id="gst" active={entity === 'gst'} onClick={() => setEntity('gst')}>GST entity</EntityTab>
        <EntityTab id="non-gst" active={entity === 'non-gst'} onClick={() => setEntity('non-gst')}>Non-GST entity</EntityTab>
      </div>

      {q.isLoading ? (
        <div className="text-13 text-neutral-500">Loading…</div>
      ) : q.error ? (
        <div className="text-13 text-red-700 bg-red-50 border border-red-200 rounded p-3">
          Failed to load: {(q.error as Error).message}
        </div>
      ) : q.data ? (
        <Body data={q.data} onGoToMatching={onGoToMatching} />
      ) : null}
    </section>
  );
}

function Body({
  data,
  onGoToMatching,
}: {
  data: NonNullable<ReturnType<typeof useQuery<Awaited<ReturnType<typeof zpayApi.collections>>>>['data']>;
  onGoToMatching?: () => void;
}) {
  const noAccounts = data.accounts.length === 0;
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Tile label="Collected" amount={data.collected.amountPaise} count={data.collected.count} tone="neutral" />
        <Tile label="Matched" amount={data.matched.amountPaise} count={data.matched.count} tone="good" />
        <Tile label="Unmatched" amount={data.unmatched.amountPaise} count={data.unmatched.count} tone="warn" />
        <Tile label="Refunded" amount={data.refunded.amountPaise} count={data.refunded.count} tone="neutral" />
      </div>

      {noAccounts ? (
        <div className="text-13 text-neutral-500 bg-neutral-50 border border-neutral-200 rounded p-4">
          No Zoho Payments accounts yet in this view. Add one under Settings →
          Integrations → Zoho Payments.
        </div>
      ) : (
        <div className="border border-neutral-200 rounded overflow-hidden">
          <table className="w-full text-13">
            <thead className="bg-neutral-50 text-11 uppercase tracking-[0.06em] text-neutral-500">
              <tr>
                <th className="text-left px-4 py-2">Account</th>
                <th className="text-left px-4 py-2">Entity</th>
                <th className="text-right px-4 py-2">Collected</th>
                <th className="text-right px-4 py-2">Payments</th>
                <th className="text-left px-4 py-2">Last sync</th>
              </tr>
            </thead>
            <tbody>
              {data.accounts.map((a) => (
                <tr key={a.accountId} className="border-t border-neutral-200">
                  <td className="px-4 py-2 font-medium text-neutral-900">{a.label}</td>
                  <td className="px-4 py-2 text-neutral-600">
                    {a.isGstRegistered
                      ? `GST-registered${a.gstin ? ` · ${a.gstin}` : ''}`
                      : 'Not GST-registered'}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">{inr(a.amountPaise)}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-neutral-600">{a.count}</td>
                  <td className="px-4 py-2 text-neutral-500 text-12">
                    {a.lastSyncAt
                      ? `${a.lastSyncStatus ?? 'synced'} · ${fmtDateTime(a.lastSyncAt)}`
                      : 'never synced'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data.unmatched.count > 0 ? (
        <div className="bg-amber-50 border border-amber-200 rounded p-3 flex items-center justify-between gap-4 flex-wrap">
          <div className="text-13 text-amber-900">
            <span className="font-semibold">{data.unmatched.count}</span> payments need matching
            <span className="text-amber-700"> — {inr(data.unmatched.amountPaise)} sitting in the review queue</span>
          </div>
          <button
            type="button"
            onClick={onGoToMatching}
            disabled={!onGoToMatching}
            className="h-8 px-3 rounded border border-amber-400 bg-white text-amber-900 text-13 font-medium hover:bg-amber-100 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Review queue ▸
          </button>
        </div>
      ) : null}
    </div>
  );
}

function Tile({
  label,
  amount,
  count,
  tone,
}: {
  label: string;
  amount: number;
  count: number;
  tone: 'good' | 'warn' | 'neutral';
}) {
  const toneCls =
    tone === 'good'
      ? 'text-emerald-800'
      : tone === 'warn'
      ? 'text-amber-800'
      : 'text-neutral-900';
  return (
    <div className="bg-white border border-neutral-200 rounded p-4">
      <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">{label}</div>
      <div className={`text-22 font-semibold tabular-nums mt-1 ${toneCls}`}>{inr(amount)}</div>
      <div className="text-12 text-neutral-500 mt-1">
        {count === 1 ? '1 payment' : `${count} payments`}
      </div>
    </div>
  );
}

function EntityTab({
  id,
  active,
  onClick,
  children,
}: {
  id: string;
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={`collections-entity-${id}`}
      className={
        'h-9 px-1 text-13 -mb-px border-b-2 ' +
        (active
          ? 'border-gold text-neutral-900 font-medium'
          : 'border-transparent text-neutral-500 hover:text-neutral-900')
      }
    >
      {children}
    </button>
  );
}
