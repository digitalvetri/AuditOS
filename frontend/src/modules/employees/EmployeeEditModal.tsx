/**
 * Two-mode edit modal:
 *   - self  : contact fields only (phone, address, emergency contact, bank)
 *   - hr    : any field on the HR allowlist
 *
 * The server is the source of truth for allowed fields; UI mirrors it.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { useToast } from '@/components/Toast';
import { employeeApi } from './api';
import type { Employee } from '@/data/models';

interface Props {
  open: boolean;
  onClose: () => void;
  employee: Employee;
  mode: 'self' | 'hr';
}

export function EmployeeEditModal({ open, onClose, employee, mode }: Props) {
  const qc = useQueryClient();
  const toast = useToast();

  const [form, setForm] = useState<Partial<Employee>>({});
  useEffect(() => {
    if (!open) return;
    setForm(
      mode === 'self'
        ? {
            phone: employee.phone,
            address: employee.address ?? '',
            emergency_contact_name: employee.emergency_contact_name ?? '',
            emergency_contact_phone: employee.emergency_contact_phone ?? '',
            bank_account_masked: employee.bank_account_masked ?? '',
          }
        : {
            first_name: employee.first_name,
            last_name: employee.last_name,
            email: employee.email,
            phone: employee.phone,
            type: employee.type,
            status: employee.status,
            designation_id: employee.designation_id,
            department_id: employee.department_id,
            manager_id: employee.manager_id ?? null,
            joining_date: employee.joining_date,
          },
    );
  }, [open, employee, mode]);

  const patch = useMutation({
    mutationFn: (body: Partial<Employee>) => employeeApi.patch(employee.id, body),
    onSuccess: () => {
      toast.push('success', 'Saved.');
      qc.invalidateQueries({ queryKey: ['employees'] });
      qc.invalidateQueries({ queryKey: ['employee', employee.id] });
      onClose();
    },
    onError: (e: Error) => toast.push('error', e.message),
  });

  if (!open) return null;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    patch.mutate(form);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-40 grid place-items-center bg-neutral-900/30 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      data-testid="employee-edit-modal"
    >
      <div className="w-full max-w-[540px] bg-white border border-neutral-200 rounded shadow-drawer p-6">
        <div className="flex items-baseline justify-between">
          <h2 className="text-20 font-semibold text-neutral-900">
            {mode === 'self' ? 'Edit contact details' : 'Edit employment'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-13 text-neutral-500 hover:text-neutral-900"
          >
            Close
          </button>
        </div>
        <p className="text-13 text-neutral-500 mt-1">
          {mode === 'self'
            ? 'Phone, address, emergency contact and bank. Bank changes are pending HR verification.'
            : 'Employment fields — visible to HR/MD only.'}
        </p>

        <form onSubmit={onSubmit} className="mt-4 space-y-3">
          {mode === 'self' ? (
            <>
              <Input label="Phone" value={form.phone ?? ''} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
              <Input label="Address" value={form.address ?? ''} onChange={(e) => setForm({ ...form, address: e.target.value })} />
              <div className="grid grid-cols-2 gap-3">
                <Input
                  label="Emergency contact name"
                  value={form.emergency_contact_name ?? ''}
                  onChange={(e) => setForm({ ...form, emergency_contact_name: e.target.value })}
                />
                <Input
                  label="Emergency contact phone"
                  value={form.emergency_contact_phone ?? ''}
                  onChange={(e) => setForm({ ...form, emergency_contact_phone: e.target.value })}
                />
              </div>
              <Input
                label="Bank account (masked)"
                value={form.bank_account_masked ?? ''}
                onChange={(e) => setForm({ ...form, bank_account_masked: e.target.value })}
              />
            </>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3">
                <Input label="First name" value={form.first_name ?? ''} onChange={(e) => setForm({ ...form, first_name: e.target.value })} required />
                <Input label="Last name" value={form.last_name ?? ''} onChange={(e) => setForm({ ...form, last_name: e.target.value })} required />
              </div>
              <Input label="Email" type="email" value={form.email ?? ''} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
              <Input label="Phone" value={form.phone ?? ''} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="block text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">Type</span>
                  <select
                    value={form.type ?? ''}
                    onChange={(e) => setForm({ ...form, type: e.target.value as Employee['type'] })}
                    className="h-8 px-2 text-13 bg-white border border-neutral-300 rounded w-full"
                  >
                    {['partner', 'manager', 'executive', 'articled', 'support'].map((t) => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="block text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">Status</span>
                  <select
                    value={form.status ?? ''}
                    onChange={(e) => setForm({ ...form, status: e.target.value as Employee['status'] })}
                    className="h-8 px-2 text-13 bg-white border border-neutral-300 rounded w-full"
                  >
                    {['active', 'on_leave', 'probation', 'notice_period'].map((s) => (
                      <option key={s} value={s}>{s.replace('_', ' ')}</option>
                    ))}
                  </select>
                </label>
              </div>
              <Input label="Joining date" type="date" value={form.joining_date ?? ''} onChange={(e) => setForm({ ...form, joining_date: e.target.value })} />
            </>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={onClose} type="button">Cancel</Button>
            <Button
              variant="primary"
              type="submit"
              disabled={patch.isPending}
              data-testid={`employee-edit-save-${mode}`}
            >
              {patch.isPending ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
