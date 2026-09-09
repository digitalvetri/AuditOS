import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Plus, X, CheckCircle2, Circle } from 'lucide-react';
import { Button } from '@/components/Button';
import { useToast } from '@/components/Toast';
import { tallyApi, type TallyCompany, type CreateTallyCompanyInput } from '@/modules/tools/audit-automation/tally';
import type { ApiError } from '@/services/api';

/**
 * /tally/companies — company list + "New company" modal.
 * Creating a company seeds its own primary groups + first FY on the
 * server; nothing to do on the client after create.
 */
export function TallyCompanies() {
  const toast = useToast();
  const [showNew, setShowNew] = useState(false);

  const q = useQuery({
    queryKey: ['tally.companies'],
    queryFn: () => tallyApi.listCompanies(),
  });

  return (
    <div className="max-w-[1200px] mx-auto" data-testid="tally-companies">
      <div className="mb-4">
        <Link to="/tally" className="inline-flex items-center gap-1 text-13 text-neutral-500 hover:text-neutral-900">
          <ArrowLeft size={14} strokeWidth={1.75} /> Tally
        </Link>
      </div>

      <header className="flex items-start justify-between gap-4 mb-5">
        <div>
          <h1 className="text-20 font-semibold text-neutral-900">Companies</h1>
          <p className="text-13 text-neutral-500 mt-1">
            Each company keeps its own books. Data never crosses between companies.
          </p>
        </div>
        <Button variant="primary" size="sm" onClick={() => setShowNew(true)}>
          <Plus size={14} strokeWidth={1.75} className="mr-1" /> New company
        </Button>
      </header>

      {q.isLoading ? (
        <div className="bg-white border border-neutral-200 rounded p-6 text-13 text-neutral-500">Loading…</div>
      ) : (q.data?.items ?? []).length === 0 ? (
        <div className="bg-white border border-neutral-200 rounded p-6 text-13 text-neutral-500">
          No companies yet. Click <strong>New company</strong> to add the first one.
        </div>
      ) : (
        <CompaniesTable companies={q.data!.items} />
      )}

      {showNew ? (
        <NewCompanyModal
          onClose={() => setShowNew(false)}
          onCreated={(c) => {
            setShowNew(false);
            toast.push('success', `Company "${c.name}" created — 17 primary groups + FY seeded.`);
          }}
        />
      ) : null}
    </div>
  );
}

function CompaniesTable({ companies }: { companies: TallyCompany[] }) {
  return (
    <div className="bg-white border border-neutral-200 rounded overflow-hidden">
      <table className="w-full text-13">
        <thead>
          <tr className="text-left text-11 text-neutral-500 tracking-[0.06em]">
            <th className="px-3 py-2 font-normal">NAME</th>
            <th className="px-3 py-2 font-normal">STATE</th>
            <th className="px-3 py-2 font-normal">GSTIN</th>
            <th className="px-3 py-2 font-normal">BOOKS FROM</th>
            <th className="px-3 py-2 font-normal">STATUS</th>
            <th className="px-3 py-2 font-normal w-16"></th>
          </tr>
        </thead>
        <tbody>
          {companies.map((c) => (
            <tr key={c.id} className="border-t border-neutral-100">
              <td className="px-3 py-2 text-neutral-900 font-medium">{c.name}</td>
              <td className="px-3 py-2 text-neutral-700">{c.state ?? '—'}</td>
              <td className="px-3 py-2 text-neutral-700 font-mono text-12">{c.gstin ?? '—'}</td>
              <td className="px-3 py-2 text-neutral-700">{c.books_begin_from}</td>
              <td className="px-3 py-2">
                {c.active ? (
                  <span className="inline-flex items-center gap-1 text-12 text-green-700">
                    <CheckCircle2 size={12} strokeWidth={2} /> Active
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-12 text-neutral-400">
                    <Circle size={12} strokeWidth={2} /> Inactive
                  </span>
                )}
              </td>
              <td className="px-3 py-2 text-right">
                <Link to={`/tally/companies/${c.id}/masters/ledgers`} className="text-12 text-gold font-medium">
                  Open →
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function NewCompanyModal({ onClose, onCreated }: {
  onClose: () => void;
  onCreated: (c: TallyCompany) => void;
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState<CreateTallyCompanyInput>({
    name: '', books_begin_from: new Date().toISOString().slice(0, 10).replace(/-\d{2}-\d{2}$/, '-04-01'),
    fy_begin_month: 4, gst_registration_type: 'regular',
  });
  const [err, setErr] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: (input: CreateTallyCompanyInput) => tallyApi.createCompany(input),
    onSuccess: async (c) => {
      await qc.invalidateQueries({ queryKey: ['tally.companies'] });
      onCreated(c);
    },
    onError: (e: ApiError) => setErr(e.message),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!form.name.trim()) { setErr('Company name is required.'); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(form.books_begin_from)) { setErr('Books begin date must be YYYY-MM-DD.'); return; }
    create.mutate({
      ...form,
      name: form.name.trim(),
      mailing_name: form.mailing_name?.trim() || undefined,
      address: form.address?.trim() || undefined,
      state: form.state?.trim() || undefined,
      pan: form.pan?.trim() || undefined,
      gstin: form.gstin?.trim() || undefined,
    });
  }

  const set = (k: keyof CreateTallyCompanyInput, v: string | number | undefined) =>
    setForm((f) => ({ ...f, [k]: v }));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <form onSubmit={submit} className="bg-white rounded shadow-lg w-full max-w-[560px] max-h-[90vh] overflow-y-auto">
        <div className="px-5 py-3 border-b border-neutral-200 flex items-center justify-between sticky top-0 bg-white">
          <h2 className="text-14 font-semibold text-neutral-900">New Tally company</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="text-neutral-400 hover:text-neutral-700">
            <X size={16} strokeWidth={1.75} />
          </button>
        </div>
        <div className="px-5 py-4 space-y-3">
          <Field label="Company name" required>
            <input
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
              className="h-9 w-full px-2 text-13 border border-neutral-300 rounded bg-white focus:outline-none focus:border-gold"
              placeholder="e.g. Kovai Textiles Private Limited"
              data-testid="tally-company-name"
            />
          </Field>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Field label="Mailing name">
              <input
                value={form.mailing_name ?? ''}
                onChange={(e) => set('mailing_name', e.target.value)}
                className="h-9 w-full px-2 text-13 border border-neutral-300 rounded bg-white focus:outline-none focus:border-gold"
              />
            </Field>
            <Field label="State">
              <input
                value={form.state ?? ''}
                onChange={(e) => set('state', e.target.value)}
                className="h-9 w-full px-2 text-13 border border-neutral-300 rounded bg-white focus:outline-none focus:border-gold"
                placeholder="e.g. Tamil Nadu"
              />
            </Field>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Field label="PAN">
              <input
                value={form.pan ?? ''}
                onChange={(e) => set('pan', e.target.value)}
                className="h-9 w-full px-2 text-13 border border-neutral-300 rounded bg-white focus:outline-none focus:border-gold font-mono"
                placeholder="ABCDE1234F"
              />
            </Field>
            <Field label="GSTIN">
              <input
                value={form.gstin ?? ''}
                onChange={(e) => set('gstin', e.target.value)}
                className="h-9 w-full px-2 text-13 border border-neutral-300 rounded bg-white focus:outline-none focus:border-gold font-mono"
                placeholder="22ABCDE1234F1Z5"
              />
            </Field>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-[1fr_180px] gap-3">
            <Field label="Books begin from" required>
              <input
                type="date"
                value={form.books_begin_from}
                onChange={(e) => set('books_begin_from', e.target.value)}
                className="h-9 w-full px-2 text-13 border border-neutral-300 rounded bg-white focus:outline-none focus:border-gold"
              />
              <span className="text-11 text-neutral-500 mt-1 block">
                Financial year is derived from this date and the FY begin month.
              </span>
            </Field>
            <Field label="FY begins in">
              <select
                value={form.fy_begin_month ?? 4}
                onChange={(e) => set('fy_begin_month', Number(e.target.value))}
                className="h-9 w-full px-2 text-13 border border-neutral-300 rounded bg-white focus:outline-none focus:border-gold"
              >
                {[1,2,3,4,5,6,7,8,9,10,11,12].map((m) => (
                  <option key={m} value={m}>{new Date(2000, m - 1, 1).toLocaleString('en-IN', { month: 'long' })}</option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="GST registration">
            <select
              value={form.gst_registration_type ?? 'regular'}
              onChange={(e) => set('gst_registration_type', e.target.value as CreateTallyCompanyInput['gst_registration_type'])}
              className="h-9 w-full px-2 text-13 border border-neutral-300 rounded bg-white focus:outline-none focus:border-gold"
            >
              <option value="regular">Regular</option>
              <option value="composition">Composition</option>
              <option value="unregistered">Unregistered</option>
              <option value="sez">SEZ</option>
              <option value="overseas">Overseas</option>
            </select>
          </Field>
          {err ? <div className="text-13 text-danger">{err}</div> : null}
          <p className="text-11 text-neutral-500 pt-1">
            Creating the company seeds 17 primary groups (Capital, Sundry Debtors, Bank Accounts, etc.) and the
            first financial year. Nothing else changes on your account.
          </p>
        </div>
        <div className="px-5 py-3 border-t border-neutral-200 flex justify-end gap-2 sticky bottom-0 bg-white">
          <Button type="button" size="sm" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" size="sm" variant="primary" disabled={create.isPending}>
            {create.isPending ? 'Creating…' : 'Create company'}
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
