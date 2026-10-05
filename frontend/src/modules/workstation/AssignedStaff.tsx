/**
 * Who a client is assigned to: the account manager and an optional second
 * staff member. Assignment decides visibility — Associates and Interns see
 * only their assigned clients; Admin, Senior Associate and Super Admin see
 * all of them and are the only ones who change it.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Users } from 'lucide-react';
import { workstationApi } from './api';
import { Detail, Field, Modal, fieldErrors, inputClass } from './components';
import type { ClientDetail } from './types';
import { Button } from '@/components/Button';
import { useToast } from '@/components/Toast';
import { can } from '@/platform/rbac/can';
import { useAuth } from '@/platform/auth/AuthContext';

/** The two staff rows plus, for those allowed, a Change button. */
export function AssignedStaffDetails({ client }: { client: ClientDetail }) {
  const { session } = useAuth();
  const canAssign = can(session?.role.code, 'clients.view_all', 'organisation');
  const [open, setOpen] = useState(false);
  return (
    <>
      <Detail label="Account Manager" value={client.account_manager?.full_name ?? '—'} />
      <Detail
        label="Second Staff"
        value={
          <span className="inline-flex items-center gap-3">
            {client.secondary_manager?.full_name ?? <span className="text-neutral-400">Not assigned</span>}
            {canAssign ? (
              <button type="button" className="text-12 text-primary hover:underline" onClick={() => setOpen(true)}>
                <Users size={12} className="inline -mt-px mr-1" />Change staff
              </button>
            ) : null}
          </span>
        }
      />
      {canAssign ? <AssignStaffModal client={client} open={open} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function AssignStaffModal({ client, open, onClose }: { client: ClientDetail; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const employees = useQuery({ queryKey: ['workstation', 'employees'], queryFn: workstationApi.assignableEmployees, enabled: open });
  const [primary, setPrimary] = useState(client.account_manager_id);
  const [secondary, setSecondary] = useState(client.secondary_manager_id ?? '');
  const save = useMutation({
    mutationFn: () => workstationApi.updateClient(client.id, {
      account_manager_id: primary,
      secondary_manager_id: secondary || null,
    }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['workstation'] });
      toast.push('success', 'Assigned staff updated.');
      onClose();
    },
  });
  const e = fieldErrors(save.error);
  const people = employees.data?.items ?? [];
  return (
    <Modal
      open={open} title={`Assigned staff — ${client.company_name}`} onClose={onClose}
      footer={<>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={save.isPending || !primary} onClick={() => save.mutate()}>
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
      </>}
    >
      <p className="text-12 text-neutral-500 mb-4">
        Only the staff assigned here (and anyone working one of its services) can see this client.
        Admin, Senior Associate and Super Admin always can.
      </p>
      <Field label="Account Manager" error={e.account_manager_id}>
        <select className={inputClass} value={primary} onChange={(ev) => { setPrimary(ev.target.value); if (ev.target.value === secondary) setSecondary(''); }}>
          {people.map((p) => <option key={p.id} value={p.id}>{p.full_name} · {p.designation}</option>)}
        </select>
      </Field>
      <Field label="Second Staff" error={e.secondary_manager_id} hint="Optional. Can see and work the client, and covers when the account manager cannot.">
        <select className={inputClass} value={secondary} onChange={(ev) => setSecondary(ev.target.value)}>
          <option value="">No second staff</option>
          {people.filter((p) => p.id !== primary).map((p) => <option key={p.id} value={p.id}>{p.full_name} · {p.designation}</option>)}
        </select>
      </Field>
      {save.error && !Object.keys(e).length ? <p className="text-12 text-danger">{(save.error as Error).message}</p> : null}
    </Modal>
  );
}
