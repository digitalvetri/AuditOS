/**
 * Statutory rates — append-only w/ effective dating (§3, §10).
 *
 * When a value changes, a NEW row is posted with a fresh `effective_from`.
 * The server automatically caps the prior row's `effective_to`. Rates are
 * never deleted or edited in place; that's how §14's audit story stays honest.
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
  const [newValue, setNewValue] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState(istToday());
  const [notes, setNotes] = useState('');

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

  return (
    <SectionShell
      title="Statutory rates"
      description="Append-only history per §10. Payroll (Part 2) reads the row where today ∈ [effective_from, effective_to]. Never edit in place — supersede."
    >
      <div className="space-y-4">
        {grouped.map(([code, rows]) => {
          const current = rows[0];
          const isEditing = supersedingCode === code;
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
                {!isEditing ? (
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setSupersedingCode(code);
                      setNewValue(current.value);
                      setNotes('');
                    }}
                    data-testid={`rate-supersede-${code}`}
                  >
                    Supersede
                  </Button>
                ) : null}
              </div>

              {isEditing ? (
                <form
                  onSubmit={(e: FormEvent) => {
                    e.preventDefault();
                    supersede.mutate();
                  }}
                  className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3"
                >
                  <Input label="New value" value={newValue} onChange={(e) => setNewValue(e.target.value)} required />
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
                    <Button variant="primary" type="submit" disabled={supersede.isPending} data-testid={`rate-supersede-submit-${code}`}>
                      Save new row
                    </Button>
                    <Button variant="ghost" type="button" onClick={() => setSupersedingCode(null)}>Cancel</Button>
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
                      <li key={r.id} className="text-11 text-neutral-500 tabular-nums font-mono">
                        {r.effective_from} → {r.effective_to ?? '…'} · {r.value.length > 40 ? r.value.slice(0, 40) + '…' : r.value}
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </div>
          );
        })}
      </div>
    </SectionShell>
  );
}
