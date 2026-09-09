import { useState, type FormEvent } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, X, Search } from 'lucide-react';
import { Button } from '@/components/Button';
import { useToast } from '@/components/Toast';
import { tallyApi, type TallyGroup, type TallyLedger, type CreateTallyLedgerInput } from '@/modules/tools/audit-automation/tally';
import type { ApiError } from '@/services/api';

/**
 * /audit-automation/tally/companies/:companyId/masters/ledgers
 * — ledger list with search + New ledger modal.
 */
export function TallyLedgers() {
  const { companyId = '' } = useParams();
  const [q, setQ] = useState('');
  const [showNew, setShowNew] = useState(false);

  const ledgersQ = useQuery({
    queryKey: ['tally.ledgers', companyId, q],
    enabled: Boolean(companyId),
    queryFn: () => tallyApi.listLedgers(companyId, { q: q.trim() || undefined }),
  });
  const groupsQ = useQuery({
    queryKey: ['tally.groups', companyId],
    enabled: Boolean(companyId),
    queryFn: () => tallyApi.listGroups(companyId),
  });

  const groupsById = new Map((groupsQ.data?.items ?? []).map((g) => [g.id, g]));

  return (
    <div data-testid="tally-ledgers">
      <header className="flex items-start justify-between gap-4 mb-4">
        <div>
          <h2 className="text-16 font-semibold text-neutral-900">Ledgers</h2>
          <p className="text-12 text-neutral-500 mt-0.5">
            One row per account. Opening balances land here; posted vouchers reference them.
          </p>
        </div>
        <div className="flex gap-2 items-center">
          <label className="relative block">
            <span className="absolute inset-y-0 left-2 flex items-center text-neutral-400"><Search size={14} strokeWidth={1.75} /></span>
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search ledgers…"
              className="h-8 w-[220px] pl-7 pr-3 text-13 bg-white border border-neutral-300 rounded focus:outline-none focus:border-gold"
            />
          </label>
          <Button variant="primary" size="sm" onClick={() => setShowNew(true)}>
            <Plus size={14} strokeWidth={1.75} className="mr-1" /> New ledger
          </Button>
        </div>
      </header>

      {ledgersQ.isLoading ? (
        <div className="bg-white border border-neutral-200 rounded p-6 text-13 text-neutral-500">Loading…</div>
      ) : (ledgersQ.data?.items ?? []).length === 0 ? (
        <div className="bg-white border border-neutral-200 rounded p-6 text-13 text-neutral-500">
          {q.trim() ? `No ledgers match "${q.trim()}".` : 'No ledgers yet. Click New ledger to add the first one.'}
        </div>
      ) : (
        <LedgersTable ledgers={ledgersQ.data!.items} groupsById={groupsById} />
      )}

      {showNew && groupsQ.data ? (
        <NewLedgerModal
          companyId={companyId}
          groups={groupsQ.data.items}
          onClose={() => setShowNew(false)}
        />
      ) : null}
    </div>
  );
}

function LedgersTable({ ledgers, groupsById }: { ledgers: TallyLedger[]; groupsById: Map<string, TallyGroup> }) {
  return (
    <div className="bg-white border border-neutral-200 rounded overflow-x-auto">
      <table className="w-full text-13 min-w-[820px]">
        <thead>
          <tr className="text-left text-11 text-neutral-500 tracking-[0.06em]">
            <th className="px-3 py-2 font-normal">NAME</th>
            <th className="px-3 py-2 font-normal">GROUP</th>
            <th className="px-3 py-2 font-normal text-right">OPENING</th>
            <th className="px-3 py-2 font-normal">DR/CR</th>
            <th className="px-3 py-2 font-normal">GSTIN</th>
            <th className="px-3 py-2 font-normal">STATE</th>
          </tr>
        </thead>
        <tbody>
          {ledgers.map((l) => (
            <tr key={l.id} className="border-t border-neutral-100">
              <td className="px-3 py-2 text-neutral-900 font-medium">{l.name}</td>
              <td className="px-3 py-2 text-neutral-700">{groupsById.get(l.group_id)?.name ?? '—'}</td>
              <td className="px-3 py-2 text-right tabular-nums">
                {l.opening_balance_paise > 0 ? paiseText(l.opening_balance_paise) : <span className="text-neutral-400">—</span>}
              </td>
              <td className="px-3 py-2 uppercase text-11 text-neutral-500">
                {l.opening_balance_paise > 0 ? l.opening_balance_type : ''}
              </td>
              <td className="px-3 py-2 font-mono text-12 text-neutral-700">{l.gstin ?? '—'}</td>
              <td className="px-3 py-2 text-neutral-700">{l.state ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function paiseText(p: number): string {
  return '₹' + (p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function NewLedgerModal({ companyId, groups, onClose }: {
  companyId: string;
  groups: TallyGroup[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState<CreateTallyLedgerInput>({
    name: '', group_id: '', opening_balance_paise: 0, opening_balance_type: 'dr',
  });
  const [openingRupees, setOpeningRupees] = useState('0');
  const [err, setErr] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => tallyApi.createLedger(companyId, {
      ...form,
      opening_balance_paise: Math.round(Number(openingRupees.replace(/[₹,\s]/g, '')) * 100),
    }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['tally.ledgers', companyId] });
      toast.push('success', `Ledger "${form.name}" created.`);
      onClose();
    },
    onError: (e: ApiError) => setErr(e.message),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!form.name.trim()) { setErr('Ledger name is required.'); return; }
    if (!form.group_id) { setErr('Under group is required.'); return; }
    const opening = Number(openingRupees.replace(/[₹,\s]/g, ''));
    if (!Number.isFinite(opening) || opening < 0) { setErr('Opening balance must be a non-negative amount.'); return; }
    create.mutate();
  }

  const set = <K extends keyof CreateTallyLedgerInput>(k: K, v: CreateTallyLedgerInput[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <form onSubmit={submit} className="bg-white rounded shadow-lg w-full max-w-[560px] max-h-[90vh] overflow-y-auto">
        <div className="px-5 py-3 border-b border-neutral-200 flex items-center justify-between sticky top-0 bg-white">
          <h2 className="text-14 font-semibold text-neutral-900">New ledger</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="text-neutral-400 hover:text-neutral-700">
            <X size={16} strokeWidth={1.75} />
          </button>
        </div>
        <div className="px-5 py-4 space-y-3">
          <Field label="Ledger name" required>
            <input
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
              className="h-9 w-full px-2 text-13 border border-neutral-300 rounded bg-white focus:outline-none focus:border-gold"
              placeholder="e.g. Main Cash"
              autoFocus
              data-testid="tally-ledger-name"
            />
          </Field>
          <Field label="Under group" required>
            <select
              value={form.group_id}
              onChange={(e) => set('group_id', e.target.value)}
              className="h-9 w-full px-2 text-13 border border-neutral-300 rounded bg-white focus:outline-none focus:border-gold"
            >
              <option value="">Select group…</option>
              {groups
                .slice()
                .sort((a, b) => (a.is_primary === b.is_primary ? a.name.localeCompare(b.name) : a.is_primary ? -1 : 1))
                .map((g) => (
                  <option key={g.id} value={g.id}>{g.is_primary ? '★ ' : ''}{g.name}</option>
                ))}
            </select>
          </Field>
          <div className="grid grid-cols-[1fr_120px] gap-3">
            <Field label="Opening balance (₹)">
              <input
                value={openingRupees}
                onChange={(e) => setOpeningRupees(e.target.value)}
                className="h-9 w-full px-2 text-13 border border-neutral-300 rounded bg-white focus:outline-none focus:border-gold font-mono text-right"
                placeholder="0.00"
              />
            </Field>
            <Field label="Dr / Cr">
              <select
                value={form.opening_balance_type ?? 'dr'}
                onChange={(e) => set('opening_balance_type', e.target.value as 'dr' | 'cr')}
                className="h-9 w-full px-2 text-13 border border-neutral-300 rounded bg-white focus:outline-none focus:border-gold uppercase"
              >
                <option value="dr">Dr</option>
                <option value="cr">Cr</option>
              </select>
            </Field>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Field label="Contact person">
              <input
                value={form.contact ?? ''}
                onChange={(e) => set('contact', e.target.value)}
                className="h-9 w-full px-2 text-13 border border-neutral-300 rounded bg-white focus:outline-none focus:border-gold"
              />
            </Field>
            <Field label="State">
              <input
                value={form.state ?? ''}
                onChange={(e) => set('state', e.target.value)}
                className="h-9 w-full px-2 text-13 border border-neutral-300 rounded bg-white focus:outline-none focus:border-gold"
              />
            </Field>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Field label="GSTIN">
              <input
                value={form.gstin ?? ''}
                onChange={(e) => set('gstin', e.target.value)}
                className="h-9 w-full px-2 text-13 border border-neutral-300 rounded bg-white focus:outline-none focus:border-gold font-mono"
              />
            </Field>
            <Field label="PAN">
              <input
                value={form.pan ?? ''}
                onChange={(e) => set('pan', e.target.value)}
                className="h-9 w-full px-2 text-13 border border-neutral-300 rounded bg-white focus:outline-none focus:border-gold font-mono"
              />
            </Field>
          </div>
          <Field label="Address">
            <textarea
              value={form.address ?? ''}
              onChange={(e) => set('address', e.target.value)}
              rows={2}
              className="w-full px-2 py-1 text-13 border border-neutral-300 rounded bg-white focus:outline-none focus:border-gold"
            />
          </Field>
          {err ? <div className="text-13 text-danger">{err}</div> : null}
        </div>
        <div className="px-5 py-3 border-t border-neutral-200 flex justify-end gap-2 sticky bottom-0 bg-white">
          <Button type="button" size="sm" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" size="sm" variant="primary" disabled={create.isPending}>
            {create.isPending ? 'Creating…' : 'Create ledger'}
          </Button>
        </div>
      </form>
    </div>
  );
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-13 font-medium text-neutral-900 mb-1">
        {label} {required ? <span className="text-danger">*</span> : null}
      </span>
      {children}
    </label>
  );
}
