import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Plus, Landmark } from 'lucide-react';
import { Button } from '@/components/Button';
import { workstationApi } from '@/modules/workstation/api';
import type { ClientListItem } from '@/modules/workstation/types';
import { auditAutomationApi, type AaJob } from '@/modules/tools/audit-automation/api';
import { fmtDateTime } from '@/lib/format';

/**
 * /audit-automation/bank — jobs list for a chosen client. The auditor
 * picks a client, then sees every statement they've uploaded for it.
 *
 * The empty state routes to the wireframe (§3) so the very first upload
 * flows through the same path a returning auditor uses.
 */
export function BankJobsListPage() {
  const [clientId, setClientId] = useState<string>('');

  const clientsQ = useQuery({
    queryKey: ['workstation.clients.for-aa'],
    queryFn: () => workstationApi.listClients(),
  });
  const jobsQ = useQuery({
    queryKey: ['aa.jobs', clientId],
    enabled: Boolean(clientId),
    queryFn: () => auditAutomationApi.jobs(clientId),
  });

  return (
    <div className="max-w-[1200px] mx-auto" data-testid="aa-bank-list">
      <div className="mb-4">
        <Link to="/audit-automation" className="inline-flex items-center gap-1 text-13 text-neutral-500 hover:text-neutral-900">
          <ArrowLeft size={14} strokeWidth={1.75} /> Repotic
        </Link>
      </div>

      <header className="flex flex-wrap items-start justify-between gap-4 mb-5">
        <div>
          <h1 className="text-20 font-semibold text-neutral-900">Bank statements</h1>
          <p className="text-13 text-neutral-500 mt-1">
            Every statement uploaded for a client — bank, period, status.
          </p>
        </div>
        <Link to="/audit-automation/bank/new">
          <Button variant="primary" size="sm" className="whitespace-nowrap">
            <Plus size={14} strokeWidth={1.75} className="mr-1" /> New
          </Button>
        </Link>
      </header>

      <div className="bg-white border border-neutral-200 rounded p-4 mb-4 flex items-center gap-3">
        <label className="text-13 text-neutral-900">Client</label>
        <select
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          className="h-9 min-w-0 flex-1 md:flex-none md:min-w-[280px] px-2 text-13 border border-neutral-300 rounded bg-white focus:outline-none focus:border-gold"
        >
          <option value="">Select client…</option>
          {(clientsQ.data?.items ?? []).map((c: ClientListItem) => (
            <option key={c.id} value={c.id}>
              {c.company_name} · {c.client_id}
            </option>
          ))}
        </select>
      </div>

      {!clientId ? (
        <div className="bg-white border border-neutral-200 rounded p-6 text-13 text-neutral-500">
          Choose a client above to see their bank statement jobs.
        </div>
      ) : jobsQ.isLoading ? (
        <div className="bg-white border border-neutral-200 rounded p-6 text-13 text-neutral-500">Loading…</div>
      ) : (jobsQ.data?.items ?? []).length === 0 ? (
        <EmptyState />
      ) : (
        <JobsTable jobs={jobsQ.data!.items} />
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="bg-white border border-neutral-200 rounded p-8 text-center">
      <div className="w-10 h-10 rounded flex items-center justify-center bg-amber-50 text-amber-700 mx-auto mb-3">
        <Landmark size={18} strokeWidth={1.75} />
      </div>
      <div className="text-14 font-medium text-neutral-900">No statements yet</div>
      <p className="text-13 text-neutral-500 mt-1 mb-4">Upload the first statement to start the pipeline.</p>
      <Link to="/audit-automation/bank/new">
        <Button variant="primary" size="sm" className="whitespace-nowrap">
          <Plus size={14} strokeWidth={1.75} className="mr-1" /> New statement
        </Button>
      </Link>
    </div>
  );
}

function JobsTable({ jobs }: { jobs: AaJob[] }) {
  return (
    <div className="bg-white border border-neutral-200 rounded overflow-hidden">
      <table className="hr-float w-full text-13">
        <thead>
          <tr className="text-left text-11 text-neutral-500 tracking-[0.06em]">
            <th className="px-3 py-2 font-normal">UPLOADED</th>
            <th className="px-3 py-2 font-normal">PERIOD</th>
            <th className="px-3 py-2 font-normal text-right">ROWS</th>
            <th className="px-3 py-2 font-normal">STATUS</th>
            <th className="px-3 py-2 font-normal">REVIEW</th>
            <th className="px-3 py-2 font-normal">FLAGS</th>
            <th className="px-3 py-2 font-normal w-16"></th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((j) => (
            <tr key={j.id} className="border-t border-neutral-100">
              <td className="px-3 py-2 text-neutral-900">{fmtDateTime(j.created_at)}</td>
              <td className="px-3 py-2 text-neutral-700 whitespace-nowrap">{j.period_from ? `${j.period_from} → ${j.period_to}` : '—'}{j.fy ? <span className="text-neutral-400"> · FY {j.fy}</span> : null}</td>
              <td className="px-3 py-2 text-right tabular-nums">{j.status === 'extracted' ? j.row_count : '—'}</td>
              <td className="px-3 py-2">
                <StatusPill status={j.status} />
              </td>
              <td className="px-3 py-2 text-12">
                {j.status !== 'extracted' ? <span className="text-neutral-400">—</span>
                  : j.review_status === 'approved' ? <span className="text-success font-medium">Approved</span>
                  : <span className="text-amber">To review</span>}
              </td>
              <td className="px-3 py-2">
                {j.flags.length === 0 ? (
                  <span className="text-neutral-400">—</span>
                ) : (
                  <div className="flex flex-wrap gap-1">
                    {j.flags.map((f) => (
                      <span key={f} className="text-11 px-1.5 py-0.5 rounded bg-amber/10 text-amber">{f.replace(/_/g, ' ').toLowerCase()}</span>
                    ))}
                  </div>
                )}
              </td>
              <td className="px-3 py-2 text-right">
                <Link to={`/audit-automation/bank/jobs/${j.id}`} className="text-12 text-gold font-medium">
                  Open →
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StatusPill({ status }: { status: AaJob['status'] }) {
  const map: Record<AaJob['status'], { label: string; color: string }> = {
    queued: { label: 'Queued', color: 'border-l-neutral-400 text-neutral-700' },
    extracting: { label: 'Reading', color: 'border-l-primary text-primary' },
    extracted: { label: 'Read', color: 'border-l-success text-success' },
    failed: { label: 'Failed', color: 'border-l-danger text-danger' },
  };
  const s = map[status];
  return (
    <span className={'inline-flex items-center pl-2 pr-1 border-l-2 text-12 font-medium ' + s.color}>
      {s.label}
    </span>
  );
}
