/**
 * Contacts on a client (POST-DELIVERY-CHANGES §B2).
 *
 * The client complained that only one phone number can live on a client.
 * This card lists every contact (primary + extras: owner, accountant,
 * authorised signatory, etc.) with add / edit / delete / mark-primary.
 * Permission is `workstation.client.manage` — the server re-checks it.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Mail, Pencil, Phone, Plus, Star, Trash2 } from 'lucide-react';
import { workstationApi } from './api';
import { Card, Field, Modal, fieldErrors, inputClass } from './components';
import type { ClientContact } from './types';
import { Button } from '@/components/Button';
import { useToast } from '@/components/Toast';
import { can } from '@/platform/rbac/can';
import { useAuth } from '@/platform/auth/AuthContext';

export function ClientContactsCard({ clientId }: { clientId: string }) {
  const { session } = useAuth();
  const canManage = can(session?.role.code, 'workstation.client.manage', 'self');
  const query = useQuery({
    queryKey: ['workstation', 'client', clientId, 'contacts'],
    queryFn: () => workstationApi.clientContacts(clientId),
  });
  const [editing, setEditing] = useState<ClientContact | 'new' | null>(null);
  const contacts = query.data?.items ?? [];

  return (
    <Card
      title="Contacts"
      right={canManage ? (
        <button type="button" className="text-12 text-primary hover:underline inline-flex items-center gap-1" onClick={() => setEditing('new')}>
          <Plus size={12} />Add
        </button>
      ) : undefined}
    >
      <div className="p-4 pt-3">
        {query.isLoading ? (
          <div className="text-12 text-inkMuted">Loading…</div>
        ) : contacts.length === 0 ? (
          <div className="text-12 text-inkMuted">No contacts yet{canManage ? ' — add one above.' : '.'}</div>
        ) : (
          <ul className="flex flex-col gap-2">
            {contacts.map((c) => (
              <ContactRow key={c.id} contact={c} canManage={canManage} onEdit={() => setEditing(c)} clientId={clientId} />
            ))}
          </ul>
        )}
      </div>
      {editing ? (
        <ContactModal
          clientId={clientId}
          contact={editing === 'new' ? null : editing}
          existingPrimary={contacts.find((c) => c.is_primary) ?? null}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </Card>
  );
}

function ContactRow({
  contact, canManage, onEdit, clientId,
}: { contact: ClientContact; canManage: boolean; onEdit: () => void; clientId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const del = useMutation({
    mutationFn: () => workstationApi.deleteClientContact(clientId, contact.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['workstation', 'client', clientId] });
      toast.push('success', 'Contact removed.');
    },
    onError: (e: Error) => toast.push('error', e.message || 'Could not remove contact.'),
  });

  return (
    <li className="flex items-center gap-3 rounded-[11px] px-3 py-[10px] ring-1 ring-inset ring-border">
      <div className="min-w-0 flex-1">
        <div className="text-13 font-semibold text-ink truncate flex items-center gap-2">
          {contact.name}
          {contact.is_primary ? (
            <span className="inline-flex items-center gap-1 text-11 font-medium px-2 h-5 rounded-full bg-primary/10 text-primary">
              <Star size={10} />Primary
            </span>
          ) : null}
        </div>
        <div className="text-12 text-inkMuted truncate">
          {[contact.designation, contact.phone, contact.email].filter(Boolean).join(' · ')}
        </div>
      </div>
      {contact.phone ? (
        <a href={`tel:${contact.phone}`} className="h-8 w-8 grid place-items-center rounded-[9px] bg-surface shadow-card text-inkMuted hover:text-ink" aria-label="Call"><Phone size={14} /></a>
      ) : null}
      {contact.email ? (
        <a href={`mailto:${contact.email}`} className="h-8 w-8 grid place-items-center rounded-[9px] bg-surface shadow-card text-inkMuted hover:text-ink" aria-label="Email"><Mail size={14} /></a>
      ) : null}
      {canManage ? (
        <>
          <button type="button" className="h-8 w-8 grid place-items-center rounded-[9px] bg-surface shadow-card text-inkMuted hover:text-ink" onClick={onEdit} aria-label="Edit">
            <Pencil size={14} />
          </button>
          <button
            type="button"
            className="h-8 w-8 grid place-items-center rounded-[9px] bg-surface shadow-card text-inkMuted hover:text-danger"
            onClick={() => {
              const label = contact.is_primary ? 'the primary contact' : contact.name;
              if (window.confirm(`Remove ${label}? This cannot be undone from the UI.`)) del.mutate();
            }}
            aria-label="Delete"
            disabled={del.isPending}
          >
            <Trash2 size={14} />
          </button>
        </>
      ) : null}
    </li>
  );
}

type Form = { name: string; designation: string; phone: string; email: string; is_primary: boolean };

function ContactModal({
  clientId, contact, existingPrimary, onClose,
}: {
  clientId: string;
  contact: ClientContact | null;
  existingPrimary: ClientContact | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const isEdit = Boolean(contact);
  const [f, setF] = useState<Form>(() => ({
    name: contact?.name ?? '',
    designation: contact?.designation ?? '',
    phone: contact?.phone ?? '',
    email: contact?.email ?? '',
    is_primary: contact?.is_primary ?? false,
  }));
  const [local, setLocal] = useState<Record<string, string>>({});
  const set = <K extends keyof Form>(k: K) => (e: { target: { value: string } }) =>
    setF((cur) => ({ ...cur, [k]: e.target.value }));

  const save = useMutation({
    mutationFn: () => {
      const payload: Record<string, unknown> = {
        name: f.name.trim(),
        designation: f.designation.trim() || null,
        phone: f.phone.trim(),
        email: f.email.trim() || null,
        is_primary: f.is_primary,
      };
      return isEdit
        ? workstationApi.updateClientContact(clientId, contact!.id, payload)
        : workstationApi.addClientContact(clientId, payload);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['workstation', 'client', clientId] });
      toast.push('success', isEdit ? 'Contact saved.' : 'Contact added.');
      onClose();
    },
  });

  function validate(): boolean {
    const e: Record<string, string> = {};
    if (!f.name.trim()) e.name = 'This field is required.';
    if (!f.phone.trim()) e.phone = 'This field is required.';
    if (f.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email.trim())) e.email = 'Enter a valid email address.';
    setLocal(e);
    return Object.keys(e).length === 0;
  }

  const server = fieldErrors(save.error);
  const err = (k: string) => local[k] ?? server[k];
  const demoteNote = f.is_primary && existingPrimary && existingPrimary.id !== contact?.id
    ? `This will demote the current primary (${existingPrimary.name}).`
    : null;

  return (
    <Modal
      open
      title={isEdit ? `Edit contact — ${contact!.name}` : 'Add contact'}
      onClose={onClose}
      width="w-[520px]"
      footer={<>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={save.isPending} onClick={() => { if (validate()) save.mutate(); }}>
          {save.isPending ? 'Saving…' : isEdit ? 'Save' : 'Add contact'}
        </Button>
      </>}
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4">
        <Field label="Name" error={err('name')}>
          <input className={inputClass} value={f.name} onChange={set('name')} />
        </Field>
        <Field label="Designation" error={err('designation')} hint="e.g. Owner, Accountant, Authorised Signatory">
          <input className={inputClass} value={f.designation} onChange={set('designation')} />
        </Field>
        <Field label="Phone" error={err('phone')}>
          <input className={inputClass} inputMode="tel" value={f.phone} onChange={set('phone')} />
        </Field>
        <Field label="Email" error={err('email')}>
          <input className={inputClass} type="email" value={f.email} onChange={set('email')} />
        </Field>
      </div>
      <label className="flex items-center gap-2 text-13 text-ink mt-1 cursor-pointer select-none">
        <input type="checkbox" checked={f.is_primary} onChange={(e) => setF((cur) => ({ ...cur, is_primary: e.target.checked }))} />
        Mark as primary contact
      </label>
      {demoteNote ? <p className="text-12 text-inkMuted mt-1">{demoteNote}</p> : null}
      {save.error && !Object.keys(server).length ? <p className="text-12 text-danger mt-2">{(save.error as Error).message}</p> : null}
    </Modal>
  );
}
