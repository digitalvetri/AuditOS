/**
 * Engagement letter → "Add services". Pick services from the Service master;
 * for each, every standard activity starts ticked (as set in the master) and
 * the ones not in the client's package are unticked. Fee, billing frequency,
 * timeline, information required and client-specific deliverables /
 * exclusions are entered here, and the result is written into the letter.
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Modal, inputClass } from '@/modules/workstation/components';
import { FREQUENCIES, KINDS, KIND_LABEL, serviceMasterApi, serviceMasterKeys, type MasterService, type ServiceScope } from './api';
import { EMPTY_EXTRAS, type ScopeExtras } from './toLetter';

export interface PickedService { scope: ServiceScope; extras: ScopeExtras; amountText: string }

interface Draft { ticked: Set<number>; frequency: string; amountText: string; extras: ScopeExtras }

const startDraft = (s: MasterService): Draft => ({
  ticked: new Set(s.items.map((it, i) => (it.default_selected ? i : -1)).filter((i) => i >= 0)),
  frequency: s.billing_frequency,
  amountText: '',
  extras: { ...EMPTY_EXTRAS },
});

export function ScopePicker({ open, onClose, onAdd, already }: {
  open: boolean;
  onClose: () => void;
  onAdd: (picked: PickedService[]) => void;
  /** Codes already on the letter — shown, but not offered twice. */
  already: string[];
}) {
  const q = useQuery({ queryKey: serviceMasterKeys.list(false), queryFn: () => serviceMasterApi.list(false), enabled: open });
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [focus, setFocus] = useState<string | null>(null);
  const services = q.data ?? [];
  const groups = useMemo(() => {
    const m = new Map<string, MasterService[]>();
    for (const s of services) m.set(s.category, [...(m.get(s.category) ?? []), s]);
    return [...m.entries()];
  }, [services]);
  const picked = services.filter((s) => drafts[s.id]);
  const current = services.find((s) => s.id === focus) ?? null;

  const toggleService = (s: MasterService) => setDrafts((d) => {
    const next = { ...d };
    if (next[s.id]) { delete next[s.id]; if (focus === s.id) setFocus(null); } else { next[s.id] = startDraft(s); setFocus(s.id); }
    return next;
  });
  const patch = (id: string, p: Partial<Draft>) => setDrafts((d) => ({ ...d, [id]: { ...d[id], ...p } }));
  const toggleItem = (id: string, i: number) => setDrafts((d) => {
    const t = new Set(d[id].ticked);
    if (t.has(i)) t.delete(i); else t.add(i);
    return { ...d, [id]: { ...d[id], ticked: t } };
  });

  const close = () => { setDrafts({}); setFocus(null); onClose(); };
  const add = () => {
    onAdd(picked.map((s) => {
      const d = drafts[s.id];
      return {
        amountText: d.amountText,
        extras: d.extras,
        scope: {
          code: s.code, name: s.name, category: s.category, billing_frequency: d.frequency, service_code: s.service_code,
          items: s.items.filter((_, i) => d.ticked.has(i)).map((it) => ({ kind: it.kind, content: it.content })),
          extras: Object.fromEntries(Object.entries(d.extras).filter(([, v]) => v.trim())),
        },
      };
    }));
    close();
  };

  return (
    <Modal open={open} title="Add services from the Service master" onClose={close} width="w-[1040px]"
      footer={(
        <div className="flex items-center gap-2 w-full">
          <Link to="/workstation/engagement/service-master" className="text-12 text-primary hover:underline">Open the Service master</Link>
          <div className="flex-1" />
          <button type="button" className="h-9 px-3 text-13 rounded-lg border border-neutral-200 bg-white" onClick={close}>Cancel</button>
          <button type="button" disabled={!picked.length} onClick={add}
            className="h-9 px-4 text-13 font-medium rounded-lg bg-primary text-white disabled:opacity-50">
            Add {picked.length || ''} {picked.length === 1 ? 'service' : 'services'} to the letter
          </button>
        </div>
      )}>
      {q.isLoading ? <p className="text-13 text-neutral-500 p-4">Loading…</p> : null}
      {q.isError ? <p className="text-13 text-[#b91c1c] p-4">The Service master could not be loaded.</p> : null}
      {q.data && !services.length ? <p className="text-13 text-neutral-500 p-4">The Service master is empty. Add services to it first.</p> : null}
      {services.length ? (
        <div className="grid grid-cols-[300px_1fr] gap-4 h-[65vh] min-h-0">
          <div className="overflow-y-auto min-h-0 pr-1 space-y-3">
            {groups.map(([cat, list]) => (
              <div key={cat}>
                <div className="text-11 font-semibold uppercase tracking-wide text-neutral-500 mb-1">{cat}</div>
                {list.map((s) => {
                  const on = Boolean(drafts[s.id]);
                  const dup = already.includes(s.code);
                  return (
                    <div key={s.id} className={`flex items-start gap-2 rounded px-2 py-1.5 ${focus === s.id ? 'bg-primary/5' : ''}`}>
                      <input type="checkbox" className="h-4 w-4 mt-0.5" checked={on} disabled={dup} onChange={() => toggleService(s)}
                        aria-label={`Add ${s.name}`} />
                      <button type="button" className="text-left flex-1 min-w-0" onClick={() => (on ? setFocus(s.id) : toggleService(s))} disabled={dup}>
                        <div className={`text-13 ${dup ? 'text-neutral-400' : 'text-neutral-900'}`}>{s.name}</div>
                        <div className="text-11 text-neutral-500">
                          {s.billing_frequency}{dup ? ' · already on this letter' : on ? ` · ${drafts[s.id].ticked.size} of ${s.items.length} activities` : ''}
                        </div>
                      </button>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>

          <div className="overflow-y-auto min-h-0 pr-1">
            {current && drafts[current.id] ? (
              <ServiceDraft s={current} d={drafts[current.id]} patch={(p) => patch(current.id, p)} toggle={(i) => toggleItem(current.id, i)} />
            ) : (
              <p className="text-13 text-neutral-500 p-4">
                Tick a service on the left. Its standard activities appear here, already ticked; untick what is not in this client&apos;s package.
              </p>
            )}
          </div>
        </div>
      ) : null}
    </Modal>
  );
}

function ServiceDraft({ s, d, patch, toggle }: { s: MasterService; d: Draft; patch: (p: Partial<Draft>) => void; toggle: (i: number) => void }) {
  const setExtra = (k: keyof ScopeExtras, v: string) => patch({ extras: { ...d.extras, [k]: v } });
  const allOf = (kind: string) => s.items.map((it, i) => (it.kind === kind ? i : -1)).filter((i) => i >= 0);
  const setAll = (kind: string, on: boolean) => {
    const t = new Set(d.ticked);
    for (const i of allOf(kind)) { if (on) t.add(i); else t.delete(i); }
    patch({ ticked: t });
  };
  return (
    <div className="space-y-4">
      <div>
        <div className="text-15 font-semibold text-neutral-900">{s.name}</div>
        <div className="grid grid-cols-2 gap-2 mt-2">
          <label className="block">
            <span className="text-11 text-neutral-500">Fee (₹)</span>
            <input value={d.amountText} onChange={(e) => patch({ amountText: e.target.value })} placeholder="e.g. 2,500" className={inputClass} inputMode="decimal" />
          </label>
          <label className="block">
            <span className="text-11 text-neutral-500">Billing frequency</span>
            <input list="sm-freq" value={d.frequency} onChange={(e) => patch({ frequency: e.target.value })} className={inputClass} />
            <datalist id="sm-freq">{FREQUENCIES.map((f) => <option key={f} value={f} />)}</datalist>
          </label>
        </div>
      </div>

      {KINDS.map((kind) => {
        const idx = allOf(kind);
        if (!idx.length) return null;
        const on = idx.filter((i) => d.ticked.has(i)).length;
        return (
          <div key={kind}>
            <div className="flex items-center gap-2 mb-1">
              <span className="text-13 font-semibold text-neutral-800">{KIND_LABEL[kind]}</span>
              <span className="text-11 text-neutral-500">{on} of {idx.length}</span>
              <div className="flex-1" />
              <button type="button" className="text-11 text-primary hover:underline" onClick={() => setAll(kind, on < idx.length)}>
                {on < idx.length ? 'Tick all' : 'Untick all'}
              </button>
            </div>
            <ul className="space-y-1">
              {idx.map((i) => (
                <li key={i}>
                  <label className="flex items-start gap-2 text-13 text-neutral-800 cursor-pointer">
                    <input type="checkbox" className="h-4 w-4 mt-0.5 shrink-0" checked={d.ticked.has(i)} onChange={() => toggle(i)} />
                    <span className={d.ticked.has(i) ? '' : 'text-neutral-400 line-through'}>{s.items[i].content}</span>
                  </label>
                </li>
              ))}
            </ul>
          </div>
        );
      })}

      <div className="border-t border-neutral-200 pt-3 space-y-2">
        <div className="text-13 font-semibold text-neutral-800">For this client</div>
        <label className="block">
          <span className="text-11 text-neutral-500">Timeline</span>
          <input value={d.extras.timeline} onChange={(e) => setExtra('timeline', e.target.value)} className={inputClass}
            placeholder="e.g. Data by the 5th; GSTR-1 by the 11th; GSTR-3B by the 20th of each month" />
        </label>
        {([
          ['information', 'Information required from the client', 'One per line, e.g. Sales register in Excel'],
          ['deliverables', 'Extra deliverables', 'One per line'],
          ['exclusions', 'Extra exclusions', 'One per line'],
        ] as [keyof ScopeExtras, string, string][]).map(([k, label, ph]) => (
          <label key={k} className="block">
            <span className="text-11 text-neutral-500">{label}</span>
            <textarea rows={2} value={d.extras[k]} onChange={(e) => setExtra(k, e.target.value)} placeholder={ph}
              className="w-full px-3 py-2 text-13 bg-white border border-neutral-200 rounded-lg" />
          </label>
        ))}
      </div>
    </div>
  );
}
