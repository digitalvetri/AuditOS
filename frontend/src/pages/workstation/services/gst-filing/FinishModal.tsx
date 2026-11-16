import { useState } from 'react';
import { Modal, Field, inputClass } from '@/modules/workstation/components';
import { Button } from '@/components/Button';

export interface FinishValues {
  arn: string; filed_date: string;
  taxable_value?: string; tax_amount?: string;
  tax_liability?: string; eligible_itc?: string; net_payable?: string; payment_date?: string; challan_ref?: string;
}

/** Finish a GSTR-1 or GSTR-3B: ARN + filed date are required; amounts are rupees. */
export function FinishModal({ kind, clientName, period, busy, error, onClose, onSave }: {
  kind: 'gstr1' | 'gstr3b'; clientName: string; period: string; busy: boolean; error: string | null;
  onClose: () => void; onSave: (v: FinishValues) => void;
}) {
  const today = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
  const [v, setV] = useState<FinishValues>({ arn: '', filed_date: today });
  const set = (k: keyof FinishValues) => (e: React.ChangeEvent<HTMLInputElement>) => setV((x) => ({ ...x, [k]: e.target.value }));
  const title = `${kind === 'gstr1' ? 'GSTR-1' : 'GSTR-3B'} filed — ${clientName} · ${period}`;
  return (
    <Modal open title={title} onClose={onClose} footer={<>
      <Button size="sm" onClick={onClose}>Cancel</Button>
      <Button size="sm" variant="primary" disabled={busy || !v.arn.trim() || !v.filed_date} onClick={() => onSave(v)}>Save as filed</Button>
    </>}>
      <div className="space-y-3">
        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="ARN"><input className={inputClass + ' font-mono'} value={v.arn} onChange={set('arn')} placeholder="AA3310260012345" /></Field>
          <Field label="Filed on"><input type="date" className={inputClass} value={v.filed_date} max={today} onChange={set('filed_date')} /></Field>
        </div>
        {kind === 'gstr1' ? (
          <div className="grid sm:grid-cols-2 gap-3">
            <Field label="Taxable value (₹)" hint="Optional"><input inputMode="decimal" className={inputClass} value={v.taxable_value ?? ''} onChange={set('taxable_value')} /></Field>
            <Field label="Tax (₹)" hint="Optional"><input inputMode="decimal" className={inputClass} value={v.tax_amount ?? ''} onChange={set('tax_amount')} /></Field>
          </div>
        ) : (
          <>
            <div className="grid sm:grid-cols-3 gap-3">
              <Field label="Tax liability (₹)"><input inputMode="decimal" className={inputClass} value={v.tax_liability ?? ''} onChange={set('tax_liability')} /></Field>
              <Field label="ITC claimed (₹)"><input inputMode="decimal" className={inputClass} value={v.eligible_itc ?? ''} onChange={set('eligible_itc')} /></Field>
              <Field label="Net payable (₹)"><input inputMode="decimal" className={inputClass} value={v.net_payable ?? ''} onChange={set('net_payable')} /></Field>
            </div>
            <div className="grid sm:grid-cols-2 gap-3">
              <Field label="Tax paid on" hint="Leave empty if nil"><input type="date" className={inputClass} value={v.payment_date ?? ''} max={today} onChange={set('payment_date')} /></Field>
              <Field label="Challan (CPIN / CIN)"><input className={inputClass + ' font-mono'} value={v.challan_ref ?? ''} onChange={set('challan_ref')} /></Field>
            </div>
          </>
        )}
        {error ? <p className="text-13 text-red-700">{error}</p> : null}
        <p className="text-12 text-neutral-500">Recorded here after you file on the GST portal — Audit OS does not submit returns.</p>
      </div>
    </Modal>
  );
}
