import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { workstationApi } from './api';
import { Card, Field, Modal, QueryState, fieldErrors, inputClass } from './components';
import type { ClientContact, ClientDetail, ListResponse } from './types';
import { Button } from '@/components/Button';
import { useToast } from '@/components/Toast';
import { can } from '@/platform/rbac/can';
import { useAuth } from '@/platform/auth/AuthContext';

/**
 * The people at a client: the primary contact (the client's own contact
 * details — editing it edits the client) and anyone else the firm deals
 * with: accountant, director, authorised signatory.
 */
export function ClientContactsCard({ client }: { client: ClientDetail }) {
  const { session } = useAuth();
  const canManage = can(session?.role.code, 'workstation.client.manage', 'self');
  const qc = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState<ClientContact | 'new' | null>(null);
  const contacts = useQuery({
    queryKey: ['workstation', 'client', client.id, 'contacts'],
    queryFn: () => workstationApi.clientContacts(client.id),
  });
  const remove = useMutation({
    mutationFn: (c: ClientContact) => workstationApi.removeClientContact(client.id, c.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['workstation', 'client', client.id] });
      toast.push('success', 'Contact removed.');
    },
    onError: (e) => toast.push('error', (e as Error).message),
  });

  return (
    <Card
      title="Contacts"
      right={canManage ? (
        <button type="button" className="text-12 text-primary hover:underline inline-flex items-center gap-1" onClick={() => setEditing('new')}>
          <Plus size={12} />Add
        </button>
      ) : undefined}
    >
      <QueryState query={contacts}>
        {(d: ListResponse<ClientContact>) => (
          <ul className="divide-y divide-neutral-100">
            {d.items.map((c) => (
              <li key={c.id} className="px-4 py-3 flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="text-13 font-medium text-neutral-900">
                    {c.name}
                    {c.is_primary ? <span className="ml-2 text-11 text-neutral-500">Primary</span> : null}
                  </div>
                  {c.designation && !c.is_primary ? <div className="text-12 text-neutral-500">{c.designation}</div> : null}
                  <div className="text-12 text-neutral-700 flex flex-wrap gap-x-3">
                    <a href={`tel:${c.phone}`} className="hover:underline">{c.phone}</a>
                    {c.email ? <a href={`mailto:${c.email}`} className="hover:underline">{c.email}</a> : null}
                  </div>
                </div>
                {canManage ? (
                  <div className="flex gap-2 shrink-0">
                    <button type="button" aria-label={`Edit ${c.name}`} className="text-neutral-500 hover:text-neutral-900" onClick={() => setEditing(c)}>
                      <Pencil size={13} />
                    </button>
                    {!c.is_primary ? (
                      <button
                        type="button" aria-label={`Remove ${c.name}`} className="text-neutral-500 hover:text-danger"
                        disabled={remove.isPending}
                        onClick={() => { if (window.confirm(`Remove ${c.name} from this client's contacts?`)) remove.mutate(c); }}
                      >
                        <Trash2 size={13} />
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </QueryState>
      {editing ? <ContactModal clientId={client.id} contact={editing === 'new' ? null : editing} onClose={() => setEditing(null)} /> : null}
    </Card>
  );
}

function ContactModal({ clientId, contact, onClose }: { clientId: string; contact: ClientContact | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState({
    name: contact?.name ?? '', designation: contact?.designation ?? '', phone: contact?.phone ?? '', email: contact?.email ?? '',
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((cur) => ({ ...cur, [k]: e.target.value }));
  const save = useMutation({
    mutationFn: () => {
      const body = { name: f.name.trim(), designation: f.designation.trim() || null, phone: f.phone.trim(), email: f.email.trim() || null };
      return contact ? workstationApi.updateClientContact(clientId, contact.id, body) : workstationApi.addClientContact(clientId, body);
    },
    onSuccess: () => {
      // Editing the primary contact changes the client's own details too.
      void qc.invalidateQueries({ queryKey: ['workstation'] });
      toast.push('success', contact ? 'Contact saved.' : 'Contact added.');
      onClose();
    },
  });
  const err = fieldErrors(save.error);
  return (
    <Modal
      open title={contact ? `Edit contact — ${contact.name}` : 'Add contact'} onClose={onClose} width="w-[520px]"
      footer={<>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={save.isPending || !f.name.trim() || !f.phone.trim()} onClick={() => save.mutate()}>
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
      </>}
    >
      {contact?.is_primary ? (
        <p className="text-12 text-neutral-600 mb-3">This is the client’s primary contact: saving it also updates the client’s contact person, number and email.</p>
      ) : null}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4">
        <Field label="Name" error={err.name}><input className={inputClass} value={f.name} onChange={set('name')} /></Field>
        {!contact?.is_primary ? (
          <Field label="Role" error={err.designation} hint="e.g. Accountant, Director">
            <input className={inputClass} value={f.designation} onChange={set('designation')} />
          </Field>
        ) : null}
        <Field label="Phone" error={err.phone}><input className={inputClass} inputMode="tel" value={f.phone} onChange={set('phone')} /></Field>
        <Field label="Email" error={err.email}><input className={inputClass} type="email" value={f.email} onChange={set('email')} /></Field>
      </div>
      {save.error && !Object.keys(err).length ? <p className="text-12 text-danger">{(save.error as Error).message}</p> : null}
    </Modal>
  );
}
