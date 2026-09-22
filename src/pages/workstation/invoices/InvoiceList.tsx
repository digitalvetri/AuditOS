import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { invoicesApi, type Invoice } from '@/modules/workstation/invoices/api';
import { inrAmount } from '@/modules/workstation/invoices/document';
import {
  Card, Cell, FilterBar, PageHeader, QueryState, Row, SearchInput, Select, Table,
} from '@/modules/workstation/components';
import { Button } from '@/components/Button';
import { fmtDate } from '@/lib/format';
import { can } from '@/platform/rbac/can';
import { useAuth } from '@/platform/auth/AuthContext';
import { StatusPill } from './InvoiceBuilder';

/**
 * Workstation → Invoice. The list, its filters and the money that matters at
 * a glance: what is outstanding and how much of it is late.
 */
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

  return (
    <>
      <PageHeader
        title="Invoices"
        subtitle="Tax invoices raised against clients. A number is allocated on first save and never reused."
        action={mayWrite ? (
          <Button variant="primary" onClick={() => navigate('/workstation/invoices/new')}>
            Create invoice
          </Button>
        ) : undefined}
      />

      {summary.data ? (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
          <Stat label="Invoices" value={String(summary.data.total)} />
          <Stat label="Outstanding" value={`₹ ${inrAmount(summary.data.outstanding_paise)}`} />
          <Stat label="Overdue" value={`₹ ${inrAmount(summary.data.overdue_paise)}`} tone="red" />
          <Stat label="Paid" value={String(summary.data.counts.paid ?? 0)} />
        </div>
      ) : null}

      <Card title="All invoices">
        <FilterBar>
          <Select label="Status" allLabel="Every status" value={status} onChange={setStatus} options={[
            { value: 'draft', label: 'Draft' },
            { value: 'sent', label: 'Sent' },
            { value: 'partially_paid', label: 'Partially paid' },
            { value: 'paid', label: 'Paid' },
            { value: 'overdue', label: 'Overdue' },
            { value: 'cancelled', label: 'Cancelled' },
          ]} />
          <SearchInput value={q} onChange={setQ} placeholder="Invoice number or client…" />
        </FilterBar>

        <QueryState query={list} empty="No invoices yet.">
          {(data: { items: Invoice[] }) => (
            <Table head={['Invoice', 'Client', 'Date', 'Due', 'Status', 'Total', 'Balance', '', '']}>
              {data.items.map((inv) => {
                const draft = inv.stored_status === 'draft';
                return (
                  <Row key={inv.id} status={inv.status} onClick={() => navigate(`/workstation/invoices/${inv.id}`)}>
                    <Cell>{inv.invoice_number}</Cell>
                    <Cell>{inv.billing_name || inv.client_name || '—'}</Cell>
                    <Cell>{fmtDate(inv.invoice_date)}</Cell>
                    <Cell>{fmtDate(inv.due_date)}</Cell>
                    <Cell><StatusPill status={inv.status} /></Cell>
                    <Cell>{inrAmount(inv.total_paise)}</Cell>
                    <Cell>{inrAmount(inv.balance_due_paise)}</Cell>
                    <Cell>
                      <button
                        type="button"
                        className="text-13 text-primary hover:underline"
                        onClick={(e) => {
                          e.stopPropagation();
                          navigate(draft && mayWrite
                            ? `/workstation/invoices/${inv.id}/edit`
                            : `/workstation/invoices/${inv.id}`);
                        }}
                      >
                        {draft && mayWrite ? 'Continue building' : 'View'}
                      </button>
                    </Cell>
                    <Cell>
                      <button
                        type="button"
                        className="text-13 text-primary hover:underline"
                        onClick={(e) => {
                          e.stopPropagation();
                          navigate(`/workstation/invoices/${inv.id}/preview`);
                        }}
                      >
                        Preview
                      </button>
                    </Cell>
                  </Row>
                );
              })}
            </Table>
          )}
        </QueryState>
      </Card>
    </>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'red' }) {
  return (
    <div className="border border-neutral-200 rounded bg-white px-3 py-2">
      <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">{label}</div>
      <div className={`text-16 font-semibold ${tone === 'red' ? 'text-red' : 'text-neutral-900'}`}>{value}</div>
    </div>
  );
}
