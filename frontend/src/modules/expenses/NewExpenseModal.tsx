/**
 * New Expense modal. Employees create as Draft. Submit is a separate action.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { useToast } from '@/components/Toast';
import { expensesApi } from './api';
import { settingsApi } from '@/modules/settings/api';
import { istToday } from '@/lib/dates';
import type { ExpensePaymentMethod } from '@/data/models';

interface Props {
  open: boolean;
  onClose: () => void;
}

const METHODS: [ExpensePaymentMethod, string][] = [
  ['card', 'Card'],
  ['cash', 'Cash'],
  ['upi', 'UPI'],
  ['bank_transfer', 'Bank transfer'],
  ['other', 'Other'],
];

export function NewExpenseModal({ open, onClose }: Props) {
  const qc = useQueryClient();
  const toast = useToast();
  const cats = useQuery({
    queryKey: ['settings', 'expense-categories'],
    queryFn: settingsApi.expenseCategories.list,
    enabled: open,
  });
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(istToday());
  const [method, setMethod] = useState<ExpensePaymentMethod>('card');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setTitle('');
    setCategory('');
    setAmount('');
    setDate(istToday());
    setMethod('card');
    setDescription('');
    setError(null);
  }, [open]);

  const create = useMutation({
    mutationFn: () =>
      expensesApi.create({
        title: title.trim(),
        category_id: category,
        amount_paise: Math.round(Number(amount) * 100),
        expense_date: date,
        payment_method: method,
        description,
      }),
    onSuccess: () => {
      toast.push('success', 'Draft saved. Click Submit on the row to send for approval.');
      qc.invalidateQueries({ queryKey: ['expenses'] });
      onClose();
    },
    onError: (e: Error) => setError(e.message),
  });

  if (!open) return null;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!title.trim()) return setError('Title required.');
    if (!category) return setError('Category required.');
    const n = Number(amount);
    if (!(n > 0)) return setError('Amount must be positive.');
    create.mutate();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-40 grid place-items-center bg-neutral-900/30 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      data-testid="expense-new-modal"
    >
      <div className="w-full max-w-[520px] bg-white border border-neutral-200 rounded shadow-drawer p-6">
        <div className="flex items-baseline justify-between">
          <h2 className="text-20 font-semibold text-neutral-900">New expense</h2>
          <button type="button" onClick={onClose} className="text-13 text-neutral-500 hover:text-neutral-900">Close</button>
        </div>
        <form onSubmit={onSubmit} className="mt-4 space-y-3">
          <Input label="Title" value={title} onChange={(e) => setTitle(e.target.value)} required data-testid="exp-title" />
          <label className="block">
            <span className="block text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">Category</span>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="h-8 px-2 text-13 bg-white border border-neutral-300 rounded w-full"
              data-testid="exp-category"
            >
              <option value="">Select…</option>
              {(cats.data?.items ?? []).filter((c) => c.is_active).map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </label>
          <div className="grid grid-cols-2 gap-3">
            <Input label="Amount (₹)" type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} required data-testid="exp-amount" />
            <Input label="Date" type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
          </div>
          <label className="block">
            <span className="block text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">Payment method</span>
            <select
              value={method}
              onChange={(e) => setMethod(e.target.value as ExpensePaymentMethod)}
              className="h-8 px-2 text-13 bg-white border border-neutral-300 rounded w-full"
            >
              {METHODS.map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="block text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">Description</span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className="block w-full px-3 py-2 text-13 bg-white text-neutral-900 border border-neutral-300 rounded focus:outline-none focus:border-gold"
            />
          </label>
          {error ? <div className="text-12 text-red border-l-2 border-red pl-2">{error}</div> : null}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" type="button" onClick={onClose}>Cancel</Button>
            <Button variant="primary" type="submit" disabled={create.isPending} data-testid="exp-save">
              {create.isPending ? 'Saving…' : 'Save draft'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
