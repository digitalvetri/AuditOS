import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { Button } from '@/components/Button';
import { StatusLabel } from '@/components/StatusRow';
import { useToast } from '@/components/Toast';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { booksApi } from '@/modules/books/api';
import { Cell, Empty, Money, Notice, Row, Table, inputCls } from '@/modules/books/components';
import { DOC_LABEL, docStatus, fromPaise, isSalesKind, money, toPaise, VOUCHER_LABEL } from '@/modules/books/format';
import type { DocKind } from '@/modules/books/types';

/**
 * The document drawer: what it is, the journal it produced, its open item,
 * everything applied against it, and its audit trail. Actions (post, void,
 * apply a credit or retainer) live here.
 */
export function DocumentDrawer({ orgId, kind, id, onClose, onChanged, onEdit }: { orgId: string; kind: DocKind; id: string; onClose: () => void; onChanged: () => void; onEdit: (id: string) => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const api = booksApi.org(orgId);
  const [confirmVoid, setConfirmVoid] = useState(false);
  const [reason, setReason] = useState('');
  const [applying, setApplying] = useState(false);

  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose]);

  const q = useQuery({ queryKey: ['books', orgId, 'document', kind, id], queryFn: () => api.documents.get(kind, id) });
  const refresh = () => { qc.invalidateQueries({ queryKey: ['books', orgId] }); onChanged(); };
  const post = useMutation({ mutationFn: () => api.documents.post(kind, id), onSuccess: (d) => { toast.push('success', `${DOC_LABEL[kind]} ${d.number} posted.`); refresh(); }, onError: (e: Error) => toast.push('error', e.message) });
  const voidIt = useMutation({ mutationFn: () => api.documents.void(kind, id, reason || undefined), onSuccess: () => { toast.push('success', 'Voided with a reversing entry.'); setConfirmVoid(false); refresh(); }, onError: (e: Error) => toast.push('error', e.message) });
  const convert = useMutation({ mutationFn: (to: DocKind) => api.documents.convert(kind, id, to), onSuccess: (d) => { toast.push('success', `Created ${DOC_LABEL[d.kind].toLowerCase()} ${d.number}.`); refresh(); onClose(); }, onError: (e: Error) => toast.push('error', e.message) });

  const d = q.data?.document;
  const canPost = d && d.status === 'draft' && ['invoice', 'retainer_invoice', 'credit_note', 'bill', 'vendor_credit'].includes(d.kind);
  const canConvert: DocKind[] = d?.kind === 'estimate' ? ['sales_order', 'invoice'] : d?.kind === 'sales_order' ? ['invoice'] : d?.kind === 'purchase_order' ? ['bill'] : [];
  const isCredit = d?.kind === 'credit_note' || d?.kind === 'vendor_credit';
  const isRetainer = d?.kind === 'retainer_invoice';

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/[0.16]" onClick={onClose} aria-hidden />
      <aside className="fixed inset-y-0 right-0 z-50 w-full sm:w-[560px] bg-white border-l border-neutral-200 shadow-drawer flex flex-col" role="dialog" aria-label={d?.number ?? 'Document'} data-testid="document-drawer">
        <div className="h-12 px-4 flex items-center border-b border-neutral-200 shrink-0">
          <span className="text-13 font-medium text-neutral-900">{d ? `${DOC_LABEL[d.kind]} ${d.number}` : 'Loading…'}</span>
          {d ? <span className="ml-2"><StatusLabel {...docStatus(d.status)} /></span> : null}
          <div className="flex-1" />
          <button type="button" onClick={onClose} aria-label="Close" className="w-8 h-8 inline-flex items-center justify-center text-neutral-500 hover:text-neutral-900"><X size={16} /></button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-5">
          {q.isLoading ? <div className="h-40 bg-neutral-100 rounded" /> : !d ? <Empty>Not found.</Empty> : (
            <>
              <dl className="grid grid-cols-[130px_minmax(0,1fr)] gap-y-1.5 text-13">
                <dt className="text-neutral-500">{isSalesKind(d.kind) ? 'Customer' : 'Vendor'}</dt><dd className="text-neutral-900">{q.data!.contact?.display_name ?? '—'}</dd>
                <dt className="text-neutral-500">Date</dt><dd className="text-neutral-900 tabular-nums">{fmtDate(`${d.date}T00:00:00Z`)}</dd>
                {d.due_date ? <><dt className="text-neutral-500">Due</dt><dd className="text-neutral-900 tabular-nums">{fmtDate(`${d.due_date}T00:00:00Z`)}</dd></> : null}
                {d.reference_no ? <><dt className="text-neutral-500">Reference</dt><dd className="text-neutral-900">{d.reference_no}</dd></> : null}
                <dt className="text-neutral-500">Place of supply</dt><dd className="text-neutral-900">{d.place_of_supply ?? '—'} · {d.is_inter_state ? 'Inter-state (IGST)' : 'Intra-state (CGST + SGST)'}</dd>
                {d.currency !== 'INR' ? <><dt className="text-neutral-500">Currency</dt><dd className="text-neutral-900 tabular-nums">{d.currency} at {d.exchange_rate}</dd></> : null}
                {d.void_reason ? <><dt className="text-neutral-500">Void reason</dt><dd className="text-neutral-900">{d.void_reason}</dd></> : null}
              </dl>

              <section>
                <h3 className="text-11 uppercase tracking-[0.06em] text-neutral-500 mb-2">Lines</h3>
                <Table head={['Description', { label: 'Qty', align: 'right' }, { label: 'Rate', align: 'right' }, { label: 'Tax', align: 'right' }, { label: 'Amount', align: 'right' }]} minWidth={420}>
                  {d.lines.map((l) => (
                    <Row key={l.id}>
                      <Cell><div className="text-neutral-900">{l.description}</div>{l.hsn_sac ? <div className="text-11 text-neutral-500">HSN {l.hsn_sac}</div> : null}</Cell>
                      <Cell right muted className="tabular-nums">{l.quantity}</Cell>
                      <Cell right><Money value={l.rate} currency={d.currency} zero="0" /></Cell>
                      <Cell right muted className="tabular-nums">{l.tax_percent_bp ? `${l.tax_percent_bp / 100}%` : '—'}</Cell>
                      <Cell right><Money value={l.line_total} currency={d.currency} zero="0" /></Cell>
                    </Row>
                  ))}
                </Table>
                <div className="bg-neutral-50 border border-neutral-200 rounded p-3 mt-2 text-13">
                  <Amt label="Taxable value" v={d.taxable_total} c={d.currency} />
                  {d.is_inter_state ? <Amt label="IGST" v={d.igst_total} c={d.currency} /> : <><Amt label="CGST" v={d.cgst_total} c={d.currency} /><Amt label="SGST" v={d.sgst_total} c={d.currency} /></>}
                  {d.round_off !== 0 ? <Amt label="Round off" v={d.round_off} c={d.currency} /> : null}
                  <div className="border-t border-neutral-300 mt-1.5 pt-1.5"><Amt label="Total" v={d.total} c={d.currency} bold /></div>
                  {d.tds_total > 0 ? <><Amt label="Less: TDS" v={-d.tds_total} c={d.currency} /><Amt label="Payable" v={d.total - d.tds_total} c={d.currency} bold /></> : null}
                  {d.status !== 'draft' && !isCredit ? <Amt label="Balance due" v={d.balance_due} c={d.currency} bold /> : null}
                  {isCredit && d.status !== 'draft' ? <Amt label="Credit remaining" v={d.credits_remaining} c={d.currency} bold /> : null}
                </div>
              </section>

              {q.data!.journal ? (
                <section>
                  <h3 className="text-11 uppercase tracking-[0.06em] text-neutral-500 mb-2">Journal {q.data!.journal.number}</h3>
                  <Table head={['Account', { label: 'Debit', align: 'right' }, { label: 'Credit', align: 'right' }]} minWidth={360}>
                    {q.data!.journal!.lines?.map((l) => (
                      <Row key={l.id}>
                        <Cell>{l.ledger?.name ?? l.ledger_id}</Cell>
                        <Cell right><Money value={l.side === 'debit' ? l.amount : 0} /></Cell>
                        <Cell right><Money value={l.side === 'credit' ? l.amount : 0} /></Cell>
                      </Row>
                    ))}
                  </Table>
                </section>
              ) : null}

              {q.data!.applications.length ? (
                <section>
                  <h3 className="text-11 uppercase tracking-[0.06em] text-neutral-500 mb-2">Applied against this</h3>
                  <ul className="space-y-1 text-13">
                    {q.data!.applications.map((a) => (
                      <li key={a.id} className="flex items-baseline justify-between">
                        <span className="text-neutral-900">{a.journal ? `${VOUCHER_LABEL[a.journal.voucher_type] ?? a.journal.voucher_type} ${a.journal.number}` : a.type}<span className="text-neutral-500"> · {a.journal ? fmtDate(`${a.journal.date}T00:00:00Z`) : ''}</span></span>
                        <Money value={a.amount} zero="0" />
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

              <section>
                <h3 className="text-11 uppercase tracking-[0.06em] text-neutral-500 mb-2">Audit trail</h3>
                <ol className="space-y-1.5">
                  {q.data!.audit.map((e) => (
                    <li key={e.id} className="text-13">
                      <div className="text-neutral-900">{e.action.replace(/[._]/g, ' ')}</div>
                      <div className="text-12 text-neutral-500 tabular-nums">{fmtDateTime(e.created_at)}</div>
                    </li>
                  ))}
                </ol>
              </section>
            </>
          )}
        </div>

        {d ? (
          <div className="px-4 py-3 border-t border-neutral-200 shrink-0 space-y-2">
            {confirmVoid ? (
              <div className="space-y-2">
                <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (recorded in the audit trail)" className={inputCls} />
                <Notice tone="warn">Voiding posts a dated reversing journal. The original stays in the books.</Notice>
                <div className="flex gap-2 justify-end">
                  <Button variant="ghost" size="sm" onClick={() => setConfirmVoid(false)}>Cancel</Button>
                  <Button variant="danger" size="sm" onClick={() => voidIt.mutate()} disabled={voidIt.isPending} data-testid="document-void-confirm">{voidIt.isPending ? 'Voiding…' : 'Void document'}</Button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap gap-2 justify-end">
                {['draft', 'sent'].includes(d.status) ? <Button variant="secondary" size="sm" onClick={() => onEdit(d.id)}>Edit</Button> : null}
                {canConvert.map((to) => <Button key={to} variant="secondary" size="sm" onClick={() => convert.mutate(to)} disabled={convert.isPending}>Convert to {DOC_LABEL[to].toLowerCase()}</Button>)}
                {(isCredit || isRetainer) && d.status !== 'draft' && d.status !== 'void' && (isCredit ? d.credits_remaining > 0 : true) ? (
                  <Button variant="secondary" size="sm" onClick={() => setApplying(true)} data-testid="document-apply">Apply to {isRetainer ? 'invoice' : isSalesKind(d.kind) ? 'invoices' : 'bills'}</Button>
                ) : null}
                {canPost ? <Button variant="primary" size="sm" onClick={() => post.mutate()} disabled={post.isPending} data-testid="document-post">{post.isPending ? 'Posting…' : 'Post to ledger'}</Button> : null}
                {d.status !== 'void' && d.status !== 'draft' ? <Button variant="danger" size="sm" onClick={() => setConfirmVoid(true)} data-testid="document-void">Void</Button> : null}
              </div>
            )}
          </div>
        ) : null}
      </aside>

      {applying && d ? <ApplyModal orgId={orgId} doc={d} onClose={() => setApplying(false)} onDone={() => { setApplying(false); refresh(); }} /> : null}
    </>
  );
}

function Amt({ label, v, c, bold }: { label: string; v: number; c: string; bold?: boolean }) {
  return <div className="flex items-baseline justify-between py-0.5"><span className={bold ? 'text-neutral-900 font-medium' : 'text-neutral-500'}>{label}</span><Money value={v} currency={c} bold={bold} zero="0" /></div>;
}

/** Manual credit / retainer application — the user picks the targets and the amounts. */
function ApplyModal({ orgId, doc, onClose, onDone }: { orgId: string; doc: { id: string; kind: DocKind; contact_id: string; currency: string; credits_remaining: number; taxable_total: number }; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const api = booksApi.org(orgId);
  const isRetainer = doc.kind === 'retainer_invoice';
  const targetSide = doc.kind === 'vendor_credit' ? 'credit' : 'debit';
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const open = useQuery({ queryKey: ['books', orgId, 'open-items', targetSide, doc.contact_id], queryFn: () => api.openItems({ side: targetSide, contact_id: doc.contact_id }) });
  const targets = (open.data?.items ?? []).filter((b) => b.document && b.document.kind === (doc.kind === 'vendor_credit' ? 'bill' : 'invoice') && b.source_id !== doc.id);
  const available = isRetainer ? doc.taxable_total : doc.credits_remaining;
  const entered = Object.values(amounts).reduce((t, v) => t + toPaise(v || '0'), 0);

  const apply = useMutation({
    mutationFn: () => {
      const applications = Object.entries(amounts).filter(([, v]) => toPaise(v || '0') > 0).map(([document_id, v]) => ({ document_id, amount: toPaise(v) }));
      return isRetainer ? api.documents.applyRetainer(doc.id, applications) : api.documents.applyCredit(doc.kind, doc.id, applications);
    },
    onSuccess: () => { toast.push('success', isRetainer ? 'Retainer applied — revenue recognised.' : 'Credit applied.'); onDone(); },
    onError: (e: Error) => setError(e.message),
  });

  return (
    <div role="dialog" aria-modal className="fixed inset-0 z-[60] grid place-items-center bg-neutral-900/30 p-4" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-full max-w-[560px] bg-white border border-neutral-200 rounded shadow-drawer p-5">
        <h2 className="text-16 font-semibold text-neutral-900">{isRetainer ? 'Apply retainer' : 'Apply credit'}</h2>
        <p className="text-13 text-neutral-500 mt-1">Choose which documents to apply against and how much. Nothing is applied automatically.</p>
        <div className="mt-3 text-13 text-neutral-900">Available: <span className="tabular-nums font-medium">{money(available, doc.currency)}</span></div>
        <div className="mt-3 max-h-[320px] overflow-y-auto border border-neutral-200 rounded">
          {targets.length === 0 ? <Empty>Nothing outstanding to apply to.</Empty> : (
            <table className="w-full border-collapse">
              <tbody>
                {targets.map((b) => (
                  <tr key={b.id} className="border-b border-neutral-200 last:border-0">
                    <td className="px-3 py-2 text-13 text-neutral-900">{b.document!.number}<div className="text-11 text-neutral-500">{fmtDate(`${b.date}T00:00:00Z`)} · outstanding {money(b.fx_balance, b.currency)}</div></td>
                    <td className="px-3 py-2 w-[140px]">
                      <input value={amounts[b.source_id] ?? ''} onChange={(e) => setAmounts((a) => ({ ...a, [b.source_id]: e.target.value.replace(/[^\d.]/g, '') }))}
                        placeholder={fromPaise(Math.min(b.fx_balance, available))} className={`${inputCls} text-right tabular-nums`} inputMode="decimal" data-testid={`apply-amount-${b.document!.number}`} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        {error ? <div className="mt-3"><Notice tone="error">{error}</Notice></div> : entered > available ? <div className="mt-3"><Notice tone="warn">You have entered more than is available.</Notice></div> : null}
        <div className="flex justify-end gap-2 mt-4">
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="sm" onClick={() => { setError(null); apply.mutate(); }} disabled={apply.isPending || entered <= 0 || entered > available} data-testid="apply-submit">{apply.isPending ? 'Applying…' : 'Apply'}</Button>
        </div>
      </div>
    </div>
  );
}
