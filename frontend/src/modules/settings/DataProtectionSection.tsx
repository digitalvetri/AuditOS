/**
 * Settings → Data protection (Admin). The firm's AI switch, how long a
 * former client's records are kept, and the records now due for deletion —
 * each removed only by an explicit purge with the client code typed in.
 * Invoices, payments and credit notes are statutory records and always stay.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SectionShell } from './SectionShell';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { useToast } from '@/components/Toast';
import { fmtDate } from '@/lib/format';
import { AI_DISCLOSURE, dataProtectionApi, type PurgePlan } from '@/modules/dataProtection/api';

const KEY = ['data-protection', 'settings'] as const;
const DUE_KEY = ['data-protection', 'due'] as const;

export function DataProtectionSection() {
  const qc = useQueryClient();
  const toast = useToast();
  const settings = useQuery({ queryKey: KEY, queryFn: dataProtectionApi.settings });
  const due = useQuery({ queryKey: DUE_KEY, queryFn: dataProtectionApi.due });
  const [years, setYears] = useState<string | null>(null);
  const [purging, setPurging] = useState<PurgePlan | null>(null);

  const update = useMutation({
    mutationFn: dataProtectionApi.updateSettings,
    onSuccess: (s) => {
      qc.setQueryData(KEY, s);
      qc.invalidateQueries({ queryKey: DUE_KEY });
      setYears(null);
      toast.push('success', 'Saved.');
    },
    onError: (e: Error) => toast.push('error', e.message),
  });

  const s = settings.data;
  const min = s?.min_retention_years ?? 7;
  const yearsValue = years ?? String(s?.data_retention_years ?? '');
  const yearsNum = Number(yearsValue);
  const yearsOk = Number.isInteger(yearsNum) && yearsNum >= min && yearsNum <= 30;

  return (
    <SectionShell title="Data protection" description="DPDP Act 2023 and ICAI confidentiality — AI processing and record retention.">
      <div className="dash-card p-4 space-y-2" data-testid="dp-ai">
        <label className="flex items-center gap-3 text-14 font-medium text-neutral-900">
          <input
            type="checkbox"
            checked={s?.ai_external_processing ?? false}
            disabled={!s || update.isPending}
            onChange={(e) => update.mutate({ ai_external_processing: e.target.checked })}
            data-testid="dp-ai-toggle"
          />
          AI drafting of notice replies
        </label>
        <p className="text-13 text-neutral-500">{AI_DISCLOSURE}</p>
        {s && !s.ai_external_processing ? (
          <p className="text-13 text-neutral-700">Off: nothing is sent; staff write replies by hand.</p>
        ) : null}
      </div>

      <form
        className="dash-card p-4 flex items-end gap-3 flex-wrap"
        onSubmit={(e) => { e.preventDefault(); if (yearsOk) update.mutate({ data_retention_years: yearsNum }); }}
      >
        <Input
          label="Keep a former client's records for (years)"
          type="number" min={min} max={30} step={1}
          value={yearsValue}
          onChange={(e) => setYears(e.target.value)}
          error={yearsValue && !yearsOk ? `At least ${min} years (SQC 1).` : null}
          data-testid="dp-years"
        />
        <Button variant="primary" type="submit" disabled={!yearsOk || years === null || update.isPending}>Save</Button>
        <p className="text-12 text-neutral-500 basis-full">
          Counted from the client's exit date (set on the client: status Inactive + exit date). Nothing is ever deleted automatically.
        </p>
      </form>

      <div className="space-y-2">
        <h3 className="text-14 font-semibold text-neutral-900">Records due for deletion</h3>
        {due.isLoading ? <p className="text-13 text-neutral-500">Loading…</p> : null}
        {due.error ? <p className="text-13 text-[#b91c1c]">{(due.error as Error).message}</p> : null}
        {due.data && due.data.items.length === 0 ? (
          <p className="text-13 text-neutral-500">No former client has passed the retention period.</p>
        ) : null}
        {due.data && due.data.items.length > 0 ? (
          <div className="bg-white border border-neutral-200 rounded overflow-x-auto" data-testid="dp-due-table">
            <table className="hr-float w-full border-collapse tabular-nums">
              <thead>
                <tr>
                  {['Client', 'Exit date', 'Kept until', 'Would remove', 'Kept (statutory)', ''].map((c) => (
                    <th key={c} className="text-left text-11 uppercase tracking-[0.06em] text-neutral-500 px-3 py-2 border-b border-neutral-300 font-medium">{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {due.data.items.map((p) => (
                  <tr key={p.client_id} className="border-b border-neutral-100 last:border-0 text-13">
                    <td className="px-3 py-2"><div className="font-medium text-neutral-900">{p.company_name}</div><div className="text-12 text-neutral-500">{p.client_code}</div></td>
                    <td className="px-3 py-2">{p.exit_date ? fmtDate(`${p.exit_date}T00:00:00Z`) : '—'}</td>
                    <td className="px-3 py-2">{p.retention_ends ? fmtDate(`${p.retention_ends}T00:00:00Z`) : '—'}</td>
                    <td className="px-3 py-2 text-neutral-700">{removeSummary(p)}</td>
                    <td className="px-3 py-2 text-neutral-700">
                      {p.retained.invoices} invoices · {p.retained.payments} payments{p.retained.credit_notes ? ` · ${p.retained.credit_notes} credit notes` : ''}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <div className="flex gap-2 justify-end">
                        <Button size="sm" variant="secondary" onClick={() => dataProtectionApi.exportClient(p.client_id, p.client_code).catch((e: Error) => toast.push('error', e.message))}>
                          Export
                        </Button>
                        <Button size="sm" variant="danger" onClick={() => setPurging(p)} data-testid={`dp-purge-${p.client_code}`}>Delete records…</Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>

      {purging ? <PurgeDialog plan={purging} onClose={() => setPurging(null)} /> : null}
    </SectionShell>
  );
}

function removeSummary(p: PurgePlan): string {
  const r = p.remove;
  const parts = [
    [r.documents, 'documents'], [r.files, 'files'], [r.audit_files, 'audit files'],
    [r.gst_notices + r.client_notices, 'notices'], [r.contacts, 'contacts'], [r.credentials, 'credentials'],
  ] as const;
  const out = parts.filter(([n]) => n > 0).map(([n, l]) => `${n} ${l}`);
  return out.length ? out.join(' · ') : 'contact details only';
}

function PurgeDialog({ plan, onClose }: { plan: PurgePlan; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [typed, setTyped] = useState('');
  const purge = useMutation({
    mutationFn: () => dataProtectionApi.purge(plan.client_id, typed.trim()),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: DUE_KEY });
      toast.push(r.files_failed.length ? 'error' : 'success', r.files_failed.length
        ? `Records removed; ${r.files_failed.length} file(s) could not be deleted — see the server log.`
        : `Records of ${plan.company_name} removed (${r.files_removed} files).`);
      onClose();
    },
    onError: (e: Error) => toast.push('error', e.message),
  });
  return (
    <div className="fixed inset-0 z-50 bg-black/30 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Delete client records">
      <div className="bg-white rounded-lg shadow-card w-full max-w-[480px] p-5 space-y-3">
        <h3 className="text-16 font-semibold text-neutral-900">Delete records of {plan.company_name}?</h3>
        <p className="text-13 text-neutral-700">
          This permanently removes {removeSummary(plan)} and the client's contact details. It cannot be undone — export first if the client asked for a copy.
        </p>
        <p className="text-13 text-neutral-700">
          Kept as statutory records: {plan.retained.invoices} invoices, {plan.retained.payments} payments{plan.retained.credit_notes ? `, ${plan.retained.credit_notes} credit notes` : ''}.
        </p>
        <Input label={`Type the client code (${plan.client_code}) to confirm`} value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus data-testid="dp-purge-confirm" />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="danger" disabled={typed.trim() !== plan.client_code || purge.isPending} onClick={() => purge.mutate()} data-testid="dp-purge-submit">
            {purge.isPending ? 'Deleting…' : 'Delete records'}
          </Button>
        </div>
      </div>
    </div>
  );
}
