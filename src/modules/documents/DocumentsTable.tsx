/**
 * Documents table. Reusable in both the standalone page and the profile tab.
 *
 * Download uses the two-step signed-URL flow:
 *   1. GET /documents/:id/download-url  → { url, expires_at }
 *   2. Client navigates to that url (opens in a new tab / auto-downloads)
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { documentsApi, type DocumentWithEmp } from './api';
import { fmtDate } from '@/lib/format';
import { StatusLabel, type StatusVariant } from '@/components/StatusRow';
import { Button } from '@/components/Button';
import { useToast } from '@/components/Toast';
import { useAuth } from '@/platform/auth/AuthContext';
import { can } from '@/platform/rbac/can';
import type { DocumentType, EmployeeDocument } from '@/data/models';

interface Props {
  employeeId?: string;
  showEmployeeColumn?: boolean;
  filters?: { expiringWithinDays?: number };
}

const TYPE_OPTIONS: [DocumentType | '', string][] = [
  ['', 'Any type'],
  ['employment', 'Employment'],
  ['joining', 'Joining'],
  ['certificate', 'Certificate'],
  ['hr', 'HR'],
  ['tax', 'Tax'],
  ['bank', 'Bank'],
  ['company_issued', 'Company-issued'],
  ['icai', 'ICAI'],
];
const STATUS_OPTIONS: [EmployeeDocument['status'] | '', string][] = [
  ['', 'Any status'],
  ['valid', 'Valid'],
  ['expiring_soon', 'Expiring soon'],
  ['expired', 'Expired'],
  ['pending_verification', 'Pending verification'],
];

export function DocumentsTable({ employeeId, showEmployeeColumn = true, filters: initialFilters }: Props) {
  const { session } = useAuth();
  const canManage = can(session?.role.code, 'document.manage', 'organisation');
  const [type, setType] = useState<DocumentType | ''>('');
  const [status, setStatus] = useState<EmployeeDocument['status'] | ''>('');

  const q = useQuery({
    queryKey: ['documents', { employeeId, type, status, ...initialFilters }],
    queryFn: () => documentsApi.list({ employeeId, type, status, ...initialFilters }),
  });

  return (
    <div data-testid="documents-table">
      {employeeId ? null : (
        <div className="flex items-end gap-3 mb-3 flex-wrap">
          <Select label="Type" value={type} onChange={setType} options={TYPE_OPTIONS} />
          <Select label="Status" value={status} onChange={setStatus} options={STATUS_OPTIONS} />
        </div>
      )}
      <div className="bg-white border border-neutral-200 rounded overflow-hidden">
        {q.isLoading ? (
          <div className="h-40 bg-neutral-100" aria-label="Loading documents" />
        ) : q.isError ? (
          <div className="p-4 text-13 text-red">Could not load documents.</div>
        ) : (q.data?.items.length ?? 0) === 0 ? (
          <div className="p-6 text-13 text-neutral-500">No documents.</div>
        ) : (
          <table className="w-full border-collapse tabular-nums">
            <thead>
              <tr>
                {[
                  'Name',
                  'Type',
                  showEmployeeColumn ? 'Employee' : null,
                  'Uploaded at',
                  'Uploaded by',
                  'Expiry',
                  'Status',
                  'Actions',
                ]
                  .filter(Boolean)
                  .map((c) => (
                    <th
                      key={c as string}
                      className="text-left text-11 uppercase tracking-[0.06em] text-neutral-500 px-3 py-2 border-b border-neutral-300 font-medium"
                    >
                      {c as string}
                    </th>
                  ))}
              </tr>
            </thead>
            <tbody>
              {q.data!.items.map((d) => (
                <Row
                  key={d.id}
                  doc={d}
                  showEmployeeColumn={showEmployeeColumn}
                  canManage={canManage}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function Select<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: T;
  onChange: (v: T) => void;
  options: (readonly [T, string])[];
}) {
  return (
    <label className="block">
      <span className="block text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className="h-8 px-2 text-13 bg-white border border-neutral-300 rounded"
      >
        {options.map(([v, l]) => (
          <option key={v} value={v}>{l}</option>
        ))}
      </select>
    </label>
  );
}

function statusStyle(s: EmployeeDocument['status']): { variant: StatusVariant; label: string } {
  switch (s) {
    case 'valid': return { variant: 'ok', label: 'Valid' };
    case 'expiring_soon': return { variant: 'pending', label: 'Expiring Soon' };
    case 'expired': return { variant: 'problem', label: 'Expired' };
    case 'pending_verification': return { variant: 'awaiting', label: 'Pending Verification' };
  }
}

function Row({
  doc,
  showEmployeeColumn,
  canManage,
}: {
  doc: DocumentWithEmp;
  showEmployeeColumn: boolean;
  canManage: boolean;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const s = statusStyle(doc.status);
  const border =
    s.variant === 'problem'
      ? 'border-red'
      : s.variant === 'pending'
        ? 'border-amber'
        : s.variant === 'awaiting'
          ? 'border-neutral-400'
          : 'border-transparent';

  const download = useMutation({
    mutationFn: () => documentsApi.downloadUrl(doc.id),
    onSuccess: (res) => {
      // Trigger the browser download by opening the signed URL.
      window.open(res.url, '_blank', 'noopener');
    },
    onError: (e: Error) => toast.push('error', e.message),
  });
  const del = useMutation({
    mutationFn: () => documentsApi.delete(doc.id),
    onSuccess: () => {
      toast.push('success', 'Document deleted.');
      qc.invalidateQueries({ queryKey: ['documents'] });
    },
    onError: (e: Error) => toast.push('error', e.message),
  });

  return (
    <tr className="border-b border-neutral-200" data-testid={`document-row-${doc.id}`}>
      <td className={`px-3 py-2 border-l-2 ${border}`}>
        <div className="text-13 text-neutral-900">{doc.name}</div>
        <div className="text-11 text-neutral-500">{doc.file_key}</div>
      </td>
      <td className="px-3 py-2 text-13 text-neutral-700 capitalize">
        {doc.type.replace('_', ' ')}
      </td>
      {showEmployeeColumn ? (
        <td className="px-3 py-2">
          <div className="text-13 text-neutral-900">{doc.employee?.full_name ?? '—'}</div>
          <div className="text-11 text-neutral-500">{doc.employee?.employee_code ?? ''}</div>
        </td>
      ) : null}
      <td className="px-3 py-2 text-13 text-neutral-900">{fmtDate(doc.uploaded_at)}</td>
      <td className="px-3 py-2 text-13 text-neutral-500">{doc.uploader_label}</td>
      <td className="px-3 py-2 text-13 text-neutral-900">
        {doc.expiry_date ? fmtDate(doc.expiry_date + 'T00:00:00Z') : <span className="text-neutral-400">—</span>}
      </td>
      <td className="px-3 py-2"><StatusLabel variant={s.variant} label={s.label} /></td>
      <td className="px-3 py-2">
        <div className="flex gap-2">
          <Button
            variant="secondary"
            onClick={() => download.mutate()}
            disabled={download.isPending}
            data-testid={`document-download-${doc.id}`}
          >
            Download
          </Button>
          {canManage ? (
            <Button
              variant="ghost"
              onClick={() => del.mutate()}
              disabled={del.isPending}
              data-testid={`document-delete-${doc.id}`}
            >
              Delete
            </Button>
          ) : null}
        </div>
      </td>
    </tr>
  );
}
