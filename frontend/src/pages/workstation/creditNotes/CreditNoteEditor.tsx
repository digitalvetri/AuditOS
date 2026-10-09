import { useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, Download, Plus, Send, Trash2, X } from 'lucide-react';
import {
  creditNotesApi, previewLineTax, CREDIT_NOTE_REASON_LABEL,
  type CreditNote, type CreditNoteInput, type CreditNoteReason, type Creditable,
} from '@/modules/workstation/creditNotes/api';
import { invoicesApi, GST_RATES } from '@/modules/workstation/invoices/api';
import { downloadFile } from '@/modules/workstation/invoices/download';
import { inrAmount } from '@/modules/workstation/invoices/document';
import {
  Card, Detail, Field, Modal, QueryState, QuerySkeleton, fieldErrors, inputClass, textareaClass,
} from '@/modules/workstation/components';
import { ListTable, ListRow, TD, Money, StatusChip, fmtDay } from '@/modules/workstation/listUi';
import { EntityHeader } from '@/components/EntityHeader';
import { Button } from '@/components/Button';
import { useToast } from '@/components/Toast';
import { istToday } from '@/lib/dates';
import { can } from '@/platform/rbac/can';
import { useAuth } from '@/platform/auth/AuthContext';

/**
 * One credit note: `/workstation/credit-notes/new?invoice=<id>` starts a draft
 * against an invoice; `/workstation/credit-notes/:id` opens a saved one. A
 * draft is editable; an issued note is fixed (it can only be cancelled).
 *
 * The tax split shown while editing is a preview that mirrors the invoice's
 * inter-state flag — the server recomputes every figure on save.
 */

const REASONS = Object.keys(CREDIT_NOTE_REASON_LABEL) as CreditNoteReason[];

interface EditLine { key: string; description: string; sac: string; taxable: string; rate: number }
let seq = 0;
const lineKey = () => `cn${++seq}`;
const blankLine = (): EditLine => ({ key: lineKey(), description: '', sac: '', taxable: '', rate: 18 });
const toPaise = (v: string) => Math.max(0, Math.round((Number(v) || 0) * 100));
const rupees = (paise: number) => String(paise / 100);

export function CreditNoteEditorPage() {
  const { id } = useParams<{ id: string }>();
  const [params] = useSearchParams();
  const isNew = !id;
  const cnQ = useQuery({ queryKey: ['creditNotes.get', id], queryFn: () => creditNotesApi.get(id!), enabled: !isNew });
  const invoiceId = isNew ? params.get('invoice') ?? '' : cnQ.data?.invoice_id ?? '';

  if (isNew && !invoiceId) {
    return (
      <Card title="New credit note">
        <p className="p-4 text-13 text-neutral-700">
          A credit note is raised against an invoice. Open the invoice and choose <b>Actions → Issue credit note</b>.{' '}
          <Link to="/workstation/invoices" className="text-primary hover:underline">Go to invoices</Link>
        </p>
      </Card>
    );
  }
  if (!isNew && !cnQ.data) return <QueryState query={cnQ}>{() => <QuerySkeleton />}</QueryState>;
  return <Loaded key={id ?? `new:${invoiceId}`} cn={cnQ.data ?? null} invoiceId={invoiceId} />;
}

function Loaded({ cn, invoiceId }: { cn: CreditNote | null; invoiceId: string }) {
  const creditableQ = useQuery({
    queryKey: ['creditNotes.creditable', invoiceId],
    queryFn: () => creditNotesApi.creditable(invoiceId),
  });
  const invoiceQ = useQuery({ queryKey: ['invoices.get', invoiceId], queryFn: () => invoicesApi.get(invoiceId), enabled: !cn });
  if (!creditableQ.data) return <QueryState query={creditableQ}>{() => <QuerySkeleton />}</QueryState>;
  return <Editor cn={cn} invoiceId={invoiceId} cr={creditableQ.data} clientName={cn?.client_name ?? invoiceQ.data?.client_name ?? invoiceQ.data?.billing_name ?? null} />;
}

function Editor({ cn, invoiceId, cr, clientName }: { cn: CreditNote | null; invoiceId: string; cr: Creditable; clientName: string | null }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { session } = useAuth();
  const mayWrite = can(session?.role.code, 'workstation.invoice.manage', 'self');
  const editable = mayWrite && (!cn || cn.status === 'draft');
  const interState = cn ? cn.is_inter_state : cr.is_inter_state;

  const [noteDate, setNoteDate] = useState(cn?.note_date?.slice(0, 10) ?? istToday());
  const [reason, setReason] = useState<CreditNoteReason>(cn?.reason ?? 'fee_reduction');
  const [reasonNote, setReasonNote] = useState(cn?.reason_note ?? '');
  const [lines, setLines] = useState<EditLine[]>(() => {
    const src = cn ? cn.lines : cr.suggested_lines;
    const out = src.map((l) => ({ key: lineKey(), description: l.description, sac: l.sac_code ?? '', taxable: rupees(l.taxable_paise), rate: l.gst_rate }));
    return out.length ? out : [blankLine()];
  });
  const [dirty, setDirty] = useState(false);
  const touch = <T,>(fn: (v: T) => void) => (v: T) => { setDirty(true); fn(v); };

  const preview = useMemo(() => {
    const rows = lines.map((l) => ({ ...previewLineTax(toPaise(l.taxable), l.rate, interState), taxable: toPaise(l.taxable) }));
    return rows.reduce((a, r) => ({
      taxable: a.taxable + r.taxable, cgst: a.cgst + r.cgst, sgst: a.sgst + r.sgst, igst: a.igst + r.igst, total: a.total + r.total,
    }), { taxable: 0, cgst: 0, sgst: 0, igst: 0, total: 0 });
  }, [lines, interState]);

  // What is still creditable on the invoice. For an issued note the server's
  // figure already includes this note, so only drafts are checked against it.
  const overLimit = editable && preview.total > cr.creditable_paise;
  const validLines = lines.filter((l) => l.description.trim() && toPaise(l.taxable) > 0);
  const canSave = editable && validLines.length > 0 && validLines.length === lines.length;

  const body = (): CreditNoteInput => ({
    note_date: noteDate,
    reason,
    reason_note: reasonNote.trim() || null,
    lines: lines.map((l) => ({ description: l.description.trim(), sac_code: l.sac.trim() || null, taxable_paise: toPaise(l.taxable), gst_rate: l.rate })),
  });

  const refresh = (saved?: CreditNote) => {
    void qc.invalidateQueries({ queryKey: ['creditNotes.list'] });
    void qc.invalidateQueries({ queryKey: ['creditNotes.creditable', invoiceId] });
    void qc.invalidateQueries({ queryKey: ['invoices.get', invoiceId] });
    void qc.invalidateQueries({ queryKey: ['invoices.list'] });
    void qc.invalidateQueries({ queryKey: ['invoices.summary'] });
    if (saved) qc.setQueryData(['creditNotes.get', saved.id], saved);
  };

  // A new note that was created but then failed to issue — remembered so a
  // second click updates that draft instead of creating another.
  const created = useRef<CreditNote | null>(null);
  const persist = async (): Promise<CreditNote> => {
    const existing = cn ?? created.current;
    if (!existing) {
      const draft = await creditNotesApi.create({ invoice_id: invoiceId, ...body() });
      created.current = draft;
      return draft;
    }
    if (dirty || !cn) return creditNotesApi.update(existing.id, body());
    return existing;
  };

  const save = useMutation({
    mutationFn: persist,
    onSuccess: (saved) => {
      setDirty(false);
      refresh(saved);
      toast.push('success', 'Credit note saved as a draft.');
      if (!cn) navigate(`/workstation/credit-notes/${saved.id}`, { replace: true });
    },
    onError: (e: Error) => toast.push('error', e.message),
  });
  const issue = useMutation({
    mutationFn: async () => creditNotesApi.issue((await persist()).id),
    onSuccess: (issued) => {
      setDirty(false);
      refresh(issued);
      toast.push('success', `Credit note ${issued.display_number} issued.`);
      if (!cn) navigate(`/workstation/credit-notes/${issued.id}`, { replace: true });
    },
    onError: (e: Error) => {
      const draft = !cn ? created.current : null;
      if (draft) {
        setDirty(false);
        refresh(draft);
        toast.push('error', `Saved as a draft — could not issue: ${e.message}`);
        navigate(`/workstation/credit-notes/${draft.id}`, { replace: true });
        return;
      }
      toast.push('error', e.message);
    },
  });
  const [deleting, setDeleting] = useState(false);
  const remove = useMutation({
    mutationFn: () => creditNotesApi.remove(cn!.id),
    onSuccess: () => {
      refresh();
      toast.push('success', 'Draft credit note deleted.');
      navigate(`/workstation/invoices/${invoiceId}`);
    },
    onError: (e: Error) => { setDeleting(false); toast.push('error', e.message); },
  });
  const [cancelling, setCancelling] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const cancel = useMutation({
    mutationFn: () => creditNotesApi.cancel(cn!.id, cancelReason.trim() || undefined),
    onSuccess: (c) => { setCancelling(false); refresh(c); toast.push('success', 'Credit note cancelled. The invoice balance is restored.'); },
    onError: (e: Error) => toast.push('error', e.message),
  });
  const pdf = useMutation({
    mutationFn: () => creditNotesApi.pdfUrl(cn!.id),
    onSuccess: (r) => downloadFile(r.url, `${cn?.credit_note_number ?? 'credit-note'}.pdf`),
    onError: (e: Error) => toast.push('error', e.message),
  });

  const setLine = (key: string, patch: Partial<EditLine>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const errs = fieldErrors(save.error ?? issue.error);
  const shown = editable ? preview : cn ? { taxable: cn.taxable_paise, cgst: cn.cgst_paise, sgst: cn.sgst_paise, igst: cn.igst_paise, total: cn.total_paise } : preview;
  const busy = save.isPending || issue.isPending;

  return (
    <div className="max-w-[1100px]">
      <Modal open={deleting} title="Delete draft credit note?" onClose={() => setDeleting(false)} footer={
        <>
          <Button onClick={() => setDeleting(false)}>Keep it</Button>
          <Button variant="danger" disabled={remove.isPending} onClick={() => remove.mutate()}>{remove.isPending ? 'Deleting…' : 'Delete draft'}</Button>
        </>
      }>
        <p className="text-13 text-neutral-700">This draft has no number yet and is removed permanently.</p>
      </Modal>
      <Modal open={cancelling} title={`Cancel ${cn?.display_number ?? 'credit note'}?`} onClose={() => setCancelling(false)} footer={
        <>
          <Button onClick={() => setCancelling(false)}>Keep it</Button>
          <Button variant="primary" disabled={cancel.isPending} onClick={() => cancel.mutate()}>Cancel credit note</Button>
        </>
      }>
        <p className="text-13 mb-3">The note keeps its number and stays on the books as cancelled; the invoice balance goes back up by its total.</p>
        <Field label="Reason" error={fieldErrors(cancel.error).reason}>
          <input className={inputClass} value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} />
        </Field>
      </Modal>

      <EntityHeader
        name={clientName || 'Credit note'}
        square
        title={<span className="font-mono tracking-[-0.01em]">{cn ? (cn.credit_note_number ?? 'Draft credit note') : 'New credit note'}</span>}
        idLine={<>
          <span className="font-sans">{clientName ?? '—'}</span>
          <span>· against <Link to={`/workstation/invoices/${invoiceId}`} className="text-primary hover:underline">{cr.invoice_number ?? 'invoice'}</Link></span>
        </>}
        chips={<StatusChip value={cn?.status ?? 'draft'} />}
        stats={[
          { label: 'Invoice total', value: `₹${inrAmount(cr.total_paise)}` },
          { label: 'Already credited', value: `₹${inrAmount(cr.credited_paise)}` },
          { label: 'Creditable', value: `₹${inrAmount(cr.creditable_paise)}`, tone: overLimit ? 'bad' : undefined },
          { label: 'This note', value: `₹${inrAmount(shown.total)}`, tone: overLimit ? 'bad' : undefined },
        ]}
        actions={
          <span className="flex gap-2 flex-wrap">
            {editable ? (
              <>
                <Button disabled={!canSave || busy} onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : 'Save draft'}</Button>
                <Button variant="primary" disabled={!canSave || overLimit || busy} onClick={() => issue.mutate()}
                  title={overLimit ? 'The note is more than what is still creditable on the invoice' : 'Allocates the CN number — the note is then fixed'}>
                  <Send size={14} className="mr-2" />{issue.isPending ? 'Issuing…' : 'Issue'}
                </Button>
                {cn ? <Button variant="danger" onClick={() => setDeleting(true)}><Trash2 size={14} className="mr-2" />Delete draft</Button> : null}
              </>
            ) : null}
            {cn && cn.status !== 'draft' ? (
              <Button disabled={pdf.isPending} onClick={() => pdf.mutate()}><Download size={14} className="mr-2" />Download PDF</Button>
            ) : null}
            {cn && cn.status === 'issued' && mayWrite ? (
              <Button variant="danger" onClick={() => setCancelling(true)}><Ban size={14} className="mr-2" />Cancel</Button>
            ) : null}
          </span>
        }
      />

      {overLimit ? (
        <div className="mb-4 border-l-2 border-red pl-3 text-13 text-neutral-900">
          This note totals ₹ {inrAmount(preview.total)}, more than the ₹ {inrAmount(cr.creditable_paise)} still creditable on {cr.invoice_number ?? 'the invoice'}. Reduce the lines before issuing.
        </div>
      ) : null}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-4">
        <div className="lg:col-span-2">
          <Card title="Details">
            <div className="p-4">
              {editable ? (
                <>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <Field label="Credit note date" error={errs.note_date}>
                      <input className={inputClass} type="date" value={noteDate} onChange={(e) => touch(setNoteDate)(e.target.value)} />
                    </Field>
                    <Field label="Reason" error={errs.reason}>
                      <select className={inputClass} value={reason} onChange={(e) => touch(setReason)(e.target.value as CreditNoteReason)}>
                        {REASONS.map((r) => <option key={r} value={r}>{CREDIT_NOTE_REASON_LABEL[r]}</option>)}
                      </select>
                    </Field>
                  </div>
                  <Field label="Note (optional)" error={errs.reason_note}>
                    <textarea className={textareaClass} rows={2} maxLength={500} value={reasonNote} onChange={(e) => touch(setReasonNote)(e.target.value)}
                      placeholder="e.g. Fee revised from ₹50,000 to ₹40,000 as agreed on 12 Sept" />
                  </Field>
                </>
              ) : cn ? (
                <>
                  <Detail label="Date" value={fmtDay(cn.note_date)} />
                  <Detail label="Reason" value={CREDIT_NOTE_REASON_LABEL[cn.reason] ?? cn.reason} />
                  {cn.reason_note ? <Detail label="Note" value={cn.reason_note} /> : null}
                  {cn.issued_at ? <Detail label="Issued" value={fmtDay(cn.issued_at)} /> : null}
                  {cn.cancelled_at ? <Detail label="Cancelled" value={fmtDay(cn.cancelled_at)} /> : null}
                </>
              ) : null}
              <Detail label="Place of supply" value={(cn?.place_of_supply ?? cr.place_of_supply) || '—'} />
              <Detail label="Tax" value={interState ? 'IGST (inter-state, as on the invoice)' : 'CGST + SGST (as on the invoice)'} />
            </div>
          </Card>
        </div>
        <Card title={editable ? 'Totals (preview)' : 'Totals'}>
          <div className="p-4">
            <Detail label="Taxable" value={`₹ ${inrAmount(shown.taxable)}`} />
            {interState
              ? <Detail label="IGST" value={`₹ ${inrAmount(shown.igst)}`} />
              : <>
                  <Detail label="CGST" value={`₹ ${inrAmount(shown.cgst)}`} />
                  <Detail label="SGST" value={`₹ ${inrAmount(shown.sgst)}`} />
                </>}
            <Detail label="Total credit" value={<b>₹ {inrAmount(shown.total)}</b>} />
            {editable ? <span className="block text-12 text-neutral-500 mt-2">A preview — the server recomputes each figure when the note is saved.</span> : null}
          </div>
        </Card>
      </div>

      <Card title="Lines" right={editable ? (
        <button type="button" onClick={() => { setDirty(true); setLines((ls) => [...ls, blankLine()]); }}
          className="inline-flex items-center gap-1 text-13 text-primary hover:underline"><Plus size={14} />Add line</button>
      ) : undefined}>
        {editable ? (
          <div className="p-4 space-y-3">
            {errs.lines ? <p className="text-12 text-red">{errs.lines}</p> : null}
            {lines.map((l, i) => {
              const t = previewLineTax(toPaise(l.taxable), l.rate, interState);
              return (
                <div key={l.key} className="grid grid-cols-2 md:grid-cols-12 gap-2 items-end pb-3 border-b border-neutral-100 last:border-b-0">
                  <label className="col-span-2 md:col-span-5 block">
                    <span className="block text-12 font-medium text-neutral-500 mb-1">Description {i + 1}</span>
                    <input className={inputClass} value={l.description} maxLength={500}
                      onChange={(e) => { setDirty(true); setLine(l.key, { description: e.target.value }); }} />
                  </label>
                  <label className="md:col-span-2 block">
                    <span className="block text-12 font-medium text-neutral-500 mb-1">SAC</span>
                    <input className={inputClass} value={l.sac} maxLength={10} inputMode="numeric"
                      onChange={(e) => { setDirty(true); setLine(l.key, { sac: e.target.value }); }} />
                  </label>
                  <label className="md:col-span-2 block">
                    <span className="block text-12 font-medium text-neutral-500 mb-1">Taxable (₹)</span>
                    <input className={inputClass} type="number" step="0.01" min="0" value={l.taxable}
                      onChange={(e) => { setDirty(true); setLine(l.key, { taxable: e.target.value }); }} />
                  </label>
                  <label className="md:col-span-1 block">
                    <span className="block text-12 font-medium text-neutral-500 mb-1">GST %</span>
                    <select className={inputClass} value={l.rate}
                      onChange={(e) => { setDirty(true); setLine(l.key, { rate: Number(e.target.value) }); }}>
                      {GST_RATES.map((r) => <option key={r} value={r}>{r}%</option>)}
                    </select>
                  </label>
                  <div className="md:col-span-2 flex items-center gap-2 h-9">
                    <span className="flex-1 text-right text-13 tabular-nums text-neutral-900" title={interState ? `IGST ₹${inrAmount(t.igst)}` : `CGST ₹${inrAmount(t.cgst)} + SGST ₹${inrAmount(t.sgst)}`}>
                      <Money value={`₹${inrAmount(t.total)}`} />
                    </span>
                    <button type="button" aria-label="Remove line" disabled={lines.length === 1}
                      onClick={() => { setDirty(true); setLines((ls) => ls.filter((x) => x.key !== l.key)); }}
                      className="h-8 w-8 inline-flex items-center justify-center rounded text-neutral-500 hover:text-red disabled:opacity-50"><X size={14} /></button>
                  </div>
                </div>
              );
            })}
          </div>
        ) : cn ? (
          <ListTable float={false} cols={[
            'Description', 'SAC', { label: 'Taxable', align: 'right' }, 'GST',
            { label: interState ? 'IGST' : 'CGST + SGST', align: 'right' }, { label: 'Total', align: 'right' },
          ]}>
            {cn.lines.map((l, i) => (
              <ListRow key={i}>
                <TD first>{l.description}</TD>
                <TD muted nowrap>{l.sac_code ?? '—'}</TD>
                <TD right nowrap className="tabular-nums"><Money value={`₹${inrAmount(l.taxable_paise)}`} /></TD>
                <TD muted nowrap>{l.gst_rate}%</TD>
                <TD right nowrap className="tabular-nums"><Money value={`₹${inrAmount(interState ? l.igst_paise : l.cgst_paise + l.sgst_paise)}`} /></TD>
                <TD last right strong nowrap className="tabular-nums"><Money value={`₹${inrAmount(l.total_paise)}`} /></TD>
              </ListRow>
            ))}
          </ListTable>
        ) : null}
      </Card>
    </div>
  );
}
