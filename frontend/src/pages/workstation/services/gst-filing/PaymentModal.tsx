import { useState } from 'react';
import { Modal, Field, inputClass } from '@/modules/workstation/components';
import { Button } from '@/components/Button';

export interface PaymentValues { payment_date: string; challan_ref: string }

/** Record the tax payment on a GSTR-3B already filed with payment due: date required, challan optional. */
export function PaymentModal({ clientName, period, challanRef, busy, error, onClose, onSave }: {
  clientName: string; period: string; challanRef: string | null; busy: boolean; error: string | null;
  onClose: () => void; onSave: (v: PaymentValues) => void;
}) {
  const today = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
  // Prefilled so an earlier challan is kept rather than cleared.
  const [v, setV] = useState<PaymentValues>({ payment_date: today, challan_ref: challanRef ?? '' });
  const set = (k: keyof PaymentValues) => (e: React.ChangeEvent<HTMLInputElement>) => setV((x) => ({ ...x, [k]: e.target.value }));
  return (
    <Modal open title={`GSTR-3B payment — ${clientName} · ${period}`} onClose={onClose} footer={<>
      <Button size="sm" onClick={onClose}>Cancel</Button>
      <Button size="sm" variant="primary" disabled={busy || !v.payment_date} onClick={() => onSave(v)}>Save payment</Button>
    </>}>
      <div className="space-y-3">
        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="Tax paid on"><input type="date" className={inputClass} value={v.payment_date} max={today} onChange={set('payment_date')} /></Field>
          <Field label="Challan (CPIN / CIN)" hint="Optional"><input className={inputClass + ' font-mono'} value={v.challan_ref} onChange={set('challan_ref')} /></Field>
        </div>
        {error ? <p className="text-13 text-danger">{error}</p> : null}
        <p className="text-12 text-neutral-500">Recorded here after you pay on the GST portal — Audit OS does not make payments.</p>
      </div>
    </Modal>
  );
}
