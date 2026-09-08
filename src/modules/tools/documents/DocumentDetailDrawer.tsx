import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { X } from 'lucide-react';
import { Button } from '@/components/Button';
import { StatusLabel } from '@/components/StatusRow';
import { useToast } from '@/components/Toast';
import { fmtDateTime } from '@/lib/format';
import { toolsApi, downloadDocument } from '../api';
import { getTool } from '../registry';
import type { AuditEntry, ToolDocument } from '../types';
import { FILE_TYPE_LABEL, formatBytes } from '../format';
import { documentStatus } from './DocumentsTable';

const ACTION_LABEL: Record<string, string> = {
  'tools.upload': 'Uploaded',
  'tools.conversion_started': 'Conversion started',
  'tools.conversion_completed': 'Converted',
  'tools.conversion_failed': 'Conversion failed',
  'tools.download': 'Downloaded',
  'tools.preview': 'Previewed',
  'tools.delete': 'Deleted',
  'tools.unlock_authorised': 'Confirmed authorisation to decrypt',
  'tools.esign_applied': 'Applied signature mark',
};

function describe(e: AuditEntry): string {
  const label = ACTION_LABEL[e.action] ?? e.action.replace('tools.', '').replace(/_/g, ' ');
  const tool = e.tool_id ? getTool(e.tool_id)?.name : null;
  const from = e.meta.from as string | undefined;
  const to = e.meta.to as string | undefined;
  const file = e.meta.filename as string | undefined;
  if (e.action === 'tools.conversion_completed' && (from || to)) return `${label}${tool ? ` with ${tool}` : ''} · ${from ?? ''}${from && to ? ' → ' : ''}${to ?? ''}`;
  if (e.action === 'tools.conversion_failed') return `${label}${tool ? ` (${tool})` : ''}${e.meta.message ? ` · ${String(e.meta.message)}` : ''}`;
  return `${label}${tool && e.action !== 'tools.upload' ? ` · ${tool}` : ''}${file ? ` · ${file}` : ''}`;
}

/**
 * Right-hand drawer: the document, its source, job timing and the audit
 * trail. Delete is a two-step inline confirm (no native dialog).
 */
export function DocumentDetailDrawer({ doc, onClose, onPreview, onDeleted }: {
  doc: ToolDocument; onClose: () => void; onPreview: (d: ToolDocument) => void; onDeleted: () => void;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  useEffect(() => { setConfirm(false); }, [doc.id]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const q = useQuery({ queryKey: ['tools', 'document', doc.id], queryFn: () => toolsApi.documents.get(doc.id) });
  const del = useMutation({
    mutationFn: () => toolsApi.documents.delete(doc.id),
    onSuccess: () => { toast.push('success', 'Document deleted.'); qc.invalidateQueries({ queryKey: ['tools', 'documents'] }); onDeleted(); },
    onError: (e: Error) => toast.push('error', e.message),
  });

  const d = q.data?.document ?? doc;
  const s = documentStatus(d);
  const job = q.data?.jobs.find((j) => j.output_document_id === d.id) ?? q.data?.jobs[0] ?? null;
  const duration = job?.started_at && job.completed_at ? Math.max(0, (new Date(job.completed_at).getTime() - new Date(job.started_at).getTime()) / 1000) : null;
  const canPreview = d.status === 'completed' && ['pdf', 'image', 'excel', 'text', 'csv'].includes(d.file_type);

  return (
    <aside
      className="fixed inset-y-0 right-0 z-40 w-full sm:w-[440px] bg-white border-l border-neutral-200 shadow-drawer flex flex-col"
      role="dialog"
      aria-label={d.filename}
      data-testid="document-drawer"
    >
      <div className="h-12 px-4 flex items-center border-b border-neutral-200 shrink-0">
        <span className="text-13 font-medium text-neutral-900 truncate">{d.filename}</span>
        <div className="flex-1" />
        <button type="button" onClick={onClose} aria-label="Close" className="inline-flex items-center justify-center w-8 h-8 text-neutral-500 hover:text-neutral-900"><X size={16} strokeWidth={1.75} /></button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-5">
        <dl className="grid grid-cols-[110px_minmax(0,1fr)] gap-y-2 text-13">
          <dt className="text-neutral-500">Status</dt><dd><StatusLabel {...s} /></dd>
          {d.error_message ? <><dt className="text-neutral-500">Reason</dt><dd className="text-neutral-900">{d.error_message}</dd></> : null}
          <dt className="text-neutral-500">Tool</dt><dd className="text-neutral-900">{d.tool_name ?? '—'}</dd>
          <dt className="text-neutral-500">Type</dt><dd className="text-neutral-900">{FILE_TYPE_LABEL[d.file_type]} <span className="text-neutral-500">· {d.mime_type}</span></dd>
          <dt className="text-neutral-500">Size</dt><dd className="text-neutral-900 tabular-nums">{d.status === 'completed' ? formatBytes(d.file_size) : '—'}</dd>
          <dt className="text-neutral-500">Created</dt><dd className="text-neutral-900 tabular-nums">{fmtDateTime(d.created_at)}</dd>
          <dt className="text-neutral-500">By</dt><dd className="text-neutral-900">{d.created_by.label}</dd>
          {d.meta.warning ? <><dt className="text-neutral-500">Note</dt><dd className="text-neutral-900">{String(d.meta.warning)}</dd></> : null}
        </dl>

        {d.status === 'completed' ? (
          <div className="flex flex-wrap gap-2">
            {canPreview ? <Button variant="secondary" size="sm" onClick={() => onPreview(d)}>Preview</Button> : null}
            <Button variant="secondary" size="sm" onClick={() => downloadDocument(d.id).catch((e: Error) => toast.push('error', e.message))}>Download</Button>
            {d.tool_id ? <Link to={`/tools/${d.tool_id}`} className="inline-flex items-center h-8 px-3 text-13 rounded text-neutral-700 hover:text-neutral-900 hover:bg-neutral-50">Run {d.tool_name} again</Link> : null}
          </div>
        ) : null}

        <section>
          <h3 className="text-11 uppercase tracking-[0.06em] text-neutral-500 mb-2">Source file</h3>
          {q.isLoading ? <div className="h-10 bg-neutral-100 rounded" /> : q.data?.source ? (
            <div className="text-13">
              <div className="text-neutral-900 truncate">{q.data.source.filename}</div>
              <div className="text-neutral-500">{FILE_TYPE_LABEL[q.data.source.file_type]} · {formatBytes(q.data.source.file_size)} · uploaded {fmtDateTime(q.data.source.created_at)}</div>
              {Array.isArray(d.meta.inputs) && (d.meta.inputs as unknown[]).length > 1 ? (
                <div className="text-neutral-500 mt-1">+ {(d.meta.inputs as unknown[]).length - 1} more input file{(d.meta.inputs as unknown[]).length > 2 ? 's' : ''}</div>
              ) : null}
            </div>
          ) : <div className="text-13 text-neutral-500">{d.kind === 'input' ? 'This is an uploaded source file.' : '—'}</div>}
        </section>

        <section>
          <h3 className="text-11 uppercase tracking-[0.06em] text-neutral-500 mb-2">Job</h3>
          {q.isLoading ? <div className="h-10 bg-neutral-100 rounded" /> : job ? (
            <dl className="grid grid-cols-[110px_minmax(0,1fr)] gap-y-1 text-13">
              <dt className="text-neutral-500">Started</dt><dd className="text-neutral-900 tabular-nums">{job.started_at ? fmtDateTime(job.started_at) : '—'}</dd>
              <dt className="text-neutral-500">Finished</dt><dd className="text-neutral-900 tabular-nums">{job.completed_at ? fmtDateTime(job.completed_at) : '—'}</dd>
              <dt className="text-neutral-500">Duration</dt><dd className="text-neutral-900 tabular-nums">{duration === null ? '—' : duration < 1 ? '< 1 s' : `${duration.toFixed(1)} s`}</dd>
              <dt className="text-neutral-500">Outcome</dt><dd className="text-neutral-900">{job.status === 'completed' ? 'Completed' : job.status === 'failed' ? `Failed — ${job.error_message ?? ''}` : job.status}</dd>
            </dl>
          ) : <div className="text-13 text-neutral-500">No job recorded.</div>}
        </section>

        <section>
          <h3 className="text-11 uppercase tracking-[0.06em] text-neutral-500 mb-2">Audit trail</h3>
          {q.isLoading ? <div className="h-16 bg-neutral-100 rounded" /> : q.data && q.data.audit.length ? (
            <ol className="space-y-2">
              {[...q.data.audit].reverse().map((e) => (
                <li key={e.id} className={'border-l-2 pl-3 ' + (e.status === 'failed' ? 'border-red' : e.status === 'success' ? 'border-transparent' : 'border-neutral-400')}>
                  <div className="text-13 text-neutral-900">{e.actor?.label ?? 'System'} · {describe(e)}</div>
                  <div className="text-12 text-neutral-500 tabular-nums">{fmtDateTime(e.created_at)} · {e.status === 'failed' ? 'Failed' : e.status === 'success' ? 'Success' : 'Info'}</div>
                </li>
              ))}
            </ol>
          ) : <div className="text-13 text-neutral-500">No audit entries.</div>}
        </section>
      </div>

      {q.data?.can_delete ? (
        <div className="px-4 py-3 border-t border-neutral-200 flex items-center gap-2 shrink-0">
          {confirm ? (
            <>
              <span className="text-13 text-neutral-900">Delete this document permanently?</span>
              <div className="flex-1" />
              <Button variant="ghost" size="sm" onClick={() => setConfirm(false)}>Cancel</Button>
              <Button variant="danger" size="sm" onClick={() => del.mutate()} disabled={del.isPending} data-testid="document-delete-confirm">{del.isPending ? 'Deleting…' : 'Delete'}</Button>
            </>
          ) : (
            <>
              <div className="flex-1" />
              <Button variant="danger" size="sm" onClick={() => setConfirm(true)} data-testid="document-delete">Delete</Button>
            </>
          )}
        </div>
      ) : null}
    </aside>
  );
}
