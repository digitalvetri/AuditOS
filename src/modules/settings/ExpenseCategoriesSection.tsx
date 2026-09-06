import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SectionShell } from './SectionShell';
import { settingsApi } from './api';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { useToast } from '@/components/Toast';

export function ExpenseCategoriesSection() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['settings', 'expense-categories'], queryFn: settingsApi.expenseCategories.list });
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [gl, setGl] = useState('');
  const [requiresReceipt, setRequiresReceipt] = useState(true);

  const create = useMutation({
    mutationFn: () => settingsApi.expenseCategories.create({ name, code, gl_account: gl || null, requires_receipt: requiresReceipt }),
    onSuccess: () => {
      toast.push('success', 'Category created.');
      qc.invalidateQueries({ queryKey: ['settings', 'expense-categories'] });
      setAdding(false);
      setName('');
      setCode('');
      setGl('');
      setRequiresReceipt(true);
    },
    onError: (e: Error) => toast.push('error', e.message),
  });
  const toggle = useMutation({
    mutationFn: ({ id, is_active }: { id: string; is_active: boolean }) =>
      settingsApi.expenseCategories.patch(id, { is_active }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings', 'expense-categories'] }),
    onError: (e: Error) => toast.push('error', e.message),
  });

  return (
    <SectionShell
      title="Expense categories"
      description="Part 2 Expenses reads this list. Toggling inactive keeps historical expenses intact but hides the category from new submissions."
      addLabel={adding ? undefined : 'Add category'}
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
          <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} required />
          <Input label="Code" value={code} onChange={(e) => setCode(e.target.value)} required />
          <Input label="GL account" value={gl} onChange={(e) => setGl(e.target.value)} />
          <label className="flex items-center gap-2 text-13 text-neutral-700 h-8">
            <input type="checkbox" checked={requiresReceipt} onChange={(e) => setRequiresReceipt(e.target.checked)} />
            Requires receipt
          </label>
          <Button variant="primary" type="submit" disabled={create.isPending}>Save</Button>
          <Button variant="ghost" type="button" onClick={() => setAdding(false)}>Cancel</Button>
        </form>
      ) : null}
      <div className="bg-white border border-neutral-200 rounded overflow-hidden">
        <table className="w-full border-collapse tabular-nums">
          <thead>
            <tr>
              {['Code', 'Name', 'GL account', 'Receipt required', 'Active', 'Actions'].map((c) => (
                <th key={c} className="text-left text-11 uppercase tracking-[0.06em] text-neutral-500 px-3 py-2 border-b border-neutral-300 font-medium">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(q.data?.items ?? []).map((ec) => (
              <tr key={ec.id} className={'border-b border-neutral-200 border-l-2 ' + (ec.is_active ? 'border-transparent' : 'border-neutral-400')}>
                <td className="px-3 py-2 text-13 text-neutral-500">{ec.code}</td>
                <td className="px-3 py-2 text-13 text-neutral-900">{ec.name}</td>
                <td className="px-3 py-2 text-13 text-neutral-700">{ec.gl_account ?? '—'}</td>
                <td className="px-3 py-2 text-13 text-neutral-700">{ec.requires_receipt ? 'Yes' : 'No'}</td>
                <td className="px-3 py-2 text-13 text-neutral-700">{ec.is_active ? 'Active' : 'Inactive'}</td>
                <td className="px-3 py-2">
                  <Button variant="ghost" onClick={() => toggle.mutate({ id: ec.id, is_active: !ec.is_active })}>
                    {ec.is_active ? 'Deactivate' : 'Activate'}
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
