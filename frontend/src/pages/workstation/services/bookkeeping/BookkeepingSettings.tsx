import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, Lock } from 'lucide-react';
import { Button } from '@/components/Button';
import { useToast } from '@/components/Toast';
import { bookkeepingApi, bookkeepingAccountingApi } from '@/modules/tools/audit-automation/bookkeeping';
import { Panel, Loading, ErrorNote, ReportHeader, DataTable } from '@/modules/tools/bookkeeping/ui';
import type { ApiError } from '@/services/api';

/**
 * /settings — per-company configuration and voucher numbering.
 *
 * Everything here is a stored override on a documented default, so a
 * business rule is a setting rather than a code change.
 */
const LABELS: Record<string, string> = {
  accounting: 'Accounting', inventory: 'Inventory', gst: 'GST', voucher: 'Vouchers',
  invoice: 'Invoice printing', payroll: 'Payroll statutory rates', audit: 'Audit', security: 'Security',
};

export function BookkeepingSettings() {
  const { companyId = '' } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState<Record<string, Record<string, unknown>>>({});

  const q = useQuery({ queryKey: ['tally.settings', companyId], queryFn: () => bookkeepingAccountingApi.getSettings(companyId) });
  const typesQ = useQuery({ queryKey: ['tally.voucherTypes', companyId], queryFn: () => bookkeepingAccountingApi.listVoucherTypes(companyId) });

  const save = useMutation({
    mutationFn: (group: string) => bookkeepingAccountingApi.updateSettings(companyId, group, draft[group] ?? {}),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ['tally.settings', companyId] });
      setDraft((d) => ({ ...d, [r.group]: {} }));
      toast.push('success', `${LABELS[r.group] ?? r.group} settings saved.`);
    },
    onError: (e: ApiError) => toast.push('error', e.message),
  });

  if (q.isLoading) return <Loading />;
  if (q.isError) return <ErrorNote message={(q.error as Error).message} />;
  const settings = q.data!;

  const valueOf = (group: string, key: string) => (draft[group] && key in draft[group] ? draft[group][key] : settings[group][key]);
  const setValue = (group: string, key: string, value: unknown) =>
    setDraft((d) => ({ ...d, [group]: { ...(d[group] ?? {}), [key]: value } }));

  return (
    <div data-testid="tally-settings">
      <ReportHeader title="Settings" subtitle="Business rules are configuration, not code. Changes apply to this company only." />

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        {Object.entries(settings).map(([group, values]) => (
          <Panel
            key={group}
            title={LABELS[group] ?? group}
            actions={
              <Button size="sm" variant="secondary" disabled={!draft[group] || Object.keys(draft[group]).length === 0 || save.isPending} onClick={() => save.mutate(group)}>
                Save
              </Button>
            }
          >
            <ul className="divide-y divide-neutral-100">
              {Object.entries(values).map(([key, def]) => (
                <li key={key} className="px-3 py-2 flex items-center justify-between gap-3">
                  <span className="text-13 text-neutral-700">{key.replace(/_/g, ' ')}</span>
                  {typeof def === 'boolean' ? (
                    <input type="checkbox" checked={Boolean(valueOf(group, key))} onChange={(e) => setValue(group, key, e.target.checked)} className="h-4 w-4 accent-neutral-900" />
                  ) : typeof def === 'number' ? (
                    <input
                      type="number" value={String(valueOf(group, key) ?? 0)}
                      onChange={(e) => setValue(group, key, Number(e.target.value))}
                      className="h-8 w-[140px] px-2 text-13 text-right border border-neutral-300 rounded font-mono focus:outline-none focus:border-gold"
                    />
                  ) : (
                    <input
                      value={String(valueOf(group, key) ?? '')}
                      onChange={(e) => setValue(group, key, e.target.value)}
                      className="h-8 w-[220px] px-2 text-13 border border-neutral-300 rounded focus:outline-none focus:border-gold"
                    />
                  )}
                </li>
              ))}
            </ul>
          </Panel>
        ))}
      </div>

      <Panel title="Voucher numbering" className="mt-4">
        <DataTable
          minWidth="620px"
          rows={typesQ.data?.items ?? []}
          rowKey={(t) => t.id}
          columns={[
            { key: 'name', label: 'Voucher type', value: (t) => t.name },
            { key: 'method', label: 'Numbering', value: (t) => t.numbering_method },
            { key: 'prefix', label: 'Prefix', value: (t) => t.prefix ?? '' },
            { key: 'current', label: 'Last number', align: 'right', value: (t) => t.current_number },
            { key: 'effects', label: 'Effect', value: (t) => [t.affects_accounts ? 'accounts' : '', t.affects_stock ? 'stock' : '', t.is_order ? 'order only' : ''].filter(Boolean).join(' + ') },
          ]}
          empty="No voucher types."
        />
      </Panel>

      <FinancialYearsPanel companyId={companyId} />

      <BankCategorizeRulesPanel companyId={companyId} />
    </div>
  );
}

/**
 * Lists the company's financial years with a "New financial year" button
 * and a per-row close toggle. Pre-fills the create form with the day after
 * the latest existing FY's end date and a 12-month span, so clicking the
 * button twice in a row rolls forward FYs correctly without typing.
 */
function FinancialYearsPanel({ companyId }: { companyId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({
    queryKey: ['tally.financialYears', companyId],
    queryFn: () => bookkeepingApi.listFinancialYears(companyId),
  });
  const items = q.data?.items ?? [];
  const [adding, setAdding] = useState(false);
  const nextDefault = useMemo(() => suggestNextFy(items), [items]);
  const [draft, setDraft] = useState(nextDefault);
  const [err, setErr] = useState<string | null>(null);

  const openForm = () => { setDraft(suggestNextFy(items)); setErr(null); setAdding(true); };

  const createM = useMutation({
    mutationFn: () => bookkeepingApi.createFinancialYear(companyId, draft),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['tally.financialYears', companyId] });
      toast.push('success', `Financial year ${draft.label} created.`);
      setAdding(false); setErr(null);
    },
    onError: (e: ApiError) => setErr(e.message),
  });
  const closeM = useMutation({
    mutationFn: (fyId: string) => bookkeepingApi.closeFinancialYear(companyId, fyId),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['tally.financialYears', companyId] });
      toast.push('success', 'Financial year closed.');
    },
    onError: (e: ApiError) => toast.push('error', e.message),
  });

  return (
    <Panel
      title="Financial years"
      className="mt-4"
      actions={
        <Button size="sm" variant="secondary" onClick={openForm} disabled={adding}>
          <Plus size={13} className="mr-1" /> New financial year
        </Button>
      }
    >
      {q.isLoading ? <div className="p-3 text-13 text-neutral-500">Loading…</div> : (
        <>
          {adding && (
            <div className="px-3 py-3 border-b border-neutral-100 bg-neutral-50">
              <div className="grid grid-cols-1 md:grid-cols-4 gap-2 items-end">
                <label className="text-11 text-neutral-500">
                  Label
                  <input value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })}
                    className="mt-1 h-8 w-full px-2 text-12 border border-neutral-300 rounded focus:outline-none focus:border-gold" placeholder="2026-27" />
                </label>
                <label className="text-11 text-neutral-500">
                  Start date
                  <input type="date" value={draft.start_date} onChange={(e) => setDraft({ ...draft, start_date: e.target.value })}
                    className="mt-1 h-8 w-full px-2 text-12 border border-neutral-300 rounded focus:outline-none focus:border-gold" />
                </label>
                <label className="text-11 text-neutral-500">
                  End date
                  <input type="date" value={draft.end_date} onChange={(e) => setDraft({ ...draft, end_date: e.target.value })}
                    className="mt-1 h-8 w-full px-2 text-12 border border-neutral-300 rounded focus:outline-none focus:border-gold" />
                </label>
                <div className="flex gap-2">
                  <Button size="sm" variant="primary" onClick={() => { setErr(null); createM.mutate(); }} disabled={!draft.label || !draft.start_date || !draft.end_date || createM.isPending}>
                    {createM.isPending ? 'Creating…' : 'Create'}
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => setAdding(false)}>Cancel</Button>
                </div>
              </div>
              {err ? <div className="text-12 text-danger mt-2">{err}</div> : null}
            </div>
          )}
          <DataTable
            minWidth="560px"
            rows={items}
            rowKey={(r) => r.id}
            columns={[
              { key: 'label', label: 'Label', value: (r) => r.label },
              { key: 'from', label: 'Starts', value: (r) => r.start_date },
              { key: 'to', label: 'Ends', value: (r) => r.end_date },
              { key: 'status', label: 'Status', value: (r) => (r.closed ? 'Closed' : 'Open'),
                render: (r) => r.closed
                  ? <span className="text-11 text-neutral-500 inline-flex items-center gap-1"><Lock size={11} /> Closed</span>
                  : <span className="text-11 text-emerald-700">Open</span> },
              { key: 'action', label: '', align: 'right', value: () => '',
                render: (r) => r.closed
                  ? <span className="text-11 text-neutral-400">—</span>
                  : <button type="button" onClick={() => closeM.mutate(r.id)} className="text-11 text-neutral-500 hover:text-neutral-900">Close</button> },
            ]}
            empty="No financial years yet."
          />
        </>
      )}
    </Panel>
  );
}

function suggestNextFy(existing: { label: string; start_date: string; end_date: string }[]): { label: string; start_date: string; end_date: string } {
  if (existing.length === 0) return { label: '', start_date: '', end_date: '' };
  // Roll forward from the latest end_date by one day; span 12 months - 1 day.
  const latest = [...existing].sort((a, b) => b.end_date.localeCompare(a.end_date))[0];
  const [y, m, d] = latest.end_date.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 1, d + 1));
  const end = new Date(Date.UTC(start.getUTCFullYear() + 1, start.getUTCMonth(), start.getUTCDate() - 1));
  const iso = (dt: Date) => dt.toISOString().slice(0, 10);
  const label = `${start.getUTCFullYear()}-${String(end.getUTCFullYear()).slice(-2)}`;
  return { label, start_date: iso(start), end_date: iso(end) };
}

/**
 * CRUD for BookkeepingBankCategorizeRule rows.
 *
 * Each row's matchPattern is a case-insensitive JavaScript regex applied to
 * bank statement line descriptions. First match wins — order by priority
 * (asc); seed rows ship from BookkeepingBankCategorizeService.DEFAULT_RULES
 * and are returned as source='seed' once persisted. The UI treats seed and
 * user rows the same except for the visual badge; both can be disabled or
 * deleted, and the Suspense fallback in the service means disabling every
 * rule only shifts lines into the review bucket, never breaks the feature.
 */
function BankCategorizeRulesPanel({ companyId }: { companyId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const rulesQ = useQuery({
    queryKey: ['tally.categorizeRules', companyId],
    queryFn: () => bookkeepingAccountingApi.listCategorizeRules(companyId),
  });
  const ledgersQ = useQuery({
    queryKey: ['tally.ledgers.all', companyId],
    queryFn: () => bookkeepingApi.listLedgers(companyId),
  });
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<{ match_pattern: string; counter_ledger_id: string; direction: 'auto' | 'receipt' | 'payment'; priority: number; label: string }>(
    { match_pattern: '', counter_ledger_id: '', direction: 'auto', priority: 100, label: '' },
  );
  const [err, setErr] = useState<string | null>(null);

  const createM = useMutation({
    mutationFn: () => bookkeepingAccountingApi.createCategorizeRule(companyId, {
      match_pattern: draft.match_pattern, counter_ledger_id: draft.counter_ledger_id, direction: draft.direction, priority: draft.priority, label: draft.label || null,
    }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['tally.categorizeRules', companyId] });
      toast.push('success', 'Rule added.');
      setAdding(false); setErr(null);
      setDraft({ match_pattern: '', counter_ledger_id: '', direction: 'auto', priority: 100, label: '' });
    },
    onError: (e: ApiError) => setErr(e.message),
  });
  const toggleM = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => bookkeepingAccountingApi.updateCategorizeRule(companyId, id, { enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tally.categorizeRules', companyId] }),
    onError: (e: ApiError) => toast.push('error', e.message),
  });
  const deleteM = useMutation({
    mutationFn: (id: string) => bookkeepingAccountingApi.deleteCategorizeRule(companyId, id),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['tally.categorizeRules', companyId] });
      toast.push('success', 'Rule deleted.');
    },
    onError: (e: ApiError) => toast.push('error', e.message),
  });

  const rules = rulesQ.data?.items ?? [];
  const ledgers = ledgersQ.data?.items ?? [];

  return (
    <Panel
      title="Bank auto-categorize rules"
      className="mt-4"
      actions={
        <Button size="sm" variant="secondary" onClick={() => { setAdding(true); setErr(null); }} disabled={adding || ledgers.length === 0}>
          <Plus size={13} className="mr-1" /> Add rule
        </Button>
      }
    >
      {rulesQ.isLoading ? <div className="p-3 text-13 text-neutral-500">Loading…</div> : (
        <>
          <div className="px-3 py-2 text-12 text-neutral-500 border-b border-neutral-100">
            Rules are evaluated in priority order against each bank statement line's description.
            First match wins. If no rule matches, the auto-categorizer falls back to a party name
            lookup, then to a <strong>Suspense</strong> ledger for later review.
            Patterns are case-insensitive JavaScript regexes — for example
            <code className="mx-1 text-11">bank\s*charg</code> matches both "bank charge" and "bankcharges".
          </div>
          {adding && (
            <div className="px-3 py-3 border-b border-neutral-100 bg-neutral-50">
              <div className="grid grid-cols-1 md:grid-cols-6 gap-2 items-end">
                <label className="text-11 text-neutral-500 md:col-span-2">
                  Label
                  <input value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })}
                    className="mt-1 h-8 w-full px-2 text-12 border border-neutral-300 rounded focus:outline-none focus:border-gold" placeholder="e.g. Office rent" />
                </label>
                <label className="text-11 text-neutral-500 md:col-span-2">
                  Match pattern (regex)
                  <input value={draft.match_pattern} onChange={(e) => setDraft({ ...draft, match_pattern: e.target.value })}
                    className="mt-1 h-8 w-full px-2 text-12 font-mono border border-neutral-300 rounded focus:outline-none focus:border-gold" placeholder="rent" />
                </label>
                <label className="text-11 text-neutral-500">
                  Direction
                  <select value={draft.direction} onChange={(e) => setDraft({ ...draft, direction: e.target.value as 'auto' | 'receipt' | 'payment' })}
                    className="mt-1 h-8 w-full px-1 text-12 border border-neutral-300 rounded bg-white">
                    <option value="auto">auto (by line)</option>
                    <option value="receipt">receipt (credit)</option>
                    <option value="payment">payment (debit)</option>
                  </select>
                </label>
                <label className="text-11 text-neutral-500">
                  Priority
                  <input type="number" value={draft.priority} onChange={(e) => setDraft({ ...draft, priority: Number(e.target.value) })}
                    className="mt-1 h-8 w-full px-2 text-12 text-right border border-neutral-300 rounded font-mono focus:outline-none focus:border-gold" />
                </label>
                <label className="text-11 text-neutral-500 md:col-span-3">
                  Counter-ledger
                  <select value={draft.counter_ledger_id} onChange={(e) => setDraft({ ...draft, counter_ledger_id: e.target.value })}
                    className="mt-1 h-8 w-full px-1 text-12 border border-neutral-300 rounded bg-white">
                    <option value="">— pick a ledger —</option>
                    {ledgers.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                  </select>
                </label>
                <div className="md:col-span-3 flex gap-2 justify-end">
                  <Button size="sm" variant="secondary" onClick={() => setAdding(false)}>Cancel</Button>
                  <Button size="sm" variant="primary" onClick={() => { setErr(null); createM.mutate(); }} disabled={!draft.match_pattern || !draft.counter_ledger_id || createM.isPending}>
                    {createM.isPending ? 'Adding…' : 'Add rule'}
                  </Button>
                </div>
              </div>
              {err ? <div className="text-12 text-danger mt-2">{err}</div> : null}
            </div>
          )}
          <DataTable
            minWidth="760px"
            rows={rules}
            rowKey={(r) => r.id}
            columns={[
              { key: 'enabled', label: '', value: (r) => (r.enabled ? '1' : '0'),
                render: (r) => (
                  <input type="checkbox" checked={r.enabled} onChange={(e) => toggleM.mutate({ id: r.id, enabled: e.target.checked })}
                    aria-label={r.enabled ? 'Disable rule' : 'Enable rule'} className="h-4 w-4 accent-neutral-900" />
                ) },
              { key: 'label', label: 'Label', value: (r) => r.label ?? '' },
              { key: 'pattern', label: 'Pattern', value: (r) => r.match_pattern,
                render: (r) => <code className="text-11 font-mono text-neutral-800">{r.match_pattern}</code> },
              { key: 'ledger', label: 'Counter-ledger', value: (r) => r.counter_ledger_name },
              { key: 'direction', label: 'Direction', value: (r) => r.direction },
              { key: 'priority', label: 'Priority', align: 'right', value: (r) => r.priority },
              { key: 'source', label: 'Source', value: (r) => r.source,
                render: (r) => r.source === 'seed'
                  ? <span className="text-11 px-1.5 py-0.5 rounded bg-sky-50 text-sky-700">Seed</span>
                  : <span className="text-11 px-1.5 py-0.5 rounded bg-neutral-100 text-neutral-700">User</span> },
              { key: 'action', label: '', align: 'right', value: () => '',
                render: (r) => (
                  <button type="button" onClick={() => deleteM.mutate(r.id)} className="text-neutral-400 hover:text-danger" aria-label="Delete rule">
                    <Trash2 size={13} />
                  </button>
                ) },
            ]}
            empty="No persisted rules — the default rules shipped in code still apply."
          />
        </>
      )}
    </Panel>
  );
}
