import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Download, GitCompareArrows, Play } from 'lucide-react';
import { useAuth } from '@/platform/auth/AuthContext';
import { can } from '@/platform/rbac/can';
import { useToast } from '@/components/Toast';
import { Button } from '@/components/Button';
import { inr, fmtDateTime } from '@/lib/format';
import { QueryState } from '@/modules/workstation/components';
import { ListCard, ListEmpty, ListHeader, ListRow, ListTable, StatusPills, TD, TwoLine } from '@/modules/workstation/listUi';
import { fyLabelForDate, fyRange } from '@/pages/workstation/tds/config';
import { rupeesToPaise, toPaise, type Paise } from '@/modules/compliance/api';
import { Chip, Labelled, errorText, fieldClass, smallBtn, useClientOptions } from '@/modules/compliance/ui';
import {
  ACTION_STATUSES, listFrom, sideTds, tdsReconApi, tdsReconKeys,
  type MatchStatus, type ReconJob, type ReconRow,
} from '@/modules/tdsRecon/api';

const TABS: { value: MatchStatus; label: string }[] = [
  { value: 'verified', label: 'Matched' },
  { value: 'only_26as', label: 'Only in 26AS' },
  { value: 'only_books', label: 'Only in books' },
  { value: 'variance', label: 'Differences' },
];

const money = (p: Paise) => { const n = toPaise(p); return n === null ? '—' : inr(n); };

/**
 * 26AS vs books — match the TDS credits in a client's Form 26AS against the
 * TDS receivable in their books: by TAN + section, then amount within a
 * tolerance. Reached from Workstation, TDS and Repotic.
 */
export function TdsReconPage() {
  const { session } = useAuth();
  const role = session?.role.code;
  const allowed = can(role, 'workstation.service.read', 'self') || can(role, 'tools.audit_automation.access', 'self');
  const toast = useToast();
  const qc = useQueryClient();

  const [params, setParams] = useSearchParams();
  const clientId = params.get('client') ?? '';
  const fy = params.get('fy') ?? fyLabelForDate(new Date(Date.now() - 180 * 86_400_000));
  const jobId = params.get('job') ?? '';
  const setP = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) { if (v) next.set(k, v); else next.delete(k); }
    setParams(next, { replace: true });
  };

  const clients = useClientOptions(allowed);
  const [file26, setFile26] = useState<File | null>(null);
  const [fileBooks, setFileBooks] = useState<File | null>(null);
  const [tolerance, setTolerance] = useState('10');

  const jobs = useQuery({
    queryKey: tdsReconKeys.jobs(clientId, fy),
    queryFn: () => tdsReconApi.jobs(clientId, fy),
    enabled: allowed && !!clientId,
  });

  // Open the newest run for this client + FY when none is chosen.
  useEffect(() => {
    if (!jobId && jobs.data?.length) setP({ job: jobs.data[0].id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobs.data, jobId]);

  const run = useMutation({
    mutationFn: () => {
      const form = new FormData();
      form.append('client_id', clientId);
      form.append('financial_year', fy);
      if (file26) form.append('file_26as', file26);
      if (fileBooks) form.append('file_books', fileBooks);
      const tol = rupeesToPaise(tolerance);
      if (tol !== null) form.append('tolerance_paise', String(tol));
      return tdsReconApi.run(form);
    },
    onSuccess: (r) => {
      const job = 'job' in r && r.job ? r.job : (r as ReconJob);
      void qc.invalidateQueries({ queryKey: ['tds-recon'] });
      setFile26(null); setFileBooks(null);
      if (job?.id) setP({ job: job.id });
      toast.push(job?.status === 'failed' ? 'error' : 'success', job?.status === 'failed' ? (job.error_message ?? 'Reconciliation failed') : 'Reconciliation complete');
    },
    onError: (e) => toast.push('error', errorText(e)),
  });

  if (!allowed) {
    return <div className="max-w-[1400px]"><ListHeader title="26AS reconciliation" /><ListCard><ListEmpty>You do not have access to TDS reconciliation.</ListEmpty></ListCard></div>;
  }

  return (
    <div className="max-w-[1400px]">
      <Link to="/workstation/services/tds" className="inline-flex items-center gap-1 text-13 text-neutral-500 hover:text-neutral-900 mb-2">
        <ArrowLeft size={14} /> TDS
      </Link>
      <ListHeader title="26AS reconciliation"
        meta="Match TDS credits in Form 26AS with the TDS receivable in the books — by TAN and section, then amount within a tolerance." />

      <ListCard title={<span className="inline-flex items-center gap-2"><GitCompareArrows size={15} /> New reconciliation</span>}>
        <div className="p-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Labelled label="Client">
            <select className={fieldClass} value={clientId} onChange={(e) => setP({ client: e.target.value, job: '' })}>
              <option value="">Choose…</option>
              {clients.options.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
          </Labelled>
          <Labelled label="Financial year">
            <select className={fieldClass} value={fy} onChange={(e) => setP({ fy: e.target.value, job: '' })}>
              {fyRange(2020, 0).map((y) => <option key={y} value={y}>FY {y}</option>)}
            </select>
          </Labelled>
          <Labelled label="Form 26AS" hint="TRACES text export, PDF or Excel">
            <input type="file" accept=".txt,.pdf,.xls,.xlsx,.csv,.zip" className="block w-full text-13 text-neutral-700"
              onChange={(e) => setFile26(e.target.files?.[0] ?? null)} />
          </Labelled>
          <Labelled label="Books (TDS receivable)" hint="Excel / CSV: party, TAN, section, amount, TDS">
            <input type="file" accept=".xls,.xlsx,.csv" className="block w-full text-13 text-neutral-700"
              onChange={(e) => setFileBooks(e.target.files?.[0] ?? null)} />
          </Labelled>
          <Labelled label="Amount tolerance (₹)">
            <input inputMode="decimal" className={fieldClass} value={tolerance} onChange={(e) => setTolerance(e.target.value)} />
          </Labelled>
          <div className="flex items-end lg:col-span-3">
            <Button variant="primary" size="sm" disabled={!clientId || !file26 || !fileBooks || run.isPending} onClick={() => run.mutate()}>
              <Play size={14} className="mr-1" /> {run.isPending ? 'Matching…' : 'Run reconciliation'}
            </Button>
          </div>
        </div>
      </ListCard>

      {clientId && jobs.data?.length ? (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <span className="text-12 text-neutral-500">Runs for FY {fy}:</span>
          <select aria-label="Reconciliation run" value={jobId} onChange={(e) => setP({ job: e.target.value })}
            className="h-8 px-2 text-13 bg-white border border-neutral-200 rounded-lg">
            {jobs.data.map((j) => (
              <option key={j.id} value={j.id}>
                {j.created_at ? fmtDateTime(j.created_at) : j.id.slice(0, 8)} · {j.status}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      {jobId ? <JobResult jobId={jobId} /> : clientId ? (
        <div className="mt-4"><ListCard><ListEmpty>No reconciliation for this client and year yet — upload both files and run one.</ListEmpty></ListCard></div>
      ) : null}
    </div>
  );
}

function JobResult({ jobId }: { jobId: string }) {
  const [tab, setTab] = useState<MatchStatus>('variance');
  const q = useQuery({
    queryKey: tdsReconKeys.job(jobId),
    queryFn: () => tdsReconApi.job(jobId),
    refetchInterval: (query) => {
      const s = query.state.data?.job.status;
      return s === 'queued' || s === 'matching' ? 3000 : false;
    },
  });
  return (
    <div className="mt-4">
      <QueryState query={q}>
        {({ job, rows }) => {
          const counts: Record<MatchStatus, number> = {
            verified: job.verified_count ?? rows.filter((r) => r.match_status === 'verified').length,
            variance: job.variance_count ?? rows.filter((r) => r.match_status === 'variance').length,
            only_26as: job.only_26as_count ?? rows.filter((r) => r.match_status === 'only_26as').length,
            only_books: job.only_books_count ?? rows.filter((r) => r.match_status === 'only_books').length,
          };
          if (job.status === 'failed') {
            return <ListCard><div className="px-5 py-4 border-l-2 border-red text-13 text-neutral-700">Failed: {job.error_message ?? 'unknown error'}</div></ListCard>;
          }
          if (job.status === 'queued' || job.status === 'matching') {
            return <ListCard><ListEmpty>Matching… this page refreshes on its own.</ListEmpty></ListCard>;
          }
          const shown = rows.filter((r) => r.match_status === tab);
          return (
            <>
              <section className="grid gap-3 grid-cols-2 lg:grid-cols-4 mb-4">
                {TABS.map((t) => {
                  const tot = totalsFor(job, rows, t.value);
                  const tone = t.value === 'verified' ? '#e3f8ee' : t.value === 'variance' ? '#fff4d6' : t.value === 'only_26as' ? '#e3f0ff' : '#ffe3ea';
                  return (
                    <button key={t.value} type="button" onClick={() => setTab(t.value)}
                      className={'pastel-tile text-left p-4 ' + (tab === t.value ? 'ring-2 ring-primary/30' : '')} style={{ background: tone }}>
                      <span className="block text-13 font-bold text-ink/70">{t.label}</span>
                      <span className="block num-display text-28 text-ink mt-1">{counts[t.value]}</span>
                      <span className="block text-12 font-semibold text-ink/60">TDS {money(tot.tds)}</span>
                    </button>
                  );
                })}
              </section>

              {listFrom(job.flags).length ? (
                <div className="mb-3 flex flex-wrap gap-1">
                  {listFrom(job.flags).map((f) => <Chip key={f} tone="amber">{f.replace(/_/g, ' ').toLowerCase()}</Chip>)}
                </div>
              ) : null}

              <ListCard
                title={<StatusPills options={TABS} value={tab} onChange={(v) => setTab(v as MatchStatus)} counts={counts} />}
                right={
                  <div className="flex items-center gap-1">
                    <a className={smallBtn} href={tdsReconApi.exportUrl(job.id, 'xlsx')}><Download size={13} /> Excel</a>
                    <a className={smallBtn} href={tdsReconApi.exportUrl(job.id, 'csv')}><Download size={13} /> CSV</a>
                  </div>
                }>
                {shown.length ? <RowsTable rows={shown} jobId={job.id} /> : <ListEmpty>Nothing in this group.</ListEmpty>}
              </ListCard>
            </>
          );
        }}
      </QueryState>
    </div>
  );
}

function totalsFor(job: ReconJob, rows: ReconRow[], s: MatchStatus) {
  const t = job.totals?.[s];
  if (t && (t.tds_paise !== undefined || t.tds_amount_paise !== undefined)) {
    return { tds: toPaise(t.tds_paise ?? t.tds_amount_paise) ?? 0 };
  }
  const tds = rows.filter((r) => r.match_status === s)
    .reduce((sum, r) => sum + (toPaise(sideTds(r.as26)) ?? toPaise(sideTds(r.books)) ?? 0), 0);
  return { tds };
}

function RowsTable({ rows, jobId }: { rows: ReconRow[]; jobId: string }) {
  const sum = (pick: (r: ReconRow) => Paise) => rows.reduce((s, r) => s + (toPaise(pick(r)) ?? 0), 0);
  const tot = {
    a26: sum((r) => r.as26?.amount_paid_paise), t26: sum((r) => sideTds(r.as26)),
    ab: sum((r) => r.books?.amount_paid_paise), tb: sum((r) => sideTds(r.books)),
  };
  const diff = (r: ReconRow) => r.difference_paise ?? ((toPaise(sideTds(r.as26)) ?? 0) - (toPaise(sideTds(r.books)) ?? 0));
  return (
    <ListTable float={false} cols={[
      'Deductor', 'Section · Qtr', { label: '26AS amount', align: 'right' }, { label: '26AS TDS', align: 'right' },
      { label: 'Books amount', align: 'right' }, { label: 'Books TDS', align: 'right' }, { label: 'Difference', align: 'right' },
      'Action', 'Reviewer note',
    ]}>
      {rows.map((r) => {
        const d = toPaise(diff(r)) ?? 0;
        return (
          <ListRow key={r.id}>
            <TD first><TwoLine top={r.deductor_name ?? '—'} sub={r.deductor_tan ?? undefined} /></TD>
            <TD nowrap muted>
              {r.section ?? '—'}{r.quarter ? ` · ${r.quarter}` : ''}
              {listFrom(r.mismatch_fields).length ? <span className="block text-11 text-[#b45309]">{listFrom(r.mismatch_fields).join(', ').replace(/_/g, ' ')}</span> : null}
            </TD>
            <TD right nowrap>{money(r.as26?.amount_paid_paise)}</TD>
            <TD right nowrap>{money(sideTds(r.as26))}</TD>
            <TD right nowrap>{money(r.books?.amount_paid_paise)}</TD>
            <TD right nowrap>{money(sideTds(r.books))}</TD>
            <TD right nowrap strong className={d !== 0 ? 'text-[#b91c1c]' : ''}>{d === 0 ? '—' : inr(d)}</TD>
            <TD><ActionSelect row={r} jobId={jobId} /></TD>
            <TD last><NoteInput row={r} jobId={jobId} /></TD>
          </ListRow>
        );
      })}
      <tr className="border-t border-neutral-200 bg-neutral-50 font-semibold">
        <td className="pl-5 pr-4 py-3 text-13" data-label="">Total ({rows.length})</td>
        <td className="px-4 py-3" data-label="" />
        <td className="px-4 py-3 text-right text-13 whitespace-nowrap" data-label="26AS amount">{inr(tot.a26)}</td>
        <td className="px-4 py-3 text-right text-13 whitespace-nowrap" data-label="26AS TDS">{inr(tot.t26)}</td>
        <td className="px-4 py-3 text-right text-13 whitespace-nowrap" data-label="Books amount">{inr(tot.ab)}</td>
        <td className="px-4 py-3 text-right text-13 whitespace-nowrap" data-label="Books TDS">{inr(tot.tb)}</td>
        <td className="px-4 py-3 text-right text-13 whitespace-nowrap" data-label="Difference">{inr(tot.t26 - tot.tb)}</td>
        <td className="px-4 py-3" data-label="" />
        <td className="pl-4 pr-5 py-3" data-label="" />
      </tr>
    </ListTable>
  );
}

function useRowPatch(jobId: string) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (v: { id: string; body: { auditor_note?: string | null; action_status?: string } }) => tdsReconApi.patchRow(v.id, v.body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: tdsReconKeys.job(jobId) }),
    onError: (e) => toast.push('error', errorText(e)),
  });
}

function ActionSelect({ row, jobId }: { row: ReconRow; jobId: string }) {
  const patch = useRowPatch(jobId);
  return (
    <select aria-label="Action" value={row.action_status ?? 'no_action'}
      onChange={(e) => patch.mutate({ id: row.id, body: { action_status: e.target.value } })}
      className="h-8 px-2 text-13 bg-white border border-neutral-200 rounded-lg max-w-[150px]">
      {ACTION_STATUSES.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
    </select>
  );
}

function NoteInput({ row, jobId }: { row: ReconRow; jobId: string }) {
  const patch = useRowPatch(jobId);
  const initial = row.auditor_note ?? '';
  const [v, setV] = useState(initial);
  useEffect(() => setV(initial), [initial]);
  const dirty = useMemo(() => v.trim() !== initial.trim(), [v, initial]);
  return (
    <input value={v} onChange={(e) => setV(e.target.value)} placeholder="Add a note"
      onBlur={() => { if (dirty) patch.mutate({ id: row.id, body: { auditor_note: v.trim() || null } }); }}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      className="h-8 w-full min-w-[160px] px-2 text-13 bg-white border border-neutral-200 rounded-lg focus:outline-none focus:border-primary/60" />
  );
}
