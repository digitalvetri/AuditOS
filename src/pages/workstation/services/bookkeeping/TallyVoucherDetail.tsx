import { useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Pencil, Printer, Ban, RotateCcw, FileJson } from 'lucide-react';
import { Button } from '@/components/Button';
import { useToast } from '@/components/Toast';
import { tallyAccountingApi } from '@/modules/tools/audit-automation/tally';
import { Money, Panel, Loading, ErrorNote, StatusPill, qty } from '@/modules/tools/tally/ui';
import type { ApiError } from '@/services/api';

/**
 * One voucher, in full: the header, the accounting lines, the stock
 * lines, and its revision history. Every ledger name links to that
 * ledger's statement — the last step of the drill-down chain.
 */
export function TallyVoucherDetail() {
  const { companyId = '', voucherId = '' } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const base = `/tally/companies/${companyId}`;
  const [showEInvoice, setShowEInvoice] = useState(false);

  const q = useQuery({
    queryKey: ['tally.voucher', companyId, voucherId],
    queryFn: () => tallyAccountingApi.getVoucher(companyId, voucherId),
  });
  const historyQ = useQuery({
    queryKey: ['tally.voucherHistory', companyId, voucherId],
    queryFn: () => tallyAccountingApi.auditTrail(companyId, { voucher_id: voucherId }),
  });
  const eInvoiceQ = useQuery({
    queryKey: ['tally.einvoice', companyId, voucherId],
    enabled: showEInvoice,
    queryFn: () => tallyAccountingApi.eInvoicePayload(companyId, voucherId),
  });

  const invalidate = async () => {
    await qc.invalidateQueries({ queryKey: ['tally.voucher', companyId, voucherId] });
    await qc.invalidateQueries({ queryKey: ['tally.voucherHistory', companyId, voucherId] });
    await qc.invalidateQueries({ queryKey: ['tally.vouchers', companyId] });
  };

  const cancel = useMutation({
    mutationFn: (reason: string) => tallyAccountingApi.cancelVoucher(companyId, voucherId, reason),
    onSuccess: async () => { await invalidate(); toast.push('success', 'Voucher cancelled. It keeps its number and its history.'); },
    onError: (e: ApiError) => toast.push('error', e.message),
  });
  const restore = useMutation({
    mutationFn: () => tallyAccountingApi.restoreVoucher(companyId, voucherId),
    onSuccess: async () => { await invalidate(); toast.push('success', 'Voucher restored.'); },
    onError: (e: ApiError) => toast.push('error', e.message),
  });
  const duplicate = useMutation({
    mutationFn: () => tallyAccountingApi.duplicateVoucher(companyId, voucherId),
    onSuccess: async (v) => { await invalidate(); toast.push('success', `Duplicated as ${v.voucher_number}.`); navigate(`${base}/vouchers/${v.id}`); },
    onError: (e: ApiError) => toast.push('error', e.message),
  });

  if (q.isLoading) return <Loading />;
  if (q.isError) return <ErrorNote message={(q.error as Error).message} />;
  const v = q.data!;
  const cancelled = v.status === 'cancelled';

  return (
    <div data-testid="tally-voucher-detail">
      <header className="flex items-start justify-between gap-4 mb-4 flex-wrap print:hidden">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-16 font-semibold text-neutral-900">
              {v.voucher_type_name ?? v.voucher_type_code} {v.voucher_number}
            </h2>
            {cancelled ? <StatusPill status="cancelled" /> : v.version > 1 ? <StatusPill status="altered" /> : null}
          </div>
          <p className="text-12 text-neutral-500 mt-0.5">
            {v.date}{v.party_name ? ` · ${v.party_name}` : ''} · version {v.version}
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Button size="sm" variant="secondary" onClick={() => window.print()}><Printer size={13} className="mr-1" /> Print</Button>
          <Button size="sm" variant="secondary" onClick={() => duplicate.mutate()} disabled={duplicate.isPending}><Copy size={13} className="mr-1" /> Duplicate</Button>
          {v.voucher_type_code === 'sales' ? (
            <Button size="sm" variant="secondary" onClick={() => setShowEInvoice((s) => !s)}><FileJson size={13} className="mr-1" /> e-Invoice data</Button>
          ) : null}
          {cancelled ? (
            <Button size="sm" variant="secondary" onClick={() => restore.mutate()} disabled={restore.isPending}><RotateCcw size={13} className="mr-1" /> Restore</Button>
          ) : (
            <>
              <Link to={`${base}/vouchers/${v.id}/edit`}><Button size="sm" variant="secondary"><Pencil size={13} className="mr-1" /> Alter</Button></Link>
              <Button
                size="sm" variant="secondary"
                onClick={() => {
                  const reason = window.prompt('Why is this voucher being cancelled? (recorded in the audit trail)');
                  if (reason !== null) cancel.mutate(reason);
                }}
                disabled={cancel.isPending}
              >
                <Ban size={13} className="mr-1" /> Cancel
              </Button>
            </>
          )}
        </div>
      </header>

      {cancelled ? (
        <div className="mb-3 bg-neutral-50 border border-neutral-200 rounded p-3 text-13 text-neutral-600">
          This voucher is cancelled and no longer affects any balance. It keeps its number so the series has no silent gap.
          {v.cancel_reason ? <> Reason: <span className="text-neutral-900">{v.cancel_reason}</span></> : null}
        </div>
      ) : null}

      <div className="grid grid-cols-1 lg:grid-cols-[2fr_1fr] gap-4">
        <div className="space-y-4">
          <Panel title="Accounting entries">
            <div className="overflow-x-auto">
              <table className="w-full text-13" style={{ minWidth: '520px' }}>
                <thead>
                  <tr className="text-left text-11 text-neutral-500 border-b border-neutral-100">
                    <th className="px-3 py-2 font-normal">LEDGER</th>
                    <th className="px-3 py-2 font-normal">BILL REF</th>
                    <th className="px-3 py-2 font-normal text-right">DEBIT</th>
                    <th className="px-3 py-2 font-normal text-right">CREDIT</th>
                  </tr>
                </thead>
                <tbody>
                  {(v.entries ?? []).map((e) => (
                    <tr key={e.id} className="border-t border-neutral-100">
                      <td className="px-3 py-2">
                        <Link to={`${base}/reports/ledger/${e.ledger_id}`} className="text-neutral-900 hover:text-gold">{e.ledger_name}</Link>
                        {e.narration ? <div className="text-11 text-neutral-500">{e.narration}</div> : null}
                      </td>
                      <td className="px-3 py-2 text-12 text-neutral-500">
                        {e.bill_allocations.map((a) => `${a.bill_ref} (${a.method})`).join(', ') || '—'}
                      </td>
                      <td className="px-3 py-2 text-right"><Money paise={e.entry_type === 'dr' ? e.amount_paise : 0} /></td>
                      <td className="px-3 py-2 text-right"><Money paise={e.entry_type === 'cr' ? e.amount_paise : 0} /></td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="border-t-2 border-neutral-200 font-medium">
                  <tr>
                    <td className="px-3 py-2" colSpan={2}>Total</td>
                    <td className="px-3 py-2 text-right"><Money paise={v.total_debit_paise} bold /></td>
                    <td className="px-3 py-2 text-right"><Money paise={v.total_credit_paise} bold /></td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </Panel>

          {(v.items ?? []).length ? (
            <Panel title="Stock lines">
              <div className="overflow-x-auto">
                <table className="w-full text-13" style={{ minWidth: '640px' }}>
                  <thead>
                    <tr className="text-left text-11 text-neutral-500 border-b border-neutral-100">
                      <th className="px-3 py-2 font-normal">ITEM</th>
                      <th className="px-3 py-2 font-normal">HSN</th>
                      <th className="px-3 py-2 font-normal">GODOWN</th>
                      <th className="px-3 py-2 font-normal text-center">IN/OUT</th>
                      <th className="px-3 py-2 font-normal text-right">QTY</th>
                      <th className="px-3 py-2 font-normal text-right">RATE</th>
                      <th className="px-3 py-2 font-normal text-right">TAXABLE</th>
                      <th className="px-3 py-2 font-normal text-right">TAX</th>
                    </tr>
                  </thead>
                  <tbody>
                    {v.items!.map((i) => (
                      <tr key={i.id} className="border-t border-neutral-100">
                        <td className="px-3 py-2">
                          <Link to={`${base}/inventory/items/${i.stock_item_id}`} className="text-neutral-900 hover:text-gold">{i.stock_item_name}</Link>
                        </td>
                        <td className="px-3 py-2 font-mono text-12 text-neutral-600">{i.hsn_code ?? '—'}</td>
                        <td className="px-3 py-2 text-neutral-600">{i.godown_name ?? '—'}</td>
                        <td className="px-3 py-2 text-center text-11 uppercase text-neutral-500">{i.direction}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{qty(i.qty_milli)}</td>
                        <td className="px-3 py-2 text-right"><Money paise={i.rate_paise} /></td>
                        <td className="px-3 py-2 text-right"><Money paise={i.amount_paise} /></td>
                        <td className="px-3 py-2 text-right"><Money paise={i.cgst_paise + i.sgst_paise + i.igst_paise + i.cess_paise} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          ) : null}

          {showEInvoice ? (
            <Panel title="e-Invoice payload (prepared — not transmitted)">
              {eInvoiceQ.isLoading ? <div className="p-3 text-13 text-neutral-500">Preparing…</div> : eInvoiceQ.data ? (
                <div className="p-3">
                  <p className="text-12 text-neutral-500 mb-2">{eInvoiceQ.data.note}</p>
                  {eInvoiceQ.data.blockers.length ? (
                    <div className="text-12 text-danger mb-2">
                      Missing before this could be filed: {eInvoiceQ.data.blockers.join(', ')}.
                    </div>
                  ) : null}
                  <pre className="text-11 bg-neutral-50 border border-neutral-200 rounded p-2 overflow-x-auto max-h-[320px]">
                    {JSON.stringify(eInvoiceQ.data.payload, null, 2)}
                  </pre>
                </div>
              ) : <div className="p-3 text-13 text-danger">Could not prepare the payload.</div>}
            </Panel>
          ) : null}
        </div>

        <div className="space-y-4">
          <Panel title="Details">
            <dl className="p-3 space-y-2 text-13">
              <Detail label="Date" value={v.date} />
              <Detail label="Reference" value={v.reference_number ?? '—'} />
              <Detail label="Party" value={v.party_name ?? '—'} />
              <Detail label="Place of supply" value={v.place_of_supply ?? '—'} />
              <Detail label="Narration" value={v.narration ?? '—'} />
              {v.taxable_value_paise ? (
                <>
                  <div className="border-t border-neutral-100 pt-2" />
                  <DetailMoney label="Taxable value" paise={v.taxable_value_paise} />
                  <DetailMoney label="CGST" paise={v.cgst_paise} />
                  <DetailMoney label="SGST" paise={v.sgst_paise} />
                  <DetailMoney label="IGST" paise={v.igst_paise} />
                  <DetailMoney label="Invoice total" paise={v.grand_total_paise} />
                </>
              ) : null}
            </dl>
          </Panel>

          <Panel title="History">
            {historyQ.isLoading ? (
              <div className="p-3 text-13 text-neutral-500">Loading…</div>
            ) : (
              <ul className="divide-y divide-neutral-100">
                {(historyQ.data?.items ?? []).map((h) => (
                  <li key={h.id} className="px-3 py-2">
                    <div className="text-13 text-neutral-900 capitalize">{h.action}</div>
                    <div className="text-11 text-neutral-500">
                      v{h.version} · {new Date(h.at).toLocaleString('en-IN')} · {h.actor_label}
                    </div>
                    {h.note ? <div className="text-11 text-neutral-500 italic">{h.note}</div> : null}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-neutral-500">{label}</dt>
      <dd className="text-neutral-900 text-right">{value}</dd>
    </div>
  );
}

function DetailMoney({ label, paise }: { label: string; paise: number }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-neutral-500">{label}</dt>
      <dd className="text-neutral-900"><Money paise={paise} /></dd>
    </div>
  );
}
