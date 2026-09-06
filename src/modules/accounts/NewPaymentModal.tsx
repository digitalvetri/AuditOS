/**
 * Manual payment entry (Finance-only). Creates a Payment + matching Ledger
 * row atomically on the server.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { useToast } from '@/components/Toast';
import { accountsApi, LEDGER_TYPES } from './api';
import { employeeApi } from '@/modules/employees/api';
import type { LedgerTransaction, Payment } from '@/data/models';

interface Props {
  open: boolean;
  onClose: () => void;
}

const METHODS: [Payment['method'], string][] = [
  ['bank_transfer', 'Bank transfer'],
  ['cash', 'Cash'],
  ['cheque', 'Cheque'],
  ['mock', 'Simulated'],
];

export function NewPaymentModal({ open, onClose }: Props) {
  const qc = useQueryClient();
  const toast = useToast();
  const [employeeId, setEmployeeId] = useState('');
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<Payment['method']>('bank_transfer');
  const [type, setType] = useState<LedgerTransaction['type']>('Employee Advance');
  const [description, setDescription] = useState('');
  const [reference, setReference] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setEmployeeId('');
    setAmount('');
    setMethod('bank_transfer');
    setType('Employee Advance');
    setDescription('');
    setReference('');
    setError(null);
  }, [open]);

  // Finance has restricted projection on employees — that's fine, we only
  // need id + name.
  const empsQ = useQuery({
    queryKey: ['employees', 'list', {}],
    queryFn: () => employeeApi.list({}),
    enabled: open,
  });

  const create = useMutation({
    mutationFn: () =>
      accountsApi.payments.create({
        employee_id: employeeId,
        amount_paise: Math.round(Number(amount) * 100),
        method,
        reference: reference || undefined,
        ledger_type: type,
        description: description || undefined,
      }),
    onSuccess: () => {
      toast.push('success', 'Payment recorded — ledger updated.');
      qc.invalidateQueries({ queryKey: ['accounts'] });
      qc.invalidateQueries({ queryKey: ['payments'] });
      onClose();
    },
    onError: (e: Error) => setError(e.message),
  });

  if (!open) return null;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!employeeId) return setError('Employee required.');
    const n = Number(amount);
    if (!(n > 0)) return setError('Amount must be positive.');
    create.mutate();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-40 grid place-items-center bg-neutral-900/30 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      data-testid="new-payment-modal"
    >
      <div className="w-full max-w-[520px] bg-white border border-neutral-200 rounded shadow-drawer p-6">
        <div className="flex items-baseline justify-between">
          <h2 className="text-20 font-semibold text-neutral-900">New payment</h2>
          <button type="button" onClick={onClose} className="text-13 text-neutral-500 hover:text-neutral-900">Close</button>
        </div>
        <p className="text-13 text-neutral-500 mt-1">
          Manual entry — used for advances or ad-hoc payouts. Ledger + Payment
          are written atomically.
        </p>
        <form onSubmit={onSubmit} className="mt-4 space-y-3">
          <label className="block">
            <span className="block text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">Employee</span>
            <select
              value={employeeId}
              onChange={(e) => setEmployeeId(e.target.value)}
              className="h-8 px-2 text-13 bg-white border border-neutral-300 rounded w-full"
              data-testid="pay-employee"
            >
              <option value="">Select…</option>
              {(empsQ.data?.items ?? []).map((e) => (
                <option key={e.id} value={e.id}>{e.employee_code} — {e.full_name}</option>
              ))}
            </select>
          </label>
          <div className="grid grid-cols-2 gap-3">
            <Input label="Amount (₹)" type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} required data-testid="pay-amount" />
            <label className="block">
              <span className="block text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">Ledger type</span>
              <select
                value={type}
                onChange={(e) => setType(e.target.value as LedgerTransaction['type'])}
                className="h-8 px-2 text-13 bg-white border border-neutral-300 rounded w-full"
                data-testid="pay-type"
              >
                {LEDGER_TYPES.filter((t) => t !== 'Payroll' && t !== 'Expense Reimbursement').map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="block text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">Method</span>
              <select
                value={method}
                onChange={(e) => setMethod(e.target.value as Payment['method'])}
                className="h-8 px-2 text-13 bg-white border border-neutral-300 rounded w-full"
              >
                {METHODS.map(([v, l]) => (<option key={v} value={v}>{l}</option>))}
              </select>
            </label>
            <Input label="Reference (optional)" value={reference} onChange={(e) => setReference(e.target.value)} />
          </div>
          <Input label="Description (optional)" value={description} onChange={(e) => setDescription(e.target.value)} />
          {error ? <div className="text-12 text-red border-l-2 border-red pl-2">{error}</div> : null}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" type="button" onClick={onClose}>Cancel</Button>
            <Button variant="primary" type="submit" disabled={create.isPending} data-testid="pay-save">
              {create.isPending ? 'Saving…' : 'Record'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
