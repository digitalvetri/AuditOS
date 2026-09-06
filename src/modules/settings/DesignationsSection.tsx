import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SectionShell } from './SectionShell';
import { settingsApi } from './api';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { useToast } from '@/components/Toast';

export function DesignationsSection() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['settings', 'designations'], queryFn: settingsApi.designations.list });
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');

  const create = useMutation({
    mutationFn: () => settingsApi.designations.create({ name }),
    onSuccess: () => {
      toast.push('success', 'Designation created.');
      qc.invalidateQueries({ queryKey: ['settings', 'designations'] });
      setAdding(false);
      setName('');
    },
    onError: (e: Error) => toast.push('error', e.message),
  });
  const del = useMutation({
    mutationFn: (id: string) => settingsApi.designations.delete(id),
    onSuccess: () => {
      toast.push('success', 'Designation removed.');
      qc.invalidateQueries({ queryKey: ['settings', 'designations'] });
    },
    onError: (e: Error) => toast.push('error', e.message),
  });

  return (
    <SectionShell
      title="Designations"
      addLabel={adding ? undefined : 'Add designation'}
      onAdd={adding ? undefined : () => setAdding(true)}
    >
      {adding ? (
        <form
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            create.mutate();
          }}
          className="bg-white border border-neutral-200 rounded p-4 flex items-end gap-3"
        >
          <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} required />
          <Button variant="primary" type="submit" disabled={create.isPending}>Save</Button>
          <Button variant="ghost" type="button" onClick={() => setAdding(false)}>Cancel</Button>
        </form>
      ) : null}
      <div className="bg-white border border-neutral-200 rounded overflow-hidden">
        <table className="w-full border-collapse tabular-nums">
          <thead>
            <tr>
              {['Name', 'Actions'].map((c) => (
                <th key={c} className="text-left text-11 uppercase tracking-[0.06em] text-neutral-500 px-3 py-2 border-b border-neutral-300 font-medium">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(q.data?.items ?? []).map((d) => (
              <tr key={d.id} className="border-b border-neutral-200">
                <td className="px-3 py-2 text-13 text-neutral-900">{d.name}</td>
                <td className="px-3 py-2">
                  <Button
                    variant="ghost"
                    onClick={() => {
                      if (confirm(`Remove ${d.name}?`)) del.mutate(d.id);
                    }}
                  >
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
