import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Mail, MessageCircle } from 'lucide-react';
import { api } from '@/services/api';
import { workstationApi } from '@/modules/workstation/api';
import { Field, Modal, inputClass, textareaClass } from '@/modules/workstation/components';
import { waNumber, waNumberProblem } from '@/modules/workstation/share';
import { Button } from '@/components/Button';
import { useToast } from '@/components/Toast';

/**
 * Ask a client for a document by WhatsApp or email. The number and address
 * come from the client's record; both stay editable.
 *
 * WhatsApp opens the chat with the message typed in (wa.me) — the user sends
 * it. Email goes out from the firm's mailbox when SMTP is configured, and
 * falls back to the user's mail app when it is not. Every send is logged on
 * the client's activity trail.
 */

export type RequestChannel = 'whatsapp' | 'email';

export interface RequestTarget {
  documentId: string;
  documentName: string;
  financialYear?: string | null;
  clientId: string;
}

const FIRM = 'JNS Accounting Solutions';

function defaultMessage(contact: string, doc: string, fy?: string | null) {
  return [
    `Dear ${contact || 'Sir/Madam'},`,
    '',
    `Greetings from ${FIRM}.`,
    '',
    `To proceed with your work, we need the following document from you:`,
    `• ${doc}${fy ? ` (FY ${fy})` : ''}`,
    '',
    'Kindly share it at the earliest by replying to this message.',
    '',
    'Thank you,',
    FIRM,
  ].join('\n');
}

export function SendRequestDialog({
  target, channel: initialChannel, onClose,
}: {
  target: RequestTarget | null;
  channel: RequestChannel;
  onClose: () => void;
}) {
  const open = target !== null;
  const toast = useToast();
  const qc = useQueryClient();
  const [channel, setChannel] = useState<RequestChannel>(initialChannel);
  const [v, setV] = useState({ phone: '', email: '', subject: '', message: '' });
  const [error, setError] = useState<string | null>(null);

  const client = useQuery({
    queryKey: ['workstation', 'client', target?.clientId],
    queryFn: () => workstationApi.getClient(target!.clientId),
    enabled: open,
  });
  const mail = useQuery({
    queryKey: ['share.email.status'],
    queryFn: () => api.get<{ configured: boolean; from: string | null }>('/api/share/email/status'),
    enabled: open,
    staleTime: 60_000,
  });

  // Prefill from the client record once per opening — a background refetch
  // must not overwrite what the user has typed.
  const prefilled = useRef<string | null>(null);
  useEffect(() => {
    if (!target) { prefilled.current = null; return; }
    if (!client.data || prefilled.current === target.documentId) return;
    prefilled.current = target.documentId;
    setChannel(initialChannel);
    setError(null);
    const c = client.data;
    setV({
      phone: c.contact_number ?? '',
      email: c.email ?? '',
      subject: `Document required: ${target.documentName}`,
      message: defaultMessage(c.contact_person ?? '', target.documentName, target.financialYear),
    });
  }, [target, initialChannel, client.data]);

  const log = useMutation({
    mutationFn: (b: Record<string, unknown>) =>
      api.post<{ sent: boolean }>(`/api/client-documents/${target!.documentId}/send-request`, b),
    onSettled: () => { void qc.invalidateQueries({ queryKey: ['workstation'] }); },
  });

  const sendWhatsApp = () => {
    const num = waNumber(v.phone);
    const problem = waNumberProblem(num);
    if (problem) return setError(problem);
    if (!v.message.trim()) return setError('Write the message to send.');
    setError(null);
    window.open(`https://wa.me/${num}?text=${encodeURIComponent(v.message)}`, '_blank', 'noopener');
    log.mutate(
      { channel: 'whatsapp', to: num, message: v.message },
      { onSuccess: () => { toast.push('success', 'WhatsApp opened with the request — press Send there.'); onClose(); },
        onError: (e) => setError((e as Error).message) },
    );
  };

  const sendEmail = (viaMailApp: boolean) => {
    const to = v.email.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
    if (to.length === 0) return setError('Enter the client’s email address.');
    const bad = to.find((x) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x));
    if (bad) return setError(`"${bad}" is not a valid email address.`);
    if (!v.message.trim()) return setError('Write the message to send.');
    setError(null);
    if (viaMailApp) {
      window.location.href = `mailto:${to.join(',')}?subject=${encodeURIComponent(v.subject)}&body=${encodeURIComponent(v.message)}`;
    }
    log.mutate(
      { channel: 'email', to, subject: v.subject, message: v.message, via: viaMailApp ? 'mail_app' : 'server' },
      { onSuccess: () => {
          toast.push('success', viaMailApp ? 'Opened in your mail app — press Send there.' : `Request emailed to ${to.join(', ')}.`);
          onClose();
        },
        onError: (e) => setError((e as Error).message) },
    );
  };

  const mailReady = mail.data?.configured === true;
  const busy = log.isPending;

  return (
    <Modal
      open={open}
      title={`Request ${target?.documentName ?? 'document'}`}
      onClose={onClose}
      width="w-[600px]"
      footer={
        <div className="flex justify-end gap-2">
          <Button size="sm" onClick={onClose}>Cancel</Button>
          {channel === 'whatsapp' ? (
            <Button size="sm" variant="primary" disabled={busy} onClick={sendWhatsApp}>
              {busy ? 'Opening…' : 'Send on WhatsApp'}
            </Button>
          ) : mailReady ? (
            <Button size="sm" variant="primary" disabled={busy} onClick={() => sendEmail(false)}>
              {busy ? 'Sending…' : 'Send email'}
            </Button>
          ) : (
            <Button size="sm" variant="primary" disabled={busy || mail.isLoading} onClick={() => sendEmail(true)}>
              Open in mail app
            </Button>
          )}
        </div>
      }
    >
      <div className="p-4 space-y-3">
        <div className="flex border border-neutral-200 w-fit">
          {([
            ['whatsapp', 'WhatsApp', MessageCircle],
            ['email', 'Email', Mail],
          ] as const).map(([key, label, Icon]) => (
            <button
              key={key}
              type="button"
              onClick={() => { setChannel(key); setError(null); }}
              className={`h-8 px-3 flex items-center gap-1.5 text-13 ${
                channel === key ? 'bg-neutral-900 text-white' : 'bg-white text-neutral-700 hover:bg-neutral-50'
              }`}
            >
              <Icon size={14} /> {label}
            </button>
          ))}
        </div>

        {client.isLoading ? <p className="text-13 text-neutral-500">Loading client contact…</p> : null}
        {error ? <div className="border-l-2 border-red pl-3 text-13 text-red">{error}</div> : null}

        {channel === 'whatsapp' ? (
          <Field label="WhatsApp number" hint={client.data ? `From ${client.data.company_name}’s contact details.` : undefined}>
            <input className={inputClass} value={v.phone} onChange={(e) => setV({ ...v, phone: e.target.value })} />
          </Field>
        ) : (
          <>
            {mail.data && !mailReady ? (
              <div className="border-l-2 border-amber bg-white px-3 py-2 text-13 text-neutral-700">
                The firm&apos;s mailbox is not set up on the server, so this opens your mail app with the
                message filled in. Add SMTP_HOST, SMTP_USER and SMTP_PASS to <code>backend/.env</code> to send directly.
              </div>
            ) : null}
            {mail.data?.from ? <p className="text-12 text-neutral-500">From: {mail.data.from}</p> : null}
            <Field label="To" hint={client.data ? `From ${client.data.company_name}’s contact details.` : undefined}>
              <input className={inputClass} value={v.email} onChange={(e) => setV({ ...v, email: e.target.value })} />
            </Field>
            <Field label="Subject">
              <input className={inputClass} value={v.subject} onChange={(e) => setV({ ...v, subject: e.target.value })} />
            </Field>
          </>
        )}

        <Field label="Message">
          <textarea
            className={`${textareaClass} min-h-[200px]`}
            value={v.message}
            onChange={(e) => setV({ ...v, message: e.target.value })}
          />
        </Field>
      </div>
    </Modal>
  );
}

/** Documents still to come from the client — the request list. */
export function needsRequest(status: string | null | undefined, noFile: boolean): boolean {
  return noFile || ['requested', 'pending', 'rejected', 'expired'].includes(status ?? '');
}

/** The WhatsApp / Email pair shown on each requested document. */
export function RequestButtons({ onPick }: { onPick: (channel: RequestChannel) => void }) {
  return (
    <span className="inline-flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        title="Send request on WhatsApp"
        aria-label="Send request on WhatsApp"
        onClick={() => onPick('whatsapp')}
        className="h-7 px-2 flex items-center gap-1 text-12 text-[#128C7E] border border-neutral-200 hover:border-[#128C7E] hover:bg-[#128C7E]/5"
      >
        <MessageCircle size={13} /> WhatsApp
      </button>
      <button
        type="button"
        title="Send request by email"
        aria-label="Send request by email"
        onClick={() => onPick('email')}
        className="h-7 px-2 flex items-center gap-1 text-12 text-neutral-700 border border-neutral-200 hover:border-neutral-500 hover:bg-neutral-50"
      >
        <Mail size={13} /> Email
      </button>
    </span>
  );
}
