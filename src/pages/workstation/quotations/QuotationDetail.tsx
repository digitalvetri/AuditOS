import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  FileText, Pencil, Send, Check, X, Copy, ListChecks, ChevronDown, Printer, Mail,
  MessageCircle, Receipt, Trash2, Download,
} from 'lucide-react';
import {
  Modal, Field, Status, QueryState, inputClass, textareaClass,
} from '@/modules/workstation/components';
import { workstationApi } from '@/modules/workstation/api';
import { quotationsApi, inr, type Quotation } from '@/modules/workstation/quotations/api';
import { fmtDate } from '@/lib/format';
import { shareDocumentPdf, waNumber, type ShareChannel } from '@/modules/workstation/share';
import { QuotationDocument, documentFromApi } from './QuotationDocument';
import { useAuth } from '@/platform/auth/AuthContext';
import { can } from '@/platform/rbac/can';

/**
 * /workstation/quotations/:id — the document, and what can be done to it.
 *
 * The document shown here is the same `QuotationDocument` the preview route
 * renders on its own, so there is no second template to drift from. Printing
 * happens on that route, never here — this page is wrapped by the CRM shell
 * and the shell has no business on the paper.
 *
 * Which actions appear is decided by the row's own status, which the server
 * computed — the browser never guesses whether something is still editable.
 */
export function QuotationDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { session } = useAuth();
  const canManage = can(session?.role.code, 'workstation.quotation.manage', 'self');
  const canApprove = can(session?.role.code, 'workstation.quotation.approve', 'self');
  const canAssign = can(session?.role.code, 'workstation.task.manage', 'self');
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const q = useQuery({ queryKey: ['quotations.get', id], queryFn: () => quotationsApi.get(id!) });

  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [converting, setConverting] = useState(false);
  const [assignee, setAssignee] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const employeesQ = useQuery({
    queryKey: ['quotations.assignable'],
    queryFn: () => workstationApi.assignableEmployees(),
    enabled: converting,
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['quotations.get', id] });
    queryClient.invalidateQueries({ queryKey: ['quotations.list'] });
    queryClient.invalidateQueries({ queryKey: ['quotations.summary'] });
  };
  const onError = (e: unknown) =>
    setActionError((e as { message?: string })?.message ?? 'That could not be done.');

  const send = useMutation({ mutationFn: () => quotationsApi.send(id!), onSuccess: refresh, onError });
  const accept = useMutation({ mutationFn: () => quotationsApi.accept(id!), onSuccess: refresh, onError });
  const reject = useMutation({
    mutationFn: () => quotationsApi.reject(id!, reason),
    onSuccess: () => { setRejecting(false); setReason(''); refresh(); },
    onError,
  });
  const revise = useMutation({
    mutationFn: () => quotationsApi.revise(id!),
    onSuccess: (fresh) => { refresh(); navigate(`/workstation/quotations/${fresh.id}/edit`); },
    onError,
  });
  const convert = useMutation({
    mutationFn: () => quotationsApi.convertToTask(id!, assignee, dueDate || undefined),
    onSuccess: (r) => { setConverting(false); refresh(); navigate(`/workstation/tasks/${r.task_id}`); },
    onError,
  });
  const remove = useMutation({
    mutationFn: () => quotationsApi.remove(id!),
    onSuccess: () => { setDeleting(false); refresh(); navigate('/workstation/quotations'); },
    onError: (e) => { setDeleting(false); onError(e); },
  });

  return (
    <QueryState query={q}>
      {(doc) => (
        <div>
          <header className="flex items-start gap-3 mb-4 flex-wrap print:hidden">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h1 className="text-20 font-semibold text-neutral-900">{doc.quotation_code}</h1>
                <Status value={doc.status} />
              </div>
              <p className="text-13 text-neutral-500 mt-1">
                {doc.subject} · {doc.party_name ?? 'No party'}
              </p>
            </div>
            <div className="flex-1" />
            <div className="flex items-center gap-2 flex-wrap">
              {/* Printing from here would put the shell on the paper, so
                  print lives on the document-only preview route instead. */}
              <Link
                to={`/workstation/quotations/${doc.id}/preview`}
                className="h-8 px-3 inline-flex items-center gap-1.5 text-13 rounded border border-neutral-300 bg-white hover:bg-neutral-50"
              >
                <FileText size={14} /> Preview
              </Link>

              {doc.is_editable && canManage ? (
                <Link
                  to={`/workstation/quotations/${doc.id}/edit`}
                  className="h-8 px-3 inline-flex items-center gap-1.5 text-13 rounded border border-neutral-300 bg-white hover:bg-neutral-50"
                >
                  <Pencil size={14} /> Edit
                </Link>
              ) : null}

              {/* Revise is how a sent quotation changes: a new draft from these
                  lines, leaving what went out exactly as it went out. */}
              {!doc.is_editable && canManage ? (
                <button
                  type="button"
                  onClick={() => revise.mutate()}
                  disabled={revise.isPending}
                  className="h-8 px-3 inline-flex items-center gap-1.5 text-13 rounded border border-neutral-300 bg-white hover:bg-neutral-50 disabled:opacity-50"
                >
                  <Copy size={14} /> Revise
                </button>
              ) : null}

              {doc.stored_status === 'draft' && canManage ? (
                <button
                  type="button"
                  onClick={() => send.mutate()}
                  disabled={send.isPending}
                  className="h-8 px-3 inline-flex items-center gap-1.5 text-13 rounded bg-neutral-900 text-white hover:bg-neutral-800 disabled:opacity-50"
                >
                  <Send size={14} /> Mark sent
                </button>
              ) : null}

              {doc.stored_status === 'sent' && canApprove ? (
                <>
                  <button
                    type="button"
                    onClick={() => setRejecting(true)}
                    className="h-8 px-3 inline-flex items-center gap-1.5 text-13 rounded border border-neutral-300 bg-white hover:bg-neutral-50"
                  >
                    <X size={14} /> Rejected
                  </button>
                  <button
                    type="button"
                    onClick={() => accept.mutate()}
                    disabled={accept.isPending}
                    className="h-8 px-3 inline-flex items-center gap-1.5 text-13 rounded bg-neutral-900 text-white hover:bg-neutral-800 disabled:opacity-50"
                  >
                    <Check size={14} /> Accepted
                  </button>
                </>
              ) : null}

              {doc.stored_status === 'accepted' && !doc.converted_task_id && canApprove && canAssign ? (
                <button
                  type="button"
                  onClick={() => setConverting(true)}
                  className="h-8 px-3 inline-flex items-center gap-1.5 text-13 rounded bg-neutral-900 text-white hover:bg-neutral-800"
                >
                  <ListChecks size={14} /> Create the work
                </button>
              ) : null}

              <ActionsMenu
                doc={doc}
                canManage={canManage}
                canApprove={canApprove}
                onSend={() => send.mutate()}
                onAccept={() => accept.mutate()}
                onDelete={() => setDeleting(true)}
                onShareError={setActionError}
              />
            </div>
          </header>

          {actionError ? (
            <div className="mb-3 border-l-2 border-red pl-3 text-13 text-neutral-900 print:hidden">{actionError}</div>
          ) : null}

          {doc.is_expired ? (
            <div className="mb-3 border-l-2 border-amber pl-3 text-13 text-neutral-900 print:hidden">
              This quotation passed its validity date on {doc.valid_until}. Revise it to send a fresh one.
            </div>
          ) : null}

          {doc.converted_task_id ? (
            <div className="mb-3 border-l-2 border-neutral-400 pl-3 text-13 text-neutral-900 print:hidden">
              The work for this quotation has been raised.{' '}
              <Link to={`/workstation/tasks/${doc.converted_task_id}`} className="underline hover:text-gold">
                Open the task
              </Link>
            </div>
          ) : null}

          {doc.stored_status === 'rejected' && doc.rejection_reason ? (
            <div className="mb-3 border-l-2 border-red pl-3 text-13 text-neutral-900 print:hidden">
              Rejected: {doc.rejection_reason}
            </div>
          ) : null}

          <QuotationDocument doc={documentFromApi(doc)} />

          <Modal
            open={rejecting}
            title="Record the rejection"
            onClose={() => setRejecting(false)}
            footer={
              <>
                <button
                  type="button"
                  onClick={() => setRejecting(false)}
                  className="h-8 px-3 text-13 rounded border border-neutral-300 bg-white hover:bg-neutral-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => reject.mutate()}
                  disabled={!reason.trim() || reject.isPending}
                  className="h-8 px-3 text-13 rounded bg-neutral-900 text-white hover:bg-neutral-800 disabled:opacity-50"
                >
                  Record it
                </button>
              </>
            }
          >
            <Field label="Why was it rejected?" hint="Kept on the record — it is what tells you why quotes are lost.">
              <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} className={textareaClass} />
            </Field>
          </Modal>

          <Modal
            open={converting}
            title="Create the work"
            onClose={() => setConverting(false)}
            footer={
              <>
                <button
                  type="button"
                  onClick={() => setConverting(false)}
                  className="h-8 px-3 text-13 rounded border border-neutral-300 bg-white hover:bg-neutral-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => convert.mutate()}
                  disabled={!assignee || convert.isPending}
                  className="h-8 px-3 text-13 rounded bg-neutral-900 text-white hover:bg-neutral-800 disabled:opacity-50"
                >
                  Create the task
                </button>
              </>
            }
          >
            <p className="text-13 text-neutral-500 mb-3">
              Raises one task on {doc.party_name}, titled “{doc.subject}”. A quotation can
              be converted once.
            </p>
            <Field label="Assign to">
              <QueryState query={employeesQ}>
                {(d) => (
                  <select value={assignee} onChange={(e) => setAssignee(e.target.value)} className={inputClass}>
                    <option value="">Choose an employee…</option>
                    {d.items.map((e) => (
                      <option key={e.id} value={e.id}>{e.full_name}</option>
                    ))}
                  </select>
                )}
              </QueryState>
            </Field>
            <Field label="Due date (optional)">
              <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className={inputClass} />
            </Field>
          </Modal>

          <Modal
            open={deleting}
            title="Delete this quotation?"
            onClose={() => setDeleting(false)}
            footer={
              <>
                <button
                  type="button"
                  onClick={() => setDeleting(false)}
                  className="h-8 px-3 text-13 rounded border border-neutral-300 bg-white hover:bg-neutral-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => remove.mutate()}
                  disabled={remove.isPending}
                  className="h-8 px-3 text-13 rounded bg-red text-white hover:opacity-90 disabled:opacity-50"
                >
                  Delete it
                </button>
              </>
            }
          >
            <p className="text-13 text-neutral-900">
              {doc.quotation_code} — “{doc.subject}” for {doc.party_name ?? 'no party'}.
            </p>
            <p className="text-13 text-neutral-500 mt-2">
              This cannot be undone. A quotation that has already gone to the client is
              usually better marked rejected than deleted, so the record of what was
              quoted survives.
            </p>
          </Modal>
        </div>
      )}
    </QueryState>
  );
}

/**
 * The full action list, behind one button.
 *
 * The inline buttons beside it stay as they are — they are the one obvious
 * next move for the quotation's current state. This menu is everything else,
 * including the sharing routes and the destructive one, which do not deserve
 * permanent space in the header.
 */
function ActionsMenu({
  doc, canManage, canApprove, onSend, onAccept, onDelete, onShareError,
}: {
  doc: Quotation;
  canManage: boolean;
  canApprove: boolean;
  onSend: () => void;
  onAccept: () => void;
  onDelete: () => void;
  onShareError: (msg: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  const phone = waNumber(doc.party_contact_number);
  const message =
    `Quotation ${doc.quotation_code}\n${doc.subject}\n`
    + `Total: ${inr(doc.total_paise)}`
    + (doc.valid_until ? `\nValid until: ${fmtDate(doc.valid_until)}` : '');

  /**
   * Send the quotation AS A FILE. Web Share API on mobile attaches the PDF
   * to WhatsApp/email natively; on desktop the file is saved to Downloads
   * and the channel opens with the covering text only, so the sender can
   * attach the just-saved file. See src/modules/workstation/share.ts for
   * the full path — kept there so invoices and engagement letters converge
   * on one implementation.
   */
  const sharePdf = async (channel: ShareChannel) => {
    setBusy(true);
    try {
      await shareDocumentPdf({
        issueUrl: () => quotationsApi.pdfUrl(doc.id),
        fileName: `${doc.quotation_code}.pdf`,
        subject: `Quotation ${doc.quotation_code} — ${doc.subject}`,
        message, channel, phone, email: doc.party_email,
      });
    } catch (e) {
      onShareError((e as { message?: string })?.message ?? 'The PDF could not be sent.');
    } finally {
      setBusy(false);
    }
  };

  const close = () => setOpen(false);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="h-8 px-3 inline-flex items-center gap-1.5 text-13 rounded border border-neutral-300 bg-white hover:bg-neutral-50"
      >
        Actions <ChevronDown size={14} />
      </button>

      {open ? (
        <div
          role="menu"
          className="absolute right-0 top-9 z-20 w-64 py-1 bg-white border border-neutral-200 rounded-md shadow-lg text-13"
        >
          <MenuLink to={`/workstation/quotations/${doc.id}/preview`} onClick={close}>
            <Printer size={14} /> Print / Save as PDF
          </MenuLink>

          <MenuButton
            disabled={busy}
            onClick={() => { close(); sharePdf('download'); }}
          >
            <Download size={14} /> Download PDF
          </MenuButton>

          <MenuButton
            disabled={!phone || busy}
            title={phone ? undefined : 'No contact number on this quotation'}
            onClick={() => { close(); sharePdf('whatsapp'); }}
          >
            <MessageCircle size={14} /> Send on WhatsApp
          </MenuButton>

          <MenuButton
            disabled={!doc.party_email || busy}
            title={doc.party_email ? undefined : 'No email address on this quotation'}
            onClick={() => { close(); sharePdf('email'); }}
          >
            <Mail size={14} /> Send by email
          </MenuButton>

          <div className="my-1 border-t border-neutral-200" />

          <MenuLink
            to={`/workstation/quotations/${doc.id}/edit`}
            disabled={!doc.is_editable || !canManage}
            title={doc.is_editable ? undefined : 'A sent quotation is frozen — use Revise'}
            onClick={close}
          >
            <Pencil size={14} /> Edit quotation
          </MenuLink>

          <MenuButton
            disabled={doc.stored_status !== 'draft' || !canManage}
            title={doc.stored_status === 'draft' ? undefined : 'Only a draft can be marked sent'}
            onClick={() => { close(); onSend(); }}
          >
            <Send size={14} /> Mark as sent
          </MenuButton>

          <MenuButton
            disabled={doc.stored_status !== 'sent' || !canApprove}
            title={doc.stored_status === 'sent' ? undefined : 'Only a sent quotation can be accepted'}
            onClick={() => { close(); onAccept(); }}
          >
            <Check size={14} /> Mark as accepted
          </MenuButton>

          <MenuButton disabled title="No invoicing module exists in AuditOS yet" onClick={close}>
            <Receipt size={14} /> Convert to invoice
          </MenuButton>

          <div className="my-1 border-t border-neutral-200" />

          <MenuButton
            disabled={!canManage}
            danger
            onClick={() => { close(); onDelete(); }}
          >
            <Trash2 size={14} /> Delete quotation
          </MenuButton>
        </div>
      ) : null}
    </div>
  );
}

const itemClass = (disabled?: boolean, danger?: boolean) =>
  'w-full px-3 py-1.5 flex items-center gap-2 text-left '
  + (disabled
    ? 'text-neutral-400 cursor-not-allowed'
    : danger
      ? 'text-red hover:bg-neutral-50'
      : 'text-neutral-900 hover:bg-neutral-50');

type ItemProps = {
  children: ReactNode;
  disabled?: boolean;
  danger?: boolean;
  title?: string;
  onClick?: () => void;
};

function MenuButton({ children, disabled, danger, title, onClick }: ItemProps) {
  return (
    <button
      type="button" role="menuitem" title={title} disabled={disabled}
      onClick={onClick} className={itemClass(disabled, danger)}
    >
      {children}
    </button>
  );
}

function MenuLink({ to, children, disabled, title, onClick }: ItemProps & { to: string }) {
  if (disabled) return <span role="menuitem" title={title} className={itemClass(true)}>{children}</span>;
  return (
    <Link to={to} role="menuitem" title={title} onClick={onClick} className={itemClass(false)}>
      {children}
    </Link>
  );
}

