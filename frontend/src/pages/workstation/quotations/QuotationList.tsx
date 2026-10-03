import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { QueryState } from '@/modules/workstation/components';
import {
  DateRange, ListAction, ListCard, ListEmpty, ListHeader, ListRow, ListTable, ListToolbar, Money, SearchBox,
  Spacer, StatusChip, StatusPills, TD, TwoLine, fmtDay,
} from '@/modules/workstation/listUi';
import { quotationsApi, inr, type QuotationFilters } from '@/modules/workstation/quotations/api';
import { useAuth } from '@/platform/auth/AuthContext';
import { can } from '@/platform/rbac/can';

/**
 * /workstation/quotations — the quotation register.
 *
 * The counts come from the server's summary, which resolves the caller's OWN
 * scope before counting; an executive's "5 sent" and a manager's "5 sent" are
 * different sets and both are correct. Nothing is filtered here in the
 * browser — every filter is a query parameter.
 */

const STATUSES = [
  { value: 'all', label: 'All' },
  { value: 'draft', label: 'Draft' },
  { value: 'sent', label: 'Sent' },
  { value: 'accepted', label: 'Accepted' },
  { value: 'rejected', label: 'Rejected' },
  // Expired is a SENT quotation past its date — not a stored status. It is
  // counted separately because it is the one that needs chasing.
  { value: 'expired', label: 'Expired' },
];

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

  const s = summaryQ.data;
  const total = listQ.data?.total ?? listQ.data?.items.length;

  return (
    <div className="max-w-[1400px]">
      <ListHeader
        title="Quotations"
        meta={<>
          {total === undefined ? 'Loading…' : `${total} quotation${total === 1 ? '' : 's'} · newest first`}
          {s && s.accepted_value_paise > 0
            ? <> · <span className="text-neutral-700 tabular-nums">{inr(s.accepted_value_paise)}</span> accepted</>
            : null}
        </>}
        action={canManage ? <ListAction to="/workstation/quotations/new" icon={<Plus size={15} />}>New quotation</ListAction> : null}
      />

      <ListToolbar>
        <SearchBox value={filters.q ?? ''} onChange={(v) => set('q', v)} placeholder="Search number, subject or party" />
        <DateRange from={filters.date_from ?? ''} to={filters.date_to ?? ''}
          onFrom={(v) => set('date_from', v)} onTo={(v) => set('date_to', v)} />
        <Spacer />
        <StatusPills options={STATUSES} value={filters.status ?? 'all'} onChange={(v) => set('status', v)}
          counts={s ? { draft: s.draft, sent: s.sent, accepted: s.accepted, rejected: s.rejected, expired: s.expired } : undefined} />
      </ListToolbar>

      <ListCard>
        <QueryState query={listQ} empty={<ListEmpty>No quotations yet.</ListEmpty>}>
          {(data) => data.items.length === 0 ? <ListEmpty>Nothing matches these filters.</ListEmpty> : (
            <ListTable cols={['Number', 'Client', 'Subject', 'Date', 'Valid until', 'Status', { label: 'Total', align: 'right' }]}>
              {data.items.map((q) => (
                <ListRow key={q.id} onOpen={() => navigate(`/workstation/quotations/${q.id}`)}>
                  <TD first strong nowrap className="tracking-[0.02em]">{q.quotation_code}</TD>
                  <TD><TwoLine avatar={q.party_name} square top={q.party_name ?? 'Unknown client'} sub={q.party_kind === 'lead' ? 'Lead' : 'Client'} /></TD>
                  <TD muted className="max-w-[280px] truncate" title={q.subject}>{q.subject}</TD>
                  <TD muted nowrap>{fmtDay(q.quote_date)}</TD>
                  <TD muted nowrap>{fmtDay(q.valid_until)}</TD>
                  <TD><StatusChip value={q.status} /></TD>
                  <TD last right strong nowrap className="tabular-nums"><Money value={inr(q.total_paise)} /></TD>
                </ListRow>
              ))}
            </ListTable>
          )}
        </QueryState>
      </ListCard>
    </div>
  );
}
