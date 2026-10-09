import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useAuth } from '@/platform/auth/AuthContext';
import { can } from '@/platform/rbac/can';
import { useToast } from '@/components/Toast';
import { Button } from '@/components/Button';
import { istToday } from '@/modules/dashboardV2/brief';
import { Modal, QueryState, fieldErrors } from '@/modules/workstation/components';
import {
  FilterSelect, ListAction, ListCard, ListEmpty, ListHeader, ListRow, ListTable, ListToolbar, SearchBox, TD,
  TogglePill, TwoLine,
} from '@/modules/workstation/listUi';
import { Chip, Labelled, day, daysUntil, errorText, fieldClass, smallBtn, useClientOptions } from '@/modules/compliance/ui';
import {
  DSC_CLASSES, DSC_CUSTODY, DSC_ROLES, DSC_USAGES, dscApi, dscKeys, type Dsc, type DscInput,
} from '@/modules/dsc/api';
import { confirmAction } from '@/components/ConfirmDialog';

const labelOf = (opts: { value: string; label: string }[], v: string | null | undefined) =>
  v ? opts.find((o) => o.value === v)?.label ?? v : '—';

/** Expired / ≤7 / ≤15 / ≤30 days, else the plain date is enough. */
export function ExpiryChip({ days }: { days: number | null }) {
  if (days === null) return null;
  if (days < 0) return <Chip tone="red">Expired</Chip>;
  if (days <= 7) return <Chip tone="red">{days === 0 ? 'Expires today' : `${days}d left`}</Chip>;
  if (days <= 15) return <Chip tone="amber">{days}d left</Chip>;
  if (days <= 30) return <Chip tone="blue">{days}d left</Chip>;
  return null;
}

/** DSC register — every digital signature the firm tracks, with expiry alerts. */
export function DscRegisterPage() {
  const { session } = useAuth();
  const role = session?.role.code;
  const canManage = can(role, 'workstation.dsc.manage', 'self');
  const canRead = canManage || can(role, 'workstation.dsc.read', 'self');
  const qc = useQueryClient();
  const toast = useToast();
  const today = istToday();

  const [params, setParams] = useSearchParams();
  const expiring = params.get('expiring') === '30';
  const client = params.get('client') ?? '';
  const setParam = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v); else next.delete(k);
    setParams(next, { replace: true });
  };
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<Dsc | 'new' | null>(null);

  const filters = { client_id: client || undefined, expiring_within_days: expiring ? 30 : undefined };
  const list = useQuery({ queryKey: dscKeys.list(filters), queryFn: () => dscApi.list(filters), enabled: canRead });
  const clients = useClientOptions(canRead);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (list.data ?? [])
      .filter((d) => !needle || [d.holder_name, d.holder_pan, d.client_name, d.provider, d.token_serial].some((x) => (x ?? '').toLowerCase().includes(needle)))
      .sort((a, b) => a.expiry_date.localeCompare(b.expiry_date));
  }, [list.data, q]);

  const remove = useMutation({
    mutationFn: (id: string) => dscApi.remove(id),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: dscKeys.all }); toast.push('success', 'DSC removed'); },
    onError: (e) => toast.push('error', errorText(e)),
  });

  if (!canRead) {
    return <div className="max-w-[1400px]"><ListHeader title="DSC register" /><ListCard><ListEmpty>You do not have access to the DSC register.</ListEmpty></ListCard></div>;
  }

  return (
    <div className="max-w-[1400px]">
      <ListHeader
        title="DSC register"
        meta="Digital signatures of clients' directors and partners and the firm's own — alerts go out 30, 15 and 7 days before expiry."
        action={canManage ? <ListAction onClick={() => setEditing('new')} icon={<Plus size={15} />}>Add DSC</ListAction> : undefined}
      />
      <ListToolbar>
        <SearchBox value={q} onChange={setQ} placeholder="Holder, PAN, provider, serial" />
        <FilterSelect label="Client" value={client} onChange={(v) => setParam('client', v)} options={clients.options} />
        <TogglePill on={expiring} onChange={(v) => setParam('expiring', v ? '30' : '')}>Expiring in 30 days</TogglePill>
      </ListToolbar>
      <QueryState query={list}>
        {() => rows.length ? (
          <ListCard>
            <ListTable cols={['Holder', 'Client', 'Role', 'Class', 'Provider / token', 'Expiry', 'Custody', '']}>
              {rows.map((d) => {
                const days = d.days_left ?? daysUntil(d.expiry_date, today);
                return (
                  <ListRow key={d.id}>
                    <TD first><TwoLine top={d.holder_name} sub={d.holder_pan ?? undefined} /></TD>
                    <TD>{d.client_name ?? (d.client_id ? '—' : <span className="text-neutral-500">Firm</span>)}</TD>
                    <TD muted>{labelOf(DSC_ROLES, d.holder_role)}</TD>
                    <TD nowrap muted>{labelOf(DSC_CLASSES, d.dsc_class)}{d.usage ? ` · ${labelOf(DSC_USAGES, d.usage)}` : ''}</TD>
                    <TD><TwoLine top={d.provider ?? '—'} sub={d.token_serial ?? undefined} /></TD>
                    <TD nowrap>
                      <span className="flex flex-col items-start gap-0.5">
                        <span>{day(d.expiry_date)}</span>
                        <ExpiryChip days={days} />
                      </span>
                    </TD>
                    <TD>
                      <Chip tone={d.custody === 'with_firm' ? 'blue' : 'grey'} dot={false}>{labelOf(DSC_CUSTODY, d.custody)}</Chip>
                    </TD>
                    <TD last>
                      {canManage ? (
                        <div className="flex items-center justify-end gap-1">
                          <button type="button" className={smallBtn} onClick={() => setEditing(d)}><Pencil size={13} /> Edit</button>
                          <button type="button" className={smallBtn} aria-label="Delete DSC" disabled={remove.isPending}
                            onClick={async () => { if (await confirmAction(`Remove ${d.holder_name}'s DSC from the register?`)) remove.mutate(d.id); }}>
                            <Trash2 size={13} />
                          </button>
                        </div>
                      ) : null}
                    </TD>
                  </ListRow>
                );
              })}
            </ListTable>
          </ListCard>
        ) : <ListCard><ListEmpty>{expiring ? 'No DSC expires in the next 30 days.' : 'No DSCs recorded yet.'}</ListEmpty></ListCard>}
      </QueryState>
      {editing ? <DscForm dsc={editing === 'new' ? null : editing} clients={clients.options} onClose={() => setEditing(null)} /> : null}
    </div>
  );
}

function DscForm({ dsc, clients, onClose }: { dsc: Dsc | null; clients: { value: string; label: string }[]; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState({
    client_id: dsc?.client_id ?? '',
    holder_name: dsc?.holder_name ?? '',
    holder_pan: dsc?.holder_pan ?? '',
    holder_role: dsc?.holder_role ?? 'director',
    dsc_class: dsc?.dsc_class ?? 'class3',
    usage: dsc?.usage ?? 'signing',
    provider: dsc?.provider ?? '',
    token_serial: dsc?.token_serial ?? '',
    valid_from: dsc?.valid_from ?? '',
    expiry_date: dsc?.expiry_date ?? '',
    custody: dsc?.custody ?? 'with_client',
    notes: dsc?.notes ?? '',
  });
  const up = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }));
  const save = useMutation({
    mutationFn: () => {
      const body: Partial<DscInput> = {
        client_id: f.client_id || null,
        holder_name: f.holder_name.trim(),
        holder_pan: f.holder_pan.trim().toUpperCase() || null,
        holder_role: f.holder_role || null,
        dsc_class: f.dsc_class,
        usage: f.usage,
        provider: f.provider.trim() || null,
        token_serial: f.token_serial.trim() || null,
        valid_from: f.valid_from || null,
        expiry_date: f.expiry_date,
        custody: f.custody,
        notes: f.notes.trim() || null,
      };
      return dsc ? dscApi.update(dsc.id, body) : dscApi.create(body);
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: dscKeys.all }); toast.push('success', dsc ? 'DSC updated' : 'DSC added'); onClose(); },
    onError: (e) => toast.push('error', errorText(e)),
  });
  const errs = fieldErrors(save.error);
  const sel = (k: keyof typeof f, opts: { value: string; label: string }[]) => (
    <select className={fieldClass} value={f[k]} onChange={up(k)}>
      {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
  return (
    <Modal open title={dsc ? 'Edit DSC' : 'Add DSC'} onClose={onClose} width="w-[640px]"
      footer={<>
        <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
        <Button size="sm" variant="primary" disabled={!f.holder_name.trim() || !f.expiry_date || save.isPending} onClick={() => save.mutate()}>Save</Button>
      </>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Labelled label="Holder name" hint={errs.holder_name}>
          <input className={fieldClass} value={f.holder_name} onChange={up('holder_name')} />
        </Labelled>
        <Labelled label="Holder PAN" hint={errs.holder_pan}>
          <input className={fieldClass} value={f.holder_pan} onChange={up('holder_pan')} maxLength={10} placeholder="ABCDE1234F" />
        </Labelled>
        <Labelled label="Client" hint={errs.client_id ?? 'Leave empty for the firm’s own DSC.'}>
          <select className={fieldClass} value={f.client_id} onChange={up('client_id')}>
            <option value="">Firm (no client)</option>
            {clients.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
        </Labelled>
        <Labelled label="Role">{sel('holder_role', DSC_ROLES)}</Labelled>
        <Labelled label="Class">{sel('dsc_class', DSC_CLASSES)}</Labelled>
        <Labelled label="Usage">{sel('usage', DSC_USAGES)}</Labelled>
        <Labelled label="Provider">
          <input className={fieldClass} value={f.provider} onChange={up('provider')} placeholder="eMudhra, Capricorn, …" />
        </Labelled>
        <Labelled label="Token serial">
          <input className={fieldClass} value={f.token_serial} onChange={up('token_serial')} />
        </Labelled>
        <Labelled label="Valid from">
          <input type="date" className={fieldClass} value={f.valid_from} onChange={up('valid_from')} />
        </Labelled>
        <Labelled label="Expiry date" hint={errs.expiry_date}>
          <input type="date" className={fieldClass} value={f.expiry_date} onChange={up('expiry_date')} />
        </Labelled>
        <Labelled label="Custody">{sel('custody', DSC_CUSTODY)}</Labelled>
        <div />
        <Labelled label="Notes" className="sm:col-span-2">
          <textarea rows={2} className="block w-full px-3 py-2 text-13 bg-white border border-neutral-200 rounded-lg focus:outline-none focus:border-primary/60"
            value={f.notes} onChange={up('notes')} />
        </Labelled>
      </div>
    </Modal>
  );
}
