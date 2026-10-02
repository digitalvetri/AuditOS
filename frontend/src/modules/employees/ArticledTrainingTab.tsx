/**
 * Articled Training sub-record tab (§8.1). Renders only for type='articled'.
 * HR/MD can edit; employee sees read-only.
 */
import { useState, useEffect, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { employeeApi } from './api';
import { Input } from '@/components/Input';
import { Button } from '@/components/Button';
import { useToast } from '@/components/Toast';
import { fmtDate } from '@/lib/format';
import type { ArticledTraining } from '@/data/models';

interface Props {
  employeeId: string;
  canEdit: boolean;
}

export function ArticledTrainingTab({ employeeId, canEdit }: Props) {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({
    queryKey: ['employee', employeeId, 'training'],
    queryFn: () => employeeApi.training(employeeId),
    retry: false,
  });
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Partial<ArticledTraining>>({});
  useEffect(() => {
    if (q.data?.training) setForm({ ...q.data.training });
  }, [q.data]);

  const patch = useMutation({
    mutationFn: (body: Partial<ArticledTraining>) => employeeApi.updateTraining(employeeId, body),
    onSuccess: () => {
      toast.push('success', 'Training saved.');
      qc.invalidateQueries({ queryKey: ['employee', employeeId, 'training'] });
      setEditing(false);
    },
    onError: (e: Error) => toast.push('error', e.message),
  });

  if (q.isLoading) return <div className="h-40 bg-neutral-100" aria-label="Loading training" />;
  if (q.isError)
    return (
      <div className="p-4 text-13 text-neutral-500">
        No training record. HR/MD can add one for this Articled Assistant.
      </div>
    );

  const t = q.data!.training;
  const principal = q.data!.principal;

  if (editing && canEdit) {
    return (
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          patch.mutate(form);
        }}
        className="bg-white border border-neutral-200 rounded p-4 space-y-3 max-w-[540px]"
      >
        <Input
          label="ICAI Registration No."
          value={form.icai_registration_no ?? ''}
          onChange={(e) => setForm({ ...form, icai_registration_no: e.target.value })}
        />
        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Training start"
            type="date"
            value={form.training_start ?? ''}
            onChange={(e) => setForm({ ...form, training_start: e.target.value })}
          />
          <Input
            label="Training end"
            type="date"
            value={form.training_end ?? ''}
            onChange={(e) => setForm({ ...form, training_end: e.target.value })}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="block text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">Current year</span>
            <select
              value={form.current_year ?? 1}
              onChange={(e) => setForm({ ...form, current_year: Number(e.target.value) as 1 | 2 | 3 })}
              className="h-8 px-2 text-13 bg-white border border-neutral-300 rounded w-full"
            >
              {[1, 2, 3].map((y) => (
                <option key={y} value={y}>
                  Year {y}
                </option>
              ))}
            </select>
          </label>
          <Input
            label="Stipend slab"
            value={form.stipend_slab ?? ''}
            onChange={(e) => setForm({ ...form, stipend_slab: e.target.value })}
          />
        </div>
        <label className="block">
          <span className="block text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">Status</span>
          <select
            value={form.status ?? 'active'}
            onChange={(e) => setForm({ ...form, status: e.target.value as ArticledTraining['status'] })}
            className="h-8 px-2 text-13 bg-white border border-neutral-300 rounded w-full"
          >
            {['active', 'transferred', 'completed', 'terminated'].map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" type="button" onClick={() => setEditing(false)}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" disabled={patch.isPending}>
            {patch.isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </form>
    );
  }

  return (
    <div className="bg-white border border-neutral-200 rounded p-4 space-y-3" data-testid="articled-training">
      <div className="flex items-baseline justify-between">
        <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">
          Articled Training
        </div>
        {canEdit ? (
          <Button variant="secondary" onClick={() => setEditing(true)}>
            Edit
          </Button>
        ) : null}
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-13">
        <Field label="ICAI No." value={t.icai_registration_no} />
        <Field label="Principal" value={principal?.full_name ?? '—'} />
        <Field label="Current year" value={`Year ${t.current_year}`} />
        <Field label="Training start" value={fmtDate(t.training_start + 'T00:00:00Z')} />
        <Field label="Training end" value={fmtDate(t.training_end + 'T00:00:00Z')} />
        <Field label="Stipend slab" value={t.stipend_slab} />
        <Field label="Status" value={t.status} />
      </div>
    </div>
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
