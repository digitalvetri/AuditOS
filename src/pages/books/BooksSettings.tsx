import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { Button } from '@/components/Button';
import { useToast } from '@/components/Toast';
import { Modal } from '@/modules/workstation/components';
import { booksApi } from '@/modules/books/api';
import { Cell, Empty, Field, Money, Notice, Row, Section, Table, inputCls, selectCls, useBooks } from '@/modules/books/components';
import { ROOT_LABEL, bp, today, toPaise } from '@/modules/books/format';
import type { RootCategory } from '@/modules/books/types';

/** /books/:orgId/settings — profile, chart of accounts, taxes, members, currencies. */
export function BooksSettingsPage() {
  const [tab, setTab] = useState<'profile' | 'chart' | 'taxes' | 'members' | 'currency'>('profile');
  const tabs = [['profile', 'Organisation'], ['chart', 'Chart of accounts'], ['taxes', 'Taxes'], ['members', 'Members'], ['currency', 'Currencies']] as const;
  return (
    <div className="space-y-4" data-testid="books-settings">
      <div className="flex flex-wrap gap-1">
        {tabs.map(([id, label]) => (
          <button key={id} type="button" onClick={() => setTab(id)} className={'h-8 px-3 text-13 rounded border ' + (tab === id ? 'bg-neutral-900 text-white border-neutral-900' : 'bg-white text-neutral-700 border-neutral-300 hover:bg-neutral-50')} data-testid={`settings-tab-${id}`}>{label}</button>
        ))}
      </div>
      {tab === 'profile' ? <Profile /> : tab === 'chart' ? <ChartTab /> : tab === 'taxes' ? <TaxesTab /> : tab === 'members' ? <MembersTab /> : <CurrencyTab />}
    </div>
  );
}

function Profile() {
  const { orgId, org } = useBooks();
  const toast = useToast();
  const qc = useQueryClient();
  const [f, setF] = useState({ name: org.name, legal_name: org.legal_name ?? '', gstin: org.gstin ?? '', pan: org.pan ?? '', state_code: org.state_code ?? '', city: org.city ?? '', address_line1: org.address_line1 ?? '', pincode: org.pincode ?? '', tds_enabled: org.tds_enabled });
  const save = useMutation({
    mutationFn: () => booksApi.org(orgId).update({ ...f, gstin: f.gstin || null, pan: f.pan || null, legal_name: f.legal_name || null, state_code: f.state_code || null, city: f.city || null, address_line1: f.address_line1 || null, pincode: f.pincode || null }),
    onSuccess: () => { toast.push('success', 'Saved.'); qc.invalidateQueries({ queryKey: ['books', orgId] }); },
    onError: (e: Error) => toast.push('error', e.message),
  });
  return (
    <Section title="Organisation">
      <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-3 max-w-[720px]">
        <Field label="Name"><input value={f.name} onChange={(e) => setF((x) => ({ ...x, name: e.target.value }))} className={inputCls} data-testid="settings-name" /></Field>
        <Field label="Legal name"><input value={f.legal_name} onChange={(e) => setF((x) => ({ ...x, legal_name: e.target.value }))} className={inputCls} /></Field>
        <Field label="GSTIN"><input value={f.gstin} onChange={(e) => setF((x) => ({ ...x, gstin: e.target.value.toUpperCase() }))} maxLength={15} className={inputCls} /></Field>
        <Field label="PAN"><input value={f.pan} onChange={(e) => setF((x) => ({ ...x, pan: e.target.value.toUpperCase() }))} maxLength={10} className={inputCls} /></Field>
        <Field label="State code" hint="Anchors place-of-supply: same state → CGST + SGST"><input value={f.state_code} onChange={(e) => setF((x) => ({ ...x, state_code: e.target.value }))} maxLength={2} className={inputCls} /></Field>
        <Field label="City"><input value={f.city} onChange={(e) => setF((x) => ({ ...x, city: e.target.value }))} className={inputCls} /></Field>
        <Field label="Address"><input value={f.address_line1} onChange={(e) => setF((x) => ({ ...x, address_line1: e.target.value }))} className={inputCls} /></Field>
        <Field label="PIN code"><input value={f.pincode} onChange={(e) => setF((x) => ({ ...x, pincode: e.target.value }))} className={inputCls} /></Field>
        <label className="flex items-center gap-2 text-13 text-neutral-900 md:col-span-2"><input type="checkbox" checked={f.tds_enabled} onChange={(e) => setF((x) => ({ ...x, tds_enabled: e.target.checked }))} className="accent-[#C8952E]" />Deduct TDS on vendor bills</label>
        <div className="md:col-span-2 flex justify-end"><Button variant="primary" size="sm" onClick={() => save.mutate()} disabled={save.isPending} data-testid="settings-save">{save.isPending ? 'Saving…' : 'Save'}</Button></div>
      </div>
    </Section>
  );
}

function ChartTab() {
  const { orgId } = useBooks();
  const qc = useQueryClient();
  const [root, setRoot] = useState<RootCategory | ''>('');
  const [adding, setAdding] = useState(false);
  const ledgers = useQuery({ queryKey: ['books', orgId, 'ledgers', root], queryFn: () => booksApi.org(orgId).chart.ledgers({ root: root || undefined }) });
  return (
    <>
      <div className="flex items-end gap-2 mb-3">
        <label className="block"><span className="block text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">Category</span>
          <select value={root} onChange={(e) => setRoot(e.target.value as RootCategory | '')} className={`${selectCls} w-[160px]`}>
            <option value="">All</option>{Object.entries(ROOT_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select></label>
        <div className="flex-1" />
        <Button variant="primary" size="sm" onClick={() => setAdding(true)} data-testid="ledger-new"><Plus size={14} strokeWidth={2} className="mr-1" />New ledger</Button>
      </div>
      <Section title="Chart of accounts">
        {ledgers.isLoading ? <div className="h-24 bg-neutral-100" /> : (
          <Table head={['Ledger', 'Group (Tally)', 'Category', { label: 'Opening', align: 'right' }, 'Flags']}>
            {ledgers.data!.items.map((l) => (
              <Row key={l.id}>
                <Cell className="font-medium">{l.name}{l.description ? <div className="text-11 text-neutral-500">{l.description}</div> : null}</Cell>
                <Cell muted>{l.tally_group}</Cell>
                <Cell muted>{ROOT_LABEL[l.root_category]}</Cell>
                <Cell right><Money value={l.opening_balance} zero="—" /></Cell>
                <Cell muted className="text-11">{[l.is_system && 'system', l.bill_wise && 'bill-wise', l.is_bank && 'bank', l.is_cash && 'cash', !l.is_active && 'inactive'].filter(Boolean).join(' · ') || '—'}</Cell>
              </Row>
            ))}
          </Table>
        )}
      </Section>
      {adding ? <LedgerModal orgId={orgId} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); qc.invalidateQueries({ queryKey: ['books', orgId] }); }} /> : null}
    </>
  );
}

function LedgerModal({ orgId, onClose, onSaved }: { orgId: string; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const api = booksApi.org(orgId);
  const groups = useQuery({ queryKey: ['books', orgId, 'groups'], queryFn: () => api.chart.groups() });
  const [f, setF] = useState({ name: '', group_id: '', opening_balance: '', opening_balance_type: 'debit', opening_date: today(), bill_wise: false, bank_name: '', bank_account_no: '', bank_ifsc: '', description: '' });
  const [error, setError] = useState<string | null>(null);
  const group = groups.data?.items.find((g) => g.id === f.group_id);
  const save = useMutation({
    mutationFn: () => api.chart.createLedger({ ...f, opening_balance: toPaise(f.opening_balance || '0'), bank_name: f.bank_name || null, bank_account_no: f.bank_account_no || null, bank_ifsc: f.bank_ifsc || null, description: f.description || null }),
    onSuccess: () => { toast.push('success', 'Ledger created.'); onSaved(); }, onError: (e: Error) => setError(e.message),
  });
  return (
    <Modal open title="New ledger" onClose={onClose} width="w-[560px]"
      footer={<><Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button><Button variant="primary" size="sm" onClick={() => { setError(null); if (!f.name.trim() || !f.group_id) return setError('Name and group are required.'); save.mutate(); }} disabled={save.isPending} data-testid="ledger-save">Create</Button></>}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Name" className="col-span-2"><input value={f.name} onChange={(e) => setF((x) => ({ ...x, name: e.target.value }))} className={inputCls} data-testid="ledger-name" /></Field>
        <Field label="Group" className="col-span-2">
          <select value={f.group_id} onChange={(e) => setF((x) => ({ ...x, group_id: e.target.value }))} className={selectCls} data-testid="ledger-group">
            <option value="">Select…</option>
            {(groups.data?.items ?? []).map((g) => <option key={g.id} value={g.id}>{g.name} · {ROOT_LABEL[g.root_category]}</option>)}
          </select>
        </Field>
        <Field label="Opening balance"><input value={f.opening_balance} onChange={(e) => setF((x) => ({ ...x, opening_balance: e.target.value.replace(/[^\d.]/g, '') }))} className={`${inputCls} text-right tabular-nums`} data-testid="ledger-opening" /></Field>
        <Field label="Dr / Cr"><select value={f.opening_balance_type} onChange={(e) => setF((x) => ({ ...x, opening_balance_type: e.target.value }))} className={selectCls}><option value="debit">Debit</option><option value="credit">Credit</option></select></Field>
        <Field label="Opening date"><input type="date" value={f.opening_date} onChange={(e) => setF((x) => ({ ...x, opening_date: e.target.value }))} className={inputCls} /></Field>
        <label className="flex items-center gap-2 text-13 text-neutral-900 mt-6"><input type="checkbox" checked={f.bill_wise} onChange={(e) => setF((x) => ({ ...x, bill_wise: e.target.checked }))} className="accent-[#C8952E]" />Track bill by bill</label>
        {group?.tally_group === 'Bank Accounts' ? (
          <>
            <Field label="Bank name"><input value={f.bank_name} onChange={(e) => setF((x) => ({ ...x, bank_name: e.target.value }))} className={inputCls} /></Field>
            <Field label="Account number"><input value={f.bank_account_no} onChange={(e) => setF((x) => ({ ...x, bank_account_no: e.target.value }))} className={inputCls} /></Field>
            <Field label="IFSC"><input value={f.bank_ifsc} onChange={(e) => setF((x) => ({ ...x, bank_ifsc: e.target.value.toUpperCase() }))} className={inputCls} /></Field>
          </>
        ) : null}
        <Field label="Description" className="col-span-2"><input value={f.description} onChange={(e) => setF((x) => ({ ...x, description: e.target.value }))} className={inputCls} /></Field>
        {error ? <div className="col-span-2"><Notice tone="error">{error}</Notice></div> : <div className="col-span-2"><Notice>An opening balance posts a dated opening journal against Opening Balance Equity, so reports stay derived from journals.</Notice></div>}
      </div>
    </Modal>
  );
}

function TaxesTab() {
  const { orgId } = useBooks();
  const q = useQuery({ queryKey: ['books', orgId, 'tax-rates', 'all'], queryFn: () => booksApi.org(orgId).taxRates.list() });
  return (
    <Section title="Tax rates">
      {q.isLoading ? <div className="h-24 bg-neutral-100" /> : (
        <Table head={['Name', 'Type', { label: 'Rate', align: 'right' }, { label: 'Without PAN', align: 'right' }, 'Section', 'Status']}>
          {q.data!.items.map((t) => (
            <Row key={t.id}>
              <Cell className="font-medium">{t.name}</Cell><Cell muted className="uppercase">{t.type}</Cell>
              <Cell right muted className="tabular-nums">{bp(t.percentage_bp)}</Cell>
              <Cell right muted className="tabular-nums">{t.no_pan_percentage_bp ? bp(t.no_pan_percentage_bp) : '—'}</Cell>
              <Cell muted>{t.section ?? '—'}</Cell><Cell muted>{t.is_active ? 'Active' : 'Inactive'}</Cell>
            </Row>
          ))}
        </Table>
      )}
      <div className="p-3 border-t border-neutral-200"><Notice>TDS section rates follow the codes in force before the Income-tax Act 2025 takes effect. Review them when the new codes are notified.</Notice></div>
    </Section>
  );
}

function MembersTab() {
  const { orgId } = useBooks();
  const toast = useToast();
  const qc = useQueryClient();
  const api = booksApi.org(orgId);
  const members = useQuery({ queryKey: ['books', orgId, 'members'], queryFn: () => api.members.list() });
  const users = useQuery({ queryKey: ['books', 'firm-users'], queryFn: () => booksApi.firmUsers() });
  const [userId, setUserId] = useState('');
  const [role, setRole] = useState('staff');
  const refresh = () => qc.invalidateQueries({ queryKey: ['books', orgId] });
  const add = useMutation({ mutationFn: () => api.members.set(userId, role), onSuccess: () => { toast.push('success', 'Member added.'); setUserId(''); refresh(); }, onError: (e: Error) => toast.push('error', e.message) });
  const remove = useMutation({ mutationFn: (uid: string) => api.members.remove(uid), onSuccess: () => { toast.push('success', 'Member removed.'); refresh(); }, onError: (e: Error) => toast.push('error', e.message) });

  return (
    <Section title="Who can open these books">
      <div className="p-4 flex flex-wrap items-end gap-2 border-b border-neutral-200">
        <Field label="Staff member"><select value={userId} onChange={(e) => setUserId(e.target.value)} className={`${selectCls} w-[240px]`} data-testid="member-user"><option value="">Select…</option>{(users.data?.items ?? []).map((u) => <option key={u.id} value={u.id}>{u.name} · {u.role}</option>)}</select></Field>
        <Field label="Role"><select value={role} onChange={(e) => setRole(e.target.value)} className={`${selectCls} w-[140px]`}><option value="admin">Admin</option><option value="staff">Staff</option><option value="viewer">Viewer</option></select></Field>
        <Button variant="secondary" size="sm" onClick={() => add.mutate()} disabled={!userId || add.isPending} data-testid="member-add">Add</Button>
      </div>
      {(members.data?.items.length ?? 0) === 0 ? <Empty>Only firm-wide administrators can open these books.</Empty> : (
        <Table head={['Name', 'Email', 'Role', '']}>
          {members.data!.items.map((m) => (
            <Row key={m.id}>
              <Cell className="font-medium">{m.name}</Cell><Cell muted>{m.email ?? '—'}</Cell><Cell muted className="capitalize">{m.role}</Cell>
              <Cell right><button type="button" onClick={() => remove.mutate(m.user_id)} className="text-12 text-neutral-500 hover:text-red">Remove</button></Cell>
            </Row>
          ))}
        </Table>
      )}
      <div className="p-3 border-t border-neutral-200"><Notice>Admin: everything including settings, reports and journals. Staff: day-to-day invoices, bills and payments. Viewer: read only.</Notice></div>
    </Section>
  );
}

function CurrencyTab() {
  const { orgId, org, canAccountant } = useBooks();
  const toast = useToast();
  const qc = useQueryClient();
  const api = booksApi.org(orgId);
  const [f, setF] = useState({ currency: 'USD', date: today(), rate: '' });
  const rates = useQuery({ queryKey: ['books', orgId, 'fx', 'rates'], queryFn: () => api.fx.rates() });
  const exposure = useQuery({ queryKey: ['books', orgId, 'fx', 'exposure', f.currency, f.rate], queryFn: () => api.fx.exposure(f.currency, f.rate ? Number(f.rate) : undefined), enabled: canAccountant && Boolean(f.currency) });
  const revals = useQuery({ queryKey: ['books', orgId, 'fx', 'revaluations'], queryFn: () => api.fx.revaluations(), enabled: canAccountant });
  const refresh = () => qc.invalidateQueries({ queryKey: ['books', orgId] });
  const setRate = useMutation({ mutationFn: () => api.fx.setRate({ currency: f.currency, date: f.date, rate: Number(f.rate) }), onSuccess: () => { toast.push('success', 'Rate saved.'); refresh(); }, onError: (e: Error) => toast.push('error', e.message) });
  const revalue = useMutation({ mutationFn: () => api.fx.revalue({ currency: f.currency, date: f.date, rate: Number(f.rate) }), onSuccess: (r) => { toast.push('success', `Revaluation posted: ${r.revaluation.delta >= 0 ? 'gain' : 'loss'}.`); refresh(); }, onError: (e: Error) => toast.push('error', e.message) });
  const open = exposure.data?.items ?? [];
  const delta = open.reduce((t, b) => t + (b.delta ?? 0), 0);

  return (
    <div className="space-y-4">
      <Section title="Exchange rates">
        <div className="p-4 flex flex-wrap items-end gap-2 border-b border-neutral-200">
          <Field label="Currency"><select value={f.currency} onChange={(e) => setF((x) => ({ ...x, currency: e.target.value }))} className={`${selectCls} w-[110px]`}>{['USD', 'EUR', 'GBP', 'AED', 'SGD'].filter((c) => c !== org.base_currency).map((c) => <option key={c} value={c}>{c}</option>)}</select></Field>
          <Field label="Date"><input type="date" value={f.date} onChange={(e) => setF((x) => ({ ...x, date: e.target.value }))} className={inputCls} /></Field>
          <Field label={`Rate (1 ${f.currency} = ? ${org.base_currency})`}><input value={f.rate} onChange={(e) => setF((x) => ({ ...x, rate: e.target.value.replace(/[^\d.]/g, '') }))} className={`${inputCls} text-right tabular-nums w-[140px]`} data-testid="fx-rate" /></Field>
          <Button variant="secondary" size="sm" onClick={() => setRate.mutate()} disabled={!f.rate || setRate.isPending} data-testid="fx-save">Save rate</Button>
          {canAccountant ? <Button variant="primary" size="sm" onClick={() => revalue.mutate()} disabled={!f.rate || revalue.isPending || open.length === 0} data-testid="fx-revalue">Revalue open items</Button> : null}
        </div>
        {(rates.data?.items.length ?? 0) === 0 ? <Empty>No rates recorded.</Empty> : (
          <Table head={['Currency', 'Date', { label: 'Rate', align: 'right' }]} minWidth={320}>
            {rates.data!.items.slice(0, 20).map((r) => <Row key={r.id}><Cell>{r.currency}</Cell><Cell muted className="tabular-nums">{r.date}</Cell><Cell right muted className="tabular-nums">{r.rate}</Cell></Row>)}
          </Table>
        )}
      </Section>

      {canAccountant ? (
        <Section title={`Open ${f.currency} items${f.rate ? ` at ${f.rate}` : ''}`}>
          {open.length === 0 ? <Empty>No open {f.currency} invoices or bills.</Empty> : (
            <>
              <Table head={['Reference', 'Date', { label: `${f.currency} balance`, align: 'right' }, { label: 'Booked value', align: 'right' }, { label: 'At this rate', align: 'right' }, { label: 'Difference', align: 'right' }]}>
                {open.map((b) => (
                  <Row key={b.id}>
                    <Cell className="font-medium">{b.bill_no}</Cell><Cell muted className="tabular-nums">{b.date}</Cell>
                    <Cell right><Money value={b.fx_balance} currency={b.currency} /></Cell>
                    <Cell right><Money value={b.balance} currency={org.base_currency} /></Cell>
                    <Cell right><Money value={b.revalued ?? 0} currency={org.base_currency} /></Cell>
                    <Cell right><Money value={b.delta ?? 0} currency={org.base_currency} /></Cell>
                  </Row>
                ))}
              </Table>
              {f.rate ? <div className="p-3 border-t border-neutral-200"><Notice tone={delta >= 0 ? 'info' : 'warn'}>Revaluing at {f.rate} books an unrealised {delta >= 0 ? 'gain' : 'loss'} to Exchange Gain / Loss.</Notice></div> : null}
            </>
          )}
        </Section>
      ) : null}

      {canAccountant && (revals.data?.items.length ?? 0) > 0 ? (
        <Section title="Past revaluations">
          <Table head={['Date', 'Currency', { label: 'Rate', align: 'right' }, { label: 'Gain / loss', align: 'right' }]} minWidth={360}>
            {revals.data!.items.map((r) => <Row key={r.id}><Cell muted className="tabular-nums">{r.date}</Cell><Cell>{r.currency}</Cell><Cell right muted className="tabular-nums">{r.rate}</Cell><Cell right><Money value={r.delta} currency={org.base_currency} zero="0" /></Cell></Row>)}
          </Table>
        </Section>
      ) : null}
    </div>
  );
}
