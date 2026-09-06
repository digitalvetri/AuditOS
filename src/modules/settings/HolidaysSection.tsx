import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SectionShell } from './SectionShell';
import { settingsApi } from './api';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { useToast } from '@/components/Toast';
import { fmtDate } from '@/lib/format';

export function HolidaysSection() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['settings', 'holidays'], queryFn: settingsApi.holidays.list });
  const [adding, setAdding] = useState(false);
  const [date, setDate] = useState('');
  const [name, setName] = useState('');
  const [optional, setOptional] = useState(false);

  const create = useMutation({
    mutationFn: () => settingsApi.holidays.create({ date, name, is_optional: optional }),
    onSuccess: () => {
      toast.push('success', 'Holiday added.');
      qc.invalidateQueries({ queryKey: ['settings', 'holidays'] });
      qc.invalidateQueries({ queryKey: ['leaves', 'holidays'] });
      setAdding(false);
      setDate('');
      setName('');
      setOptional(false);
    },
    onError: (e: Error) => toast.push('error', e.message),
  });
  const del = useMutation({
    mutationFn: (id: string) => settingsApi.holidays.delete(id),
    onSuccess: () => {
      toast.push('success', 'Holiday removed.');
      qc.invalidateQueries({ queryKey: ['settings', 'holidays'] });
      qc.invalidateQueries({ queryKey: ['leaves', 'holidays'] });
    },
    onError: (e: Error) => toast.push('error', e.message),
  });

  return (
    <SectionShell
      title="Holiday calendar"
      description="Attendance and leave respect these. Sandwich rule applies (§3)."
      addLabel={adding ? undefined : 'Add holiday'}
      onAdd={adding ? undefined : () => setAdding(true)}
    >
      {adding ? (
        <form
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            create.mutate();
          }}
          className="bg-white border border-neutral-200 rounded p-4 flex items-end gap-3 flex-wrap"
        >
          <Input label="Date" type="date" value={date} onChange={(e) => setDate(e.target.value)} required data-testid="holiday-date" />
          <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} required data-testid="holiday-name" />
          <label className="flex items-center gap-2 text-13 text-neutral-700 h-8">
            <input type="checkbox" checked={optional} onChange={(e) => setOptional(e.target.checked)} />
            Optional
          </label>
          <Button variant="primary" type="submit" disabled={create.isPending} data-testid="holiday-submit">Save</Button>
          <Button variant="ghost" type="button" onClick={() => setAdding(false)}>Cancel</Button>
        </form>
      ) : null}
      <div className="bg-white border border-neutral-200 rounded overflow-hidden" data-testid="holidays-table">
        <table className="w-full border-collapse tabular-nums">
          <thead>
            <tr>
              {['Date', 'Name', 'Optional', 'Actions'].map((c) => (
                <th key={c} className="text-left text-11 uppercase tracking-[0.06em] text-neutral-500 px-3 py-2 border-b border-neutral-300 font-medium">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(q.data?.items ?? []).map((h) => (
              <tr key={h.id} className={'border-b border-neutral-200 border-l-2 ' + (h.is_optional ? 'border-amber' : 'border-transparent')}>
                <td className="px-3 py-2 text-13 text-neutral-900">{fmtDate(h.date + 'T00:00:00Z')}</td>
                <td className="px-3 py-2 text-13 text-neutral-900">{h.name}</td>
                <td className="px-3 py-2 text-13 text-neutral-700">{h.is_optional ? 'Yes' : 'No'}</td>
                <td className="px-3 py-2">
                  <Button variant="ghost" onClick={() => { if (confirm(`Remove ${h.name}?`)) del.mutate(h.id); }}>
                    Delete
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SectionShell>
  );
}
