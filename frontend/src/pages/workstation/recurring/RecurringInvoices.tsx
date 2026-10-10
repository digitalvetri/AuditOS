import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { Play, Plus, Trash2, X } from 'lucide-react';
import {
  recurringApi, FREQUENCY_LABEL, MONTH_END, RECURRING_TERM_LABEL,
  type RecurringFrequency, type RecurringInput, type RecurringProfile, type RecurringTerm,
} from '@/modules/workstation/recurring/api';
import { GST_RATES, gstRateLabel } from '@/modules/workstation/invoices/api';
import { STATES, inrAmount, stateName } from '@/modules/workstation/invoices/document';
import { workstationApi } from '@/modules/workstation/api';
import { clientNameWithOrg } from '@/modules/workstation/organization/badges';
import { Field, Modal, QueryState, fieldErrors, inputClass } from '@/modules/workstation/components';
import {
  ListAction, ListCard, ListEmpty, ListHeader, ListRow, ListTable, ListToolbar, Money, SearchBox, Spacer,
  StatusChip, StatusPills, TD, TwoLine, fmtDay,
} from '@/modules/workstation/listUi';
import { Button } from '@/components/Button';
import { useToast } from '@/components/Toast';
import { istToday } from '@/lib/dates';
import { can } from '@/platform/rbac/can';
import { useAuth } from '@/platform/auth/AuthContext';

/**
 * Workstation → Recurring. Retainer profiles that raise an invoice for a
 * client on a schedule — the monthly bookkeeping fee, the quarterly GST
 * retainer, the annual audit fee. The scheduler raises each invoice on its
 * issue date; "Run now" raises the one that is due immediately.
 */

const ACTIVE = [
  { value: '', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'paused', label: 'Paused' },
];

const dayLabel = (d: number) => (d === MONTH_END ? 'Month end' : `Day ${d}`);

/** Profile total per run (display only): Σ (qty × rate − discount) × (1 + GST). */
function runTotal(p: Pick<RecurringProfile, 'lines'>): number {
  return p.lines.reduce((sum, l) => {
    const taxable = Math.max(0, Math.round((l.quantity_centi * l.unit_rate_paise) / 100) - l.discount_paise);
    return sum + taxable + Math.round((taxable * l.gst_rate) / 100);
  }, 0);
}

const link = 'text-13 text-primary hover:underline whitespace-nowrap disabled:opacity-50';

export function RecurringInvoicesPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { session } = useAuth();
  const mayWrite = can(session?.role.code, 'workstation.invoice.manage', 'self');

  const [q, setQ] = useState('');
  const [active, setActive] = useState('');
  const [editing, setEditing] = useState<RecurringProfile | 'new' | null>(null);
  const [deleting, setDeleting] = useState<RecurringProfile | null>(null);

  const list = useQuery({ queryKey: ['recurring.list'], queryFn: () => recurringApi.list() });
  const items = useMemo(() => {
    const all = list.data?.items ?? [];
    const needle = q.trim().toLowerCase();
    return all.filter((p) =>
      (active === '' || (active === 'active') === p.is_active)
      && (!needle || p.name.toLowerCase().includes(needle) || (p.client_name ?? '').toLowerCase().includes(needle)));
  }, [list.data, q, active]);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['recurring.list'] });
    void qc.invalidateQueries({ queryKey: ['invoices.list'] });
    void qc.invalidateQueries({ queryKey: ['invoices.summary'] });
  };
  const run = useMutation({
    mutationFn: (p: RecurringProfile) => recurringApi.run(p.id),
    onSuccess: (r) => {
      refresh();
      if (r.created) toast.push('success', r.invoice_number ? `Invoice ${r.invoice_number} raised.` : 'Draft invoice raised.');
      else toast.push('info', r.reason ?? 'Nothing is due on this profile yet.');
    },
    onError: (e: Error) => toast.push('error', e.message),
  });
  const remove = useMutation({
    mutationFn: (p: RecurringProfile) => recurringApi.remove(p.id),
    onSuccess: () => { setDeleting(null); refresh(); toast.push('success', 'Recurring profile removed. Invoices already raised are kept.'); },
    onError: (e: Error) => toast.push('error', e.message),
  });

  const total = list.data?.items.length;
  const activeCount = list.data?.items.filter((p) => p.is_active).length ?? 0;

  return (
    <div className="max-w-[1400px]">
      <ListHeader
        title="Recurring invoices"
        meta={total === undefined ? 'Loading…' : <>{total} retainer profile{total === 1 ? '' : 's'} · {activeCount} active</>}
        action={mayWrite ? <ListAction onClick={() => setEditing('new')} icon={<Plus size={15} />}>New profile</ListAction> : undefined}
      />

      <ListToolbar>
        <SearchBox value={q} onChange={setQ} placeholder="Profile or client…" />
        <Spacer />
        <StatusPills options={ACTIVE} value={active} onChange={setActive} />
      </ListToolbar>

      <ListCard>
        <QueryState query={list} empty={<ListEmpty>No recurring profiles yet. Create one for each retainer client.</ListEmpty>}>
          {() => items.length === 0 ? <ListEmpty>Nothing matches these filters.</ListEmpty> : (
            <ListTable cols={[
              'Profile', 'Client', 'Frequency', 'Next issue', { label: 'Per invoice', align: 'right' }, 'Last invoice',
              'Auto-send', 'Status', { label: '', key: 'actions' },
            ]}>
              {items.map((p) => (
                <ListRow key={p.id} onOpen={mayWrite ? () => setEditing(p) : undefined}>
                  <TD first strong>{p.name}</TD>
                  <TD><TwoLine avatar={p.client_name} square top={p.client_name || '—'} /></TD>
                  <TD muted nowrap>{FREQUENCY_LABEL[p.frequency] ?? p.frequency} · {dayLabel(p.day_of_month)}</TD>
                  <TD muted nowrap>{p.is_active ? fmtDay(p.next_issue_date) : '—'}</TD>
                  <TD right nowrap className="tabular-nums"><Money value={`₹${inrAmount(runTotal(p))}`} /></TD>
                  <TD nowrap>
                    {p.last_invoice_id ? (
                      <button type="button" className={link}
                        onClick={(e) => { e.stopPropagation(); navigate(`/workstation/invoices/${p.last_invoice_id}`); }}>
                        {p.last_invoice_number ?? 'Draft'}
                      </button>
                    ) : <span className="text-neutral-500">—</span>}
                    {p.invoice_count > 0 ? <span className="text-11 text-neutral-500"> · {p.invoice_count} raised</span> : null}
                  </TD>
                  <TD muted nowrap>{p.auto_send ? 'Yes' : 'No'}</TD>
                  <TD><StatusChip value={p.is_active ? 'active' : 'inactive'} /></TD>
                  <TD last nowrap>
                    {mayWrite ? (
                      <span className="inline-flex items-center gap-3">
                        <button type="button" className={`${link} inline-flex items-center gap-1`} disabled={!p.is_active || run.isPending}
                          title={p.is_active ? 'Raise the invoice that is due now' : 'Paused'}
                          onClick={(e) => { e.stopPropagation(); run.mutate(p); }}>
                          <Play size={13} />Run now
                        </button>
                        <button type="button" aria-label={`Delete ${p.name}`} className="text-neutral-500 hover:text-red"
                          onClick={(e) => { e.stopPropagation(); setDeleting(p); }}>
                          <Trash2 size={14} />
                        </button>
                      </span>
                    ) : null}
                  </TD>
                </ListRow>
              ))}
            </ListTable>
          )}
        </QueryState>
      </ListCard>

      <Modal open={deleting !== null} title={`Delete “${deleting?.name ?? ''}”?`} onClose={() => setDeleting(null)} footer={
        <>
          <Button onClick={() => setDeleting(null)}>Keep it</Button>
          <Button variant="danger" disabled={remove.isPending} onClick={() => deleting && remove.mutate(deleting)}>Delete profile</Button>
        </>
      }>
        <p className="text-13 text-neutral-700">No further invoices are raised from it. Invoices it already raised are not touched.</p>
      </Modal>

      {editing ? (
        <ProfileModal profile={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refresh(); }} />
      ) : null}
    </div>
  );
}

interface EditLine { key: string; description: string; sac: string; qty: string; rate: string; gst: number; discount: string }
let seq = 0;
const blankLine = (): EditLine => ({ key: `rl${++seq}`, description: '', sac: '998222', qty: '1', rate: '', gst: 18, discount: '' });
const toPaise = (v: string) => Math.max(0, Math.round((Number(v) || 0) * 100));
const toCenti = (v: string) => Math.max(0, Math.round((Number(v) || 0) * 100));

function ProfileModal({ profile, onClose, onSaved }: { profile: RecurringProfile | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const clientsQ = useQuery({ queryKey: ['invoices.clients'], queryFn: () => workstationApi.listClients() });

  const [clientId, setClientId] = useState(profile?.client_id ?? '');
  const [name, setName] = useState(profile?.name ?? '');
  const [frequency, setFrequency] = useState<RecurringFrequency>(profile?.frequency ?? 'monthly');
  const [day, setDay] = useState(profile?.day_of_month ?? 1);
  const [start, setStart] = useState(profile?.start_date?.slice(0, 10) ?? istToday());
  const [end, setEnd] = useState(profile?.end_date?.slice(0, 10) ?? '');
  const [terms, setTerms] = useState<RecurringTerm>(profile?.terms ?? 'net_15');
  const [pos, setPos] = useState(stateName(profile?.place_of_supply ?? 'Tamil Nadu'));
  const [autoSend, setAutoSend] = useState(profile?.auto_send ?? false);
  const [isActive, setIsActive] = useState(profile?.is_active ?? true);
  const [lines, setLines] = useState<EditLine[]>(() => profile?.lines.length
    ? profile.lines.map((l) => ({
        key: `rl${++seq}`, description: l.description, sac: l.sac_code ?? '', qty: String(l.quantity_centi / 100),
        rate: String(l.unit_rate_paise / 100), gst: l.gst_rate, discount: l.discount_paise ? String(l.discount_paise / 100) : '',
      }))
    : [blankLine()]);

  // A client picked for a new profile suggests the name.
  useEffect(() => {
    if (profile || name || !clientId) return;
    const c = clientsQ.data?.items.find((x) => x.id === clientId);
    if (c) setName(`${c.company_name} — ${FREQUENCY_LABEL[frequency].toLowerCase()} retainer`);
  }, [clientId]); // eslint-disable-line react-hooks/exhaustive-deps

  const setLine = (key: string, patch: Partial<EditLine>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const body = (): RecurringInput => ({
    client_id: clientId,
    name: name.trim(),
    frequency,
    day_of_month: day,
    start_date: start,
    end_date: end || null,
    terms,
    place_of_supply: pos || null,
    client_service_id: profile?.client_service_id ?? null,
    lines: lines.map((l) => ({
      description: l.description.trim(), sac_code: l.sac.trim() || null, quantity_centi: toCenti(l.qty),
      unit_rate_paise: toPaise(l.rate), gst_rate: l.gst, discount_paise: toPaise(l.discount),
    })),
    auto_send: autoSend,
    is_active: isActive,
  });
  const save = useMutation({
    mutationFn: () => (profile ? recurringApi.update(profile.id, body()) : recurringApi.create(body())),
    onSuccess: () => { toast.push('success', profile ? 'Recurring profile updated.' : 'Recurring profile created.'); onSaved(); },
    onError: (e: Error) => toast.push('error', e.message),
  });
  const errs = fieldErrors(save.error);
  const preview = runTotal({ lines: body().lines.map((l) => ({ ...l, sac_code: l.sac_code ?? null })) });
  const valid = clientId && name.trim() && start && lines.length > 0
    && lines.every((l) => l.description.trim() && toCenti(l.qty) > 0 && toPaise(l.rate) > 0);

  return (
    <Modal open title={profile ? `Edit ${profile.name}` : 'New recurring profile'} onClose={onClose} width="w-[960px]" footer={
      <>
        <span className="text-13 text-neutral-500 mr-auto">Each invoice ≈ <b className="text-neutral-900 tabular-nums">₹ {inrAmount(preview)}</b> incl. GST</span>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!valid || save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : 'Save'}</Button>
      </>
    }>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Client" error={errs.client_id}>
          <select className={inputClass} value={clientId} onChange={(e) => setClientId(e.target.value)} disabled={!clientsQ.data}>
            <option value="">{clientsQ.data ? 'Choose a client…' : 'Loading clients…'}</option>
            {(clientsQ.data?.items ?? []).map((c) => <option key={c.id} value={c.id}>{clientNameWithOrg(c)}</option>)}
          </select>
        </Field>
        <Field label="Profile name" error={errs.name}>
          <input className={inputClass} value={name} maxLength={200} onChange={(e) => setName(e.target.value)} placeholder="e.g. Monthly bookkeeping retainer" />
        </Field>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Field label="Frequency" error={errs.frequency}>
          <select className={inputClass} value={frequency} onChange={(e) => setFrequency(e.target.value as RecurringFrequency)}>
            {(Object.keys(FREQUENCY_LABEL) as RecurringFrequency[]).map((f) => <option key={f} value={f}>{FREQUENCY_LABEL[f]}</option>)}
          </select>
        </Field>
        <Field label="Issue on" error={errs.day_of_month}>
          <select className={inputClass} value={day} onChange={(e) => setDay(Number(e.target.value))}>
            {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>Day {d}</option>)}
            <option value={MONTH_END}>Month end</option>
          </select>
        </Field>
        <Field label="Start date" error={errs.start_date}>
          <input className={inputClass} type="date" value={start} onChange={(e) => setStart(e.target.value)} />
        </Field>
        <Field label="End date (optional)" error={errs.end_date}>
          <input className={inputClass} type="date" value={end} min={start} onChange={(e) => setEnd(e.target.value)} />
        </Field>
        <Field label="Terms" error={errs.terms}>
          <select className={inputClass} value={terms} onChange={(e) => setTerms(e.target.value as RecurringTerm)}>
            {(Object.keys(RECURRING_TERM_LABEL) as RecurringTerm[]).map((t) => <option key={t} value={t}>{RECURRING_TERM_LABEL[t]}</option>)}
          </select>
        </Field>
        <Field label="Place of supply" error={errs.place_of_supply}>
          <select className={inputClass} value={pos} onChange={(e) => setPos(e.target.value)}>
            {STATES.map((s) => <option key={s.code} value={s.name}>{s.name} ({s.code})</option>)}
          </select>
        </Field>
        <label className="flex items-center gap-2 text-13 text-neutral-700 md:mt-6 mb-3">
          <input type="checkbox" checked={autoSend} onChange={(e) => setAutoSend(e.target.checked)} />
          Auto-send (issue &amp; email)
        </label>
        <label className="flex items-center gap-2 text-13 text-neutral-700 md:mt-6 mb-3">
          <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
          Active
        </label>
      </div>
      <p className="text-12 text-neutral-500 -mt-1 mb-3">
        {autoSend
          ? 'Each invoice is numbered and emailed to the client on its issue date.'
          : 'Each invoice is raised as a draft for you to review and send.'}
        {profile?.next_issue_date ? ` Next issue: ${fmtDay(profile.next_issue_date)}.` : ''}
      </p>

      <div className="flex items-center mb-2">
        <span className="text-13 font-semibold text-neutral-900 flex-1">Lines</span>
        <button type="button" onClick={() => setLines((ls) => [...ls, blankLine()])} className="inline-flex items-center gap-1 text-13 text-primary hover:underline">
          <Plus size={14} />Add line
        </button>
      </div>
      {errs.lines ? <p className="text-12 text-red mb-2">{errs.lines}</p> : null}
      <div className="space-y-3">
        {lines.map((l, i) => (
          <div key={l.key} className="grid grid-cols-2 md:grid-cols-12 gap-2 items-end pb-3 border-b border-neutral-100 last:border-b-0">
            <label className="col-span-2 md:col-span-4 block">
              <span className="block text-12 font-medium text-neutral-500 mb-1">Description {i + 1}</span>
              <input className={inputClass} value={l.description} maxLength={500} onChange={(e) => setLine(l.key, { description: e.target.value })} />
            </label>
            <label className="md:col-span-2 block">
              <span className="block text-12 font-medium text-neutral-500 mb-1">SAC</span>
              <input className={inputClass} value={l.sac} maxLength={10} inputMode="numeric" onChange={(e) => setLine(l.key, { sac: e.target.value })} />
            </label>
            <label className="md:col-span-1 block">
              <span className="block text-12 font-medium text-neutral-500 mb-1">Qty</span>
              <input className={inputClass} type="number" step="0.01" min="0" value={l.qty} onChange={(e) => setLine(l.key, { qty: e.target.value })} />
            </label>
            <label className="md:col-span-2 block">
              <span className="block text-12 font-medium text-neutral-500 mb-1">Rate (₹)</span>
              <input className={inputClass} type="number" step="0.01" min="0" value={l.rate} onChange={(e) => setLine(l.key, { rate: e.target.value })} />
            </label>
            <label className="md:col-span-1 block">
              <span className="block text-12 font-medium text-neutral-500 mb-1">GST %</span>
              <select className={inputClass} value={l.gst} onChange={(e) => setLine(l.key, { gst: Number(e.target.value) })}>
                {GST_RATES.map((r) => <option key={r} value={r}>{gstRateLabel(r)}</option>)}
              </select>
            </label>
            <label className="md:col-span-1 block">
              <span className="block text-12 font-medium text-neutral-500 mb-1">Disc. ₹</span>
              <input className={inputClass} type="number" step="0.01" min="0" value={l.discount} placeholder="0" onChange={(e) => setLine(l.key, { discount: e.target.value })} />
            </label>
            <div className="md:col-span-1 flex items-center justify-end h-9">
              <button type="button" aria-label="Remove line" disabled={lines.length === 1}
                onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                className="h-8 w-8 inline-flex items-center justify-center rounded text-neutral-500 hover:text-red disabled:opacity-50"><X size={14} /></button>
            </div>
          </div>
        ))}
      </div>
      {profile?.last_invoice_id ? (
        <p className="text-12 text-neutral-500 mt-3">
          Last raised: <Link to={`/workstation/invoices/${profile.last_invoice_id}`} className="text-primary hover:underline">{profile.last_invoice_number ?? 'Draft'}</Link>
          {profile.last_generated_at ? ` on ${fmtDay(profile.last_generated_at)}` : ''}. Changes apply to invoices raised from now on.
        </p>
      ) : null}
    </Modal>
  );
}
