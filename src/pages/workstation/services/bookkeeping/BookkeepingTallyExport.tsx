/**
 * Tally Export screen — docs/tally-export/README.md.
 *
 * One page under a bookkeeping company workspace with three tabs:
 *
 *   Rules            — CRUD for the mapping rules that turn a bank-row
 *                      description into a Tally ledger name (§5).
 *   Preview & Preflight
 *                    — pick a bank account + date range, see every row
 *                      resolved with its ledger + voucher type + number,
 *                      run the §6 preflight, hit Generate (which is
 *                      currently 501 until §11's fixture arrives).
 *   History          — the tally_export audit trail (§7).
 *
 * Kept in one file for now — the tabs are small enough that splitting
 * them into modules would be premature; when the XLSX writer lands and
 * the review UI grows Apply-to-similar / Save-as-rule inline actions,
 * the Preview tab can lift into its own file.
 */
import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, Info, Trash2 } from 'lucide-react';
import { rupees, ReportHeader, Panel, Loading, ErrorNote } from '@/modules/tools/bookkeeping/ui';
import { bookkeepingAccountingApi } from '@/modules/tools/audit-automation/bookkeeping';
import {
  tallyExportApi, MATCH_TYPES, VOUCHER_TYPES,
  type MatchType, type VoucherType, type Rule, type PreviewRow, type PreflightReport, type Scope,
} from '@/modules/workstation/tallyExport/api';
import { useToast } from '@/components/Toast';

const inputCls =
  'h-9 w-full px-2 text-13 border border-neutral-300 rounded bg-white focus:outline-none focus:border-neutral-500';

export function BookkeepingTallyExport() {
  const { companyId = '' } = useParams();
  const [tab, setTab] = useState<'rules' | 'preview' | 'history'>('preview');

  return (
    <div>
      <ReportHeader title="Tally Export" subtitle="Bank statement rows → TallyPrime Excel file." />

      <div className="border-b border-neutral-200 mb-3 flex gap-1">
        {(['preview', 'rules', 'history'] as const).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setTab(k)}
            className={
              'px-3 h-9 text-13 border-b-2 -mb-px '
              + (tab === k ? 'border-gold text-neutral-900 font-medium' : 'border-transparent text-neutral-500 hover:text-neutral-900')
            }
          >
            {k === 'preview' ? 'Preview & Preflight' : k === 'rules' ? 'Rules' : 'History'}
          </button>
        ))}
      </div>

      {tab === 'preview' ? <PreviewPanel companyId={companyId} />
        : tab === 'rules' ? <RulesPanel companyId={companyId} />
        : <HistoryPanel companyId={companyId} />}
    </div>
  );
}

// ── Rules tab ─────────────────────────────────────────────────────────────

function RulesPanel({ companyId }: { companyId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const rulesQ = useQuery({
    queryKey: ['tallyExport.rules', companyId],
    queryFn: () => tallyExportApi.listRules(companyId),
  });

  const [draft, setDraft] = useState<{ match_type: MatchType; pattern: string; ledger_name: string; voucher_type: VoucherType | ''; priority: number; scope: 'company' | 'global' }>({
    match_type: 'contains', pattern: '', ledger_name: '', voucher_type: '', priority: 0, scope: 'company',
  });

  const create = useMutation({
    mutationFn: () => tallyExportApi.createRule({
      company_id: draft.scope === 'company' ? companyId : null,
      match_type: draft.match_type,
      pattern: draft.pattern,
      ledger_name: draft.ledger_name,
      voucher_type: draft.voucher_type === '' ? null : draft.voucher_type,
      priority: draft.priority,
    }),
    onSuccess: () => {
      setDraft({ match_type: 'contains', pattern: '', ledger_name: '', voucher_type: '', priority: 0, scope: 'company' });
      void qc.invalidateQueries({ queryKey: ['tallyExport.rules', companyId] });
      toast.push('success', 'Rule created.');
    },
    onError: (e: Error) => toast.push('error', e.message),
  });
  const del = useMutation({
    mutationFn: (id: string) => tallyExportApi.deleteRule(id),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['tallyExport.rules', companyId] }); },
    onError: (e: Error) => toast.push('error', e.message),
  });

  const rules = rulesQ.data?.items ?? [];

  return (
    <div className="space-y-3">
      <Panel title="New rule">
        <div className="p-3 grid grid-cols-1 md:grid-cols-6 gap-2 items-end">
          <label className="text-13">
            <div className="text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">Match type</div>
            <select className={inputCls} value={draft.match_type} onChange={(e) => setDraft((d) => ({ ...d, match_type: e.target.value as MatchType }))}>
              {MATCH_TYPES.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </label>
          <label className="text-13 md:col-span-2">
            <div className="text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">Pattern</div>
            <input className={inputCls} value={draft.pattern} onChange={(e) => setDraft((d) => ({ ...d, pattern: e.target.value }))} placeholder="SRI VARI TRADERS" />
          </label>
          <label className="text-13 md:col-span-2">
            <div className="text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">Ledger name</div>
            <input className={inputCls} value={draft.ledger_name} onChange={(e) => setDraft((d) => ({ ...d, ledger_name: e.target.value }))} placeholder="Sri Vari Traders" />
          </label>
          <label className="text-13">
            <div className="text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">Voucher type</div>
            <select className={inputCls} value={draft.voucher_type} onChange={(e) => setDraft((d) => ({ ...d, voucher_type: e.target.value as VoucherType | '' }))}>
              <option value="">auto</option>
              {VOUCHER_TYPES.map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </label>
          <label className="text-13">
            <div className="text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">Priority</div>
            <input className={inputCls} type="number" value={draft.priority} onChange={(e) => setDraft((d) => ({ ...d, priority: Number(e.target.value) || 0 }))} />
          </label>
          <label className="text-13">
            <div className="text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">Scope</div>
            <select className={inputCls} value={draft.scope} onChange={(e) => setDraft((d) => ({ ...d, scope: e.target.value as 'company' | 'global' }))}>
              <option value="company">this company</option>
              <option value="global">global (all companies)</option>
            </select>
          </label>
          <button
            type="button"
            disabled={!draft.pattern || !draft.ledger_name || create.isPending}
            onClick={() => create.mutate()}
            className="h-9 px-3 text-13 border border-neutral-300 rounded bg-white hover:bg-neutral-50 disabled:opacity-50 md:col-start-6"
          >
            {create.isPending ? 'Saving…' : 'Add rule'}
          </button>
        </div>
      </Panel>

      <Panel title={`Rules (${rules.length})`}>
        {rulesQ.isLoading ? <Loading /> : rulesQ.isError ? <ErrorNote message={(rulesQ.error as Error).message} /> : (
          <table className="w-full text-13">
            <thead>
              <tr className="text-11 uppercase tracking-[0.06em] text-neutral-500">
                <th className="text-left px-3 py-2">Scope</th>
                <th className="text-left px-3 py-2">Match</th>
                <th className="text-left px-3 py-2">Pattern</th>
                <th className="text-left px-3 py-2">Ledger</th>
                <th className="text-left px-3 py-2">Type</th>
                <th className="text-right px-3 py-2">Priority</th>
                <th className="text-right px-3 py-2">Hits</th>
                <th className="px-3 py-2 w-9" />
              </tr>
            </thead>
            <tbody>
              {rules.length === 0 ? (
                <tr><td colSpan={8} className="px-3 py-6 text-neutral-500 text-center">No rules yet — add one above.</td></tr>
              ) : rules.map((r: Rule) => (
                <tr key={r.id} className="border-t border-neutral-100">
                  <td className="px-3 py-2 text-neutral-500">{r.company_id === null ? 'global' : 'company'}</td>
                  <td className="px-3 py-2">{r.match_type}</td>
                  <td className="px-3 py-2 font-mono text-12">{r.pattern}</td>
                  <td className="px-3 py-2">{r.ledger_name}</td>
                  <td className="px-3 py-2 text-neutral-500">{r.voucher_type ?? 'auto'}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.priority}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-neutral-500">{r.hit_count}</td>
                  <td className="px-3 py-2">
                    <button type="button" onClick={() => del.mutate(r.id)} aria-label="Delete rule" className="text-neutral-400 hover:text-red">
                      <Trash2 size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}

// ── Preview + preflight tab ───────────────────────────────────────────────

function PreviewPanel({ companyId }: { companyId: string }) {
  const toast = useToast();
  const asOf = new Date().toISOString().slice(0, 10);
  const accountsQ = useQuery({
    queryKey: ['tally.bankAccounts', companyId, asOf],
    queryFn: () => bookkeepingAccountingApi.bankAccounts(companyId, asOf),
  });

  const today = new Date();
  const firstOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
  const [scope, setScope] = useState<Scope>({
    companyId,
    bankLedgerId: '',
    periodFrom: firstOfMonth.toISOString().slice(0, 10),
    periodTo: today.toISOString().slice(0, 10),
  });

  const accounts = accountsQ.data?.items ?? [];
  const effectiveScope: Scope = { ...scope, bankLedgerId: scope.bankLedgerId || accounts[0]?.ledger_id || '' };

  const runReadyQ = !!effectiveScope.bankLedgerId && !!effectiveScope.periodFrom && !!effectiveScope.periodTo;
  const preflightQ = useQuery({
    queryKey: ['tallyExport.preflight', effectiveScope],
    queryFn: () => tallyExportApi.preflight(effectiveScope),
    enabled: runReadyQ,
  });

  const generate = useMutation({
    mutationFn: () => tallyExportApi.generate(effectiveScope),
    onSuccess: () => toast.push('success', 'Generated.'),
    onError: (e: Error) => toast.push('error', e.message),
  });

  const errorsBlock = preflightQ.data?.errors.length ?? 0;

  return (
    <div className="space-y-3">
      <Panel title="Scope">
        <div className="p-3 grid grid-cols-1 md:grid-cols-4 gap-2 items-end">
          <label className="text-13">
            <div className="text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">Bank account</div>
            <select className={inputCls} value={effectiveScope.bankLedgerId} onChange={(e) => setScope((s) => ({ ...s, bankLedgerId: e.target.value }))}>
              {accounts.length === 0 ? <option value="">— no bank accounts —</option> : null}
              {accounts.map((a) => (
                <option key={a.ledger_id} value={a.ledger_id}>{a.account_name ?? a.ledger_name}</option>
              ))}
            </select>
          </label>
          <label className="text-13">
            <div className="text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">From</div>
            <input className={inputCls} type="date" value={scope.periodFrom} onChange={(e) => setScope((s) => ({ ...s, periodFrom: e.target.value }))} />
          </label>
          <label className="text-13">
            <div className="text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">To</div>
            <input className={inputCls} type="date" value={scope.periodTo} onChange={(e) => setScope((s) => ({ ...s, periodTo: e.target.value }))} />
          </label>
          <button
            type="button"
            disabled={!runReadyQ || errorsBlock > 0 || generate.isPending}
            title={errorsBlock > 0 ? 'Fix preflight errors first' : 'The XLSX writer is not yet enabled (spec §11) — this will return 501 for now.'}
            onClick={() => generate.mutate()}
            className="h-9 px-3 text-13 border border-neutral-300 rounded bg-white hover:bg-neutral-50 disabled:opacity-50"
          >
            {generate.isPending ? 'Generating…' : 'Generate voucher sheet'}
          </button>
        </div>
      </Panel>

      {preflightQ.isLoading ? <Loading /> : preflightQ.isError ? <ErrorNote message={(preflightQ.error as Error).message} /> : preflightQ.data ? (
        <PreflightBody report={preflightQ.data} />
      ) : (
        <Panel><div className="px-3 py-6 text-13 text-neutral-500">Pick a bank account and date range to run the preflight.</div></Panel>
      )}
    </div>
  );
}

function PreflightBody({ report }: { report: PreflightReport }) {
  const [filter, setFilter] = useState<'all' | 'unmapped' | 'contra' | 'new_ledgers'>('all');
  const rows = useMemo(() => {
    switch (filter) {
      case 'unmapped': return report.rows.filter((r) => !r.ledger_name);
      case 'contra': return report.rows.filter((r) => r.voucher_type === 'contra');
      case 'new_ledgers': return report.rows.filter((r) => r.new_ledger);
      default: return report.rows;
    }
  }, [report.rows, filter]);

  return (
    <div className="space-y-3">
      <Panel title="Preflight">
        <div className="p-3 grid grid-cols-2 md:grid-cols-6 gap-2 text-13">
          <Stat label="Rows" value={report.totals.rows} />
          <Stat label="Mapped" value={report.totals.mapped} />
          <Stat label="Unmapped" value={report.totals.unmapped} tone={report.totals.unmapped > 0 ? 'warn' : 'ok'} />
          <Stat label="Contra" value={report.totals.contra} />
          <Stat label="Vouchers" value={report.totals.vouchers} />
          <Stat label="Errors" value={report.errors.length} tone={report.errors.length > 0 ? 'error' : 'ok'} />
        </div>
        {report.errors.length > 0 ? (
          <div className="px-3 py-2 border-t border-neutral-100 space-y-1">
            {report.errors.slice(0, 20).map((e, i) => (
              <div key={i} className="flex items-start gap-2 text-13 text-red">
                <AlertTriangle size={13} className="mt-[2px]" /> <span>{e.message}</span>
              </div>
            ))}
            {report.errors.length > 20 ? (
              <div className="text-12 text-neutral-500 pl-5">+ {report.errors.length - 20} more…</div>
            ) : null}
          </div>
        ) : null}
        {report.warnings.length > 0 ? (
          <div className="px-3 py-2 border-t border-neutral-100 space-y-1">
            {report.warnings.map((w, i) => (
              <div key={i} className="flex items-start gap-2 text-13 text-amber">
                <Info size={13} className="mt-[2px]" /> <span>{w.message}</span>
              </div>
            ))}
          </div>
        ) : null}
      </Panel>

      <Panel title={`Ledgers used (${report.ledgers.length})`}>
        <div className="p-3 flex flex-wrap gap-2 text-13">
          {report.ledgers.length === 0 ? (
            <span className="text-neutral-500">No mapped rows yet.</span>
          ) : report.ledgers.map((l) => (
            <span key={l.ledger_name} className="inline-flex items-center gap-1 px-2 h-6 rounded border border-neutral-200 bg-neutral-50">
              {l.new_ledger ? <span className="text-amber" title="Not seen before for this client">new</span> : <Check size={12} className="text-green" />}
              {l.ledger_name}
              <span className="text-neutral-500 tabular-nums">{l.voucher_count}</span>
            </span>
          ))}
        </div>
      </Panel>

      <Panel title={`Rows (${rows.length} of ${report.rows.length})`}>
        <div className="px-3 py-2 border-b border-neutral-200 flex gap-1">
          {([
            ['all', 'All'],
            ['unmapped', 'Unmapped'],
            ['contra', 'Contra'],
            ['new_ledgers', 'New ledgers'],
          ] as const).map(([k, label]) => (
            <button
              key={k}
              type="button"
              onClick={() => setFilter(k)}
              className={
                'h-7 px-2 text-13 rounded '
                + (filter === k ? 'bg-neutral-900 text-white' : 'text-neutral-600 hover:text-neutral-900')
              }
            >{label}</button>
          ))}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-13">
            <thead>
              <tr className="text-11 uppercase tracking-[0.06em] text-neutral-500">
                <th className="text-left px-3 py-2">Date</th>
                <th className="text-left px-3 py-2">Description</th>
                <th className="text-right px-3 py-2">Withdrawal</th>
                <th className="text-right px-3 py-2">Deposit</th>
                <th className="text-left px-3 py-2">Ledger</th>
                <th className="text-left px-3 py-2">Type</th>
                <th className="text-left px-3 py-2">Voucher #</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr><td colSpan={7} className="px-3 py-6 text-neutral-500 text-center">Nothing to show.</td></tr>
              ) : rows.map((r: PreviewRow) => (
                <tr key={r.statement_line_id} className={'border-t border-neutral-100 ' + (r.ledger_name ? '' : 'bg-red/[0.04]')}>
                  <td className="px-3 py-2 tabular-nums text-neutral-600">{r.date}</td>
                  <td className="px-3 py-2 text-neutral-900">{r.description || '—'}</td>
                  <td className="px-3 py-2 tabular-nums text-right">{r.debit_paise > 0 ? rupees(r.debit_paise) : ''}</td>
                  <td className="px-3 py-2 tabular-nums text-right">{r.credit_paise > 0 ? rupees(r.credit_paise) : ''}</td>
                  <td className="px-3 py-2">
                    {r.ledger_name ?? <span className="text-red">unmapped</span>}
                    {r.new_ledger ? <span className="ml-1 text-11 text-amber">new</span> : null}
                  </td>
                  <td className="px-3 py-2 text-neutral-500">{r.voucher_type ?? '—'}</td>
                  <td className="px-3 py-2 font-mono text-11 text-neutral-500">{r.voucher_number}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel title="Import instructions">
        <ol className="p-3 text-13 text-neutral-700 space-y-1 list-decimal list-inside">
          <li>Open the client's company in TallyPrime</li>
          <li>Gateway of Tally → Import → Vouchers</li>
          <li>Choose the downloaded file · file type Excel</li>
          <li>Review the mapping screen, then accept</li>
          <li>Read the Exceptions Report before closing</li>
        </ol>
      </Panel>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'ok' | 'warn' | 'error' }) {
  const color = tone === 'error' ? 'text-red' : tone === 'warn' ? 'text-amber' : 'text-neutral-900';
  return (
    <div>
      <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">{label}</div>
      <div className={`text-18 font-semibold tabular-nums ${color}`}>{value.toLocaleString('en-IN')}</div>
    </div>
  );
}

// ── History tab ───────────────────────────────────────────────────────────

function HistoryPanel({ companyId }: { companyId: string }) {
  const q = useQuery({
    queryKey: ['tallyExport.history', companyId],
    queryFn: () => tallyExportApi.history(companyId),
  });
  if (q.isLoading) return <Loading />;
  if (q.isError) return <ErrorNote message={(q.error as Error).message} />;
  const items = q.data?.items ?? [];
  return (
    <Panel title={`History (${items.length})`}>
      {items.length === 0 ? (
        <div className="px-3 py-6 text-13 text-neutral-500">No exports yet.</div>
      ) : (
        <table className="w-full text-13">
          <thead>
            <tr className="text-11 uppercase tracking-[0.06em] text-neutral-500">
              <th className="text-left px-3 py-2">Generated</th>
              <th className="text-left px-3 py-2">Period</th>
              <th className="text-left px-3 py-2">Kind</th>
              <th className="text-right px-3 py-2">Rows</th>
              <th className="text-right px-3 py-2">Vouchers</th>
              <th className="text-left px-3 py-2">Checksum</th>
            </tr>
          </thead>
          <tbody>
            {items.map((r) => (
              <tr key={r.id} className="border-t border-neutral-100">
                <td className="px-3 py-2 tabular-nums text-neutral-600">{r.generated_at.slice(0, 10)}</td>
                <td className="px-3 py-2 tabular-nums text-neutral-600">{r.period_from} → {r.period_to}</td>
                <td className="px-3 py-2 text-neutral-500">{r.kind}</td>
                <td className="px-3 py-2 text-right tabular-nums">{r.row_count}</td>
                <td className="px-3 py-2 text-right tabular-nums">{r.voucher_count}</td>
                <td className="px-3 py-2 font-mono text-11 text-neutral-500">{r.checksum?.slice(0, 12) ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}
