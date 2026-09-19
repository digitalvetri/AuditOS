/**
 * The Matching queue (docs/zoho-payments/README.md §6.2).
 *
 * The screen finance actually uses every week. Three tabs:
 *
 *   Unmatched  →  Zoho payment with no invoice link. "Link manually" per row.
 *   Proposed   →  Probable-tier proposals. Empty until an invoice-import
 *                 mechanism lands (spec §4.2 requires external invoice data).
 *   Matched    →  Auto-matched (exact) + human-confirmed (manual). "Unmatch"
 *                 recomputes on the next sync.
 *
 * A manual link is a bare invoice-ref string plus an optional client — the
 * spec is explicit that we do NOT build a second invoicing system; the
 * ref is whatever the operator agreed with whoever raises the invoices.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { useToast } from '@/components/Toast';
import { inr, fmtDate } from '@/lib/format';
import { workstationApi } from '@/modules/workstation/api';
import {
  zpayApi,
  type EntityFilter,
  type MatchFilter,
  type QueuePayment,
} from './api';

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

export function MatchingQueueSection() {
  const [period, setPeriod] = useState<string>(() => ymKey(new Date()));
  const [entity, setEntity] = useState<EntityFilter>('all');
  const [filter, setFilter] = useState<MatchFilter>('unmatched');
  const [matching, setMatching] = useState<QueuePayment | null>(null);

  const q = useQuery({
    queryKey: ['zpay', 'queue', period, entity, filter],
    queryFn: () => zpayApi.queue(period, entity, filter),
  });

  return (
    <section className="space-y-6">
      <header className="flex items-baseline justify-between gap-4 flex-wrap">
        <div>
          <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">
            Accounts / Collections / Matching
          </div>
          <h2 className="text-18 font-medium text-neutral-900 mt-1">
            Matching queue — {monthLabel(period)}
          </h2>
          <p className="text-12 text-neutral-500 mt-1">
            Exact matches happen automatically as payments sync. Everything
            else lands here for a human decision.
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
            disabled={period === ymKey(new Date())}
          >
            ▸
          </button>
        </div>
      </header>

      <div className="border-b border-neutral-200 flex items-center gap-4 flex-wrap">
        <FilterTab active={filter === 'unmatched'} onClick={() => setFilter('unmatched')}>
          Unmatched {q.data ? <Badge tone="warn">{q.data.counts.unmatched}</Badge> : null}
        </FilterTab>
        <FilterTab active={filter === 'proposed'} onClick={() => setFilter('proposed')}>
          Proposed {q.data ? <Badge tone="neutral">{q.data.counts.proposed}</Badge> : null}
        </FilterTab>
        <FilterTab active={filter === 'matched'} onClick={() => setFilter('matched')}>
          Matched {q.data ? <Badge tone="good">{q.data.counts.matched}</Badge> : null}
        </FilterTab>
        <div className="ml-auto flex items-center gap-1">
          {(['all', 'gst', 'non-gst'] as EntityFilter[]).map((e) => (
            <button
              key={e}
              type="button"
              onClick={() => setEntity(e)}
              className={
                'h-7 px-2 text-12 rounded ' +
                (entity === e
                  ? 'bg-neutral-900 text-white'
                  : 'text-neutral-600 hover:text-neutral-900')
              }
            >
              {e === 'all' ? 'All' : e === 'gst' ? 'GST' : 'Non-GST'}
            </button>
          ))}
        </div>
      </div>

      {q.isLoading ? (
        <div className="text-13 text-neutral-500">Loading…</div>
      ) : q.error ? (
        <div className="text-13 text-red-700 bg-red-50 border border-red-200 rounded p-3">
          Failed to load: {(q.error as Error).message}
        </div>
      ) : filter === 'proposed' ? (
        <ProposedEmpty />
      ) : q.data && q.data.items.length === 0 ? (
        <EmptyState filter={filter} />
      ) : (
        <ol className="space-y-2">
          {q.data?.items.map((p) => (
            <QueueRow
              key={p.id}
              payment={p}
              filter={filter}
              onMatch={() => setMatching(p)}
            />
          ))}
        </ol>
      )}

      {matching ? (
        <MatchModal
          payment={matching}
          onClose={() => setMatching(null)}
        />
      ) : null}
    </section>
  );
}

function QueueRow({
  payment,
  filter,
  onMatch,
}: {
  payment: QueuePayment;
  filter: MatchFilter;
  onMatch: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const un = useMutation({
    mutationFn: () => zpayApi.unmatchPayment(payment.id),
    onSuccess: () => {
      toast.push('success', 'Payment moved back to Unmatched.');
      qc.invalidateQueries({ queryKey: ['zpay', 'queue'] });
      qc.invalidateQueries({ queryKey: ['zpay', 'collections'] });
    },
    onError: (e: Error) => toast.push('error', e.message),
  });
  return (
    <li className="bg-white border border-neutral-200 rounded p-3 flex items-start justify-between gap-4 flex-wrap">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-3 flex-wrap text-13">
          <span className="text-neutral-500 tabular-nums">{fmtDate(payment.paidAt)}</span>
          <span className="font-semibold text-neutral-900 tabular-nums">{inr(payment.amountPaise)}</span>
          <span className="text-neutral-900">{payment.customerName ?? '(no payer name)'}</span>
          <span className="text-11 text-neutral-500 border border-neutral-200 rounded px-1.5 h-5 inline-flex items-center">
            {payment.account.label}
            {payment.account.isGstRegistered ? '' : ' · non-GST'}
          </span>
        </div>
        <div className="text-12 text-neutral-500 mt-1 font-mono">
          Ref: {payment.referenceNumber ?? '—'}
          {payment.matchedInvoiceRef ? (
            <>
              {' · matched → '}
              <span className="text-neutral-900">{payment.matchedInvoiceRef}</span>
              {payment.matchType === 'exact' ? (
                <span className="text-emerald-700"> (auto)</span>
              ) : payment.matchType === 'manual' ? (
                <span className="text-navy-700"> (manual)</span>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
      <div className="flex items-center gap-2">
        {filter === 'unmatched' ? (
          <Button variant="primary" onClick={onMatch}>Link manually ▸</Button>
        ) : (
          <Button variant="secondary" onClick={() => un.mutate()} disabled={un.isPending}>
            {un.isPending ? 'Unmatching…' : 'Unmatch'}
          </Button>
        )}
      </div>
    </li>
  );
}

function MatchModal({
  payment,
  onClose,
}: {
  payment: QueuePayment;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [invoiceRef, setInvoiceRef] = useState('');
  const [clientQuery, setClientQuery] = useState('');
  const [clientId, setClientId] = useState<string | null>(null);
  const [clientLabel, setClientLabel] = useState<string>('');
  const seed = payment.account.invoiceSeriesPrefix;

  // Debounced typeahead against the workstation clients endpoint. Only
  // fires when the user has typed at least 2 characters and hasn't
  // already picked a client — the picked-state is a stable label.
  const search = useQuery({
    queryKey: ['zpay', 'match-client-search', clientQuery],
    enabled: clientQuery.trim().length >= 2 && clientId === null,
    queryFn: () => workstationApi.listClients({ q: clientQuery.trim() }),
  });

  const match = useMutation({
    mutationFn: () =>
      zpayApi.matchPayment(payment.id, {
        invoiceRef: invoiceRef.trim(),
        ...(clientId ? { clientId } : {}),
      }),
    onSuccess: () => {
      toast.push('success', `Linked to ${invoiceRef.trim()}.`);
      qc.invalidateQueries({ queryKey: ['zpay', 'queue'] });
      qc.invalidateQueries({ queryKey: ['zpay', 'collections'] });
      qc.invalidateQueries({ queryKey: ['zpay', 'billing-slice'] });
      onClose();
    },
    onError: (e: Error) => toast.push('error', e.message),
  });

  return (
    <div className="fixed inset-0 z-40 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-white rounded shadow-lg max-w-[520px] w-full p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">
          Link manually
        </div>
        <h3 className="text-16 font-medium text-neutral-900 mt-1">
          {inr(payment.amountPaise)} · {payment.customerName ?? '(no payer name)'}
        </h3>
        <div className="text-12 text-neutral-500 mt-1">
          Reference on Zoho: <span className="font-mono">{payment.referenceNumber ?? '—'}</span>
        </div>

        <form
          className="mt-4 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!invoiceRef.trim()) return;
            match.mutate();
          }}
        >
          <label className="block">
            <span className="text-11 uppercase tracking-[0.06em] text-neutral-500 block mb-1">
              Invoice reference
            </span>
            <Input
              autoFocus
              value={invoiceRef}
              onChange={(e) => setInvoiceRef(e.target.value)}
              placeholder={seed ? `${seed}0412` : 'INV/2026/0412'}
            />
            <span className="text-11 text-neutral-500 block mt-1">
              Whatever your invoicing system calls it. Recorded exactly as typed.
            </span>
          </label>

          <div>
            <div className="text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">
              Client <span className="normal-case text-neutral-400">(optional)</span>
            </div>
            {clientId ? (
              <div className="flex items-center gap-2 bg-emerald-50 border border-emerald-200 rounded p-2">
                <span className="text-13 flex-1">{clientLabel}</span>
                <button
                  type="button"
                  className="text-12 text-neutral-500 hover:text-neutral-900"
                  onClick={() => {
                    setClientId(null);
                    setClientLabel('');
                    setClientQuery('');
                  }}
                >
                  Change
                </button>
              </div>
            ) : (
              <div className="relative">
                <Input
                  value={clientQuery}
                  onChange={(e) => setClientQuery(e.target.value)}
                  placeholder="Search clients by name…"
                />
                {clientQuery.trim().length >= 2 && search.data ? (
                  <div className="absolute z-10 mt-1 w-full bg-white border border-neutral-200 rounded shadow-sm max-h-56 overflow-auto">
                    {search.data.items.length === 0 ? (
                      <div className="px-3 py-2 text-12 text-neutral-500">
                        No clients match "{clientQuery.trim()}"
                      </div>
                    ) : (
                      search.data.items.map((c) => (
                        <button
                          key={c.id}
                          type="button"
                          className="block w-full text-left px-3 py-2 hover:bg-neutral-50"
                          onClick={() => {
                            setClientId(c.id);
                            setClientLabel(`${c.company_name} · ${c.client_id}`);
                          }}
                        >
                          <div className="text-13 text-neutral-900">{c.company_name}</div>
                          <div className="text-11 text-neutral-500">{c.client_id}</div>
                        </button>
                      ))
                    )}
                  </div>
                ) : null}
              </div>
            )}
            <p className="text-11 text-neutral-500 mt-1">
              Linking a client here is what makes the payment show up on that
              client's billing slice.
            </p>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" type="button" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              type="submit"
              disabled={!invoiceRef.trim() || match.isPending}
            >
              {match.isPending ? 'Linking…' : 'Link'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

function ProposedEmpty() {
  return (
    <div className="text-13 text-neutral-600 bg-amber-50 border border-amber-200 rounded p-4">
      <div className="font-medium text-amber-900 mb-1">Probable-tier matching needs an invoice source</div>
      <p>
        The spec§4.2 probable tier proposes a match when a payment's amount matches
        an OPEN invoice for a client billed from the same account. That requires
        pulling invoice data from your invoicing system. Once we wire either an
        API or a CSV upload, this tab will fill in.
      </p>
    </div>
  );
}

function EmptyState({ filter }: { filter: MatchFilter }) {
  return (
    <div className="text-13 text-neutral-500 bg-neutral-50 border border-neutral-200 rounded p-4">
      {filter === 'unmatched'
        ? 'Nothing to match right now. Every synced payment carries either an exact reference match or is waiting for a manual link.'
        : 'No matched payments in this window.'}
    </div>
  );
}

function FilterTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'h-9 px-1 text-13 -mb-px border-b-2 flex items-center gap-2 ' +
        (active
          ? 'border-gold text-neutral-900 font-medium'
          : 'border-transparent text-neutral-500 hover:text-neutral-900')
      }
    >
      {children}
    </button>
  );
}

function Badge({ children, tone }: { children: React.ReactNode; tone: 'warn' | 'good' | 'neutral' }) {
  const cls =
    tone === 'warn'
      ? 'bg-amber-100 text-amber-800'
      : tone === 'good'
      ? 'bg-emerald-100 text-emerald-800'
      : 'bg-neutral-100 text-neutral-700';
  return (
    <span className={`inline-flex items-center h-5 min-w-[20px] px-1.5 rounded-full text-11 tabular-nums ${cls}`}>
      {children}
    </span>
  );
}
