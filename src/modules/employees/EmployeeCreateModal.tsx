/**
 * Create modal — HR/MD only. Mirrors the "hr" mode of EmployeeEditModal and
 * posts to POST /api/employees, which allocates the employee code, work
 * location and schedule server-side. On success the caller navigates to the
 * new profile.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { useToast } from '@/components/Toast';
import { employeeApi, isFullEmployee, type EmployeeCreateInput } from './api';
import { settingsApi } from '@/modules/settings/api';
import type { Employee } from '@/data/models';

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
}

const EMPTY: EmployeeCreateInput = {
  first_name: '', last_name: '', email: '', phone: '',
  department_id: '', designation_id: '', manager_id: null,
  type: 'executive', status: 'probation', joining_date: '',
};

export function EmployeeCreateModal({ open, onClose, onCreated }: Props) {
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState<EmployeeCreateInput>(EMPTY);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setForm({ ...EMPTY, joining_date: new Date().toISOString().slice(0, 10) });
    setError(null);
  }, [open]);

  const departments = useQuery({ queryKey: ['settings', 'departments'], queryFn: settingsApi.departments.list, enabled: open });
  const designations = useQuery({ queryKey: ['settings', 'designations'], queryFn: settingsApi.designations.list, enabled: open });
  const managers = useQuery({ queryKey: ['employees', 'list', {}], queryFn: () => employeeApi.list({}), enabled: open });

  const create = useMutation({
    mutationFn: (body: EmployeeCreateInput) => employeeApi.create(body),
    onSuccess: ({ employee }) => {
      toast.push('success', `${employee.full_name} added as ${employee.employee_code}.`);
      qc.invalidateQueries({ queryKey: ['employees'] });
      onCreated(employee.id);
    },
    onError: (e: Error) => setError(e.message),
  });

  if (!open) return null;

  const set = <K extends keyof EmployeeCreateInput>(key: K, value: EmployeeCreateInput[K]) => setForm((f) => ({ ...f, [key]: value }));
  const selectCls = 'h-8 px-2 text-13 bg-white border border-neutral-300 rounded w-full';

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!form.first_name.trim() || !form.last_name.trim()) return setError('First and last name are required.');
    if (!form.email.trim()) return setError('Email is required.');
    if (!form.department_id) return setError('Choose a department.');
    if (!form.designation_id) return setError('Choose a designation.');
    create.mutate({
      ...form,
      first_name: form.first_name.trim(),
      last_name: form.last_name.trim(),
      email: form.email.trim().toLowerCase(),
      phone: form.phone?.trim() || undefined,
      manager_id: form.manager_id || null,
      joining_date: form.joining_date || undefined,
    });
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-40 grid place-items-center bg-neutral-900/30 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      data-testid="employee-create-modal"
    >
      <div className="w-full max-w-[540px] bg-white border border-neutral-200 rounded shadow-drawer p-6">
        <div className="flex items-baseline justify-between">
          <h2 className="text-20 font-semibold text-neutral-900">Add employee</h2>
          <button type="button" onClick={onClose} className="text-13 text-neutral-500 hover:text-neutral-900">Close</button>
        </div>
        <p className="text-13 text-neutral-500 mt-1">
          The employee code is allocated automatically. A login is not created here.
        </p>

        <form onSubmit={onSubmit} className="mt-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Input label="First name" value={form.first_name} onChange={(e) => set('first_name', e.target.value)} required data-testid="employee-create-first" />
            <Input label="Last name" value={form.last_name} onChange={(e) => set('last_name', e.target.value)} required data-testid="employee-create-last" />
          </div>
          <Input label="Email" type="email" value={form.email} onChange={(e) => set('email', e.target.value)} required data-testid="employee-create-email" />
          <Input label="Phone" value={form.phone ?? ''} onChange={(e) => set('phone', e.target.value)} />
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="block text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">Department</span>
              <select value={form.department_id} onChange={(e) => set('department_id', e.target.value)} className={selectCls} required data-testid="employee-create-department">
                <option value="">Select…</option>
                {(departments.data?.items ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="block text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">Designation</span>
              <select value={form.designation_id} onChange={(e) => set('designation_id', e.target.value)} className={selectCls} required data-testid="employee-create-designation">
                <option value="">Select…</option>
                {(designations.data?.items ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </label>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="block text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">Type</span>
              <select value={form.type} onChange={(e) => set('type', e.target.value as Employee['type'])} className={selectCls}>
                {['partner', 'manager', 'executive', 'articled', 'support'].map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="block text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">Status</span>
              <select value={form.status} onChange={(e) => set('status', e.target.value as Employee['status'])} className={selectCls}>
                {['probation', 'active', 'on_leave', 'notice_period'].map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
              </select>
            </label>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="block text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">Manager</span>
              <select value={form.manager_id ?? ''} onChange={(e) => set('manager_id', e.target.value || null)} className={selectCls}>
                <option value="">None</option>
                {(managers.data?.items ?? []).filter(isFullEmployee).map((m) => (
                  <option key={m.id} value={m.id}>{m.employee_code} — {m.full_name}</option>
                ))}
              </select>
            </label>
            <Input label="Joining date" type="date" value={form.joining_date ?? ''} onChange={(e) => set('joining_date', e.target.value)} />
          </div>
          {error ? <div className="text-12 text-red border-l-2 border-red pl-2">{error}</div> : null}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" type="button" onClick={onClose}>Cancel</Button>
            <Button variant="primary" type="submit" disabled={create.isPending} data-testid="employee-create-submit">
              {create.isPending ? 'Adding…' : 'Add employee'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
