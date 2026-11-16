import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RotateCcw, Trash2 } from 'lucide-react';
import { workstationApi } from '@/modules/workstation/api';
import { Field, Modal, QueryState, inputClass } from '@/modules/workstation/components';
import type { ClientDocument, ListResponse } from '@/modules/workstation/types';
import { Button } from '@/components/Button';
import { useToast } from '@/components/Toast';
import { fmtDateTime } from '@/lib/format';

/**
 * Row actions for an uploaded document: move or copy it (to another folder,
 * or another client the user can see), or delete it to Recently Deleted.
 * A move or copy to another client is not shared with that client until
 * someone there shares it.
 */
export function DocumentRowActions({ clientId, documentId, title }: { clientId: string; documentId: string; title: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [mode, setMode] = useState<'move' | 'copy' | null>(null);
  const del = useMutation({
    mutationFn: () => workstationApi.deleteDocument(documentId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['workstation', 'client', clientId] });
      toast.push('success', `${title} moved to Recently Deleted.`);
    },
    onError: (e) => toast.push('error', (e as Error).message),
  });
  const link = 'text-12 text-neutral-700 underline hover:text-neutral-900';
  return (
    <>
      <button type="button" className={link} onClick={() => setMode('move')}>Move</button>
      <button type="button" className={link} onClick={() => setMode('copy')}>Copy</button>
      <button
        type="button" className="text-12 text-neutral-500 underline hover:text-danger" disabled={del.isPending}
        onClick={() => { if (window.confirm(`Delete “${title}”? It goes to Recently Deleted, where it can be restored.`)) del.mutate(); }}
      >
        Delete
      </button>
      {mode ? <MoveCopyModal mode={mode} clientId={clientId} documentId={documentId} title={title} onClose={() => setMode(null)} /> : null}
    </>
  );
}

function MoveCopyModal({ mode, clientId, documentId, title, onClose }: {
  mode: 'move' | 'copy'; clientId: string; documentId: string; title: string; onClose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const categories = useQuery({ queryKey: ['workstation', 'document-categories'], queryFn: () => workstationApi.documentCategories() });
  const clients = useQuery({ queryKey: ['workstation', 'clients', 'picker'], queryFn: () => workstationApi.listClients() });
  const [categoryId, setCategoryId] = useState('');
  const [targetClient, setTargetClient] = useState(clientId);
  const crossClient = targetClient !== clientId;
  const targetName = clients.data?.items.find((c) => c.id === targetClient)?.company_name ?? 'the other client';
  const run = useMutation({
    mutationFn: () => {
      const to = { ...(categoryId ? { category_id: categoryId } : {}), ...(crossClient ? { client_id: targetClient } : {}) };
      return mode === 'move' ? workstationApi.moveDocument(documentId, to) : workstationApi.copyDocument(documentId, to);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['workstation', 'client'] });
      toast.push('success', `${title} ${mode === 'move' ? 'moved' : 'copied'}${crossClient ? ` to ${targetName}` : ''}.`);
      onClose();
    },
  });
  const nothing = mode === 'move' && !categoryId && !crossClient;
  return (
    <Modal
      open title={`${mode === 'move' ? 'Move' : 'Copy'} — ${title}`} onClose={onClose}
      footer={<>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="primary" disabled={run.isPending || nothing}
          onClick={() => {
            if (crossClient && !window.confirm(`${mode === 'move' ? 'Move' : 'Copy'} “${title}” to ${targetName}? It will not be shared with that client until someone shares it.`)) return;
            run.mutate();
          }}
        >
          {run.isPending ? 'Working…' : mode === 'move' ? 'Move' : 'Copy'}
        </Button>
      </>}
    >
      <Field label="Folder" hint={mode === 'move' ? 'Leave as is to keep the current folder.' : 'Leave as is to keep the same folder.'}>
        <select className={inputClass} value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
          <option value="">Same folder</option>
          {(categories.data?.items ?? []).filter((c) => !c.code.startsWith('folder_')).map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      </Field>
      <Field label="Client">
        <select className={inputClass} value={targetClient} onChange={(e) => setTargetClient(e.target.value)}>
          {(clients.data?.items ?? []).map((c) => (
            <option key={c.id} value={c.id}>{c.company_name} ({c.client_id}){c.id === clientId ? ' — this client' : ''}</option>
          ))}
        </select>
      </Field>
      {run.error ? <p className="text-12 text-danger">{(run.error as Error).message}</p> : null}
    </Modal>
  );
}

/** "Recently deleted" for one client: deleted documents, newest first, each restorable. */
export function RecentlyDeletedButton({ clientId, canManage }: { clientId: string; canManage: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="flex items-center gap-1 text-12 text-neutral-600 hover:text-neutral-900" onClick={() => setOpen(true)}>
        <Trash2 size={13} />Recently deleted
      </button>
      {open ? <RecentlyDeletedModal clientId={clientId} canManage={canManage} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function RecentlyDeletedModal({ clientId, canManage, onClose }: { clientId: string; canManage: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const list = useQuery({ queryKey: ['workstation', 'client', clientId, 'deleted-documents'], queryFn: () => workstationApi.deletedDocuments(clientId) });
  const restore = useMutation({
    mutationFn: (id: string) => workstationApi.restoreDocument(id),
    onSuccess: (d) => {
      void qc.invalidateQueries({ queryKey: ['workstation', 'client', clientId] });
      toast.push('success', `${d.name} restored.`);
    },
    onError: (e) => toast.push('error', (e as Error).message),
  });
  return (
    <Modal open title="Recently deleted" onClose={onClose} width="w-[640px]" footer={<Button onClick={onClose}>Close</Button>}>
      <QueryState query={list} empty={<p className="text-13 text-neutral-500">Nothing deleted.</p>}>
        {(d: ListResponse<ClientDocument & { deleted_at: string }>) => d.items.length === 0 ? (
          <p className="text-13 text-neutral-500">Nothing deleted.</p>
        ) : (
          <ul className="divide-y divide-neutral-100 -mx-1">
            {d.items.map((doc) => (
              <li key={doc.id} className="px-1 py-2 flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="text-13 text-neutral-900 truncate">{doc.name}</div>
                  <div className="text-11 text-neutral-500">{doc.category_name ?? '—'} · deleted {fmtDateTime(doc.deleted_at)}</div>
                </div>
                {canManage ? (
                  <Button disabled={restore.isPending} onClick={() => restore.mutate(doc.id)}>
                    <span className="flex items-center gap-1.5"><RotateCcw size={13} />Restore</span>
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </QueryState>
    </Modal>
  );
}
