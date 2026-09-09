import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeftRight, Plus } from 'lucide-react';
import { Button } from '@/components/Button';
import { useToast } from '@/components/Toast';
import { fmtDate } from '@/lib/format';
import { Modal } from '@/modules/workstation/components';
import { booksApi } from '@/modules/books/api';
import { Cell, Empty, Field, Money, MoneyInput, Notice, Row, Section, Table, inputCls, selectCls, useBooks } from '@/modules/books/components';
import { money, today, toPaise, VOUCHER_LABEL } from '@/modules/books/format';

/**
 * /books/:orgId/banking — accounts and balances, transfers between them,
 * and reconciliation against a manually entered statement.
 */
export function BooksBankingPage() {
  const { orgId, org, canWrite, canAccountant } = useBooks();
  const qc = useQueryClient();
  const [transfer, setTransfer] = useState(false);
  const [reconciling, setReconciling] = useState<string | null>(null);
  const accounts = useQuery({ queryKey: ['books', orgId, 'banking', 'accounts'], queryFn: () => booksApi.org(orgId).banking.accounts() });
  const transfers = useQuery({ queryKey: ['books', orgId, 'banking', 'transfers'], queryFn: () => booksApi.org(orgId).banking.transfers() });
  const refresh = () => qc.invalidateQueries({ queryKey: ['books', orgId] });

  if (reconciling) return <Reconcile orgId={orgId} ledgerId={reconciling} onBack={() => { setReconciling(null); refresh(); }} />;

  return (
    <div className="space-y-4" data-testid="books-banking">
      <div className="flex justify-end">
        {canWrite ? <Button variant="primary" size="sm" onClick={() => setTransfer(true)} data-testid="banking-transfer"><ArrowLeftRight size={14} strokeWidth={2} className="mr-1" />Transfer between accounts</Button> : null}
      </div>

      <Section title="Cash and bank accounts">
        {accounts.isLoading ? <div className="h-24 bg-neutral-100" /> : (accounts.data?.items.length ?? 0) === 0 ? <Empty>No bank or cash accounts. Add one under Settings → Chart of accounts.</Empty> : (
          <Table head={['Account', 'Bank', 'Account number', { label: 'Balance', align: 'right' }, '']}>
            {accounts.data!.items.map((a) => (
              <Row key={a.id}>
                <Cell className="font-medium">{a.name}</Cell>
                <Cell muted>{a.bank_name ?? (a.is_cash ? 'Cash' : '—')}</Cell>
                <Cell muted className="tabular-nums">{a.bank_account_no ?? '—'}</Cell>
                <Cell right><Money value={a.balance ?? 0} currency={org.base_currency} zero="0" /></Cell>
                <Cell right>{canAccountant ? <button type="button" onClick={() => setReconciling(a.id)} className="text-12 text-gold hover:text-gold-hover" data-testid={`reconcile-${a.id}`}>Reconcile →</button> : null}</Cell>
              </Row>
            ))}
          </Table>
        )}
      </Section>

      <Section title="Transfers">
        {(transfers.data?.items.length ?? 0) === 0 ? <Empty>No transfers recorded.</Empty> : (
          <Table head={['Number', 'Date', 'From', 'To', { label: 'Amount', align: 'right' }, 'Status']}>
            {transfers.data!.items.map((t) => {
              const name = (id: string) => accounts.data?.items.find((a) => a.id === id)?.name ?? '—';
              return (
                <Row key={t.id} border={t.status === 'void' ? 'red' : null} muted={t.status === 'void'}>
                  <Cell className="font-medium">{t.number}</Cell>
                  <Cell muted className="tabular-nums">{fmtDate(`${t.date}T00:00:00Z`)}</Cell>
                  <Cell muted>{name(t.from_ledger_id)}</Cell>
                  <Cell muted>{name(t.to_ledger_id)}</Cell>
                  <Cell right><Money value={t.amount} currency={org.base_currency} zero="0" /></Cell>
                  <Cell muted className="capitalize">{t.status}</Cell>
                </Row>
              );
            })}
          </Table>
        )}
      </Section>

      {transfer ? <TransferModal orgId={orgId} onClose={() => setTransfer(false)} onSaved={() => { setTransfer(false); refresh(); }} /> : null}
    </div>
  );
}

function TransferModal({ orgId, onClose, onSaved }: { orgId: string; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const api = booksApi.org(orgId);
  const accounts = useQuery({ queryKey: ['books', orgId, 'banking', 'accounts'], queryFn: () => api.banking.accounts() });
  const [f, setF] = useState({ date: today(), from_ledger_id: '', to_ledger_id: '', amount: '', reference: '' });
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => api.banking.transfer({ ...f, amount: toPaise(f.amount || '0'), reference: f.reference || null }),
    onSuccess: (t) => { toast.push('success', `Transfer ${t.number} recorded.`); onSaved(); }, onError: (e: Error) => setError(e.message),
  });
  return (
    <Modal open title="Transfer between accounts" onClose={onClose} width="w-[480px]"
      footer={<><Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button><Button variant="primary" size="sm" onClick={() => { setError(null); save.mutate(); }} disabled={save.isPending} data-testid="transfer-save">Record transfer</Button></>}>
      <div className="space-y-3">
        <Field label="Date"><input type="date" value={f.date} onChange={(e) => setF((x) => ({ ...x, date: e.target.value }))} className={inputCls} /></Field>
        <Field label="From"><select value={f.from_ledger_id} onChange={(e) => setF((x) => ({ ...x, from_ledger_id: e.target.value }))} className={selectCls}><option value="">Select…</option>{(accounts.data?.items ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
        <Field label="To"><select value={f.to_ledger_id} onChange={(e) => setF((x) => ({ ...x, to_ledger_id: e.target.value }))} className={selectCls}><option value="">Select…</option>{(accounts.data?.items ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
        <Field label="Amount"><MoneyInput value={f.amount} onChange={(v) => setF((x) => ({ ...x, amount: v }))} data-testid="transfer-amount" /></Field>
        <Field label="Reference"><input value={f.reference} onChange={(e) => setF((x) => ({ ...x, reference: e.target.value }))} className={inputCls} /></Field>
        {error ? <Notice tone="error">{error}</Notice> : null}
      </div>
    </Modal>
  );
}

/** Match ledger entries to statement lines. Statement lines are typed in; no parsing here. */
function Reconcile({ orgId, ledgerId, onBack }: { orgId: string; ledgerId: string; onBack: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const api = booksApi.org(orgId);
  const [selected, setSelected] = useState<{ statement?: string; journal?: string }>({});
  const [adding, setAdding] = useState(false);
  const q = useQuery({ queryKey: ['books', orgId, 'reconciliation', ledgerId], queryFn: () => api.banking.reconciliation(ledgerId) });
  const refresh = () => qc.invalidateQueries({ queryKey: ['books', orgId, 'reconciliation', ledgerId] });
  const match = useMutation({ mutationFn: () => api.banking.match(selected.statement!, selected.journal!), onSuccess: () => { setSelected({}); refresh(); }, onError: (e: Error) => toast.push('error', e.message) });
  const unmatch = useMutation({ mutationFn: (id: string) => api.banking.unmatch(id), onSuccess: refresh, onError: (e: Error) => toast.push('error', e.message) });

  const d = q.data;
  return (
    <div className="space-y-4" data-testid="books-reconcile">
      <div className="flex items-center gap-3">
        <button type="button" onClick={onBack} className="text-13 text-neutral-500 hover:text-neutral-900">← Banking</button>
        <h2 className="text-16 font-semibold text-neutral-900">{d?.ledger.name ?? 'Reconciliation'}</h2>
        <div className="flex-1" />
        <Button variant="secondary" size="sm" onClick={() => setAdding(true)} data-testid="statement-add"><Plus size={14} strokeWidth={2} className="mr-1" />Add statement lines</Button>
        <Button variant="primary" size="sm" disabled={!selected.statement || !selected.journal || match.isPending} onClick={() => match.mutate()} data-testid="reconcile-match">Match selected</Button>
      </div>

      {d ? (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-13">
          <Stat label="Ledger balance" v={d.summary.ledger_balance} />
          <Stat label="Reconciled" v={d.summary.reconciled_balance} />
          <Stat label="Unreconciled" v={d.summary.unreconciled} />
          <Stat label="Statement total" v={d.summary.statement_balance} />
        </div>
      ) : null}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Section title="Ledger entries">
          {q.isLoading ? <div className="h-24 bg-neutral-100" /> : !d?.journal_lines.length ? <Empty>No entries in this account.</Empty> : (
            <Table head={['', 'Date', 'Voucher', { label: 'Amount', align: 'right' }, 'Reconciled']} minWidth={420}>
              {d.journal_lines.map((l) => (
                <Row key={l.id} onClick={() => !l.reconciled_at && setSelected((s) => ({ ...s, journal: l.id }))}>
                  <Cell><input type="radio" checked={selected.journal === l.id} readOnly disabled={Boolean(l.reconciled_at)} className="accent-[#C8952E]" /></Cell>
                  <Cell muted className="tabular-nums whitespace-nowrap">{fmtDate(`${l.journal.date}T00:00:00Z`)}</Cell>
                  <Cell muted>{l.journal.number}<div className="text-11 text-neutral-500">{VOUCHER_LABEL[l.journal.voucher_type] ?? l.journal.voucher_type}</div></Cell>
                  <Cell right><Money value={l.side === 'debit' ? l.amount : -l.amount} zero="0" /></Cell>
                  <Cell muted>{l.reconciled_at ? 'Yes' : '—'}</Cell>
                </Row>
              ))}
            </Table>
          )}
        </Section>

        <Section title="Statement lines">
          {!d?.statement_lines.length ? <Empty>No statement lines entered yet.</Empty> : (
            <Table head={['', 'Date', 'Description', { label: 'Amount', align: 'right' }, '']} minWidth={420}>
              {d.statement_lines.map((s) => (
                <Row key={s.id} onClick={() => !s.matched_journal_line_id && setSelected((x) => ({ ...x, statement: s.id }))}>
                  <Cell><input type="radio" checked={selected.statement === s.id} readOnly disabled={Boolean(s.matched_journal_line_id)} className="accent-[#C8952E]" /></Cell>
                  <Cell muted className="tabular-nums whitespace-nowrap">{fmtDate(`${s.date}T00:00:00Z`)}</Cell>
                  <Cell muted className="max-w-[200px] truncate">{s.description}</Cell>
                  <Cell right><Money value={s.amount} zero="0" /></Cell>
                  <Cell right>{s.matched_journal_line_id ? <button type="button" onClick={(e) => { e.stopPropagation(); unmatch.mutate(s.id); }} className="text-12 text-neutral-500 hover:text-neutral-900">Unmatch</button> : null}</Cell>
                </Row>
              ))}
            </Table>
          )}
        </Section>
      </div>

      {adding ? <StatementModal orgId={orgId} ledgerId={ledgerId} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); refresh(); }} /> : null}
    </div>
  );
}

function Stat({ label, v }: { label: string; v: number }) {
  return <div className="bg-white border border-neutral-200 rounded px-3 py-2"><div className="text-11 uppercase tracking-[0.06em] text-neutral-500">{label}</div><div className="tabular-nums text-neutral-900 mt-0.5">{money(v)}</div></div>;
}

function StatementModal({ orgId, ledgerId, onClose, onSaved }: { orgId: string; ledgerId: string; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [rows, setRows] = useState([{ date: today(), description: '', amount: '', direction: 'in' as 'in' | 'out' }]);
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => booksApi.org(orgId).banking.addStatementLines(ledgerId, rows.filter((r) => r.amount).map((r) => ({ date: r.date, description: r.description || 'Statement line', amount: (r.direction === 'out' ? -1 : 1) * toPaise(r.amount) }))),
    onSuccess: () => { toast.push('success', 'Statement lines added.'); onSaved(); }, onError: (e: Error) => setError(e.message),
  });
  return (
    <Modal open title="Add statement lines" onClose={onClose} width="w-[620px]"
      footer={<><Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button><Button variant="primary" size="sm" onClick={() => { setError(null); save.mutate(); }} disabled={save.isPending} data-testid="statement-save">Add lines</Button></>}>
      <div className="space-y-2">
        {rows.map((r, i) => (
          <div key={i} className="grid grid-cols-[130px_minmax(0,1fr)_110px_100px] gap-2">
            <input type="date" value={r.date} onChange={(e) => setRows((rs) => rs.map((x, j) => (i === j ? { ...x, date: e.target.value } : x)))} className={inputCls} />
            <input value={r.description} onChange={(e) => setRows((rs) => rs.map((x, j) => (i === j ? { ...x, description: e.target.value } : x)))} placeholder="Description" className={inputCls} />
            <MoneyInput value={r.amount} onChange={(v) => setRows((rs) => rs.map((x, j) => (i === j ? { ...x, amount: v } : x)))} data-testid={`statement-amount-${i}`} />
            <select value={r.direction} onChange={(e) => setRows((rs) => rs.map((x, j) => (i === j ? { ...x, direction: e.target.value as 'in' | 'out' } : x)))} className={selectCls}><option value="in">Money in</option><option value="out">Money out</option></select>
          </div>
        ))}
        <button type="button" onClick={() => setRows((rs) => [...rs, { date: today(), description: '', amount: '', direction: 'in' }])} className="text-12 text-gold hover:text-gold-hover">+ Add another line</button>
        {error ? <Notice tone="error">{error}</Notice> : <Notice>Type the lines from the bank statement. Automatic statement import is a separate module.</Notice>}
      </div>
    </Modal>
  );
}
