import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Plus, FileSpreadsheet } from 'lucide-react';
import { Button } from '@/components/Button';
import { workstationApi } from '@/modules/workstation/api';
import type { ClientListItem } from '@/modules/workstation/types';
import { gstApi, type ReconJob } from '@/modules/tools/audit-automation/gst';

/**
 * /audit-automation/gst — recon jobs list, filtered by client.
 * Mirrors BankJobsList's shape and empty-state pattern.
 */
export function GstJobsListPage() {
  const [clientId, setClientId] = useState<string>('');

  const clientsQ = useQuery({
    queryKey: ['workstation.clients.for-aa'],
    queryFn: () => workstationApi.listClients(),
  });
  const jobsQ = useQuery({
    queryKey: ['gst.recon', clientId],
    enabled: Boolean(clientId),
    queryFn: () => gstApi.listRecon(clientId),
  });

  return (
    <div className="max-w-[1200px] mx-auto" data-testid="gst-list">
      <div className="mb-4">
        <Link to="/audit-automation" className="inline-flex items-center gap-1 text-13 text-neutral-500 hover:text-neutral-900">
          <ArrowLeft size={14} strokeWidth={1.75} /> Repotic
        </Link>
      </div>

      <header className="flex items-start justify-between gap-4 mb-5">
        <div>
          <h1 className="text-20 font-semibold text-neutral-900">GST reconciliation</h1>
          <p className="text-13 text-neutral-500 mt-1">
            GSTR-2B vs purchase register — matching and ITC classification.
          </p>
        </div>
        <Link to="/audit-automation/gst/new">
          <Button variant="primary" size="sm">
            <Plus size={14} strokeWidth={1.75} className="mr-1" /> New reconciliation
          </Button>
        </Link>
      </header>

      <div className="bg-white border border-neutral-200 rounded p-4 mb-4 flex items-center gap-3">
        <label className="text-13 text-neutral-900">Client</label>
        <select
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          className="h-9 min-w-[280px] px-2 text-13 border border-neutral-300 rounded bg-white focus:outline-none focus:border-gold"
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
          Choose a client above to see their GST reconciliations.
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
        <FileSpreadsheet size={18} strokeWidth={1.75} />
      </div>
      <div className="text-14 font-medium text-neutral-900">No reconciliations yet</div>
      <p className="text-13 text-neutral-500 mt-1 mb-4">Upload a GSTR-2B and a purchase register to start.</p>
      <Link to="/audit-automation/gst/new">
        <Button variant="primary" size="sm">
          <Plus size={14} strokeWidth={1.75} className="mr-1" /> New reconciliation
        </Button>
      </Link>
    </div>
  );
}

function JobsTable({ jobs }: { jobs: ReconJob[] }) {
  return (
    <div className="bg-white border border-neutral-200 rounded overflow-hidden">
      <table className="w-full text-13">
        <thead>
          <tr className="text-left text-11 text-neutral-500 tracking-[0.06em]">
            <th className="px-3 py-2 font-normal">CREATED</th>
            <th className="px-3 py-2 font-normal">STATUS</th>
            <th className="px-3 py-2 font-normal">MATCHED</th>
            <th className="px-3 py-2 font-normal">PARTIAL</th>
            <th className="px-3 py-2 font-normal">ONLY 2B</th>
            <th className="px-3 py-2 font-normal">ONLY PR</th>
            <th className="px-3 py-2 font-normal w-16"></th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((j) => (
            <tr key={j.id} className="border-t border-neutral-100">
              <td className="px-3 py-2 text-neutral-900">{new Date(j.created_at).toLocaleString()}</td>
              <td className="px-3 py-2"><StatusPill status={j.status} /></td>
              <td className="px-3 py-2 text-neutral-900">{j.matched_count}</td>
              <td className="px-3 py-2 text-amber-700">{j.partial_count}</td>
              <td className="px-3 py-2 text-neutral-600">{j.only_2b_count}</td>
              <td className="px-3 py-2 text-neutral-600">{j.only_pr_count}</td>
              <td className="px-3 py-2 text-right">
                <Link to={`/audit-automation/gst/jobs/${j.id}`} className="text-12 text-gold font-medium">
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

function StatusPill({ status }: { status: ReconJob['status'] }) {
  const map: Record<ReconJob['status'], { label: string; color: string }> = {
    queued: { label: 'Queued', color: 'border-l-neutral-400 text-neutral-700' },
    matching: { label: 'Matching', color: 'border-l-blue-500 text-blue-700' },
    matched: { label: 'Matched', color: 'border-l-green-500 text-green-700' },
    failed: { label: 'Failed', color: 'border-l-danger text-danger' },
  };
  const s = map[status];
  return (
    <span className={'inline-flex items-center pl-2 pr-1 border-l-2 text-12 font-medium ' + s.color}>
      {s.label}
    </span>
  );
}
