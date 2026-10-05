import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, ExternalLink, Link2, Mail, MessageCircle, Power, PowerOff, RefreshCw } from 'lucide-react';
import { workstationApi } from '@/modules/workstation/api';
import { Modal, QueryState } from '@/modules/workstation/components';
import type { ClientDetail, ClientShareLink } from '@/modules/workstation/types';
import { Button } from '@/components/Button';
import { useToast } from '@/components/Toast';
import { fmtDateTime } from '@/lib/format';

/**
 * The client's live document link: one URL the client keeps that always shows
 * their Documents folders as they are right now, with Open and Download on
 * every file — no login, nothing to re-send when a document is added.
 * Regenerating or turning it off stops the old URL at once.
 */
export function ClientShareLinkButton({ client, canManage }: { client: ClientDetail; canManage: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <span className="flex items-center gap-2"><Link2 size={14} />Share with client</span>
      </Button>
      {open ? <ShareLinkDialog client={client} canManage={canManage} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

const absolute = (l: ClientShareLink) => (l.absolute ? l.url : `${window.location.origin}${l.url}`);

function ShareLinkDialog({ client, canManage, onClose }: { client: ClientDetail; canManage: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const key = ['workstation', 'client', client.id, 'share-link'];
  const link = useQuery({ queryKey: key, queryFn: () => workstationApi.clientShareLink(client.id) });
  const [confirm, setConfirm] = useState<'off' | 'new' | null>(null);

  const create = useMutation({
    mutationFn: () => workstationApi.createClientShareLink(client.id),
    onSuccess: (l) => {
      qc.setQueryData(key, l);
      setConfirm(null);
      toast.push('success', link.data ? 'New link created — the old link no longer works.' : 'Link created.');
    },
    onError: (e: Error) => toast.push('error', e.message),
  });
  const pause = useMutation({
    mutationFn: () => workstationApi.pauseClientShareLink(client.id),
    onSuccess: (l) => {
      qc.setQueryData(key, l);
      setConfirm(null);
      toast.push('success', 'Link turned off. Turn it on again any time — the same link will work.');
    },
    onError: (e: Error) => toast.push('error', e.message),
  });
  const resume = useMutation({
    mutationFn: () => workstationApi.resumeClientShareLink(client.id),
    onSuccess: (l) => {
      qc.setQueryData(key, l);
      toast.push('success', 'Link turned on. The client can open the same link again.');
    },
    onError: (e: Error) => toast.push('error', e.message),
  });

  const message = (url: string) =>
    `Dear ${client.contact_person || client.company_name},\n\nYou can view and download all your documents with us here — it always shows the latest:\n${url}`;

  async function copy(url: string) {
    try { await navigator.clipboard.writeText(url); toast.push('success', 'Link copied.'); }
    catch { toast.push('error', 'Could not copy — select the link and copy it.'); }
  }
  function whatsapp(url: string) {
    let n = (client.contact_number ?? '').replace(/[^0-9]/g, '');
    if (n.length === 10) n = `91${n}`;
    window.open(`https://wa.me/${n}?text=${encodeURIComponent(message(url))}`, '_blank', 'noopener');
  }
  function email(url: string) {
    const subject = `Your documents — ${client.company_name}`;
    window.location.href = `mailto:${client.email ?? ''}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(message(url))}`;
  }

  return (
    <Modal open title="Share documents with client" onClose={onClose} width="w-[600px]" footer={<Button onClick={onClose}>Close</Button>}>
      <QueryState query={link}>
        {(l: ClientShareLink | null) => l ? (
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <span className={`inline-flex items-center gap-1.5 px-2 h-6 text-12 font-medium border ${l.active ? 'border-success/40 text-success' : 'border-amber text-neutral-700'}`}>
                <span className={`h-1.5 w-1.5 rounded-full ${l.active ? 'bg-success' : 'bg-amber'}`} />
                {l.active ? 'On' : 'Off'}
              </span>
              {!l.active && l.paused_at ? <span className="text-12 text-neutral-500">Turned off {fmtDateTime(l.paused_at)}</span> : null}
            </div>
            {!l.active ? (
              <div className="border-l-2 border-amber pl-3 flex flex-wrap items-center gap-3">
                <span className="text-13 text-neutral-700 flex-1 min-w-[240px]">
                  This link is turned off — the client sees “turned off for now”. Turn it on and the same link works again; nothing needs to be re-sent.
                </span>
                {canManage ? (
                  <Button variant="primary" disabled={resume.isPending} onClick={() => resume.mutate()}>
                    <span className="flex items-center gap-2"><Power size={14} />{resume.isPending ? 'Turning on…' : 'Turn on link'}</span>
                  </Button>
                ) : null}
              </div>
            ) : null}
            <p className="text-13 text-neutral-600">
              {client.company_name} can open this link any time to see their documents as they are now and download them.
              New documents appear on it automatically — no need to send it again.
            </p>
            <div className="flex items-stretch gap-2">
              <input
                readOnly
                value={absolute(l)}
                onFocus={(e) => e.currentTarget.select()}
                className="flex-1 min-w-0 h-9 px-3 border border-neutral-200 bg-neutral-50 text-13 text-neutral-900 font-mono"
              />
              <Button variant="primary" onClick={() => void copy(absolute(l))}>
                <span className="flex items-center gap-2"><Copy size={14} />Copy</span>
              </Button>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => whatsapp(absolute(l))}>
                <span className="flex items-center gap-2"><MessageCircle size={14} />WhatsApp</span>
              </Button>
              <Button onClick={() => email(absolute(l))}>
                <span className="flex items-center gap-2"><Mail size={14} />Email</span>
              </Button>
              <Button onClick={() => window.open(absolute(l), '_blank', 'noopener')}>
                <span className="flex items-center gap-2"><ExternalLink size={14} />Open as client</span>
              </Button>
            </div>
            <div className="text-12 text-neutral-500">
              Created {fmtDateTime(l.created_at)} ·{' '}
              {l.view_count === 0 ? 'Not opened yet' : `Opened ${l.view_count} time${l.view_count === 1 ? '' : 's'}, last ${fmtDateTime(l.last_viewed_at!)}`}
            </div>
            {!l.absolute ? (
              <div className="text-12 text-neutral-700 border-l-2 border-amber pl-3">
                The server has no PUBLIC_APP_URL, so this link uses the address you are on now. Make sure the client can reach it.
              </div>
            ) : null}
            {canManage ? (
              <div className="pt-3 border-t border-neutral-200 flex flex-wrap items-center gap-2">
                {confirm === 'off' ? (
                  <>
                    <span className="text-13 text-neutral-700">Turn off this link? The client cannot open it until you turn it back on.</span>
                    <Button variant="primary" disabled={pause.isPending} onClick={() => pause.mutate()}>Turn off</Button>
                    <Button onClick={() => setConfirm(null)}>Cancel</Button>
                  </>
                ) : confirm === 'new' ? (
                  <>
                    <span className="text-13 text-neutral-700">Make a new link? The current link stops working for good — you will need to send the new one.</span>
                    <Button variant="primary" disabled={create.isPending} onClick={() => create.mutate()}>Create new link</Button>
                    <Button onClick={() => setConfirm(null)}>Cancel</Button>
                  </>
                ) : (
                  <>
                    {l.active ? (
                      <Button onClick={() => setConfirm('off')} title="Stops the link for now — you can turn the same link on again">
                        <span className="flex items-center gap-2"><PowerOff size={14} />Turn off link</span>
                      </Button>
                    ) : null}
                    <Button onClick={() => setConfirm('new')} title="Replaces this link with a new one; the old link never works again">
                      <span className="flex items-center gap-2"><RefreshCw size={14} />New link</span>
                    </Button>
                  </>
                )}
              </div>
            ) : null}
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-13 text-neutral-600">
              Create a link {client.company_name} can keep. It opens a read-only page of their documents — always up to date —
              where they can view and download each file. Drafts are never shown.
            </p>
            {canManage ? (
              <Button variant="primary" disabled={create.isPending} onClick={() => create.mutate()}>
                <span className="flex items-center gap-2"><Link2 size={14} />{create.isPending ? 'Creating…' : 'Create link'}</span>
              </Button>
            ) : (
              <p className="text-13 text-neutral-500">No link yet. Ask someone who manages documents to create one.</p>
            )}
          </div>
        )}
      </QueryState>
    </Modal>
  );
}
