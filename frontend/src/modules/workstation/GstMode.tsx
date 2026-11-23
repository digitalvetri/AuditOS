/**
 * With GST / without GST — asked when a quotation or invoice is started, and
 * switchable on the Details tab while it is a draft. Without GST every line is
 * 0% (the server enforces it too) and the document drops its tax columns.
 */
import { Modal } from './components';

export function GstModePrompt({ open, kind, onChoose, onCancel }: {
  open: boolean;
  kind: 'quotation' | 'invoice';
  onChoose: (gstApplicable: boolean) => void;
  onCancel: () => void;
}) {
  const opt = (gst: boolean, title: string, body: string) => (
    <button type="button" onClick={() => onChoose(gst)}
      className="flex-1 text-left rounded-xl border border-neutral-200 bg-white p-4 hover:border-primary hover:bg-primary/5 transition-colors">
      <div className="text-15 font-semibold text-neutral-900">{title}</div>
      <div className="text-12 text-neutral-500 mt-1">{body}</div>
    </button>
  );
  return (
    <Modal open={open} title={`New ${kind}: with GST or without GST?`} onClose={onCancel} width="w-[600px]">
      <div className="p-1 flex flex-col sm:flex-row gap-3">
        {opt(true, 'With GST', kind === 'invoice'
          ? 'A tax invoice: GST on each line, CGST + SGST or IGST.'
          : 'GST on each line, shown in the totals.')}
        {opt(false, 'Without GST', kind === 'invoice'
          ? 'No GST on any line. Prints as "INVOICE" with no tax columns.'
          : 'No GST on any line, no tax rows in the totals.')}
      </div>
      <p className="text-12 text-neutral-500 mt-3 px-1">You can change this on the Details tab while it is a draft.</p>
    </Modal>
  );
}

/** The Details-tab switch. */
export function GstModeSwitch({ value, onChange, disabled }: { value: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  const seg = (v: boolean, label: string) => (
    <button type="button" disabled={disabled} onClick={() => onChange(v)} aria-pressed={value === v}
      className={`h-9 px-4 text-13 rounded-lg border transition-colors ${value === v
        ? 'bg-primary text-white border-primary' : 'bg-white text-neutral-700 border-neutral-200 hover:bg-neutral-50'} disabled:opacity-50`}>
      {label}
    </button>
  );
  return (
    <div className="mb-4">
      <span className="block text-12 text-neutral-500 mb-1">GST</span>
      <div className="flex gap-2">{seg(true, 'With GST')}{seg(false, 'Without GST')}</div>
    </div>
  );
}
