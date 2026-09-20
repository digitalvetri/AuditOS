import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import {
  PageHeader, Card, Table, Row, Cell, FilterBar, Select, SearchInput, Status, QueryState,
} from '@/modules/workstation/components';
import { quotationsApi, inr, type QuotationFilters } from '@/modules/workstation/quotations/api';
import { useAuth } from '@/platform/auth/AuthContext';
import { can } from '@/platform/rbac/can';

/**
 * /workstation/quotations — the quotation register.
 *
 * The tiles count the caller's OWN scope, because the server resolves scope
 * before counting; an executive's "5 sent" and a manager's "5 sent" are
 * different sets and both are correct. Nothing is filtered here in the
 * browser.
 */
export function QuotationListPage() {
  const { session } = useAuth();
  const canManage = can(session?.role.code, 'workstation.quotation.manage', 'self');
  const navigate = useNavigate();

  const [filters, setFilters] = useState<QuotationFilters>({ status: 'all', limit: 50 });

  const summaryQ = useQuery({ queryKey: ['quotations.summary'], queryFn: () => quotationsApi.summary() });
  const listQ = useQuery({
    queryKey: ['quotations.list', filters],
    queryFn: () => quotationsApi.list(filters),
  });

  const set = <K extends keyof QuotationFilters>(k: K, v: QuotationFilters[K]) =>
    setFilters((f) => ({ ...f, [k]: v }));

  return (
    <div>
      <PageHeader
        title="Quotation"
        subtitle="Priced proposals to prospects and clients. An accepted quotation is what authorises the work."
        action={canManage ? (
          <Link
            to="/workstation/quotations/new"
            className="h-8 px-3 inline-flex items-center gap-1.5 text-13 rounded bg-neutral-900 text-white hover:bg-neutral-800"
          >
            <Plus size={14} /> New quotation
          </Link>
        ) : null}
      />

      <QueryState query={summaryQ}>
        {(s) => (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mb-4">
            <Tile label="Draft" value={String(s.draft)} onClick={() => set('status', 'draft')} />
            <Tile label="Sent" value={String(s.sent)} onClick={() => set('status', 'sent')} />
            {/* Expired is a SENT quotation past its date — not a stored status.
                It is counted separately because it is the one that needs chasing. */}
            <Tile label="Expired" value={String(s.expired)} onClick={() => set('status', 'expired')} />
            <Tile label="Accepted" value={String(s.accepted)} onClick={() => set('status', 'accepted')} />
            <Tile label="Accepted value" value={inr(s.accepted_value_paise)} />
          </div>
        )}
      </QueryState>

      <FilterBar>
        <Select
          label="Status"
          value={filters.status ?? 'all'}
          onChange={(v) => set('status', v)}
          options={[
            { value: 'all', label: 'All' },
            { value: 'draft', label: 'Draft' },
            { value: 'sent', label: 'Sent' },
            { value: 'expired', label: 'Expired' },
            { value: 'accepted', label: 'Accepted' },
            { value: 'rejected', label: 'Rejected' },
          ]}
        />
        <label className="block">
          <span className="block text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">From</span>
          <input
            type="date"
            value={filters.date_from ?? ''}
            onChange={(e) => set('date_from', e.target.value)}
            className="h-8 px-2 text-13 bg-white text-neutral-900 border border-neutral-300 rounded focus:outline-none focus:border-gold"
          />
        </label>
        <label className="block">
          <span className="block text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">To</span>
          <input
            type="date"
            value={filters.date_to ?? ''}
            onChange={(e) => set('date_to', e.target.value)}
            className="h-8 px-2 text-13 bg-white text-neutral-900 border border-neutral-300 rounded focus:outline-none focus:border-gold"
          />
        </label>
        <SearchInput
          value={filters.q ?? ''}
          onChange={(v) => set('q', v)}
          placeholder="Code, subject or party"
        />
      </FilterBar>

      <Card>
        <QueryState
          query={listQ}
          empty={<div className="px-4 py-6 text-13 text-neutral-500">No quotations yet.</div>}
        >
          {(data) => data.items.length === 0 ? (
            <div className="px-4 py-6 text-13 text-neutral-500">Nothing matches these filters.</div>
          ) : (
            <Table head={['Code', 'Party', 'Subject', 'Date', 'Valid until', 'Total', 'Status']}>
              {data.items.map((q) => (
                <Row key={q.id} status={q.status} onClick={() => navigate(`/workstation/quotations/${q.id}`)}>
                  <Cell className="font-medium whitespace-nowrap">{q.quotation_code}</Cell>
                  <Cell>
                    {q.party_name ?? '—'}
                    <span className="text-neutral-500"> · {q.party_kind === 'lead' ? 'Lead' : 'Client'}</span>
                  </Cell>
                  <Cell muted>{q.subject}</Cell>
                  <Cell muted className="whitespace-nowrap">{q.quote_date}</Cell>
                  <Cell muted className="whitespace-nowrap">{q.valid_until}</Cell>
                  <Cell className="whitespace-nowrap tabular-nums">{inr(q.total_paise)}</Cell>
                  <Cell><Status value={q.status} /></Cell>
                </Row>
              ))}
            </Table>
          )}
        </QueryState>
      </Card>
    </div>
  );
}

function Tile({ label, value, onClick }: { label: string; value: string; onClick?: () => void }) {
  const inner = (
    <>
      <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">{label}</div>
      <div className="text-20 font-semibold text-neutral-900 mt-1 tabular-nums">{value}</div>
    </>
  );
  if (!onClick) {
    return <div className="bg-white border border-neutral-200 rounded p-3">{inner}</div>;
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-left bg-white border border-neutral-200 rounded p-3 hover:border-gold transition-colors"
    >
      {inner}
    </button>
  );
}
