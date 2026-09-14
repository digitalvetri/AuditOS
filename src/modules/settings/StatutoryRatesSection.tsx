/**
 * Statutory rates — append-only w/ effective dating (§3, §10).
 *
 * When a value changes, a NEW row is posted with a fresh `effective_from`.
 * The server automatically caps the prior row's `effective_to`. That is how
 * §14's audit story stays honest, and it stays the default action.
 *
 * Edit is the narrow exception, for the row that was TYPED WRONG. Superseding
 * a typo would record a rate that never applied and a change that never
 * happened — a worse lie than the correction. It is safe because a processed
 * payroll run reads its own snapshot, not this table, and the server audits
 * the correction with before/after under its own action.
 */
import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SectionShell } from './SectionShell';
import { settingsApi } from './api';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { useToast } from '@/components/Toast';
import { fmtDate } from '@/lib/format';
import { istToday } from '@/lib/dates';
import type { StatutoryRate } from '@/data/models';

export function StatutoryRatesSection() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['settings', 'statutory-rates'], queryFn: settingsApi.statutoryRates.list });
  const [supersedingCode, setSupersedingCode] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [newValue, setNewValue] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState(istToday());
  const [notes, setNotes] = useState('');

  const startEdit = (r: StatutoryRate) => {
    setSupersedingCode(null);
    setEditingId(r.id);
    setNewValue(r.value);
    setEffectiveFrom(r.effective_from);
    setNotes(r.notes ?? '');
  };
  const closeForms = () => { setSupersedingCode(null); setEditingId(null); };

  // Group by code so the UI reads as "current + history" per statute.
  const grouped = useMemo(() => {
    const byCode = new Map<string, StatutoryRate[]>();
    for (const r of q.data?.items ?? []) {
      const arr = byCode.get(r.code) ?? [];
      arr.push(r);
      byCode.set(r.code, arr);
    }
    // Sort each code's rows by effective_from desc (current on top).
    for (const [k, v] of byCode) {
      byCode.set(k, [...v].sort((a, b) => (a.effective_from < b.effective_from ? 1 : -1)));
    }
    return Array.from(byCode.entries()).sort(([a], [b]) => (a < b ? -1 : 1));
  }, [q.data]);

  const supersede = useMutation({
    mutationFn: () =>
      settingsApi.statutoryRates.supersede({
        code: supersedingCode!,
        value: newValue,
        effective_from: effectiveFrom,
        notes: notes || null,
      }),
    onSuccess: () => {
      toast.push('success', 'New rate effective — prior row capped.');
      qc.invalidateQueries({ queryKey: ['settings', 'statutory-rates'] });
      setSupersedingCode(null);
      setNewValue('');
      setNotes('');
      setEffectiveFrom(istToday());
    },
    onError: (e: Error) => toast.push('error', e.message),
  });

  const correct = useMutation({
    mutationFn: () =>
      settingsApi.statutoryRates.correct(editingId!, {
        value: newValue,
        effective_from: effectiveFrom,
        notes: notes || null,
      }),
    onSuccess: () => {
      toast.push('success', 'Row corrected — the change is in the audit log.');
      qc.invalidateQueries({ queryKey: ['settings', 'statutory-rates'] });
      closeForms();
      setNewValue('');
      setNotes('');
      setEffectiveFrom(istToday());
    },
    onError: (e: Error) => toast.push('error', e.message),
  });

  return (
    <SectionShell
      title="Statutory rates"
      description="Append-only history per §10. Payroll (Part 2) reads the row where today ∈ [effective_from, effective_to]. Never edit in place — supersede."
    >
      <div className="space-y-4">
        {grouped.map(([code, rows]) => {
          const current = rows[0];
          const isSuperseding = supersedingCode === code;
          const isCorrecting = editingId === current.id;
          return (
            <div key={code} className="bg-white border border-neutral-200 rounded p-4" data-testid={`rate-${code}`}>
              <div className="flex items-baseline justify-between gap-4">
                <div>
                  <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">{code}</div>
                  <div className="text-16 text-neutral-900 mt-1 tabular-nums font-mono">
                    {current.value.length > 60 ? current.value.slice(0, 60) + '…' : current.value}
                  </div>
                  <div className="text-11 text-neutral-500 mt-1">
                    Effective from {fmtDate(current.effective_from + 'T00:00:00Z')}
                    {current.effective_to ? ` to ${fmtDate(current.effective_to + 'T00:00:00Z')}` : ' · current'}
                  </div>
                  {current.notes ? <div className="text-11 text-neutral-500 mt-1">{current.notes}</div> : null}
                </div>
                {!isSuperseding && !isCorrecting ? (
                  <div className="flex items-center gap-2 shrink-0">
                    <Button
                      variant="secondary"
                      onClick={() => {
                        setEditingId(null);
                        setSupersedingCode(code);
                        setNewValue(current.value);
                        setEffectiveFrom(istToday());
                        setNotes('');
                      }}
                      data-testid={`rate-supersede-${code}`}
                    >
                      Supersede
                    </Button>
                    <Button variant="ghost" onClick={() => startEdit(current)} data-testid={`rate-edit-${code}`}>
                      Edit
                    </Button>
                  </div>
                ) : null}
              </div>

              {isSuperseding || isCorrecting ? (
                <form
                  onSubmit={(e: FormEvent) => {
                    e.preventDefault();
                    if (isCorrecting) correct.mutate();
                    else supersede.mutate();
                  }}
                  className="mt-3"
                >
                  <div className="text-11 text-neutral-500 mb-2">
                    {isCorrecting
                      ? 'Correcting this row in place. Use this only when it was entered wrong — if the rate itself changed, Supersede instead so the history stays true. The change is recorded in the audit log.'
                      : 'Adding a new row. The current one is capped the day before this takes effect.'}
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <Input
                      label={isCorrecting ? 'Value' : 'New value'}
                      value={newValue}
                      onChange={(e) => setNewValue(e.target.value)}
                      required
                      data-testid={`rate-value-${code}`}
                    />
                    <Input
                      label="Effective from"
                      type="date"
                      value={effectiveFrom}
                      onChange={(e) => setEffectiveFrom(e.target.value)}
                      required
                      data-testid={`rate-effective-from-${code}`}
                    />
                    <Input label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
                    <div className="flex items-end gap-2">
                      <Button
                        variant="primary"
                        type="submit"
                        disabled={isCorrecting ? correct.isPending : supersede.isPending}
                        data-testid={isCorrecting ? `rate-edit-submit-${code}` : `rate-supersede-submit-${code}`}
                      >
                        {isCorrecting ? 'Save correction' : 'Save new row'}
                      </Button>
                      <Button variant="ghost" type="button" onClick={closeForms}>Cancel</Button>
                    </div>
                  </div>
                </form>
              ) : null}

              {rows.length > 1 ? (
                <details className="mt-3">
                  <summary className="text-11 uppercase tracking-[0.06em] text-neutral-500 cursor-pointer">
                    History ({rows.length - 1} superseded)
                  </summary>
                  <ul className="mt-2 space-y-1">
                    {rows.slice(1).map((r) => (
                      <li key={r.id} className="flex items-center gap-2 text-11 text-neutral-500">
                        <span className="tabular-nums font-mono">
                          {r.effective_from} → {r.effective_to ?? '…'} · {r.value.length > 40 ? r.value.slice(0, 40) + '…' : r.value}
                        </span>
                        {/* A superseded row is where a typo usually surfaces —
                            once a later rate has capped it, the only way to fix
                            it is in place. */}
                        <button
                          type="button"
                          onClick={() => startEdit(r)}
                          className="text-11 text-neutral-400 hover:text-gold underline underline-offset-2"
                          data-testid={`rate-edit-history-${r.id}`}
                        >
                          Edit
                        </button>
                      </li>
                    ))}
                  </ul>
                  {rows.slice(1).some((r) => r.id === editingId) ? (
                    <form
                      onSubmit={(e: FormEvent) => { e.preventDefault(); correct.mutate(); }}
                      className="mt-3 border-t border-neutral-100 pt-3"
                    >
                      <div className="text-11 text-neutral-500 mb-2">
                        Correcting a superseded row in place. The change is recorded in the audit log.
                      </div>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        <Input label="Value" value={newValue} onChange={(e) => setNewValue(e.target.value)} required />
                        <Input label="Effective from" type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} required />
                        <Input label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
                        <div className="flex items-end gap-2">
                          <Button variant="primary" type="submit" disabled={correct.isPending}>Save correction</Button>
                          <Button variant="ghost" type="button" onClick={closeForms}>Cancel</Button>
                        </div>
                      </div>
                    </form>
                  ) : null}
                </details>
              ) : null}
            </div>
          );
        })}
      </div>
    </SectionShell>
  );
}
