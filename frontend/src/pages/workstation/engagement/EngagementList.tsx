import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { QueryState } from '@/modules/workstation/components';
import {
  ListAction, ListCard, ListEmpty, ListHeader, ListRow, ListTable, ListToolbar, SearchBox, Spacer, StatusChip,
  StatusPills, TD, TwoLine, fmtDay,
} from '@/modules/workstation/listUi';
import { engagementApi, type EngagementLetter } from '@/modules/workstation/engagement/api';
import { useAuth } from '@/platform/auth/AuthContext';
import { can } from '@/platform/rbac/can';

/**
 * /workstation/engagement — every engagement letter, and the way to start one.
 *
 * The row action follows state, as on the client's quotation tab: a draft is
 * carried on building; anything sent is frozen, so it opens read-only in the
 * builder and changes are made by duplicating it.
 */
export function EngagementListPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { session } = useAuth();
  const mayWrite = can(session?.role.code, 'workstation.engagement.manage', 'self');
  const [status, setStatus] = useState('all');
  const [q, setQ] = useState('');

  const list = useQuery({
    queryKey: ['engagement.list', status, q],
    queryFn: () => engagementApi.list({ status, q: q.trim() || undefined, limit: 100 }),
  });

  const act = useMutation({
    mutationFn: async ({ id, op }: { id: string; op: 'send' | 'accept' | 'archive' | 'unarchive' | 'duplicate' | 'remove' }) => {
      await engagementApi[op](id);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['engagement.list'] }),
  });

  const opsFor = (l: EngagementLetter) => {
    const ops: { op: 'send' | 'accept' | 'archive' | 'unarchive' | 'duplicate' | 'remove'; label: string }[] = [];
    if (l.status === 'draft') ops.push({ op: 'send', label: 'Mark sent' });
    if (l.status === 'sent') ops.push({ op: 'accept', label: 'Mark accepted' });
    ops.push({ op: 'duplicate', label: 'Duplicate' });
    if (l.status !== 'archived') ops.push({ op: 'archive', label: 'Archive' });
    else ops.push({ op: 'unarchive', label: 'Restore from archive' });
    if (l.status === 'draft') ops.push({ op: 'remove', label: 'Delete' });
    return ops;
  };

  const total = list.data?.total ?? list.data?.items.length;

  return (
    <div className="max-w-[1400px]">
      <ListHeader
        title="Engagement Letters"
        meta={total === undefined ? 'Loading…' : `${total} letter${total === 1 ? '' : 's'} · newest first`}
        action={mayWrite ? (
          <ListAction onClick={() => navigate('/workstation/engagement/new')} icon={<Plus size={15} />}>New engagement letter</ListAction>
        ) : null}
      />

      <ListToolbar>
        <SearchBox value={q} onChange={setQ} placeholder="Search reference, subject or client" />
        <Spacer />
        <StatusPills value={status} onChange={setStatus} options={[
          { value: 'all', label: 'All' },
          { value: 'draft', label: 'Draft' },
          { value: 'sent', label: 'Sent' },
          { value: 'accepted', label: 'Accepted' },
          { value: 'archived', label: 'Archived' },
        ]} />
      </ListToolbar>

      {act.isError ? (
        <div className="border-l-2 border-red pl-3 text-13 mb-3">
          {(act.error as { message?: string })?.message ?? 'That could not be done.'}
        </div>
      ) : null}

      <ListCard>
        <QueryState query={list} empty={<ListEmpty>No engagement letters yet.</ListEmpty>}>
          {(data) => data.items.length === 0 ? <ListEmpty>Nothing matches these filters.</ListEmpty> : (
            <ListTable cols={['Reference', 'Client', 'Subject', 'Date', 'Financial year', 'Status', { label: '', key: 'actions' }]}>
              {data.items.map((l) => (
                <ListRow key={l.id} onOpen={() => navigate(`/workstation/engagement/${l.id}/edit`)}>
                  <TD first strong nowrap className="tracking-[0.02em]">{l.letter_code}</TD>
                  <TD><TwoLine top={l.party_name ?? '—'} sub={l.party_kind === 'lead' ? 'Lead' : l.party_kind === 'client' ? 'Client' : undefined} /></TD>
                  <TD muted className="max-w-[320px] truncate" title={l.subject}>{l.subject}</TD>
                  <TD muted nowrap>{fmtDay(l.letter_date)}</TD>
                  <TD muted nowrap>{l.financial_year ?? '—'}</TD>
                  <TD><StatusChip value={l.status} /></TD>
                  <TD last right>
                    {mayWrite ? (
                      <select
                        value=""
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => {
                          const op = e.target.value as ReturnType<typeof opsFor>[number]['op'];
                          if (!op) return;
                          if (op === 'remove' && !window.confirm(`Delete ${l.letter_code}? This cannot be undone.`)) return;
                          act.mutate({ id: l.id, op });
                        }}
                        className="h-8 px-2 text-12 text-neutral-700 border border-neutral-200 rounded-lg bg-white hover:border-neutral-300 focus:outline-none focus:border-primary/60"
                        aria-label={`Actions for ${l.letter_code}`}
                      >
                        <option value="">Actions…</option>
                        {opsFor(l).map((o) => <option key={o.op} value={o.op}>{o.label}</option>)}
                      </select>
                    ) : null}
                  </TD>
                </ListRow>
              ))}
            </ListTable>
          )}
        </QueryState>
      </ListCard>
    </div>
  );
}
