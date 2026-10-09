/**
 * /hrms/audit-log — the firm's audit trail.
 *
 * What a reader sees is decided by the server: a full audit reader sees
 * everything, an HR or finance reader only their domain's records. Filters
 * by date range, actor, action and entity; pages with a cursor ("Load
 * more"); exports the filtered rows as CSV. Admins can verify the log's
 * tamper-evident hash chain.
 */
import { useState } from 'react';
import { useInfiniteQuery, useMutation } from '@tanstack/react-query';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { api } from '@/services/api';
import type { AuditLog } from '@/data/models';
import { fmtDateTime } from '@/lib/format';
import { useAuth } from '@/platform/auth/AuthContext';
import { can } from '@/platform/rbac/can';

interface Filters {
  from: string;
  to: string;
  actor: string;
  action: string;
  entity_type: string;
  entity_id: string;
}

const EMPTY: Filters = { from: '', to: '', actor: '', action: '', entity_type: '', entity_id: '' };

interface Page { items: AuditLog[]; count: number; next_cursor: number | null }

interface ChainReport {
  ok: boolean;
  checked: number;
  pre_chain: number;
  first_broken: null | { seq: number; id: string; reason: string; created_at: string };
}

function query(f: Filters, extra: Record<string, string> = {}): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...f, ...extra })) if (v.trim()) p.set(k, v.trim());
  return p.toString();
}

export function AuditLogPage() {
  const { session } = useAuth();
  const role = session?.role.code;
  const canVerify = role === 'md' || role === 'hr_admin' || can(role, 'audit.read.all', 'organisation');

  const [draft, setDraft] = useState<Filters>(EMPTY);
  const [applied, setApplied] = useState<Filters>(EMPTY);
  const set = (k: keyof Filters) => (e: React.ChangeEvent<HTMLInputElement>) => setDraft((d) => ({ ...d, [k]: e.target.value }));

  const list = useInfiniteQuery({
    queryKey: ['audit-log', applied],
    initialPageParam: null as number | null,
    queryFn: ({ pageParam }) =>
      api.get<Page>(`/api/audit-logs?${query(applied, { limit: '100', ...(pageParam !== null ? { cursor: String(pageParam) } : {}) })}`),
    getNextPageParam: (last) => last.next_cursor,
    retry: false,
  });

  const verify = useMutation({ mutationFn: () => api.get<ChainReport>('/api/platform/audit-log/verify') });

  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-20 font-semibold text-neutral-900">Audit log</h1>
          <p className="text-13 text-neutral-500">Every sign-in, change and download, newest first.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canVerify ? (
            <Button variant="secondary" onClick={() => verify.mutate()} disabled={verify.isPending}>
              {verify.isPending ? 'Verifying…' : 'Verify integrity'}
            </Button>
          ) : null}
          <a
            className="inline-flex items-center rounded-full border border-neutral-300 px-4 h-10 text-13 font-medium text-neutral-900 hover:bg-neutral-100"
            href={`/api/audit-logs?${query(applied, { format: 'csv' })}`}
          >
            Export CSV
          </a>
        </div>
      </div>

      {verify.data ? (
        <div className={`rounded border-l-2 px-3 py-2 text-13 ${verify.data.ok ? 'border-neutral-400 bg-neutral-100 text-neutral-900' : 'border-red bg-white text-red'}`}>
          {verify.data.ok
            ? `Intact: ${verify.data.checked} chained entries verified${verify.data.pre_chain ? ` (${verify.data.pre_chain} older entries predate the chain)` : ''}.`
            : `Tampering detected at entry #${verify.data.first_broken?.seq} (${verify.data.first_broken?.reason.replace(/_/g, ' ')}, ${fmtDateTime(verify.data.first_broken!.created_at)}). ${verify.data.checked} entries before it are intact.`}
        </div>
      ) : null}
      {verify.isError ? <div className="text-13 text-red">{(verify.error as Error).message}</div> : null}

      <form
        className="grid grid-cols-2 md:grid-cols-6 gap-3 items-end"
        onSubmit={(e) => { e.preventDefault(); setApplied(draft); }}
      >
        <Input label="From" type="date" value={draft.from} onChange={set('from')} />
        <Input label="To" type="date" value={draft.to} onChange={set('to')} />
        <Input label="Action" placeholder="e.g. auth.login" value={draft.action} onChange={set('action')} />
        <Input label="Entity type" placeholder="e.g. Invoice" value={draft.entity_type} onChange={set('entity_type')} />
        <Input label="Entity id" value={draft.entity_id} onChange={set('entity_id')} />
        <Input label="Actor user id" value={draft.actor} onChange={set('actor')} />
        <div className="col-span-2 md:col-span-6 flex gap-2">
          <Button type="submit" variant="primary">Apply filters</Button>
          <Button type="button" variant="ghost" onClick={() => { setDraft(EMPTY); setApplied(EMPTY); }}>Clear</Button>
        </div>
      </form>

      {list.isLoading ? <div className="h-40 bg-neutral-100" aria-label="Loading audit log" /> : null}
      {list.isError ? (
        <div className="p-4 text-13 text-neutral-500 border-l-2 border-neutral-400 pl-3">
          {(list.error as Error).message || 'Audit access required.'}
        </div>
      ) : null}

      {list.isSuccess && !rows.length ? <div className="p-4 text-13 text-neutral-500">No entries match these filters.</div> : null}

      {rows.length ? (
        <div className="bg-white border border-neutral-200 rounded overflow-x-auto">
          <table className="hr-float w-full border-collapse tabular-nums">
            <thead>
              <tr>
                {['When', 'Actor', 'Action', 'Entity', 'IP'].map((c) => (
                  <th key={c} className="text-left text-11 uppercase tracking-[0.06em] text-neutral-500 px-3 py-2 border-b border-neutral-300 font-medium">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-neutral-200 align-top">
                  <td className="px-3 py-2 text-13 text-neutral-900 whitespace-nowrap">{fmtDateTime(r.created_at)}</td>
                  <td className="px-3 py-2 text-13 text-neutral-500">{r.actor_label ?? r.actor_user_id ?? 'system'}</td>
                  <td className="px-3 py-2 text-13 text-neutral-900">{r.action}</td>
                  <td className="px-3 py-2 text-13 text-neutral-500 break-all">{r.entity_type} · {r.entity_id}</td>
                  <td className="px-3 py-2 text-13 text-neutral-500 whitespace-nowrap">{r.ip ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {list.hasNextPage ? (
        <Button variant="secondary" onClick={() => list.fetchNextPage()} disabled={list.isFetchingNextPage}>
          {list.isFetchingNextPage ? 'Loading…' : 'Load more'}
        </Button>
      ) : null}
    </div>
  );
}
