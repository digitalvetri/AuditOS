import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { creditNotesApi, CREDIT_NOTE_REASON_LABEL, type CreditNote } from '@/modules/workstation/creditNotes/api';
import { inrAmount } from '@/modules/workstation/invoices/document';
import { QueryState } from '@/modules/workstation/components';
import {
  ListCard, ListEmpty, ListHeader, ListRow, ListTable, ListToolbar, Money, SearchBox, Spacer,
  StatusChip, StatusPills, TD, TwoLine, fmtDay,
} from '@/modules/workstation/listUi';

/**
 * Workstation → Credit notes. Every credit note raised against an invoice —
 * a fee revised after billing, a post-sale discount, a service withdrawn.
 * A note is raised from its invoice (Actions → Issue credit note).
 */

const STATUSES = [
  { value: '', label: 'All' },
  { value: 'draft', label: 'Draft' },
  { value: 'issued', label: 'Issued' },
  { value: 'cancelled', label: 'Cancelled' },
];

export function CreditNoteListPage() {
  const navigate = useNavigate();
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const list = useQuery({
    queryKey: ['creditNotes.list', { status, q }],
    queryFn: () => creditNotesApi.list({ status: status || undefined, q: q || undefined }),
  });
  const total = list.data?.total;

  return (
    <div className="max-w-[1400px]">
      <ListHeader
        title="Credit notes"
        meta={total === undefined ? 'Loading…' : <>
          {total} credit note{total === 1 ? '' : 's'} · raise one from an invoice&apos;s Actions menu
        </>}
      />

      <ListToolbar>
        <SearchBox value={q} onChange={setQ} placeholder="CN number, invoice or client…" />
        <Spacer />
        <StatusPills options={STATUSES} value={status} onChange={setStatus} />
      </ListToolbar>

      <ListCard>
        <QueryState query={list} empty={<ListEmpty>No credit notes yet.</ListEmpty>}>
          {(data: { items: CreditNote[] }) => data.items.length === 0 ? <ListEmpty>Nothing matches these filters.</ListEmpty> : (
            <ListTable cols={[
              'Number', 'Date', 'Invoice', 'Client', 'Reason', { label: 'Total', align: 'right' }, 'Status',
            ]}>
              {data.items.map((cn) => (
                <ListRow key={cn.id} onOpen={() => navigate(`/workstation/credit-notes/${cn.id}`)}>
                  <TD first strong nowrap className="tracking-[0.02em]">{cn.display_number}</TD>
                  <TD muted nowrap>{fmtDay(cn.note_date)}</TD>
                  <TD nowrap>
                    <button type="button" className="text-13 text-primary hover:underline whitespace-nowrap"
                      onClick={(e) => { e.stopPropagation(); navigate(`/workstation/invoices/${cn.invoice_id}`); }}>
                      {cn.invoice_number ?? 'Invoice'}
                    </button>
                  </TD>
                  <TD><TwoLine avatar={cn.client_name} square top={cn.client_name || '—'} /></TD>
                  <TD muted>{CREDIT_NOTE_REASON_LABEL[cn.reason] ?? cn.reason}</TD>
                  <TD right strong nowrap className="tabular-nums"><Money value={`₹${inrAmount(cn.total_paise)}`} /></TD>
                  <TD last><StatusChip value={cn.status} /></TD>
                </ListRow>
              ))}
            </ListTable>
          )}
        </QueryState>
      </ListCard>
    </div>
  );
}
