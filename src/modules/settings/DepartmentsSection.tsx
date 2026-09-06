import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SectionShell } from './SectionShell';
import { settingsApi } from './api';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { useToast } from '@/components/Toast';

export function DepartmentsSection() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['settings', 'departments'], queryFn: settingsApi.departments.list });
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');

  const create = useMutation({
    mutationFn: () => settingsApi.departments.create({ name, code }),
    onSuccess: () => {
      toast.push('success', 'Department created.');
      qc.invalidateQueries({ queryKey: ['settings', 'departments'] });
      setAdding(false);
      setName('');
      setCode('');
    },
    onError: (e: Error) => toast.push('error', e.message),
  });
  const del = useMutation({
    mutationFn: (id: string) => settingsApi.departments.delete(id),
    onSuccess: () => {
      toast.push('success', 'Department removed.');
      qc.invalidateQueries({ queryKey: ['settings', 'departments'] });
    },
    onError: (e: Error) => toast.push('error', e.message),
  });

  return (
    <SectionShell
      title="Departments"
      description="Structure the org. Cannot delete a department that still has employees."
      addLabel={adding ? undefined : 'Add department'}
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
          <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} required data-testid="dept-name" />
          <Input label="Code" value={code} onChange={(e) => setCode(e.target.value)} required data-testid="dept-code" />
          <Button variant="primary" type="submit" disabled={create.isPending} data-testid="dept-submit">
            {create.isPending ? 'Saving…' : 'Save'}
          </Button>
          <Button variant="ghost" type="button" onClick={() => setAdding(false)}>Cancel</Button>
        </form>
      ) : null}

      <div className="bg-white border border-neutral-200 rounded overflow-hidden" data-testid="departments-table">
        {q.isLoading ? (
          <div className="h-32 bg-neutral-100" aria-label="Loading" />
        ) : (
          <table className="w-full border-collapse tabular-nums">
            <thead>
              <tr>
                {['Code', 'Name', 'Actions'].map((c) => (
                  <th key={c} className="text-left text-11 uppercase tracking-[0.06em] text-neutral-500 px-3 py-2 border-b border-neutral-300 font-medium">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {q.data!.items.map((d) => (
                <tr key={d.id} className="border-b border-neutral-200" data-testid={`dept-row-${d.id}`}>
                  <td className="px-3 py-2 text-13 text-neutral-500">{d.code}</td>
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
        )}
      </div>
    </SectionShell>
  );
}
