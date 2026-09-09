import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, X } from 'lucide-react';
import { Button } from '@/components/Button';
import { StatusLabel } from '@/components/StatusRow';
import { useToast } from '@/components/Toast';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { Modal } from '@/modules/workstation/components';
import { booksApi } from '@/modules/books/api';
import { Cell, Empty, Field, Money, MoneyInput, Notice, Row, Section, Table, inputCls, selectCls, useBooks } from '@/modules/books/components';
import { journalStatus, money, today, toPaise, VOUCHER_LABEL } from '@/modules/books/format';

/** /books/:orgId/journals — every posting, and the manual journal editor. */
export function BooksJournalsPage() {
  const { orgId, canAccountant } = useBooks();
  const qc = useQueryClient();
  const [f, setF] = useState({ status: '', voucher_type: '', q: '' });
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const journals = useQuery({ queryKey: ['books', orgId, 'journals', f], queryFn: () => booksApi.org(orgId).journals.list(f) });
  const refresh = () => qc.invalidateQueries({ queryKey: ['books', orgId] });

  return (
    <div className="space-y-4" data-testid="books-journals">
      <div className="flex flex-wrap items-end gap-2">
        <label className="block"><span className="block text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">Search</span>
          <input value={f.q} onChange={(e) => setF((x) => ({ ...x, q: e.target.value }))} placeholder="Number or narration" className={`${inputCls} w-[200px]`} /></label>
        <label className="block"><span className="block text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">Status</span>
          <select value={f.status} onChange={(e) => setF((x) => ({ ...x, status: e.target.value }))} className={`${selectCls} w-[130px]`}><option value="">All</option><option value="draft">Draft</option><option value="posted">Posted</option><option value="void">Void</option></select></label>
        <label className="block"><span className="block text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">Type</span>
          <select value={f.voucher_type} onChange={(e) => setF((x) => ({ ...x, voucher_type: e.target.value }))} className={`${selectCls} w-[180px]`}>
            <option value="">All</option>{Object.entries(VOUCHER_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select></label>
        <div className="flex-1" />
        {canAccountant ? <Button variant="primary" size="sm" onClick={() => setEditing('new')} data-testid="journal-new"><Plus size={14} strokeWidth={2} className="mr-1" />Manual journal</Button> : null}
      </div>

      <Section title="Journals">
        {journals.isLoading ? <div className="h-24 bg-neutral-100" /> : (journals.data?.items.length ?? 0) === 0 ? <Empty>Nothing posted yet.</Empty> : (
          <Table head={['Number', 'Date', 'Type', 'Narration', { label: 'Amount', align: 'right' }, 'Status']}>
            {journals.data!.items.map((j) => (
              <Row key={j.id} onClick={() => setOpen(j.id)} border={j.status === 'void' ? 'red' : j.status === 'draft' ? 'neutral' : null} muted={j.status === 'void'}>
                <Cell className="font-medium whitespace-nowrap">{j.number}</Cell>
                <Cell muted className="whitespace-nowrap tabular-nums">{fmtDate(`${j.date}T00:00:00Z`)}</Cell>
                <Cell muted className="whitespace-nowrap">{VOUCHER_LABEL[j.voucher_type] ?? j.voucher_type}</Cell>
                <Cell muted className="max-w-[280px] truncate">{j.narration ?? '—'}</Cell>
                <Cell right><Money value={j.total_debit} zero="0" /></Cell>
                <Cell><StatusLabel {...journalStatus(j.status)} /></Cell>
              </Row>
            ))}
          </Table>
        )}
      </Section>

      {editing ? <JournalEditor orgId={orgId} journalId={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refresh(); }} /> : null}
      {open ? <JournalDrawer orgId={orgId} id={open} canAccountant={canAccountant} onClose={() => setOpen(null)} onChanged={refresh} onEdit={(id) => { setOpen(null); setEditing(id); }} /> : null}
    </div>
  );
}

interface LineDraft { key: string; ledger_id: string; side: 'debit' | 'credit'; amount: string; description: string }
let seq = 0;
const line = (side: 'debit' | 'credit' = 'debit'): LineDraft => ({ key: `jl${++seq}`, ledger_id: '', side, amount: '', description: '' });

function JournalEditor({ orgId, journalId, onClose, onSaved }: { orgId: string; journalId: string | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const api = booksApi.org(orgId);
  const [date, setDate] = useState(today());
  const [narration, setNarration] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([line('debit'), line('credit')]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const ledgers = useQuery({ queryKey: ['books', orgId, 'ledgers', 'all'], queryFn: () => api.chart.ledgers() });
  const existing = useQuery({ queryKey: ['books', orgId, 'journal', journalId], queryFn: () => api.journals.get(journalId!), enabled: Boolean(journalId) });
  if (existing.data && !loaded) {
    setDate(existing.data.date); setNarration(existing.data.narration ?? '');
    setLines((existing.data.lines ?? []).map((l) => ({ key: l.id, ledger_id: l.ledger_id, side: l.side, amount: (l.amount / 100).toFixed(2), description: l.description ?? '' })));
    setLoaded(true);
  }

  const totals = useMemo(() => {
    const d = lines.filter((l) => l.side === 'debit').reduce((t, l) => t + toPaise(l.amount || '0'), 0);
    const c = lines.filter((l) => l.side === 'credit').reduce((t, l) => t + toPaise(l.amount || '0'), 0);
    return { debit: d, credit: c, diff: d - c };
  }, [lines]);

  const payload = () => ({ date, narration: narration || null, lines: lines.filter((l) => l.ledger_id && toPaise(l.amount || '0') > 0).map((l) => ({ ledger_id: l.ledger_id, side: l.side, amount: toPaise(l.amount), description: l.description || null })) });
  const saveDraft = useMutation({ mutationFn: () => (journalId ? api.journals.update(journalId, payload()) : api.journals.create({ ...payload(), draft: true })), onSuccess: () => { toast.push('success', 'Draft saved.'); onSaved(); }, onError: (e: Error) => setError(e.message) });
  const postNow = useMutation({
    mutationFn: async () => { const j = journalId ? await api.journals.update(journalId, payload()) : await api.journals.create({ ...payload(), draft: true }); return api.journals.post(j.id); },
    onSuccess: (j) => { toast.push('success', `Journal ${j.number} posted.`); onSaved(); }, onError: (e: Error) => setError(e.message),
  });

  const set = (key: string, patch: Partial<LineDraft>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  return (
    <Modal open title={journalId ? 'Edit draft journal' : 'Manual journal'} onClose={onClose} width="w-[760px]"
      footer={<>
        <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
        <Button variant="secondary" size="sm" onClick={() => { setError(null); saveDraft.mutate(); }} disabled={saveDraft.isPending} data-testid="journal-save-draft">Save draft</Button>
        <Button variant="primary" size="sm" onClick={() => { setError(null); if (totals.diff !== 0) return setError('Debits and credits must be equal before posting.'); postNow.mutate(); }} disabled={postNow.isPending || totals.debit === 0} data-testid="journal-post">{postNow.isPending ? 'Posting…' : 'Post'}</Button>
      </>}>
      <div className="space-y-3">
        <div className="grid grid-cols-3 gap-3">
          <Field label="Date"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={inputCls} /></Field>
          <Field label="Narration" className="col-span-2"><input value={narration} onChange={(e) => setNarration(e.target.value)} className={inputCls} placeholder="Depreciation for May, rent accrual…" data-testid="journal-narration" /></Field>
        </div>

        <div className="border border-neutral-200 rounded overflow-x-auto">
          <table className="w-full border-collapse" style={{ minWidth: 640 }}>
            <thead><tr className="border-b border-neutral-200">{['Account', 'Dr / Cr', 'Amount', 'Description', ''].map((h) => <th key={h} className="h-8 px-2 text-11 uppercase tracking-[0.06em] font-medium text-neutral-500 text-left">{h}</th>)}</tr></thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={l.key} className="border-b border-neutral-200 last:border-0">
                  <td className="px-2 py-1 min-w-[220px]">
                    <select value={l.ledger_id} onChange={(e) => set(l.key, { ledger_id: e.target.value })} className={selectCls} data-testid={`journal-ledger-${i}`}>
                      <option value="">Select account…</option>
                      {(ledgers.data?.items ?? []).map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                    </select>
                  </td>
                  <td className="px-2 py-1 w-[110px]">
                    <select value={l.side} onChange={(e) => set(l.key, { side: e.target.value as 'debit' | 'credit' })} className={selectCls}><option value="debit">Debit</option><option value="credit">Credit</option></select>
                  </td>
                  <td className="px-2 py-1 w-[130px]"><MoneyInput value={l.amount} onChange={(v) => set(l.key, { amount: v })} data-testid={`journal-amount-${i}`} /></td>
                  <td className="px-2 py-1"><input value={l.description} onChange={(e) => set(l.key, { description: e.target.value })} className={inputCls} /></td>
                  <td className="px-1 py-1"><button type="button" onClick={() => setLines((ls) => (ls.length <= 2 ? ls : ls.filter((x) => x.key !== l.key)))} className="text-neutral-400 hover:text-red" aria-label="Remove"><X size={14} /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
          <button type="button" onClick={() => setLines((ls) => [...ls, line()])} className="inline-flex items-center gap-1 h-8 px-3 text-12 text-neutral-700 hover:text-neutral-900"><Plus size={14} strokeWidth={2} />Add line</button>
        </div>

        <div className="flex flex-wrap items-center gap-6 text-13 bg-neutral-50 border border-neutral-200 rounded px-3 py-2">
          <span className="text-neutral-500">Debits <Money value={totals.debit} bold zero="0" /></span>
          <span className="text-neutral-500">Credits <Money value={totals.credit} bold zero="0" /></span>
          <span className={totals.diff === 0 ? 'text-neutral-500' : 'text-red font-medium'}>Difference {money(Math.abs(totals.diff))}</span>
        </div>

        {error ? <Notice tone="error">{error}</Notice> : <Notice>A journal can be saved unbalanced as a draft, but the ledger will refuse to post it until debits equal credits.</Notice>}
      </div>
    </Modal>
  );
}

function JournalDrawer({ orgId, id, canAccountant, onClose, onChanged, onEdit }: { orgId: string; id: string; canAccountant: boolean; onClose: () => void; onChanged: () => void; onEdit: (id: string) => void }) {
  const toast = useToast();
  const api = booksApi.org(orgId);
  const [reason, setReason] = useState('');
  const [confirm, setConfirm] = useState(false);
  const q = useQuery({ queryKey: ['books', orgId, 'journal', id], queryFn: () => api.journals.get(id) });
  const post = useMutation({ mutationFn: () => api.journals.post(id), onSuccess: () => { toast.push('success', 'Journal posted.'); onChanged(); }, onError: (e: Error) => toast.push('error', e.message) });
  const voidIt = useMutation({ mutationFn: () => api.journals.void(id, reason || undefined), onSuccess: () => { toast.push('success', 'Journal voided with a reversing entry.'); setConfirm(false); onChanged(); onClose(); }, onError: (e: Error) => toast.push('error', e.message) });
  const j = q.data;

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/[0.16]" onClick={onClose} aria-hidden />
      <aside className="fixed inset-y-0 right-0 z-50 w-full sm:w-[520px] bg-white border-l border-neutral-200 shadow-drawer flex flex-col" role="dialog" data-testid="journal-drawer">
        <div className="h-12 px-4 flex items-center border-b border-neutral-200">
          <span className="text-13 font-medium text-neutral-900">{j?.number ?? 'Journal'}</span>
          {j ? <span className="ml-2"><StatusLabel {...journalStatus(j.status)} /></span> : null}
          <div className="flex-1" />
          <button type="button" onClick={onClose} aria-label="Close" className="w-8 h-8 inline-flex items-center justify-center text-neutral-500 hover:text-neutral-900"><X size={16} /></button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
          {q.isLoading ? <div className="h-32 bg-neutral-100 rounded" /> : !j ? <Empty>Not found.</Empty> : (
            <>
              <dl className="grid grid-cols-[110px_minmax(0,1fr)] gap-y-1.5 text-13">
                <dt className="text-neutral-500">Date</dt><dd className="text-neutral-900 tabular-nums">{fmtDate(`${j.date}T00:00:00Z`)}</dd>
                <dt className="text-neutral-500">Type</dt><dd className="text-neutral-900">{VOUCHER_LABEL[j.voucher_type] ?? j.voucher_type}</dd>
                <dt className="text-neutral-500">Narration</dt><dd className="text-neutral-900">{j.narration ?? '—'}</dd>
                {j.reverses_journal_id ? <><dt className="text-neutral-500">Reverses</dt><dd className="text-neutral-900">another journal</dd></> : null}
                {j.voided_by_journal_id ? <><dt className="text-neutral-500">Voided by</dt><dd className="text-neutral-900">a reversing journal</dd></> : null}
              </dl>
              <Table head={['Account', { label: 'Debit', align: 'right' }, { label: 'Credit', align: 'right' }]} minWidth={360}>
                {(j.lines ?? []).map((l) => (
                  <Row key={l.id}>
                    <Cell>{l.ledger?.name ?? l.ledger_id}{l.description ? <div className="text-11 text-neutral-500">{l.description}</div> : null}</Cell>
                    <Cell right><Money value={l.side === 'debit' ? l.amount : 0} /></Cell>
                    <Cell right><Money value={l.side === 'credit' ? l.amount : 0} /></Cell>
                  </Row>
                ))}
                <Row><Cell className="font-medium">Total</Cell><Cell right><Money value={j.total_debit} bold zero="0" /></Cell><Cell right><Money value={j.total_credit} bold zero="0" /></Cell></Row>
              </Table>
              <section>
                <h3 className="text-11 uppercase tracking-[0.06em] text-neutral-500 mb-2">Audit trail</h3>
                <ol className="space-y-1.5">{(j.audit ?? []).map((e) => <li key={e.id} className="text-13"><div className="text-neutral-900">{e.action.replace(/[._]/g, ' ')}</div><div className="text-12 text-neutral-500 tabular-nums">{fmtDateTime(e.created_at)}</div></li>)}</ol>
              </section>
            </>
          )}
        </div>
        {j && canAccountant ? (
          <div className="px-4 py-3 border-t border-neutral-200">
            {confirm ? (
              <div className="space-y-2">
                <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason" className={inputCls} />
                <div className="flex justify-end gap-2"><Button variant="ghost" size="sm" onClick={() => setConfirm(false)}>Cancel</Button><Button variant="danger" size="sm" onClick={() => voidIt.mutate()} disabled={voidIt.isPending} data-testid="journal-void-confirm">Void journal</Button></div>
              </div>
            ) : (
              <div className="flex justify-end gap-2">
                {j.status === 'draft' ? <><Button variant="secondary" size="sm" onClick={() => onEdit(j.id)}>Edit</Button><Button variant="primary" size="sm" onClick={() => post.mutate()} disabled={post.isPending}>Post</Button></> : null}
                {j.status === 'posted' ? <Button variant="danger" size="sm" onClick={() => setConfirm(true)} data-testid="journal-void">Void</Button> : null}
              </div>
            )}
          </div>
        ) : null}
      </aside>
    </>
  );
}
