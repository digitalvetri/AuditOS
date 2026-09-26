import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { bookkeepingAccountingApi, type AuditTrailRow } from '@/modules/tools/audit-automation/bookkeeping';
import { DataTable, Money, Panel, Loading, ErrorNote, usePeriod, ReportHeader, StatusPill, ExportButtons } from '@/modules/tools/bookkeeping/ui';

/**
 * /audit — the verification surface.
 *
 * Audit OS is an audit product, so the Bookkeeping module keeps an append-only
 * record of every create, alter, cancel and restore, with the before and
 * after of each change. Nothing on this screen can delete anything.
 */
type Tab = 'exceptions' | 'trail' | 'altered' | 'cancelled' | 'activity';

export function BookkeepingAudit() {
  const { companyId = '' } = useParams();
  const { from, to } = usePeriod();
  const [tab, setTab] = useState<Tab>('exceptions');

  return (
    <div data-testid="tally-audit">
      <ReportHeader title="Audit &amp; verification" subtitle={`${from} to ${to} · every change is recorded, nothing is erased`} />

      <div className="flex gap-1 mb-3 flex-wrap print:hidden">
        {([['exceptions', 'Exceptions'], ['trail', 'Edit log'], ['altered', 'Altered vouchers'], ['cancelled', 'Cancelled'], ['activity', 'User activity']] as [Tab, string][]).map(([k, label]) => (
          <button key={k} type="button" onClick={() => setTab(k)}
            className={`h-8 px-3 text-12 rounded border ${tab === k ? 'bg-neutral-100 border-neutral-300 text-neutral-900 font-medium' : 'bg-white border-neutral-200 text-neutral-600 hover:bg-neutral-50'}`}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'exceptions' ? <ExceptionsTab companyId={companyId} from={from} to={to} /> : null}
      {tab === 'trail' ? <TrailTab companyId={companyId} from={from} to={to} /> : null}
      {tab === 'altered' ? <AlteredTab companyId={companyId} from={from} to={to} /> : null}
      {tab === 'cancelled' ? <CancelledTab companyId={companyId} from={from} to={to} /> : null}
      {tab === 'activity' ? <ActivityTab companyId={companyId} /> : null}
    </div>
  );
}

function ExceptionsTab({ companyId, from, to }: { companyId: string; from: string; to: string }) {
  const q = useQuery({ queryKey: ['tally.auditExceptions', companyId, from, to], queryFn: () => bookkeepingAccountingApi.auditExceptions(companyId, { from, to }) });
  if (q.isLoading) return <Loading />;
  if (q.isError) return <ErrorNote message={(q.error as Error).message} />;
  return (
    <Panel title={`Exception report · ${q.data!.voucher_count} vouchers examined`}>
      <ul className="divide-y divide-neutral-100">
        {q.data!.items.map((i) => (
          <li key={i.key} className="px-3 py-2 flex items-start gap-3">
            <span className={`text-10 uppercase px-1.5 py-0.5 rounded font-medium mt-0.5 ${
              i.count === 0 ? 'bg-emerald-50 text-emerald-700'
                : i.severity === 'critical' || i.severity === 'high' ? 'bg-red-50 text-danger'
                : i.severity === 'medium' ? 'bg-amber-50 text-amber-700' : 'bg-neutral-100 text-neutral-500'}`}>
              {i.count === 0 ? 'clear' : i.severity}
            </span>
            <div className="flex-1 min-w-0">
              <div className="text-13 text-neutral-900">{i.label}</div>
              <div className="text-12 text-neutral-500">{i.detail}</div>
            </div>
            <span className="text-14 font-semibold tabular-nums text-neutral-900">{i.count}</span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function TrailTab({ companyId, from, to }: { companyId: string; from: string; to: string }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['tally.auditTrail', companyId, from, to], queryFn: () => bookkeepingAccountingApi.auditTrail(companyId, { from, to, limit: 500 }) });
  const revisionQ = useQuery({
    queryKey: ['tally.auditRevision', companyId, openId],
    enabled: Boolean(openId),
    queryFn: () => bookkeepingAccountingApi.auditRevision(companyId, openId!),
  });
  const base = `/tally/companies/${companyId}`;
  if (q.isLoading) return <Loading />;
  if (q.isError) return <ErrorNote message={(q.error as Error).message} />;
  const columns = [
    { key: 'at', label: 'When', value: (r: AuditTrailRow) => r.at, render: (r: AuditTrailRow) => <span className="text-12 text-neutral-600">{new Date(r.at).toLocaleString('en-IN')}</span> },
    { key: 'action', label: 'Action', value: (r: AuditTrailRow) => r.action, render: (r: AuditTrailRow) => <StatusPill status={r.action} /> },
    { key: 'voucher', label: 'Voucher', value: (r: AuditTrailRow) => r.voucher_number, render: (r: AuditTrailRow) => <Link to={`${base}/vouchers/${r.voucher_id}`} className="text-neutral-900 hover:text-gold">{r.voucher_type_code.replace(/_/g, ' ')} {r.voucher_number}</Link> },
    { key: 'version', label: 'Ver.', align: 'right' as const, value: (r: AuditTrailRow) => r.version },
    { key: 'actor', label: 'By', value: (r: AuditTrailRow) => r.actor_label },
    {
      key: 'compare', label: '', value: () => '',
      render: (r: AuditTrailRow) => (r.has_before ? <button type="button" onClick={(e) => { e.stopPropagation(); setOpenId(r.id); }} className="text-12 text-gold hover:underline">Compare</button> : <span className="text-11 text-neutral-400">—</span>),
    },
  ];
  return (
    <>
      <Panel title="Edit log" actions={<ExportButtons filename="edit-log.csv" rows={q.data!.items} columns={columns} />}>
        <DataTable minWidth="760px" rows={q.data!.items} rowKey={(r) => r.id} columns={columns} empty="No voucher changes recorded in this period." />
      </Panel>

      {openId ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setOpenId(null)}>
          <div className="bg-white rounded shadow-lg w-full max-w-[720px] max-h-[80vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="px-4 py-3 border-b border-neutral-200 flex items-center justify-between">
              <h3 className="text-14 font-semibold">Before and after</h3>
              <button type="button" onClick={() => setOpenId(null)} className="text-neutral-400 hover:text-neutral-700">Close</button>
            </div>
            {revisionQ.isLoading ? <div className="p-4 text-13 text-neutral-500">Loading…</div> : revisionQ.data ? (
              <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <div className="text-12 font-medium text-neutral-700 mb-1">Before</div>
                  <pre className="text-11 bg-neutral-50 border border-neutral-200 rounded p-2 overflow-x-auto">{JSON.stringify(revisionQ.data.before, null, 2)}</pre>
                </div>
                <div>
                  <div className="text-12 font-medium text-neutral-700 mb-1">After</div>
                  <pre className="text-11 bg-neutral-50 border border-neutral-200 rounded p-2 overflow-x-auto">{JSON.stringify(revisionQ.data.after, null, 2)}</pre>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}

function AlteredTab({ companyId, from, to }: { companyId: string; from: string; to: string }) {
  const q = useQuery({ queryKey: ['tally.altered', companyId, from, to], queryFn: () => bookkeepingAccountingApi.alteredVouchers(companyId, { from, to }) });
  const base = `/tally/companies/${companyId}`;
  if (q.isLoading) return <Loading />;
  return (
    <Panel title="Vouchers altered after posting">
      <DataTable
        minWidth="760px" rows={q.data?.items ?? []} rowKey={(r) => r.voucher_id}
        columns={[
          { key: 'date', label: 'Date', value: (r) => r.date },
          { key: 'voucher', label: 'Voucher', value: (r) => r.voucher_number, render: (r) => <Link to={`${base}/vouchers/${r.voucher_id}`} className="text-neutral-900 hover:text-gold">{r.voucher_type_code.replace(/_/g, ' ')} {r.voucher_number}</Link> },
          { key: 'party', label: 'Party', value: (r) => r.party_name ?? '' },
          { key: 'amount', label: 'Amount', align: 'right', value: (r) => r.grand_total_paise / 100, render: (r) => <Money paise={r.grand_total_paise} /> },
          { key: 'versions', label: 'Versions', align: 'right', value: (r) => r.version },
          { key: 'modified', label: 'Last change', value: (r) => new Date(r.last_modified_at).toLocaleString('en-IN') },
        ]}
        empty="No voucher has been altered after posting."
      />
    </Panel>
  );
}

function CancelledTab({ companyId, from, to }: { companyId: string; from: string; to: string }) {
  const q = useQuery({ queryKey: ['tally.cancelled', companyId, from, to], queryFn: () => bookkeepingAccountingApi.cancelledVouchers(companyId, { from, to }) });
  const base = `/tally/companies/${companyId}`;
  if (q.isLoading) return <Loading />;
  return (
    <Panel title="Cancelled vouchers">
      <DataTable
        minWidth="760px" rows={q.data?.items ?? []} rowKey={(r) => r.voucher_id}
        columns={[
          { key: 'date', label: 'Date', value: (r) => r.date },
          { key: 'voucher', label: 'Voucher', value: (r) => r.voucher_number, render: (r) => <Link to={`${base}/vouchers/${r.voucher_id}`} className="text-neutral-900 hover:text-gold">{r.voucher_type_code.replace(/_/g, ' ')} {r.voucher_number}</Link> },
          { key: 'party', label: 'Party', value: (r) => r.party_name ?? '' },
          { key: 'amount', label: 'Amount', align: 'right', value: (r) => r.grand_total_paise / 100, render: (r) => <Money paise={r.grand_total_paise} /> },
          { key: 'reason', label: 'Reason', value: (r) => r.reason ?? '' },
          { key: 'at', label: 'Cancelled', value: (r) => (r.cancelled_at ? new Date(r.cancelled_at).toLocaleString('en-IN') : '') },
        ]}
        empty="Nothing has been cancelled."
      />
    </Panel>
  );
}

function ActivityTab({ companyId }: { companyId: string }) {
  const q = useQuery({ queryKey: ['tally.activity', companyId], queryFn: () => bookkeepingAccountingApi.userActivity(companyId, 200) });
  if (q.isLoading) return <Loading />;
  return (
    <Panel title="User activity (platform audit log)">
      <DataTable
        minWidth="720px" rows={q.data?.items ?? []} rowKey={(r) => r.id}
        columns={[
          { key: 'at', label: 'When', value: (r) => new Date(r.at).toLocaleString('en-IN') },
          { key: 'actor', label: 'User', value: (r) => r.actor_label },
          { key: 'action', label: 'Action', value: (r) => r.action, render: (r) => <span className="font-mono text-12">{r.action}</span> },
          { key: 'entity', label: 'Entity', value: (r) => r.entity_type },
          { key: 'ip', label: 'IP', value: (r) => r.ip ?? '', render: (r) => <span className="text-12 text-neutral-500">{r.ip ?? '—'}</span> },
        ]}
        empty="No Bookkeeping activity recorded yet."
      />
    </Panel>
  );
}
