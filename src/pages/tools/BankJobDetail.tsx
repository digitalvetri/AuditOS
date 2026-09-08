import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, FileText, AlertTriangle } from 'lucide-react';
import { auditAutomationApi, type AaJobDetail } from '@/modules/tools/audit-automation/api';

/**
 * /audit-automation/bank/jobs/:jobId — status + flags for one job.
 *
 * This slice's extractor is a stub (see AaJobService.scheduleStubExtraction)
 * so the detail page currently shows only source-document facts and job
 * state. Row-level review is a follow-on slice (amendment §6 differentiator).
 *
 * Polls while the job is not terminal so the UI reflects the pipeline
 * progressing from queued → extracting → extracted.
 */
export function BankJobDetailPage() {
  const { jobId = '' } = useParams();
  const q = useQuery({
    queryKey: ['aa.job', jobId],
    enabled: Boolean(jobId),
    queryFn: () => auditAutomationApi.job(jobId),
    refetchInterval: (query) => {
      const status = query.state.data?.job.status;
      return status === 'queued' || status === 'extracting' ? 1500 : false;
    },
  });

  return (
    <div className="max-w-[900px] mx-auto" data-testid="aa-bank-job">
      <div className="mb-4">
        <Link to="/audit-automation/bank" className="inline-flex items-center gap-1 text-13 text-neutral-500 hover:text-neutral-900">
          <ArrowLeft size={14} strokeWidth={1.75} /> Bank statements
        </Link>
      </div>

      {q.isLoading ? (
        <div className="bg-white border border-neutral-200 rounded p-6 text-13 text-neutral-500">Loading…</div>
      ) : q.error ? (
        <div className="bg-white border border-neutral-200 rounded p-6 text-13 text-danger">
          Could not load this job.
        </div>
      ) : q.data ? (
        <JobDetail detail={q.data} />
      ) : null}
    </div>
  );
}

function JobDetail({ detail }: { detail: AaJobDetail }) {
  const { job, source_document: doc } = detail;
  const statusLabel: Record<typeof job.status, string> = {
    queued: 'Queued',
    extracting: 'Extracting',
    extracted: 'Extracted',
    failed: 'Failed',
  };
  const statusColor: Record<typeof job.status, string> = {
    queued: 'border-l-neutral-400 text-neutral-700',
    extracting: 'border-l-blue-500 text-blue-700',
    extracted: 'border-l-green-500 text-green-700',
    failed: 'border-l-danger text-danger',
  };

  return (
    <div className="space-y-4">
      <header className="bg-white border border-neutral-200 rounded p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="text-11 tracking-[0.06em] text-neutral-500 mb-1">JOB</div>
            <h1 className="text-14 font-semibold text-neutral-900 truncate">
              {doc?.original_filename ?? job.id.slice(0, 8)}
            </h1>
            <div className="text-12 text-neutral-500 mt-1">Created {new Date(job.created_at).toLocaleString()}</div>
          </div>
          <span className={'inline-flex items-center pl-2 pr-2 border-l-2 text-13 font-medium ' + statusColor[job.status]}>
            {statusLabel[job.status]}
            {(job.status === 'queued' || job.status === 'extracting') ? ` · ${job.progress}%` : ''}
          </span>
        </div>

        {job.flags.length > 0 ? (
          <div className="mt-4 flex items-start gap-2 border-l-2 border-amber-500 bg-amber-50 px-3 py-2">
            <AlertTriangle size={14} strokeWidth={1.75} className="text-amber-700 mt-0.5" />
            <div>
              <div className="text-13 font-medium text-neutral-900">Flags</div>
              <div className="flex flex-wrap gap-1 mt-1">
                {job.flags.map((f) => (
                  <span key={f} className="text-11 px-1.5 py-0.5 rounded bg-white border border-amber-200 text-amber-800">{f}</span>
                ))}
              </div>
            </div>
          </div>
        ) : null}

        {job.error_message ? (
          <div className="mt-4 border-l-2 border-danger bg-canvas px-3 py-2 text-13 text-neutral-900">
            {job.error_message}
          </div>
        ) : null}
      </header>

      {doc ? (
        <section className="bg-white border border-neutral-200 rounded p-5">
          <div className="text-11 tracking-[0.06em] text-neutral-500 mb-3">SOURCE STATEMENT</div>
          <dl className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-2 text-13">
            <Fact label="Bank" value={doc.bank.name} />
            <Fact label="Account" value={`${doc.bank_account.account_number_masked}${doc.bank_account.label ? ` — ${doc.bank_account.label}` : ''}`} />
            <Fact label="Filename" value={<span className="inline-flex items-center gap-1"><FileText size={12} strokeWidth={1.75} /> {doc.original_filename}</span>} />
            <Fact label="Size" value={`${(doc.file_size / 1024).toFixed(0)} KB`} />
            <Fact label="Pages" value={`${doc.page_count}${doc.declared_page_count && doc.declared_page_count !== doc.page_count ? ` (declared ${doc.declared_page_count})` : ''}`} />
            <Fact label="Encrypted" value={doc.encrypted ? 'Yes' : 'No'} />
            <Fact label="Uploaded by" value={doc.uploaded_by.label} />
            <Fact label="Uploaded at" value={new Date(doc.uploaded_at).toLocaleString()} />
          </dl>
        </section>
      ) : null}

      <section className="bg-white border border-neutral-200 rounded p-5 text-13 text-neutral-500">
        Row-level review is not yet available. This slice implements the upload
        pipeline (bank select, password support, scanned-PDF rejection, per-client
        dedupe) and stubs the extractor so the job flows through
        <code className="mx-1 text-12 bg-neutral-100 px-1 rounded">queued → extracting → extracted</code>.
        Row extraction, the balance chain and the review UI are follow-on slices.
      </section>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex">
      <dt className="w-32 text-neutral-500">{label}</dt>
      <dd className="flex-1 text-neutral-900">{value}</dd>
    </div>
  );
}
