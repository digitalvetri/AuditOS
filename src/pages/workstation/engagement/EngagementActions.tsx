import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Archive, Check, ChevronDown, Copy, Download, Mail, MessageCircle, Pencil, Printer, Send, Trash2,
} from 'lucide-react';
import { Modal } from '@/modules/workstation/components';
import { engagementApi, type EngagementLetter } from '@/modules/workstation/engagement/api';
import { fmtDate } from '@/lib/format';
import { shareDocumentPdf, waNumber, type ShareChannel } from '@/modules/workstation/share';

/**
 * The engagement letter's Actions menu — the quotation's menu, for a letter.
 *
 * Same shape and the same rules: items that do not apply to the letter's
 * current state stay visible but disabled, with a tooltip saying why, so the
 * menu does not change shape under the user.
 */
export function EngagementActions({ letter, canManage, onError, onChanged }: {
  letter: EngagementLetter;
  canManage: boolean;
  onError: (msg: string) => void;
  /** Called with the letter after a status change or duplicate. */
  onChanged?: (l: EngagementLetter) => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);

  const fail = (e: unknown) => onError((e as { message?: string })?.message ?? 'That could not be done.');
  const refresh = (l?: EngagementLetter) => {
    queryClient.invalidateQueries({ queryKey: ['engagement.list'] });
    if (l) { queryClient.setQueryData(['engagement.get', l.id], l); onChanged?.(l); }
  };

  const status = useMutation({
    mutationFn: (op: 'send' | 'accept' | 'archive' | 'reopen') => engagementApi[op](letter.id),
    onSuccess: (l) => refresh(l),
    onError: fail,
  });
  const duplicate = useMutation({
    mutationFn: () => engagementApi.duplicate(letter.id),
    onSuccess: (l) => { refresh(); navigate(`/workstation/engagement/${l.id}/edit`); onChanged?.(l); },
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: () => engagementApi.remove(letter.id),
    onSuccess: () => { setDeleting(false); refresh(); navigate('/workstation/engagement'); },
    onError: (e) => { setDeleting(false); fail(e); },
  });

  const phone = waNumber(letter.party_contact_number);
  const message =
    `Engagement letter ${letter.letter_code}\n${letter.subject}\n`
    + `Dated ${fmtDate(letter.letter_date)}${letter.financial_year ? ` · FY ${letter.financial_year}` : ''}`;

  const share = async (channel: ShareChannel) => {
    setOpen(false);
    setBusy(true);
    try {
      await shareDocumentPdf({
        issueUrl: () => engagementApi.pdfUrl(letter.id),
        fileName: `${letter.letter_code}.pdf`,
        subject: `Engagement letter ${letter.letter_code} — ${letter.subject}`,
        message, channel, phone, email: letter.party_email,
      });
    } catch (e) { fail(e); } finally { setBusy(false); }
  };
  const run = (fn: () => void) => () => { setOpen(false); fn(); };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button" onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open}
        className="h-8 px-3 inline-flex items-center gap-1.5 text-13 rounded border border-neutral-300 bg-white hover:bg-neutral-50"
      >
        Actions <ChevronDown size={14} />
      </button>

      {open ? (
        <div role="menu" className="absolute right-0 top-9 z-20 w-64 py-1 bg-white border border-neutral-200 rounded-md shadow-lg text-13">
          <MenuLink to={`/workstation/engagement/${letter.id}/preview`} onClick={() => setOpen(false)}>
            <Printer size={14} /> Print / Save as PDF
          </MenuLink>
          <Item disabled={busy} onClick={() => share('download')}><Download size={14} /> Download PDF</Item>
          <Item disabled={!phone || busy} title={phone ? undefined : 'No contact number for this client'} onClick={() => share('whatsapp')}>
            <MessageCircle size={14} /> Send on WhatsApp
          </Item>
          <Item disabled={!letter.party_email || busy} title={letter.party_email ? undefined : 'No email address for this client'} onClick={() => share('email')}>
            <Mail size={14} /> Send by email
          </Item>

          <div className="my-1 border-t border-neutral-200" />

          <Item disabled={!canManage || duplicate.isPending} onClick={run(() => duplicate.mutate())}>
            <Copy size={14} /> Duplicate letter
          </Item>
          <Item
            disabled={letter.status !== 'draft' || !canManage}
            title={letter.status === 'draft' ? undefined : 'Only a draft can be marked sent'}
            onClick={run(() => status.mutate('send'))}
          >
            <Send size={14} /> Mark as sent
          </Item>
          <Item
            disabled={letter.status !== 'sent' || !canManage}
            title={letter.status === 'sent' ? undefined : 'Only a sent letter can be accepted'}
            onClick={run(() => status.mutate('accept'))}
          >
            <Check size={14} /> Mark as accepted
          </Item>
          <Item
            disabled={letter.status !== 'sent' || !canManage}
            title={letter.status === 'sent' ? 'Back to draft, so both sides can be edited again'
              : letter.status === 'accepted' ? 'Accepted terms are final — duplicate the letter instead' : 'Already editable'}
            onClick={run(() => status.mutate('reopen'))}
          >
            <Pencil size={14} /> Reopen for editing
          </Item>
          <Item
            disabled={letter.status === 'archived' || !canManage}
            title={letter.status === 'archived' ? 'Already archived' : undefined}
            onClick={run(() => status.mutate('archive'))}
          >
            <Archive size={14} /> Archive
          </Item>

          <div className="my-1 border-t border-neutral-200" />

          <Item danger disabled={letter.status !== 'draft' || !canManage}
            title={letter.status === 'draft' ? undefined : 'A sent letter is kept on record — archive it instead'}
            onClick={run(() => setDeleting(true))}>
            <Trash2 size={14} /> Delete letter
          </Item>
        </div>
      ) : null}

      <Modal
        open={deleting}
        title="Delete this engagement letter?"
        onClose={() => setDeleting(false)}
        footer={
          <>
            <button type="button" onClick={() => setDeleting(false)} className="h-8 px-3 text-13 rounded border border-neutral-300 bg-white hover:bg-neutral-50">Cancel</button>
            <button type="button" onClick={() => remove.mutate()} disabled={remove.isPending} className="h-8 px-3 text-13 rounded bg-red text-white hover:opacity-90 disabled:opacity-50">Delete it</button>
          </>
        }
      >
        <p className="text-13 text-neutral-900">{letter.letter_code} — “{letter.subject}” for {letter.party_name ?? 'no party'}.</p>
        <p className="text-13 text-neutral-500 mt-2">This cannot be undone.</p>
      </Modal>
    </div>
  );
}

const cls = (disabled?: boolean, danger?: boolean) =>
  'w-full px-3 py-1.5 flex items-center gap-2 text-left '
  + (disabled ? 'text-neutral-400 cursor-not-allowed' : danger ? 'text-red hover:bg-neutral-50' : 'text-neutral-900 hover:bg-neutral-50');

function Item({ children, disabled, danger, title, onClick }: {
  children: ReactNode; disabled?: boolean; danger?: boolean; title?: string; onClick: () => void;
}) {
  return (
    <button type="button" role="menuitem" title={title} disabled={disabled} onClick={onClick} className={cls(disabled, danger)}>
      {children}
    </button>
  );
}

function MenuLink({ to, children, onClick }: { to: string; children: ReactNode; onClick: () => void }) {
  return <Link to={to} role="menuitem" onClick={onClick} className={cls()}>{children}</Link>;
}
