import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { invoicesApi, type Invoice } from '@/modules/workstation/invoices/api';
import { inrAmount } from '@/modules/workstation/invoices/document';
import { QueryState } from '@/modules/workstation/components';
import {
  ListAction, ListCard, ListEmpty, ListHeader, ListRow, ListTable, ListToolbar, Money, SearchBox, Spacer,
  StatusChip, TwoLine, StatusPills, TD, fmtDay,
} from '@/modules/workstation/listUi';
import { can } from '@/platform/rbac/can';
import { useAuth } from '@/platform/auth/AuthContext';

/**
 * Workstation → Invoice. The list, its filters and the money that matters at
 * a glance: what is outstanding and how much of it is late.
 */

const STATUSES = [
  { value: '', label: 'All' },
  { value: 'draft', label: 'Draft' },
  { value: 'sent', label: 'Sent' },
  { value: 'partially_paid', label: 'Partially paid' },
  { value: 'paid', label: 'Paid' },
  { value: 'overdue', label: 'Overdue' },
  { value: 'cancelled', label: 'Cancelled' },
  // Not a stored status: settled beyond the total, money owed back.
  { value: 'refund_due', label: 'Refund due' },
];

const link = 'text-13 text-primary hover:underline whitespace-nowrap';

export function InvoiceListPage() {
  const navigate = useNavigate();
  const { session } = useAuth();
  const mayWrite = can(session?.role.code, 'workstation.invoice.manage', 'self');

  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');

  const list = useQuery({
    queryKey: ['invoices.list', status, q],
    queryFn: () => invoicesApi.list({ status: status || undefined, q: q || undefined, limit: 100 }),
  });
  const summary = useQuery({ queryKey: ['invoices.summary'], queryFn: () => invoicesApi.summary() });
  const s = summary.data;

  return (
    <div className="max-w-[1400px]">
      <ListHeader
        title="Invoices"
        meta={s ? <>
          {s.total} invoice{s.total === 1 ? '' : 's'} · newest first
          {' · '}<span className="text-neutral-700 tabular-nums">₹ {inrAmount(s.outstanding_paise)}</span> outstanding
          {s.overdue_paise > 0 ? <> · <span className="text-red tabular-nums">₹ {inrAmount(s.overdue_paise)}</span> overdue</> : null}
          {(s.refund_due_paise ?? 0) > 0 ? <> · <span className="text-warning tabular-nums">₹ {inrAmount(s.refund_due_paise)}</span> due back to clients</> : null}
        </> : 'Loading…'}
        action={mayWrite ? (
          <ListAction onClick={() => navigate('/workstation/invoices/new')} icon={<Plus size={15} />}>Create invoice</ListAction>
        ) : undefined}
      />

      <ListToolbar>
        <SearchBox value={q} onChange={setQ} placeholder="Invoice number or client…" />
        <Spacer />
        <StatusPills options={STATUSES} value={status} onChange={setStatus} counts={s?.counts} />
      </ListToolbar>

      <ListCard>
        <QueryState query={list} empty={<ListEmpty>No invoices yet.</ListEmpty>}>
          {(data: { items: Invoice[] }) => data.items.length === 0 ? <ListEmpty>Nothing matches these filters.</ListEmpty> : (
            <ListTable cols={[
              'Invoice', 'Client', 'Date', 'Due', 'Status',
              { label: 'Total', align: 'right' }, { label: 'Balance', align: 'right' },
              { label: '', key: 'open' }, { label: '', key: 'preview' },
            ]}>
              {data.items.map((inv) => {
                const draft = inv.stored_status === 'draft';
                return (
                  <ListRow key={inv.id} onOpen={() => navigate(`/workstation/invoices/${inv.id}`)}>
                    <TD first strong nowrap className="tracking-[0.02em]">{inv.invoice_number ?? 'Draft'}</TD>
                    <TD><TwoLine avatar={inv.billing_name || inv.client_name} square top={inv.billing_name || inv.client_name || '—'} /></TD>
                    <TD muted nowrap>{fmtDay(inv.invoice_date)}</TD>
                    <TD muted nowrap>{fmtDay(inv.due_date)}</TD>
                    <TD><StatusChip value={inv.status} /></TD>
                    <TD right strong nowrap className="tabular-nums"><Money value={`₹${inrAmount(inv.total_paise)}`} /></TD>
                    <TD right nowrap className="tabular-nums">
                      <Money value={`₹${inrAmount(inv.balance_due_paise)}`} />
                      {(inv.tds_deducted_paise ?? 0) > 0 || (inv.credited_paise ?? 0) > 0 ? (
                        <span className="block text-11 text-neutral-500"
                          title={`TDS ₹${inrAmount(inv.tds_deducted_paise ?? 0)} · Credit notes ₹${inrAmount(inv.credited_paise ?? 0)}`}>
                          {[(inv.tds_deducted_paise ?? 0) > 0 ? 'TDS' : '', (inv.credited_paise ?? 0) > 0 ? 'CN' : ''].filter(Boolean).join(' + ')} adjusted
                        </span>
                      ) : null}
                      {(inv.refund_due_paise ?? 0) > 0 ? (
                        <span className="mt-0.5 inline-block rounded-full bg-warning/10 text-warning text-11 font-semibold px-2 py-[1px] whitespace-nowrap"
                          title="Settled beyond the total — record a refund">
                          Refund due ₹{inrAmount(inv.refund_due_paise)}
                        </span>
                      ) : null}
                    </TD>
                    <TD>
                      <button
                        type="button"
                        className={link}
                        onClick={(e) => {
                          e.stopPropagation();
                          navigate(draft && mayWrite
                            ? `/workstation/invoices/${inv.id}/edit`
                            : `/workstation/invoices/${inv.id}`);
                        }}
                      >
                        {draft && mayWrite ? 'Continue building' : 'View'}
                      </button>
                    </TD>
                    <TD last>
                      <button
                        type="button"
                        className={link}
                        onClick={(e) => {
                          e.stopPropagation();
                          navigate(`/workstation/invoices/${inv.id}/preview`);
                        }}
                      >
                        Preview
                      </button>
                    </TD>
                  </ListRow>
                );
              })}
            </ListTable>
          )}
        </QueryState>
      </ListCard>
    </div>
  );
}
