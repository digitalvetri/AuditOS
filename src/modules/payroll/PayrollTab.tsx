/**
 * EmployeeDetail's Payroll tab:
 *   - Current salary structure (HR/MD/Finance can see; edit button HR/MD only)
 *   - Payslip history for this employee
 */
import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { payrollApi } from './api';
import { inr } from '@/lib/format';
import { istToday } from '@/lib/dates';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { useToast } from '@/components/Toast';

interface Props {
  employeeId: string;
  canManageSalary: boolean;
}

export function PayrollTab({ employeeId, canManageSalary }: Props) {
  const salaryQ = useQuery({
    queryKey: ['payroll', 'salary', employeeId],
    queryFn: () => payrollApi.salary.get(employeeId),
    retry: false,
  });
  const payslipsQ = useQuery({
    queryKey: ['payroll', 'payslips', 'byemp', employeeId],
    queryFn: () => payrollApi.payslips.list({ employeeId }),
    retry: false,
  });

  if (salaryQ.isError) {
    return (
      <div className="bg-white border border-neutral-200 rounded p-4 text-13 text-neutral-500 border-l-2 border-l-neutral-400">
        Payroll access required to view salary structure.
      </div>
    );
  }

  const current = salaryQ.data?.current ?? null;
  const payslips = payslipsQ.data?.items ?? [];

  return (
    <div className="space-y-6" data-testid="payroll-tab">
      <SalaryCard structure={current} employeeId={employeeId} canManage={canManageSalary} />
      <PayslipHistory items={payslips} />
    </div>
  );
}

function SalaryCard({
  structure,
  employeeId,
  canManage,
}: {
  structure: null | Awaited<ReturnType<typeof payrollApi.salary.get>>['current'];
  employeeId: string;
  canManage: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState({
    effective_from: istToday(),
    monthly_ctc_paise: structure?.monthly_ctc_paise ?? 0,
    basic_paise: structure?.basic_paise ?? 0,
    hra_paise: structure?.hra_paise ?? 0,
    conveyance_paise: structure?.conveyance_paise ?? 0,
    special_allowance_paise: structure?.special_allowance_paise ?? 0,
  });

  const save = useMutation({
    mutationFn: () => payrollApi.salary.patch(employeeId, form),
    onSuccess: () => {
      toast.push('success', 'Salary structure superseded — takes effect from next payroll cycle.');
      qc.invalidateQueries({ queryKey: ['payroll', 'salary', employeeId] });
      setEditing(false);
    },
    onError: (e: Error) => toast.push('error', e.message),
  });

  if (!structure) {
    return (
      <div className="bg-white border border-neutral-200 rounded p-4 text-13 text-neutral-500">
        No salary structure on file.
      </div>
    );
  }

  return (
    <section className="bg-white border border-neutral-200 rounded p-4" data-testid="salary-card">
      <div className="flex items-baseline justify-between gap-4">
        <div>
          <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">Salary structure</div>
          <div className="text-16 text-neutral-900 mt-1 tabular-nums">
            {inr(structure.monthly_ctc_paise)} <span className="text-13 text-neutral-500">/month</span>
          </div>
          <div className="text-11 text-neutral-500 mt-1">Effective from {structure.effective_from}</div>
        </div>
        {canManage && !editing ? (
          <Button variant="secondary" onClick={() => setEditing(true)} data-testid="salary-edit">
            Supersede
          </Button>
        ) : null}
      </div>

      <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-4 tabular-nums">
        <Field label="Basic" value={inr(structure.basic_paise)} />
        <Field label="HRA" value={inr(structure.hra_paise)} />
        <Field label="Conveyance" value={inr(structure.conveyance_paise)} />
        <Field label="Special allowance" value={inr(structure.special_allowance_paise)} />
      </div>

      {editing ? (
        <form
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            save.mutate();
          }}
          className="mt-4 grid grid-cols-2 md:grid-cols-3 gap-3"
        >
          <Input
            label="Effective from"
            type="date"
            value={form.effective_from}
            onChange={(e) => setForm({ ...form, effective_from: e.target.value })}
            required
          />
          <PaiseInput label="Monthly CTC" value={form.monthly_ctc_paise} onChange={(v) => setForm({ ...form, monthly_ctc_paise: v })} />
          <PaiseInput label="Basic" value={form.basic_paise} onChange={(v) => setForm({ ...form, basic_paise: v })} />
          <PaiseInput label="HRA" value={form.hra_paise} onChange={(v) => setForm({ ...form, hra_paise: v })} />
          <PaiseInput label="Conveyance" value={form.conveyance_paise} onChange={(v) => setForm({ ...form, conveyance_paise: v })} />
          <PaiseInput label="Special allowance" value={form.special_allowance_paise} onChange={(v) => setForm({ ...form, special_allowance_paise: v })} />
          <div className="col-span-full flex justify-end gap-2 pt-1">
            <Button variant="ghost" type="button" onClick={() => setEditing(false)}>Cancel</Button>
            <Button variant="primary" type="submit" disabled={save.isPending} data-testid="salary-save">
              {save.isPending ? 'Saving…' : 'Save new version'}
            </Button>
          </div>
        </form>
      ) : null}
    </section>
  );
}

function PayslipHistory({ items }: { items: Awaited<ReturnType<typeof payrollApi.payslips.list>>['items'] }) {
  return (
    <section className="bg-white border border-neutral-200 rounded overflow-hidden">
      <div className="p-4 border-b border-neutral-200">
        <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">Payslip history</div>
      </div>
      {items.length === 0 ? (
        <div className="p-6 text-13 text-neutral-500">No payslips yet.</div>
      ) : (
        <table className="w-full border-collapse tabular-nums">
          <thead>
            <tr>
              {['Period', 'Gross', 'Net', 'Published', ''].map((c) => (
                <th key={c} className="text-left text-11 uppercase tracking-[0.06em] text-neutral-500 px-3 py-2 border-b border-neutral-300 font-medium">{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.map((p) => (
              <tr key={p.id} className="border-b border-neutral-200">
                <td className="px-3 py-2 text-13 text-neutral-900">{p.period_start} → {p.period_end}</td>
                <td className="px-3 py-2 text-13 text-neutral-900">{inr(p.gross_paise)}</td>
                <td className="px-3 py-2 text-13 text-neutral-900">{inr(p.net_paise)}</td>
                <td className="px-3 py-2 text-13 text-neutral-500">{p.published_at.slice(0, 10)}</td>
                <td className="px-3 py-2">
                  <Link to={`/hrms/payroll/payslips/${p.id}`} className="text-13 text-gold hover:text-gold-hover">Open →</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">{label}</div>
      <div className="text-13 text-neutral-900 mt-1">{value}</div>
    </div>
  );
}

function PaiseInput({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <Input
      label={label}
      type="number"
      value={String(value / 100)}
      onChange={(e) => onChange(Math.round(Number(e.target.value)) * 100)}
    />
  );
}
