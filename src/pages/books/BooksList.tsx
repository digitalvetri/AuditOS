import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Search } from 'lucide-react';
import { Button } from '@/components/Button';
import { useToast } from '@/components/Toast';
import { Modal } from '@/modules/workstation/components';
import { booksApi } from '@/modules/books/api';
import { Field, inputCls, Notice, selectCls } from '@/modules/books/components';
import type { BooksListResponse } from '@/modules/books/types';

/**
 * /books — every set of books this person may open. One row per client;
 * a firm-wide grant shows all of them, a staff member only those they are
 * assigned to.
 */
export function BooksListPage() {
  const toast = useToast();
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const list = useQuery({ queryKey: ['books', 'list'], queryFn: booksApi.list });

  return (
    <div className="max-w-[1100px] mx-auto" data-testid="books-list-page">
      <header className="flex flex-col md:flex-row md:items-start gap-3 mb-5">
        <div className="min-w-0 flex-1">
          <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">Books</div>
          <h1 className="text-20 font-semibold text-neutral-900 mt-1">Client books</h1>
          <p className="text-13 text-neutral-500 mt-1">One set of books per client — ledgers, invoices, bills and reports, kept separately.</p>
        </div>
        <div className="flex items-center gap-2">
          <label className="relative block">
            <span className="absolute inset-y-0 left-2 flex items-center text-neutral-400"><Search size={14} strokeWidth={1.75} /></span>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search clients…" className={`${inputCls} pl-7 w-[220px]`} data-testid="books-search" />
          </label>
          {list.data?.can_manage ? (
            <Button variant="primary" size="sm" onClick={() => setCreating(true)} data-testid="books-new">
              <Plus size={14} strokeWidth={2} className="mr-1" />New books
            </Button>
          ) : null}
        </div>
      </header>

      {list.isLoading ? <div className="h-40 bg-neutral-100 rounded" /> : list.isError ? (
        <div className="bg-white border border-neutral-200 rounded p-6">
          <div className="text-13 font-medium text-neutral-900">{(list.error as { status?: number }).status === 403 ? 'You do not have access to Books' : 'Could not load Books'}</div>
          <p className="text-13 text-neutral-500 mt-1">{(list.error as Error).message}</p>
        </div>
      ) : (
        <Grid data={list.data!} q={q} />
      )}

      {creating ? (
        <NewBooksModal onClose={() => setCreating(false)} states={list.data?.states ?? {}} onCreated={() => { qc.invalidateQueries({ queryKey: ['books', 'list'] }); toast.push('success', 'Books created with a default chart of accounts.'); setCreating(false); }} />
      ) : null}
    </div>
  );
}

function Grid({ data, q }: { data: BooksListResponse; q: string }) {
  const needle = q.trim().toLowerCase();
  const items = data.items.filter((o) => !needle || [o.name, o.legal_name, o.gstin, o.city].some((v) => v?.toLowerCase().includes(needle)));
  if (!data.items.length) {
    return (
      <div className="bg-white border border-neutral-200 rounded p-6" data-testid="books-empty">
        <div className="text-13 font-medium text-neutral-900">No books yet</div>
        <p className="text-13 text-neutral-500 mt-1">{data.can_manage ? 'Create a set of books for a client to start recording their transactions.' : 'You have not been assigned to any client books yet.'}</p>
      </div>
    );
  }
  if (!items.length) return <div className="bg-white border border-neutral-200 rounded p-6 text-13 text-neutral-500">No client matches “{q.trim()}”.</div>;
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
      {items.map((o) => (
        <Link key={o.id} to={`/books/${o.id}`} className="bg-white border border-neutral-200 rounded p-4 hover:border-neutral-400 transition-colors" data-testid={`books-card-${o.id}`}>
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="text-14 font-semibold text-neutral-900 truncate">{o.name}</div>
              <div className="text-12 text-neutral-500 mt-0.5 truncate">{o.gstin ?? 'No GSTIN'}{o.state_name ? ` · ${o.state_name}` : ''}</div>
            </div>
            {!o.is_active ? <span className="text-11 text-neutral-500 shrink-0">Inactive</span> : null}
          </div>
          <div className="flex items-center gap-3 mt-3 text-12 text-neutral-500">
            <span>{o.base_currency}</span>
            <span>·</span>
            <span>{o.my_role === 'admin' ? 'Admin' : o.my_role === 'staff' ? 'Staff' : 'Viewer'}</span>
            {o.member_count ? <><span>·</span><span>{o.member_count} member{o.member_count === 1 ? '' : 's'}</span></> : null}
          </div>
          <div className="mt-3 text-12 font-medium text-gold">Open books →</div>
        </Link>
      ))}
    </div>
  );
}

function NewBooksModal({ onClose, onCreated, states }: { onClose: () => void; onCreated: () => void; states: Record<string, string> }) {
  const toast = useToast();
  const [form, setForm] = useState({ name: '', legal_name: '', gstin: '', pan: '', state_code: '', city: '', base_currency: 'INR', fiscal_year_start_month: 4 });
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => booksApi.create({ ...form, gstin: form.gstin || null, pan: form.pan || null, legal_name: form.legal_name || null, state_code: form.state_code || (form.gstin ? form.gstin.slice(0, 2) : null), city: form.city || null }),
    onSuccess: onCreated,
    onError: (e: Error) => { setError(e.message); toast.push('error', e.message); },
  });
  const submit = (e: FormEvent) => { e.preventDefault(); setError(null); if (!form.name.trim()) return setError('Name is required.'); create.mutate(); };
  const set = (k: keyof typeof form, v: string | number) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <Modal open title="New set of books" onClose={onClose} width="w-[560px]"
      footer={<><Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button><Button variant="primary" size="sm" onClick={submit} disabled={create.isPending} data-testid="books-create-submit">{create.isPending ? 'Creating…' : 'Create books'}</Button></>}>
      <form onSubmit={submit} className="space-y-3">
        <Field label="Client / business name"><input value={form.name} onChange={(e) => set('name', e.target.value)} className={inputCls} required data-testid="books-name" /></Field>
        <Field label="Legal name (optional)"><input value={form.legal_name} onChange={(e) => set('legal_name', e.target.value)} className={inputCls} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="GSTIN" hint="Sets the state for place-of-supply"><input value={form.gstin} onChange={(e) => set('gstin', e.target.value.toUpperCase())} className={inputCls} maxLength={15} data-testid="books-gstin" /></Field>
          <Field label="PAN"><input value={form.pan} onChange={(e) => set('pan', e.target.value.toUpperCase())} className={inputCls} maxLength={10} /></Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="State">
            <select value={form.state_code} onChange={(e) => set('state_code', e.target.value)} className={selectCls}>
              <option value="">From GSTIN</option>
              {Object.entries(states).map(([code, name]) => <option key={code} value={code}>{code} · {name}</option>)}
            </select>
          </Field>
          <Field label="City"><input value={form.city} onChange={(e) => set('city', e.target.value)} className={inputCls} /></Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Base currency">
            <select value={form.base_currency} onChange={(e) => set('base_currency', e.target.value)} className={selectCls}>
              {['INR', 'USD', 'EUR', 'GBP', 'AED', 'SGD'].map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </Field>
          <Field label="Financial year starts">
            <select value={form.fiscal_year_start_month} onChange={(e) => set('fiscal_year_start_month', Number(e.target.value))} className={selectCls}>
              {['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'].map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
            </select>
          </Field>
        </div>
        {error ? <Notice tone="error">{error}</Notice> : <Notice>A standard Indian chart of accounts, GST and TDS rates are created automatically. You can edit them afterwards.</Notice>}
      </form>
    </Modal>
  );
}
