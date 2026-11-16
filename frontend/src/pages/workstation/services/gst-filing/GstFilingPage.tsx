/**
 * Workstation → Services → GST Filing. Every GST Filing client for the
 * month (last month by default): who has sent their data, and a GSTR-1 and a
 * GSTR-3B job each, started and finished here.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Card, PageHeader, QueryState, Table, Row, Cell, FilterBar, SearchInput } from '@/modules/workstation/components';
import { Button } from '@/components/Button';
import { useToast } from '@/components/Toast';
import { confirmAction } from '@/components/ConfirmDialog';
import { fmtDate, formatPaise } from '@/lib/format';
import { gstFilingApi, periodLabel, recentPeriods, type FilingBoardRow, type FilingCell } from '@/modules/workstation/gst/api';
import { FinishModal, type FinishValues } from './FinishModal';

type Tab = 'data' | 'gstr1' | 'gstr3b';
const STARTED: Record<'gstr1' | 'gstr3b', string> = { gstr1: 'in_preparation', gstr3b: 'preparation' };
const FILED = ['filed', 'payment_pending', 'completed'];
const LABEL: Record<string, string> = {
  pending: 'Not started', data_collection: 'Not started', in_preparation: 'In progress', preparation: 'In progress',
  under_review: 'In progress', ready_to_file: 'In progress', filed: 'Filed', payment_pending: 'Filed · payment due',
  completed: 'Filed', rework_required: 'Reopened',
};
const errText = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong.');
/** Rupees as typed ('1,50,000.50') → what the API reads ('150000.50'). */
const plainAmount = (v: string) => v.replace(/[,\s]/g, '');
const day = (iso: string | null) => (iso ? fmtDate(iso) : '—');

/** This month in IST, YYYY-MM. */
function thisMonth(): string {
  return new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 7);
}
function previousMonth(): string {
  const d = new Date(Date.now() + 5.5 * 3600e3);
  d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
}

export function GstFilingPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const [period, setPeriod] = useState(previousMonth());
  const [tab, setTab] = useState<Tab>('data');
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [finish, setFinish] = useState<{ row: FilingBoardRow; kind: 'gstr1' | 'gstr3b' } | null>(null);
  const [finishError, setFinishError] = useState<string | null>(null);

  const board = useQuery({ queryKey: ['gst-filing', period], queryFn: () => gstFilingApi.board(period) });
  const refresh = () => qc.invalidateQueries({ queryKey: ['gst-filing'] });

  const data = useMutation({
    mutationFn: (v: { id: string; received: boolean }) => gstFilingApi.setData(v.id, v.received),
    onSuccess: (_r, v) => {
      if (v.received) setPicked((s) => { if (!s.has(v.id)) return s; const n = new Set(s); n.delete(v.id); return n; });
      refresh();
    },
    onError: (e) => toast.push('error', errText(e)),
  });
  const remind = useMutation({
    mutationFn: (ids: string[]) => gstFilingApi.remind(ids),
    onSuccess: (r) => {
      setPicked(new Set());
      toast.push(r.failed.length ? 'error' : 'success', `${r.sent} reminder(s) sent${r.failed.length ? ` · ${r.failed.length} not sent: ${r.failed[0].reason}` : ''}.`);
    },
    onError: (e) => toast.push('error', errText(e)),
  });
  const start = useMutation({
    mutationFn: (v: { row: FilingBoardRow; kind: 'gstr1' | 'gstr3b' }) => gstFilingApi.stage(v.row.period_id, v.kind, { status: STARTED[v.kind] }),
    onSuccess: refresh, onError: (e) => toast.push('error', errText(e)),
  });
  const reopen = useMutation({
    mutationFn: (v: { row: FilingBoardRow; kind: 'gstr1' | 'gstr3b' }) => gstFilingApi.stage(v.row.period_id, v.kind, { status: 'rework_required' }),
    onSuccess: () => { refresh(); toast.push('success', 'Reopened.'); },
    onError: (e) => toast.push('error', errText(e)),
  });
  const save = useMutation({
    mutationFn: (v: { row: FilingBoardRow; kind: 'gstr1' | 'gstr3b'; values: FinishValues }) => {
      const { values } = v;
      const body: Record<string, unknown> = { status: 'filed', arn: values.arn.trim(), filed_date: values.filed_date };
      for (const k of ['taxable_value', 'tax_amount', 'tax_liability', 'eligible_itc', 'net_payable'] as const) {
        const amount = plainAmount(values[k] ?? '');
        if (amount) body[k] = amount;
      }
      if (v.kind === 'gstr3b') {
        // Filed but not yet paid: keep the payment due visible.
        body.payment_status = values.payment_date ? 'completed' : (Number(plainAmount(values.net_payable ?? '')) > 0 ? 'pending' : 'not_applicable');
        if (values.payment_date) body.payment_date = values.payment_date;
        if (values.challan_ref?.trim()) body.challan_ref = values.challan_ref.trim();
      }
      return gstFilingApi.stage(v.row.period_id, v.kind, body);
    },
    onSuccess: () => { setFinish(null); refresh(); toast.push('success', 'Recorded as filed.'); },
    onError: (e) => setFinishError(errText(e)),
  });

  const rows = useMemo(() => {
    const all = board.data?.rows ?? [];
    const s = q.trim().toLowerCase();
    const hit = s ? all.filter((r) => r.client_name.toLowerCase().includes(s) || r.gstin.toLowerCase().includes(s)) : all;
    if (tab === 'data') return hit.filter((r) => r.data_status === 'pending');
    return hit.filter((r) => (tab === 'gstr1' ? r.gstr1 : r.gstr3b) !== null);
  }, [board.data, q, tab]);
  // Only what is on screen is sent: a pick hidden by the search or another tab is not.
  const pickedVisible = tab === 'data' ? rows.filter((r) => picked.has(r.period_id)).map((r) => r.period_id) : [];

  const emptyText = () => {
    if (tab !== 'data') return 'No clients owe this return for the month.';
    if (q.trim()) return 'No client matches your search.';
    if (period >= thisMonth()) return `Data for ${periodLabel(period)} is collected next month.`;
    return `Everyone has sent their ${periodLabel(period)} data.`;
  };

  const jobCell = (row: FilingBoardRow, kind: 'gstr1' | 'gstr3b', c: FilingCell | null) => {
    if (!c) return <span className="text-neutral-400">—</span>;
    const filed = FILED.includes(c.status);
    const paymentDue = filed && kind === 'gstr3b' && (c.status === 'payment_pending' || c.payment_status === 'pending');
    return (
      <div className="flex items-center gap-2 flex-wrap">
        <span className={'inline-flex h-6 px-2 items-center rounded-md text-11 font-medium ' +
          (paymentDue ? 'bg-amber/10 text-amber' : filed ? 'bg-success/10 text-success' : c.overdue ? 'bg-danger/10 text-danger' : 'bg-neutral-100 text-neutral-700')}>
          {c.overdue && !filed ? 'Overdue' : paymentDue ? 'Filed · payment due' : LABEL[c.status] ?? c.status}
        </span>
        {filed ? (
          <>
            <span className="text-12 font-mono text-neutral-600">{c.arn}</span>
            {c.filed_at ? <span className="text-12 text-neutral-500">on {fmtDate(c.filed_at)}</span> : null}
            {kind === 'gstr3b' && c.net_payable_paise !== null ? <span className="text-12 text-neutral-600">Net payable {formatPaise(c.net_payable_paise)}</span> : null}
            {kind === 'gstr3b' && c.challan_ref ? <span className="text-12 font-mono text-neutral-500">Challan {c.challan_ref}</span> : null}
            <Button size="sm" disabled={reopen.isPending} onClick={async () => {
              if (!(await confirmAction('Reopen this return? It goes back to Not started so it can be corrected and filed again.', { action: 'Reopen', danger: true }))) return;
              reopen.mutate({ row, kind });
            }}>Reopen</Button>
          </>
        ) : (
          c.status === 'pending' || c.status === 'data_collection' || c.status === 'rework_required'
            ? <Button size="sm" disabled={start.isPending} onClick={async () => {
                if (row.data_status === 'pending' && !(await confirmAction('Data is not marked received yet. Start anyway?', { action: 'Start', danger: false }))) return;
                start.mutate({ row, kind });
              }}>Start</Button>
            : <Button size="sm" variant="primary" onClick={() => { setFinishError(null); setFinish({ row, kind }); }}>Finish</Button>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-4" data-testid="gst-filing">
      <PageHeader
        title="GST Filing"
        subtitle="Every GST Filing client for the month: data received, GSTR-1 and GSTR-3B — started and finished here."
        action={
          <select className="h-9 px-3 rounded-md border border-neutral-200 bg-white text-13" value={period} onChange={(e) => { setPeriod(e.target.value); setPicked(new Set()); }} aria-label="Return period">
            {recentPeriods(12).map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
        }
      />
      <QueryState query={board}>
        {(b) => (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
              {([['Clients', b.tiles.clients], ['Data pending', b.tiles.data_pending], ['GSTR-1 filed', b.tiles.gstr1_filed], ['GSTR-3B filed', b.tiles.gstr3b_filed], ['Overdue', b.tiles.overdue]] as const).map(([k, n]) => (
                <div key={k} className="bg-white border border-neutral-200 rounded-lg px-4 py-3">
                  <div className="text-12 text-neutral-500">{k}</div>
                  <div className={'text-20 font-semibold ' + (k === 'Overdue' && n > 0 ? 'text-danger' : 'text-neutral-900')}>{n}</div>
                </div>
              ))}
            </div>
            {b.needs_setup.length ? (
              <div className="border-l-2 border-amber pl-3 text-13">
                <span className="font-medium text-neutral-900">Needs setup — add a GSTIN: </span>
                {b.needs_setup.map((c, i) => <span key={c.client_id}>{i ? ', ' : ''}<Link className="text-primary underline" to={`/workstation/clients/${c.client_id}`}>{c.client_name}</Link></span>)}
              </div>
            ) : null}
            <Card>
              <FilterBar>
                <SearchInput value={q} onChange={setQ} placeholder="Client or GSTIN" />
                {(['data', 'gstr1', 'gstr3b'] as const).map((t) => (
                  <button key={t} type="button" onClick={() => setTab(t)}
                    className={'h-8 px-3 rounded-full border text-13 ' + (tab === t ? 'bg-neutral-900 text-white border-neutral-900' : 'bg-white border-neutral-200 text-neutral-700')}>
                    {t === 'data' ? `Data pending (${b.tiles.data_pending})` : t === 'gstr1' ? 'GSTR-1' : 'GSTR-3B'}
                  </button>
                ))}
                <div className="flex-1" />
                {pickedVisible.length ? <Button size="sm" variant="primary" disabled={remind.isPending} onClick={() => remind.mutate(pickedVisible)}>Send reminder ({pickedVisible.length})</Button> : null}
              </FilterBar>
              {rows.length === 0 ? (
                <p className="px-5 py-6 text-13 text-neutral-500">{emptyText()}</p>
              ) : tab === 'data' ? (
                <Table head={['Select', 'Client', 'GSTIN', 'Assigned', 'GSTR-1 due', 'Actions']}>
                  {rows.map((r) => (
                    <Row key={r.period_id}>
                      <Cell><input type="checkbox" aria-label={`Select ${r.client_name}`} checked={picked.has(r.period_id)} onChange={(e) => setPicked((s) => { const n = new Set(s); if (e.target.checked) n.add(r.period_id); else n.delete(r.period_id); return n; })} /></Cell>
                      <Cell><Link className="font-medium text-neutral-900 hover:underline" to={`/workstation/clients/${r.client_id}`}>{r.client_name}</Link></Cell>
                      <Cell className="font-mono" muted>{r.gstin}</Cell>
                      <Cell muted>{r.assigned?.name ?? '—'}</Cell>
                      <Cell muted>{day(r.gstr1?.due_date ?? null)}</Cell>
                      <Cell>
                        <div className="flex gap-2 justify-end">
                          <Button size="sm" disabled={data.isPending} onClick={() => data.mutate({ id: r.period_id, received: true })}>Mark received</Button>
                          <Button size="sm" disabled={remind.isPending} onClick={() => remind.mutate([r.period_id])}>Remind</Button>
                        </div>
                      </Cell>
                    </Row>
                  ))}
                </Table>
              ) : (
                <Table head={['Client', 'Data', 'Due', 'Assigned', tab === 'gstr1' ? 'GSTR-1' : 'GSTR-3B']}>
                  {rows.map((r) => {
                    const c = tab === 'gstr1' ? r.gstr1 : r.gstr3b;
                    return (
                      <Row key={r.period_id}>
                        <Cell><Link className="font-medium text-neutral-900 hover:underline" to={`/workstation/clients/${r.client_id}`}>{r.client_name}</Link><div className="text-11 font-mono text-neutral-500">{r.gstin}</div></Cell>
                        <Cell>{r.data_status === 'received'
                          ? <button type="button" className="text-12 text-success" title="Mark as not received" onClick={() => data.mutate({ id: r.period_id, received: false })}>Received ✓</button>
                          : <button type="button" className="text-12 text-amber underline" onClick={() => data.mutate({ id: r.period_id, received: true })}>Pending — mark received</button>}</Cell>
                        <Cell muted>{day(c?.due_date ?? null)}{c && c.days_left !== null && !FILED.includes(c.status) ? ` · ${c.days_left < 0 ? `${-c.days_left}d late` : `${c.days_left}d left`}` : ''}</Cell>
                        <Cell muted>{r.assigned?.name ?? '—'}</Cell>
                        <Cell>{jobCell(r, tab === 'gstr1' ? 'gstr1' : 'gstr3b', c)}</Cell>
                      </Row>
                    );
                  })}
                </Table>
              )}
            </Card>
          </>
        )}
      </QueryState>
      {finish ? (
        <FinishModal kind={finish.kind} clientName={finish.row.client_name} period={periodLabel(period)} busy={save.isPending} error={finishError}
          onClose={() => setFinish(null)} onSave={(values) => save.mutate({ row: finish.row, kind: finish.kind, values })} />
      ) : null}
    </div>
  );
}
