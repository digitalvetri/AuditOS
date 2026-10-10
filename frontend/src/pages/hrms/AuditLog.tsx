/**
 * /hrms/audit-log — the firm's audit trail.
 *
 * What a reader sees is decided by the server: a full audit reader sees
 * everything, an HR or finance reader only their domain's records. Filters
 * by date range, actor, action and entity; pages with a cursor ("Load
 * more"); exports the filtered rows as CSV. Admins can verify the log's
 * tamper-evident hash chain.
 */
import { useEffect, useMemo, useState } from 'react';
import { useInfiniteQuery, useMutation } from '@tanstack/react-query';
import { Download, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/Button';
import { api } from '@/services/api';
import type { AuditLog } from '@/data/models';
import { fmtDateTime } from '@/lib/format';
import { useAuth } from '@/platform/auth/AuthContext';
import { can } from '@/platform/rbac/can';
import {
  DateRange, FilterSelect, ListCard, ListEmpty, ListHeader, ListRow, ListTable, ListToolbar, SearchBox, TD, TwoLine,
} from '@/modules/workstation/listUi';

interface Filters {
  from: string;
  to: string;
  actor: string;
  action: string;
  entity_type: string;
  entity_id: string;
}

const EMPTY: Filters = { from: '', to: '', actor: '', action: '', entity_type: '', entity_id: '' };

/** The entity types people look for most; the server accepts any. */
const ENTITY_TYPES = [
  'Client', 'Invoice', 'CreditNote', 'Quotation', 'Employee', 'User', 'Task', 'Lead',
  'ComplianceItem', 'EngagementLetter', 'AuditEngagement', 'DigitalSignature', 'LeaveRequest', 'PayrollRun', 'Expense',
].map((t) => ({ value: t, label: t.replace(/([a-z])([A-Z])/g, '$1 $2') }));

/** Text filters settle for a moment before they query. */
function useSettled<T>(value: T, ms = 350): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

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

  const [f, setF] = useState<Filters>(EMPTY);
  const set = (k: keyof Filters) => (v: string) => setF((d) => ({ ...d, [k]: v }));
  const applied = useSettled(f);
  const [actors, setActors] = useState<Map<string, string>>(new Map());

  const list = useInfiniteQuery({
    queryKey: ['audit-log', applied],
    initialPageParam: null as number | null,
    queryFn: ({ pageParam }) =>
      api.get<Page>(`/api/audit-logs?${query(applied, { limit: '100', ...(pageParam !== null ? { cursor: String(pageParam) } : {}) })}`),
    getNextPageParam: (last) => last.next_cursor,
    retry: false,
  });

  const verify = useMutation({ mutationFn: () => api.get<ChainReport>('/api/platform/audit-log/verify') });

  const rows = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);
  // Actors seen so far, so the actor filter offers names rather than ids.
  useEffect(() => {
    const fresh = rows.filter((r) => r.actor_user_id && !actors.has(r.actor_user_id));
    if (!fresh.length) return;
    setActors((m) => { const n = new Map(m); for (const r of fresh) n.set(r.actor_user_id!, r.actor_label ?? r.actor_user_id!); return n; });
  }, [rows, actors]);
  const actorOptions = [...actors].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
  const filtered = Object.values(f).some((v) => v.trim());

  return (
    <div className="max-w-[1400px]">
      <ListHeader
        title="Audit log"
        meta="Every sign-in, change and download, newest first."
        action={(
          <span className="flex flex-wrap gap-2">
            {canVerify ? (
              <Button variant="secondary" onClick={() => verify.mutate()} disabled={verify.isPending}>
                <ShieldCheck size={15} className="mr-2" />{verify.isPending ? 'Verifying…' : 'Verify integrity'}
              </Button>
            ) : null}
            <a
              className="h-9 px-4 inline-flex items-center gap-2 text-13 font-medium rounded-lg bg-white border border-neutral-200 text-neutral-800 hover:bg-neutral-50"
              href={`/api/audit-logs?${query(applied, { format: 'csv' })}`}
            >
              <Download size={15} /> Export CSV
            </a>
          </span>
        )}
      />

      {verify.data ? (
        <div className={`mb-4 rounded border-l-2 px-3 py-2 text-13 ${verify.data.ok ? 'border-neutral-400 bg-neutral-100 text-neutral-900' : 'border-red bg-white text-red'}`}>
          {verify.data.ok
            ? `Intact: ${verify.data.checked} chained entries verified${verify.data.pre_chain ? ` (${verify.data.pre_chain} older entries predate the chain)` : ''}.`
            : `Tampering detected at entry #${verify.data.first_broken?.seq} (${verify.data.first_broken?.reason.replace(/_/g, ' ')}, ${fmtDateTime(verify.data.first_broken!.created_at)}). ${verify.data.checked} entries before it are intact.`}
        </div>
      ) : null}
      {verify.isError ? <div className="mb-4 text-13 text-red">{(verify.error as Error).message}</div> : null}

      <ListToolbar>
        <SearchBox value={f.action} onChange={set('action')} placeholder="Action, e.g. auth.login" label="Action" />
        <FilterSelect label="Entity" value={f.entity_type} onChange={set('entity_type')} options={ENTITY_TYPES} />
        <FilterSelect label="Actor" value={f.actor} onChange={set('actor')} options={actorOptions} />
        <DateRange from={f.from} to={f.to} onFrom={set('from')} onTo={set('to')} />
        {filtered ? (
          <button type="button" onClick={() => setF(EMPTY)} className="h-9 px-3 text-13 text-primary hover:underline">Clear</button>
        ) : null}
      </ListToolbar>
      {f.entity_id ? (
        <div className="mb-3 text-12 text-neutral-500">
          Showing one record ({f.entity_id}). <button type="button" className="text-primary hover:underline" onClick={() => set('entity_id')('')}>Show all</button>
        </div>
      ) : null}

      <ListCard>
        {list.isLoading ? <div className="h-40 bg-neutral-100" aria-label="Loading audit log" /> : null}
        {list.isError ? (
          <ListEmpty>{(list.error as Error).message || 'Audit access required.'}</ListEmpty>
        ) : null}
        {list.isSuccess && !rows.length ? <ListEmpty>No entries match these filters.</ListEmpty> : null}
        {rows.length ? (
          <ListTable cols={['When', 'Actor', 'Action', 'Entity', 'IP']}>
            {rows.map((r) => (
              <ListRow key={r.id}>
                <TD first nowrap>{fmtDateTime(r.created_at)}</TD>
                <TD title={r.actor_user_id ?? undefined}>{r.actor_label ?? r.actor_user_id ?? 'system'}</TD>
                <TD><span className="font-mono text-12">{r.action}</span></TD>
                <TD title={`${r.entity_type} · ${r.entity_id}`}>
                  <button type="button" className="text-left" onClick={() => setF((d) => ({ ...d, entity_type: r.entity_type, entity_id: r.entity_id }))}
                    aria-label={`Show only ${r.entity_label ?? r.entity_type} entries`}>
                    <TwoLine top={r.entity_label ?? <span className="font-normal text-neutral-500">{shortId(r.entity_id)}</span>} sub={humanType(r.entity_type)} />
                  </button>
                </TD>
                <TD last muted nowrap>{r.ip ?? '—'}</TD>
              </ListRow>
            ))}
          </ListTable>
        ) : null}
      </ListCard>

      {list.hasNextPage ? (
        <div className="mt-4">
          <Button variant="secondary" onClick={() => list.fetchNextPage()} disabled={list.isFetchingNextPage}>
            {list.isFetchingNextPage ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

const humanType = (t: string) => (t.charAt(0).toUpperCase() + t.slice(1)).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ');
/** A long uuid is noise; the full id is in the cell's tooltip. */
const shortId = (id: string) => (id.length > 14 ? `${id.slice(0, 8)}…` : id);
