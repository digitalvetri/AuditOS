/**
 * Upload modal. Employees upload to their own record; HR/MD upload to any.
 * In mock mode the actual file bytes aren't stored — we only record metadata.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { useToast } from '@/components/Toast';
import { useAuth } from '@/platform/auth/AuthContext';
import { can } from '@/platform/rbac/can';
import { documentsApi } from './api';
import { employeeApi } from '@/modules/employees/api';
import type { DocumentType } from '@/data/models';

const TYPES: [DocumentType, string][] = [
  ['employment', 'Employment'],
  ['joining', 'Joining'],
  ['certificate', 'Certificate'],
  ['hr', 'HR'],
  ['tax', 'Tax'],
  ['bank', 'Bank'],
  ['company_issued', 'Company-issued'],
  ['icai', 'ICAI (Articled)'],
];

interface Props {
  open: boolean;
  onClose: () => void;
  /** Pin the upload to a specific employee (used by profile tab). */
  fixedEmployeeId?: string;
}

export function UploadModal({ open, onClose, fixedEmployeeId }: Props) {
  const { session } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const canManage = can(session?.role.code, 'document.manage', 'organisation');

  const [name, setName] = useState('');
  const [type, setType] = useState<DocumentType>('employment');
  const [employeeId, setEmployeeId] = useState<string>(
    fixedEmployeeId ?? session?.employee?.id ?? '',
  );
  const [expiry, setExpiry] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName('');
    setType('employment');
    setEmployeeId(fixedEmployeeId ?? session?.employee?.id ?? '');
    setExpiry('');
    setError(null);
  }, [open, fixedEmployeeId, session]);

  // Only HR/MD sees the full employee picker.
  const employeesQ = useQuery({
    queryKey: ['employees', 'list', {}],
    queryFn: () => employeeApi.list({}),
    enabled: open && canManage && !fixedEmployeeId,
  });

  const submit = useMutation({
    mutationFn: () =>
      documentsApi.upload({
        name: name.trim(),
        type,
        employee_id: employeeId,
        expiry_date: expiry || null,
      }),
    onSuccess: () => {
      toast.push('success', 'Document uploaded.');
      qc.invalidateQueries({ queryKey: ['documents'] });
      qc.invalidateQueries({ queryKey: ['dashboard', 'pending-actions'] });
      onClose();
    },
    onError: (e: Error) => setError(e.message),
  });

  if (!open) return null;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!name.trim()) return setError('Name is required.');
    if (!employeeId) return setError('Choose an employee.');
    submit.mutate();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-40 grid place-items-center bg-neutral-900/30 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      data-testid="document-upload-modal"
    >
      <div className="w-full max-w-[480px] bg-white border border-neutral-200 rounded shadow-drawer p-6">
        <div className="flex items-baseline justify-between">
          <h2 className="text-20 font-semibold text-neutral-900">Upload document</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-13 text-neutral-500 hover:text-neutral-900"
          >
            Close
          </button>
        </div>
        <p className="text-13 text-neutral-500 mt-1">
          Mock mode: metadata is stored; the file itself is not uploaded to storage.
        </p>

        <form onSubmit={onSubmit} className="mt-4 space-y-3">
          <Input
            label="Document name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            data-testid="document-name"
          />
          <label className="block">
            <span className="block text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">Type</span>
            <select
              value={type}
              onChange={(e) => setType(e.target.value as DocumentType)}
              className="h-8 px-2 text-13 bg-white border border-neutral-300 rounded w-full"
              data-testid="document-type"
            >
              {TYPES.map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </select>
          </label>
          {canManage && !fixedEmployeeId ? (
            <label className="block">
              <span className="block text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">Employee</span>
              <select
                value={employeeId}
                onChange={(e) => setEmployeeId(e.target.value)}
                className="h-8 px-2 text-13 bg-white border border-neutral-300 rounded w-full"
                data-testid="document-employee"
              >
                <option value="">Select employee…</option>
                {(employeesQ.data?.items ?? []).map((emp) => (
                  <option key={emp.id} value={emp.id}>
                    {emp.employee_code} — {emp.full_name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <Input
            label="Expiry (optional)"
            type="date"
            value={expiry}
            onChange={(e) => setExpiry(e.target.value)}
          />
          {error ? (
            <div className="text-12 text-red border-l-2 border-red pl-2">{error}</div>
          ) : null}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" type="button" onClick={onClose}>Cancel</Button>
            <Button variant="primary" type="submit" disabled={submit.isPending} data-testid="document-submit">
              {submit.isPending ? 'Uploading…' : 'Upload'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
