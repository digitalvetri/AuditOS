/**
 * Upload modal. Employees upload to their own record; HR/MD upload to any.
 * The file itself is uploaded and stored; Download returns those bytes.
 */
import { useEffect, useRef, useState, type DragEvent, type FormEvent } from 'react';
import { FileUp, X } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { useToast } from '@/components/Toast';
import { useAuth } from '@/platform/auth/AuthContext';
import { can } from '@/platform/rbac/can';
import { documentsApi } from './api';
import { employeeApi } from '@/modules/employees/api';
import type { DocumentType } from '@/data/models';

const ACCEPT = '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.csv,.txt,.zip,.png,.jpg,.jpeg,.webp,.gif';
const MAX_MB = 15;

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
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** Pick a file; an empty name takes the file's name (without the extension). */
  const choose = (f: File | null | undefined) => {
    if (!f) return;
    const ext = (f.name.split('.').pop() ?? '').toLowerCase();
    if (!ACCEPT.split(',').includes(`.${ext}`)) return setError(`"${f.name}" is not a PDF, Word, Excel, PowerPoint, CSV, text, zip or image file.`);
    if (f.size > MAX_MB * 1024 * 1024) return setError(`"${f.name}" is larger than ${MAX_MB} MB.`);
    setError(null);
    setFile(f);
    setName((n) => n || f.name.replace(/\.[^.]+$/, ''));
  };
  const onDrop = (e: DragEvent) => { e.preventDefault(); setDragging(false); choose(e.dataTransfer.files?.[0]); };

  useEffect(() => {
    if (!open) return;
    setName('');
    setType('employment');
    setEmployeeId(fixedEmployeeId ?? session?.employee?.id ?? '');
    setExpiry('');
    setFile(null);
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
        file: file!,
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
    if (!file) return setError('Choose the file to upload.');
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
          The file is stored securely and downloads with its own name from the Download button.
        </p>

        <form onSubmit={onSubmit} className="mt-4 space-y-3">
          <div>
            <span className="block text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">File</span>
            <input ref={fileRef} type="file" accept={ACCEPT} className="hidden" data-testid="document-file"
              onChange={(e) => { choose(e.target.files?.[0]); e.target.value = ''; }} />
            {file ? (
              <div className="flex items-center gap-3 px-3 py-2 border border-neutral-300 rounded bg-neutral-50">
                <FileUp size={18} className="text-neutral-500 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="text-13 text-neutral-900 truncate" title={file.name}>{file.name}</div>
                  <div className="text-11 text-neutral-500">{file.size < 1024 * 1024 ? `${Math.max(1, Math.round(file.size / 1024))} KB` : `${(file.size / (1024 * 1024)).toFixed(1)} MB`}</div>
                </div>
                <button type="button" onClick={() => fileRef.current?.click()} className="text-12 text-neutral-600 hover:text-neutral-900 underline">Change</button>
                <button type="button" onClick={() => setFile(null)} aria-label="Remove file" className="text-neutral-500 hover:text-neutral-900"><X size={16} /></button>
              </div>
            ) : (
              <button type="button" onClick={() => fileRef.current?.click()}
                onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={onDrop}
                className={'w-full flex flex-col items-center justify-center gap-1 px-3 py-5 border-2 border-dashed rounded text-center transition-colors ' + (dragging ? 'border-primary bg-neutral-50' : 'border-neutral-300 hover:bg-neutral-50')}>
                <FileUp size={22} className="text-neutral-500" />
                <span className="text-13 text-neutral-900">Click to choose a file, or drag it here</span>
                <span className="text-11 text-neutral-500">PDF, Word, Excel, PowerPoint, CSV, text, zip or image · up to {MAX_MB} MB</span>
              </button>
            )}
          </div>
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
            <Button variant="primary" type="submit" disabled={submit.isPending || !file} data-testid="document-submit">
              {submit.isPending ? 'Uploading…' : 'Upload'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
