import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { Cell, QueryState, Row, Status, Table, inputClass } from '@/modules/workstation/components';
import { engagementApi, type EngagementLetter } from '@/modules/workstation/engagement/api';
import { fmtDate } from '@/lib/format';
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
    mutationFn: async ({ id, op }: { id: string; op: 'send' | 'accept' | 'archive' | 'duplicate' | 'remove' }) => {
      await engagementApi[op](id);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['engagement.list'] }),
  });

  const opsFor = (l: EngagementLetter) => {
    const ops: { op: 'send' | 'accept' | 'archive' | 'duplicate' | 'remove'; label: string }[] = [];
    if (l.status === 'draft') ops.push({ op: 'send', label: 'Mark sent' });
    if (l.status === 'sent') ops.push({ op: 'accept', label: 'Mark accepted' });
    ops.push({ op: 'duplicate', label: 'Duplicate' });
    if (l.status !== 'archived') ops.push({ op: 'archive', label: 'Archive' });
    if (l.status === 'draft') ops.push({ op: 'remove', label: 'Delete' });
    return ops;
  };

  return (
    <div className="space-y-4">
      <header className="flex items-start gap-3 flex-wrap">
        <div>
          <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">Workstation</div>
          <h1 className="text-20 font-semibold text-neutral-900 mt-0.5">Engagement Letters</h1>
        </div>
        <div className="flex-1" />
        {mayWrite ? (
          <button
            type="button"
            onClick={() => navigate('/workstation/engagement/new')}
            className="h-8 px-3 inline-flex items-center gap-1.5 text-13 rounded bg-neutral-900 text-white hover:bg-neutral-800"
          >
            <Plus size={14} /> New engagement letter
          </button>
        ) : null}
      </header>

      <div className="flex gap-2 flex-wrap">
        <select value={status} onChange={(e) => setStatus(e.target.value)} className={`${inputClass} w-40`}>
          {['all', 'draft', 'sent', 'accepted', 'archived'].map((s) => (
            <option key={s} value={s}>{s === 'all' ? 'All statuses' : s[0].toUpperCase() + s.slice(1)}</option>
          ))}
        </select>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search reference, subject or client" className={`${inputClass} w-72`} />
      </div>

      {act.isError ? (
        <div className="border-l-2 border-red pl-3 text-13">
          {(act.error as { message?: string })?.message ?? 'That could not be done.'}
        </div>
      ) : null}

      <QueryState query={list} empty="No engagement letters yet.">
        {(data) => (
          <Table head={['Reference', 'Client', 'Subject', 'Date', 'Financial year', 'Status', '']}>
            {data.items.map((l) => (
              <Row key={l.id} status={l.status} onClick={() => navigate(`/workstation/engagement/${l.id}/edit`)}>
                <Cell className="font-medium">{l.letter_code}</Cell>
                <Cell>{l.party_name ?? '—'}</Cell>
                <Cell>{l.subject}</Cell>
                <Cell muted>{fmtDate(l.letter_date)}</Cell>
                <Cell muted>{l.financial_year ?? '—'}</Cell>
                <Cell><Status value={l.status} /></Cell>
                <Cell>
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
                      className="h-7 px-1 text-12 border border-neutral-300 rounded bg-white"
                      aria-label={`Actions for ${l.letter_code}`}
                    >
                      <option value="">Actions…</option>
                      {opsFor(l).map((o) => <option key={o.op} value={o.op}>{o.label}</option>)}
                    </select>
                  ) : null}
                </Cell>
              </Row>
            ))}
          </Table>
        )}
      </QueryState>
    </div>
  );
}
