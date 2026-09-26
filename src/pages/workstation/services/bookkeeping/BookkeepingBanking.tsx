import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Upload, Link2, Unlink } from 'lucide-react';
import { Button } from '@/components/Button';
import { useToast } from '@/components/Toast';
import { bookkeepingAccountingApi, type StatementLine } from '@/modules/tools/audit-automation/bookkeeping';
import { DataTable, Money, DrCr, Panel, Loading, ErrorNote, usePeriod, ReportHeader, parseCsv } from '@/modules/tools/bookkeeping/ui';
import type { ApiError } from '@/services/api';

/**
 * /banking — bank accounts, the bank book, statement import and
 * reconciliation.
 *
 * Matching a statement line to a book entry records WHEN the bank saw it.
 * It never edits an amount: a genuine difference stays visible as a
 * reconciling item, which is the only useful kind of reconciliation.
 */
export function BookkeepingBanking() {
  const { companyId = '' } = useParams();
  const { from, to } = usePeriod();
  const [selected, setSelected] = useState<string>('');
  const [tab, setTab] = useState<'book' | 'statement' | 'reconcile'>('book');
  const base = `/tally/companies/${companyId}`;

  const accountsQ = useQuery({
    queryKey: ['tally.bankAccounts', companyId, to],
    queryFn: () => bookkeepingAccountingApi.bankAccounts(companyId, to),
  });
  const accounts = accountsQ.data?.items ?? [];
  const ledgerId = selected || accounts[0]?.ledger_id || '';

  if (accountsQ.isLoading) return <Loading />;
  if (accountsQ.isError) return <ErrorNote message={(accountsQ.error as Error).message} />;
  if (!accounts.length) {
    return (
      <div>
        <ReportHeader title="Banking" />
        <Panel>
          <div className="px-3 py-6 text-13 text-neutral-500">
            No bank ledgers yet. Create a ledger under <strong>Bank Accounts</strong> in{' '}
            <Link to={`${base}/masters/ledgers`} className="text-gold hover:underline">Ledgers</Link>, then come back here to import a statement.
          </div>
        </Panel>
      </div>
    );
  }

  return (
    <div data-testid="tally-banking">
      <ReportHeader title="Banking" subtitle={`${from} to ${to}`} />

      <div className="grid grid-cols-1 md:grid-cols-3 gap-2 mb-4">
        {accounts.map((a) => (
          <button
            key={a.ledger_id}
            type="button"
            onClick={() => setSelected(a.ledger_id)}
            className={`text-left bg-white border rounded p-3 ${a.ledger_id === ledgerId ? 'border-gold' : 'border-neutral-200 hover:border-neutral-300'}`}
          >
            <div className="text-13 font-medium text-neutral-900 truncate">{a.ledger_name}</div>
            <div className="text-11 text-neutral-500">{a.account_number ?? 'No account number on the ledger'}</div>
            <div className="text-14 font-semibold mt-1"><DrCr paise={a.book_balance_paise} /></div>
            {a.unmatched_statement_lines > 0 ? (
              <div className="text-11 text-amber-700 mt-1">{a.unmatched_statement_lines} unmatched statement line{a.unmatched_statement_lines === 1 ? '' : 's'}</div>
            ) : null}
          </button>
        ))}
      </div>

      <div className="flex gap-1 mb-3 print:hidden">
        {(['book', 'statement', 'reconcile'] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`h-8 px-3 text-12 rounded border ${tab === t ? 'bg-neutral-100 border-neutral-300 text-neutral-900 font-medium' : 'bg-white border-neutral-200 text-neutral-600 hover:bg-neutral-50'}`}
          >
            {t === 'book' ? 'Bank book' : t === 'statement' ? 'Statement' : 'Reconciliation'}
          </button>
        ))}
      </div>

      {tab === 'book' ? <BankBook companyId={companyId} ledgerId={ledgerId} from={from} to={to} base={base} /> : null}
      {tab === 'statement' ? <StatementTab companyId={companyId} ledgerId={ledgerId} /> : null}
      {tab === 'reconcile' ? <ReconcileTab companyId={companyId} ledgerId={ledgerId} to={to} /> : null}
    </div>
  );
}

function BankBook({ companyId, ledgerId, from, to, base }: { companyId: string; ledgerId: string; from: string; to: string; base: string }) {
  const q = useQuery({
    queryKey: ['tally.bankBook', companyId, ledgerId, from, to],
    enabled: Boolean(ledgerId),
    queryFn: () => bookkeepingAccountingApi.bankBook(companyId, ledgerId, { from, to }),
  });
  if (q.isLoading) return <Loading />;
  if (q.isError) return <ErrorNote message={(q.error as Error).message} />;
  const d = q.data!;
  return (
    <Panel title={`${d.ledger.name} — bank book`}>
      <div className="px-3 py-2 border-b border-neutral-100 flex flex-wrap gap-4 text-12">
        <span className="text-neutral-500">Opening <DrCr paise={d.opening_paise} /></span>
        <span className="text-neutral-500">Closing <DrCr paise={d.closing_paise} /></span>
        <span className="text-neutral-500">Unreconciled <Money paise={Math.abs(d.unreconciled_paise)} /></span>
      </div>
      <DataTable
        minWidth="820px"
        rows={d.rows}
        rowKey={(r) => r.entry_id}
        columns={[
          { key: 'date', label: 'Date', value: (r) => r.date },
          { key: 'voucher', label: 'Voucher', value: (r) => r.voucher_number, render: (r) => <Link to={`${base}/vouchers/${r.voucher_id}`} className="text-neutral-900 hover:text-gold">{r.voucher_number}</Link> },
          { key: 'particulars', label: 'Particulars', value: (r) => r.particulars },
          { key: 'in', label: 'Deposit', align: 'right', value: (r) => r.deposit_paise / 100, render: (r) => <Money paise={r.deposit_paise} /> },
          { key: 'out', label: 'Withdrawal', align: 'right', value: (r) => r.withdrawal_paise / 100, render: (r) => <Money paise={r.withdrawal_paise} /> },
          { key: 'balance', label: 'Balance', align: 'right', value: (r) => r.running_balance_paise / 100, render: (r) => <DrCr paise={r.running_balance_paise} /> },
          { key: 'recon', label: 'Bank date', align: 'center', value: (r) => r.bank_date ?? '', render: (r) => (r.reconciled ? <span className="text-11 text-emerald-700">{r.bank_date}</span> : <span className="text-11 text-neutral-400">unreconciled</span>) },
        ]}
        empty="No bank movement in this period."
      />
    </Panel>
  );
}

function StatementTab({ companyId, ledgerId }: { companyId: string; ledgerId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [csv, setCsv] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState('all');

  const linesQ = useQuery({
    queryKey: ['tally.statementLines', companyId, ledgerId, statusFilter],
    enabled: Boolean(ledgerId),
    queryFn: () => bookkeepingAccountingApi.statementLines(companyId, ledgerId, { status: statusFilter }),
  });

  const importM = useMutation({
    mutationFn: () => {
      const { rows } = parseCsv(csv);
      const parsed = rows.map((r) => ({
        date: normaliseDate(r.date ?? r.txn_date ?? r.value_date ?? ''),
        description: r.description ?? r.narration ?? r.particulars ?? '',
        ref_number: r.ref ?? r.reference ?? r.cheque_no ?? null,
        debit_paise: money(r.debit ?? r.withdrawal ?? ''),
        credit_paise: money(r.credit ?? r.deposit ?? ''),
        balance_paise: r.balance ? money(r.balance) : null,
      })).filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date) && (r.debit_paise || r.credit_paise));
      if (!parsed.length) throw new Error('No usable rows. Expected columns: date, description, debit, credit, balance.');
      return bookkeepingAccountingApi.importStatement(companyId, ledgerId, parsed);
    },
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ['tally.statementLines', companyId, ledgerId] });
      await qc.invalidateQueries({ queryKey: ['tally.bankAccounts', companyId] });
      toast.push('success', `${r.imported} line${r.imported === 1 ? '' : 's'} imported${r.duplicates_skipped ? `, ${r.duplicates_skipped} duplicate skipped` : ''}.`);
      setCsv('');
    },
    onError: (e: Error) => setErr(e.message),
  });

  return (
    <div className="space-y-4">
      <Panel title="Import a statement (CSV)">
        <div className="p-3">
          <p className="text-12 text-neutral-500 mb-2">
            Paste the CSV with a header row. Recognised columns: <code className="text-11">date, description, debit, credit, balance, ref</code>.
            Rows that duplicate an already-imported line are skipped.
          </p>
          <textarea
            value={csv} onChange={(e) => setCsv(e.target.value)} rows={5}
            placeholder={'date,description,debit,credit,balance\n2026-04-15,NEFT XYZ CUSTOMERS,,100000,540000'}
            className="w-full px-2 py-1 text-12 font-mono border border-neutral-300 rounded focus:outline-none focus:border-gold"
          />
          {err ? <div className="text-12 text-danger mt-2">{err}</div> : null}
          <div className="mt-2">
            <Button size="sm" variant="primary" onClick={() => { setErr(null); importM.mutate(); }} disabled={!csv.trim() || importM.isPending}>
              <Upload size={13} className="mr-1" /> {importM.isPending ? 'Importing…' : 'Import lines'}
            </Button>
          </div>
        </div>
      </Panel>

      <Panel
        title="Statement lines"
        actions={
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="h-7 px-1 text-12 border border-neutral-300 rounded bg-white">
            <option value="all">All</option>
            <option value="unmatched">Unmatched</option>
            <option value="matched">Matched</option>
          </select>
        }
      >
        {linesQ.isLoading ? <div className="p-3 text-13 text-neutral-500">Loading…</div> : (
          <DataTable
            minWidth="760px"
            rows={linesQ.data?.items ?? []}
            rowKey={(r) => r.id}
            columns={[
              { key: 'date', label: 'Date', value: (r) => r.date },
              { key: 'desc', label: 'Description', value: (r) => r.description },
              { key: 'debit', label: 'Withdrawal', align: 'right', value: (r) => r.debit_paise / 100, render: (r) => <Money paise={r.debit_paise} /> },
              { key: 'credit', label: 'Deposit', align: 'right', value: (r) => r.credit_paise / 100, render: (r) => <Money paise={r.credit_paise} /> },
              { key: 'status', label: 'Status', value: (r) => r.status, render: (r) => <MatchCell companyId={companyId} ledgerId={ledgerId} line={r} /> },
            ]}
            empty="No statement lines imported for this account yet."
          />
        )}
      </Panel>
    </div>
  );
}

function MatchCell({ companyId, ledgerId, line }: { companyId: string; ledgerId: string; line: StatementLine }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const suggestionsQ = useQuery({
    queryKey: ['tally.matchSuggestions', companyId, line.id],
    enabled: open,
    queryFn: () => bookkeepingAccountingApi.matchSuggestions(companyId, line.id),
  });
  const invalidate = async () => {
    await qc.invalidateQueries({ queryKey: ['tally.statementLines', companyId, ledgerId] });
    await qc.invalidateQueries({ queryKey: ['tally.bankBook', companyId, ledgerId] });
    await qc.invalidateQueries({ queryKey: ['tally.bankAccounts', companyId] });
  };
  const match = useMutation({
    mutationFn: (entryId: string) => bookkeepingAccountingApi.matchLine(companyId, line.id, entryId),
    onSuccess: async () => { await invalidate(); setOpen(false); toast.push('success', 'Matched.'); },
    onError: (e: ApiError) => toast.push('error', e.message),
  });
  const unmatch = useMutation({
    mutationFn: () => bookkeepingAccountingApi.unmatchLine(companyId, line.id),
    onSuccess: async () => { await invalidate(); toast.push('success', 'Unmatched.'); },
    onError: (e: ApiError) => toast.push('error', e.message),
  });

  if (line.status === 'matched') {
    return (
      <span className="inline-flex items-center gap-2">
        <span className="text-11 text-emerald-700">matched {line.matched_voucher_number}</span>
        <button type="button" onClick={() => unmatch.mutate()} className="text-neutral-400 hover:text-danger" aria-label="Unmatch"><Unlink size={12} /></button>
      </span>
    );
  }
  return (
    <span className="relative inline-block">
      <button type="button" onClick={() => setOpen((s) => !s)} className="text-12 text-gold hover:underline inline-flex items-center gap-1">
        <Link2 size={12} /> Match
      </button>
      {open ? (
        <div className="absolute right-0 top-6 z-30 w-[320px] bg-white border border-neutral-200 rounded shadow-lg">
          {suggestionsQ.isLoading ? <div className="px-3 py-2 text-12 text-neutral-500">Looking for candidates…</div>
            : (suggestionsQ.data?.items.length ?? 0) === 0 ? (
              <div className="px-3 py-2 text-12 text-neutral-500">
                No posted entry on this account matches that amount within a week. Post the voucher first.
              </div>
            ) : suggestionsQ.data!.items.map((c) => (
              <button key={c.entry_id} type="button" onClick={() => match.mutate(c.entry_id)} className="w-full text-left px-3 py-2 hover:bg-neutral-50 border-b border-neutral-100 last:border-0">
                <div className="text-12 text-neutral-900">{c.voucher_number} · {c.date}</div>
                <div className="text-11 text-neutral-500">{c.party_name ?? c.narration ?? '—'} · {c.day_gap} day gap</div>
              </button>
            ))}
        </div>
      ) : null}
    </span>
  );
}

function ReconcileTab({ companyId, ledgerId, to }: { companyId: string; ledgerId: string; to: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [statementDate, setStatementDate] = useState(to);
  const q = useQuery({
    queryKey: ['tally.reconciliation', companyId, ledgerId, statementDate],
    enabled: Boolean(ledgerId && statementDate),
    queryFn: () => bookkeepingAccountingApi.reconciliation(companyId, ledgerId, statementDate),
  });
  const historyQ = useQuery({
    queryKey: ['tally.reconciliations', companyId, ledgerId],
    queryFn: () => bookkeepingAccountingApi.listReconciliations(companyId, ledgerId),
  });
  const save = useMutation({
    mutationFn: () => bookkeepingAccountingApi.saveReconciliation(companyId, ledgerId, statementDate),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ['tally.reconciliations', companyId, ledgerId] }); toast.push('success', 'Reconciliation saved.'); },
    onError: (e: ApiError) => toast.push('error', e.message),
  });

  return (
    <div className="space-y-4">
      <Panel
        title="Reconciliation"
        actions={
          <div className="flex items-center gap-2">
            <input type="date" value={statementDate} onChange={(e) => setStatementDate(e.target.value)} className="h-7 px-1 text-12 border border-neutral-300 rounded" />
            <Button size="sm" variant="secondary" onClick={() => save.mutate()} disabled={save.isPending}>Save as evidence</Button>
          </div>
        }
      >
        {q.isLoading ? <div className="p-3 text-13 text-neutral-500">Loading…</div> : q.data ? (
          <>
            <div className="p-3 grid grid-cols-1 md:grid-cols-3 gap-3 text-13">
              <div><div className="text-11 text-neutral-500">Balance as per books</div><div className="text-14 font-semibold"><DrCr paise={q.data.book_balance_paise} /></div></div>
              <div><div className="text-11 text-neutral-500">Balance as per statement</div><div className="text-14 font-semibold"><DrCr paise={q.data.statement_balance_paise} /></div></div>
              <div>
                <div className="text-11 text-neutral-500">Difference</div>
                <div className={`text-14 font-semibold ${q.data.difference_paise === 0 ? 'text-emerald-700' : 'text-danger'}`}>
                  <Money paise={q.data.difference_paise} signed />
                </div>
              </div>
            </div>
            <div className="px-3 pb-3 text-12 text-neutral-500">
              {q.data.matched_count} matched · {q.data.unmatched_book_count} book entries not on the statement · {q.data.unmatched_statement_count} statement lines not in the books.
            </div>
          </>
        ) : null}
      </Panel>

      {q.data && q.data.unmatched_book.length ? (
        <Panel title="In the books, not yet on the statement">
          <DataTable
            minWidth="620px" rows={q.data.unmatched_book} rowKey={(r) => r.entry_id}
            columns={[
              { key: 'date', label: 'Date', value: (r) => r.date },
              { key: 'voucher', label: 'Voucher', value: (r) => r.voucher_number },
              { key: 'particulars', label: 'Particulars', value: (r) => r.particulars },
              { key: 'in', label: 'Deposit', align: 'right', value: (r) => r.deposit_paise / 100, render: (r) => <Money paise={r.deposit_paise} /> },
              { key: 'out', label: 'Withdrawal', align: 'right', value: (r) => r.withdrawal_paise / 100, render: (r) => <Money paise={r.withdrawal_paise} /> },
            ]}
          />
        </Panel>
      ) : null}

      {q.data && q.data.unmatched_statement.length ? (
        <Panel title="On the statement, not yet in the books">
          <DataTable
            minWidth="620px" rows={q.data.unmatched_statement} rowKey={(r) => r.id}
            columns={[
              { key: 'date', label: 'Date', value: (r) => r.date },
              { key: 'desc', label: 'Description', value: (r) => r.description },
              { key: 'out', label: 'Withdrawal', align: 'right', value: (r) => r.debit_paise / 100, render: (r) => <Money paise={r.debit_paise} /> },
              { key: 'in', label: 'Deposit', align: 'right', value: (r) => r.credit_paise / 100, render: (r) => <Money paise={r.credit_paise} /> },
            ]}
          />
        </Panel>
      ) : null}

      <Panel title="Saved reconciliations">
        <DataTable
          minWidth="620px"
          rows={historyQ.data?.items ?? []}
          rowKey={(r) => r.id}
          columns={[
            { key: 'date', label: 'Statement date', value: (r) => r.statement_date },
            { key: 'book', label: 'Books', align: 'right', value: (r) => r.book_balance_paise / 100, render: (r) => <DrCr paise={r.book_balance_paise} /> },
            { key: 'stmt', label: 'Statement', align: 'right', value: (r) => r.statement_balance_paise / 100, render: (r) => <DrCr paise={r.statement_balance_paise} /> },
            { key: 'diff', label: 'Difference', align: 'right', value: (r) => r.difference_paise / 100, render: (r) => <Money paise={r.difference_paise} signed /> },
            { key: 'at', label: 'Saved', value: (r) => new Date(r.created_at).toLocaleString('en-IN') },
          ]}
          empty="No reconciliation has been saved for this account yet."
        />
      </Panel>
    </div>
  );
}

function money(v: string): number {
  const n = Number(String(v).replace(/[₹,\s]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

/** Accept YYYY-MM-DD and DD/MM/YYYY, the two shapes Indian banks export. */
function normaliseDate(v: string): string {
  const s = v.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{2})[/-](\d{2})[/-](\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
}
