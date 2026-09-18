/**
 * Client-record billing slice (docs/zoho-payments/README.md §6.3).
 *
 * Renders on the client workspace overview tab, but ONLY for users
 * holding `accounts.manage@organisation`. The spec is emphatic that
 * this block is hidden entirely — not greyed — from other users, so
 * the parent gate is at the render-caller in ClientWorkspace.tsx.
 *
 *   Billed from:  {account label}                  [Change]
 *   Paid this FY  ₹X,XX,XXX      Last payment  10 Sep · ₹25,000
 *   Outstanding   —              Oldest        —
 *
 * "Outstanding" and "Oldest open invoice" render as em-dashes with a
 * subline explaining that a real invoice source is needed. That
 * mechanism (CSV/XLSX or Books) is a separate step; step 6 wires the
 * shape and everything computable from local zpay tables.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/Button';
import { useToast } from '@/components/Toast';
import { inr, fmtDate } from '@/lib/format';
import { zpayApi } from './api';

export function BillingSliceCard({ clientId }: { clientId: string }) {
  const [editing, setEditing] = useState(false);

  const slice = useQuery({
    queryKey: ['zpay', 'billing-slice', clientId],
    queryFn: () => zpayApi.billingSlice(clientId),
  });

  return (
    <div className="bg-white border border-neutral-200 rounded">
      <header className="px-4 py-3 border-b border-neutral-200 flex items-center justify-between">
        <div>
          <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">
            Billing · Zoho Payments
          </div>
          <div className="text-12 text-neutral-500">
            {slice.data ? `FY ${slice.data.financialYear}` : 'Loading…'}
          </div>
        </div>
        {slice.data ? (
          <button
            type="button"
            onClick={() => setEditing((v) => !v)}
            className="text-12 text-navy-700 hover:underline"
          >
            {slice.data.billingAccount ? 'Change' : 'Set billed-from'}
          </button>
        ) : null}
      </header>

      <div className="p-4 space-y-3">
        {slice.isLoading ? (
          <div className="text-13 text-neutral-500">Loading…</div>
        ) : slice.error ? (
          <div className="text-13 text-red-700">Failed to load: {(slice.error as Error).message}</div>
        ) : slice.data ? (
          <>
            <Row label="Billed from">
              {slice.data.billingAccount ? (
                <span>
                  {slice.data.billingAccount.label}
                  <span className="text-11 text-neutral-500 ml-2">
                    {slice.data.billingAccount.isGstRegistered ? 'GST entity' : 'Non-GST entity'}
                  </span>
                </span>
              ) : (
                <span className="text-neutral-500">Not set</span>
              )}
            </Row>

            {editing ? (
              <ChangeBillingAccountForm
                clientId={clientId}
                currentAccountId={slice.data.billingAccount?.id ?? null}
                onDone={() => setEditing(false)}
              />
            ) : null}

            <div className="grid grid-cols-2 gap-3">
              <Stat label={`Paid FY ${slice.data.financialYear}`}>
                <span className="text-16 font-semibold tabular-nums text-neutral-900">
                  {inr(slice.data.paidThisFyPaise)}
                </span>
                <div className="text-11 text-neutral-500">
                  {slice.data.paymentCountThisFy === 1
                    ? '1 payment'
                    : `${slice.data.paymentCountThisFy} payments`}
                </div>
              </Stat>
              <Stat label="Last payment">
                {slice.data.lastPayment ? (
                  <>
                    <span className="text-16 font-semibold tabular-nums text-neutral-900">
                      {inr(slice.data.lastPayment.amountPaise)}
                    </span>
                    <div className="text-11 text-neutral-500">
                      {fmtDate(slice.data.lastPayment.paidAt)}
                      {slice.data.lastPayment.matchedInvoiceRef ? (
                        <span className="ml-1 font-mono">
                          · {slice.data.lastPayment.matchedInvoiceRef}
                        </span>
                      ) : null}
                    </div>
                  </>
                ) : (
                  <span className="text-13 text-neutral-500">No matched payments yet</span>
                )}
              </Stat>
            </div>

            <div className="grid grid-cols-2 gap-3 pt-2 border-t border-neutral-100">
              <Stat label="Outstanding">
                {slice.data.outstandingCount > 0 ? (
                  <>
                    <span className="text-16 font-semibold tabular-nums text-amber-800">
                      {inr(slice.data.outstandingPaise ?? 0)}
                    </span>
                    <div className="text-11 text-neutral-500">
                      {slice.data.outstandingCount === 1
                        ? '1 open invoice'
                        : `${slice.data.outstandingCount} open invoices`}
                    </div>
                  </>
                ) : (
                  <>
                    <span className="text-neutral-400">—</span>
                    <div className="text-11 text-neutral-500">
                      No open invoices for this client
                    </div>
                  </>
                )}
              </Stat>
              <Stat label="Oldest open invoice">
                {slice.data.oldestOpenInvoice ? (
                  <>
                    <span className="text-13 font-medium text-neutral-900 font-mono">
                      {slice.data.oldestOpenInvoice.invoiceNumber}
                    </span>
                    <div className="text-11 text-neutral-500">
                      {slice.data.oldestOpenInvoice.ageDays} days
                      <span className="ml-1">
                        · {inr(slice.data.oldestOpenInvoice.amountPaise)}
                      </span>
                    </div>
                  </>
                ) : (
                  <>
                    <span className="text-neutral-400">—</span>
                    <div className="text-11 text-neutral-500">Nothing open</div>
                  </>
                )}
              </Stat>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 flex-wrap">
      <span className="text-11 uppercase tracking-[0.06em] text-neutral-500">{label}</span>
      <span className="text-13 text-neutral-900">{children}</span>
    </div>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">{label}</div>
      <div className="mt-1">{children}</div>
    </div>
  );
}

function ChangeBillingAccountForm({
  clientId,
  currentAccountId,
  onDone,
}: {
  clientId: string;
  currentAccountId: string | null;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const connections = useQuery({
    queryKey: ['zpay', 'connections'],
    queryFn: zpayApi.list,
  });
  const [selected, setSelected] = useState<string>(currentAccountId ?? '');

  const save = useMutation({
    mutationFn: () =>
      zpayApi.setBillingAccount(clientId, selected === '' ? null : selected),
    onSuccess: () => {
      toast.push('success', 'Billing account updated.');
      qc.invalidateQueries({ queryKey: ['zpay', 'billing-slice', clientId] });
      onDone();
    },
    onError: (e: Error) => toast.push('error', e.message),
  });

  const accounts = (connections.data?.items ?? []).flatMap((c) =>
    c.accounts.map((a) => ({
      id: a.id,
      label: `${a.label} — ${c.zohoOrgLabel}`,
      isGstRegistered: a.isGstRegistered,
    })),
  );

  return (
    <div className="bg-neutral-50 border border-neutral-200 rounded p-3 space-y-3">
      <label className="block">
        <span className="text-11 uppercase tracking-[0.06em] text-neutral-500 block mb-1">
          Billed from
        </span>
        <select
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
          className="w-full h-9 px-2 bg-white border border-neutral-300 rounded text-13 focus:outline-none focus:border-gold"
        >
          <option value="">— clear —</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label} {a.isGstRegistered ? '(GST)' : '(Non-GST)'}
            </option>
          ))}
        </select>
        <span className="text-11 text-neutral-500 block mt-1">
          One client is billed from one account. Drives which invoice
          series should apply and which Zoho account a payment is expected
          in (spec §3).
        </span>
      </label>
      <div className="flex gap-2 justify-end">
        <Button variant="secondary" type="button" onClick={onDone}>
          Cancel
        </Button>
        <Button
          variant="primary"
          type="button"
          onClick={() => save.mutate()}
          disabled={save.isPending}
        >
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </div>
  );
}
