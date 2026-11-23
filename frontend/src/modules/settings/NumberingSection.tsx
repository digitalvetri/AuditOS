/**
 * Settings → Invoice & quotation numbers (Admin). The prefix, how many digits,
 * and the number to continue from — a firm that has already raised 160
 * invoices elsewhere sets the next invoice to 161. A number at or below one
 * already issued is refused, so nothing repeats. The prefix may carry {FY}
 * (2026-27), {FY2} (26-27) or {YYYY} (2026); a prefix with a year in it
 * starts again at 1 each year.
 */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SectionShell } from './SectionShell';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { useToast } from '@/components/Toast';
import { invoicesApi, type NumberSeries } from '@/modules/workstation/invoices/api';

const KEY = ['invoices.numbering'] as const;

interface Draft { prefix: string; digits: string; next: string }
const toDraft = (s: NumberSeries): Draft => ({ prefix: s.prefix, digits: String(s.digits), next: String(s.next_number) });

/** What the next number will look like with the draft's values (today's year tokens). */
function preview(d: Draft, s: NumberSeries): string {
  const now = new Date();
  const y = now.getFullYear();
  const fy = now.getMonth() >= 3 ? y : y - 1;
  const prefix = d.prefix
    .split('{YYYY}').join(String(y))
    .split('{FY2}').join(`${String(fy).slice(2)}-${String(fy + 1).slice(2)}`)
    .split('{FY}').join(`${fy}-${String(fy + 1).slice(2)}`);
  const n = Number(d.next) || s.next_number;
  const digits = Math.min(10, Math.max(1, Number(d.digits) || s.digits));
  return `${prefix}${String(n).padStart(digits, '0')}`;
}

export function NumberingSection() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: KEY, queryFn: invoicesApi.numbering });
  const [inv, setInv] = useState<Draft | null>(null);
  const [quo, setQuo] = useState<Draft | null>(null);
  useEffect(() => {
    if (q.data) { setInv(toDraft(q.data.invoice)); setQuo(toDraft(q.data.quotation)); }
  }, [q.data]);

  const save = useMutation({
    mutationFn: (kind: 'invoice' | 'quotation') => {
      const d = kind === 'invoice' ? inv! : quo!;
      const cur = q.data![kind];
      const next = Number(d.next);
      return invoicesApi.setNumbering({
        [kind]: {
          prefix: d.prefix.trim(),
          digits: Number(d.digits),
          // Only send a starting number when it was changed; otherwise the
          // series simply carries on from what is issued.
          next_number: next && next !== cur.next_number ? next : null,
        },
      });
    },
    onSuccess: (n) => { qc.setQueryData(KEY, n); toast.push('success', 'Saved. New numbers follow this from now on.'); },
    onError: (e: Error) => toast.push('error', e.message),
  });

  const card = (kind: 'invoice' | 'quotation', title: string, d: Draft | null, set: (d: Draft) => void) => {
    const s = q.data?.[kind];
    if (!s || !d) return null;
    const dirty = d.prefix !== s.prefix || d.digits !== String(s.digits) || d.next !== String(s.next_number);
    return (
      <div className="dash-card p-4 space-y-3" data-testid={`numbering-${kind}`}>
        <div className="flex items-baseline justify-between gap-3 flex-wrap">
          <h3 className="text-15 font-semibold text-neutral-900">{title}</h3>
          <span className="text-12 text-neutral-500">
            {s.highest_issued ? `Last issued: ${s.resolved_prefix}${String(s.highest_issued).padStart(s.digits, '0')}` : 'None issued in this series yet'}
          </span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Input label="Prefix" value={d.prefix} onChange={(e) => set({ ...d, prefix: e.target.value })} placeholder="INV-" />
          <Input label="Digits" type="number" min={1} max={10} value={d.digits} onChange={(e) => set({ ...d, digits: e.target.value })} />
          <Input label="Next number" type="number" min={s.highest_issued + 1} value={d.next} onChange={(e) => set({ ...d, next: e.target.value })} />
        </div>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <p className="text-13 text-neutral-700">
            Next {kind}: <span className="font-semibold text-neutral-900">{preview(d, s)}</span>
          </p>
          <Button variant="primary" disabled={!dirty || save.isPending} onClick={() => save.mutate(kind)}>Save</Button>
        </div>
      </div>
    );
  };

  return (
    <SectionShell title="Invoice & quotation numbers"
      description="Set where numbering continues from. A number at or below one already issued is refused, so no number is ever repeated.">
      {q.isLoading ? <p className="text-13 text-neutral-500">Loading…</p> : null}
      {q.isError ? <p className="text-13 text-[#b91c1c]">The numbering could not be loaded.</p> : null}
      {card('invoice', 'Invoices', inv, setInv)}
      {card('quotation', 'Quotations', quo, setQuo)}
      <div className="dash-card p-4 text-13 text-neutral-600 space-y-1">
        <p>The prefix can include <code>{'{FY}'}</code> (2026-27), <code>{'{FY2}'}</code> (26-27) or <code>{'{YYYY}'}</code> (2026). With a year in the prefix, numbering starts again at 1 each year.</p>
        <p>An invoice gets its number when it is sent, so drafts never use one up.</p>
      </div>
    </SectionShell>
  );
}
