import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SectionShell } from './SectionShell';
import { settingsApi } from './api';
import { useToast } from '@/components/Toast';
import { useState } from 'react';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import type { LeaveType } from '@/data/models';

export function LeaveTypesSection() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['settings', 'leave-types'], queryFn: settingsApi.leaveTypes.list });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<Partial<LeaveType>>({});

  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<LeaveType> }) =>
      settingsApi.leaveTypes.patch(id, body),
    onSuccess: () => {
      toast.push('success', 'Leave type updated.');
      qc.invalidateQueries({ queryKey: ['settings', 'leave-types'] });
      qc.invalidateQueries({ queryKey: ['leaves'] });
      setEditingId(null);
    },
    onError: (e: Error) => toast.push('error', e.message),
  });

  return (
    <SectionShell
      title="Leave types"
      description="Edit entitlements, carry-forward, notice and probation rules per §3. Types are never deleted — history references them."
    >
      <div className="bg-white border border-neutral-200 rounded overflow-hidden">
        <table className="w-full border-collapse tabular-nums">
          <thead>
            <tr>
              {['Name', 'Code', 'Annual entitlement', 'Carry-fwd max', 'Half-day', 'Min notice', 'Probation accrual', 'Actions'].map((c) => (
                <th key={c} className="text-left text-11 uppercase tracking-[0.06em] text-neutral-500 px-3 py-2 border-b border-neutral-300 font-medium">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(q.data?.items ?? []).map((t) => {
              const isEdit = editingId === t.id;
              return (
                <tr key={t.id} className="border-b border-neutral-200 align-top">
                  <td className="px-3 py-2 text-13 text-neutral-900">{t.name}</td>
                  <td className="px-3 py-2 text-13 text-neutral-500">{t.code}</td>
                  <td className="px-3 py-2">
                    {isEdit ? (
                      <Input
                        label=""
                        type="number"
                        value={form.annual_entitlement == null ? '' : String(form.annual_entitlement)}
                        onChange={(e) =>
                          setForm({ ...form, annual_entitlement: e.target.value === '' ? null : Number(e.target.value) })
                        }
                      />
                    ) : (
                      <span className="text-13 text-neutral-900">{t.annual_entitlement ?? '∞'}</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {isEdit ? (
                      <Input
                        label=""
                        type="number"
                        value={String(form.carry_forward_max ?? 0)}
                        onChange={(e) => setForm({ ...form, carry_forward_max: Number(e.target.value) })}
                      />
                    ) : (
                      <span className="text-13 text-neutral-900">{t.carry_forward_max}</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-13 text-neutral-700">{t.half_day_allowed ? 'Yes' : 'No'}</td>
                  <td className="px-3 py-2">
                    {isEdit ? (
                      <Input
                        label=""
                        type="number"
                        value={String(form.min_notice_days ?? 0)}
                        onChange={(e) => setForm({ ...form, min_notice_days: Number(e.target.value) })}
                      />
                    ) : (
                      <span className="text-13 text-neutral-900">{t.min_notice_days}</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-13 text-neutral-700">{t.accrue_during_probation ? 'Yes' : 'No'}</td>
                  <td className="px-3 py-2">
                    {isEdit ? (
                      <div className="flex gap-2">
                        <Button
                          variant="primary"
                          onClick={() => patch.mutate({ id: t.id, body: form })}
                          disabled={patch.isPending}
                          data-testid={`leave-type-save-${t.code}`}
                        >
                          Save
                        </Button>
                        <Button variant="ghost" onClick={() => setEditingId(null)}>Cancel</Button>
                      </div>
                    ) : (
                      <Button
                        variant="secondary"
                        data-testid={`leave-type-edit-${t.code}`}
                        onClick={() => {
                          setEditingId(t.id);
                          setForm({
                            annual_entitlement: t.annual_entitlement,
                            carry_forward_max: t.carry_forward_max,
                            min_notice_days: t.min_notice_days,
                          });
                        }}
                      >
                        Edit
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </SectionShell>
  );
}
