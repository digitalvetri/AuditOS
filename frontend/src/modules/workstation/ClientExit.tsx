/**
 * A client the firm no longer acts for: status Inactive plus the exit date.
 * The exit date starts the retention period (Settings → Data protection);
 * records are only ever removed later by an Admin, never automatically.
 */
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { workstationApi } from './api';
import { Detail, Field, Modal, fieldErrors, inputClass } from './components';
import type { ClientDetail } from './types';
import { Button } from '@/components/Button';
import { useToast } from '@/components/Toast';
import { can } from '@/platform/rbac/can';
import { useAuth } from '@/platform/auth/AuthContext';
import { fmtDate } from '@/lib/format';
import { dataProtectionApi } from '@/modules/dataProtection/api';

const todayIst = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);

export function ClientExitDetail({ client }: { client: ClientDetail }) {
  const { session } = useAuth();
  const canManage = can(session?.role.code, 'workstation.client.manage', 'self');
  const [open, setOpen] = useState(false);
  const isAdmin = session?.role.code === 'md' || session?.role.code === 'hr_admin';
  const toast = useToast();
  const exit = client.exit_date ?? null;
  return (
    <>
      <Detail
        label="Exit date"
        value={
          <span className="inline-flex items-center gap-3">
            {exit ? fmtDate(`${exit}T00:00:00Z`) : <span className="text-neutral-400">—</span>}
            {canManage ? (
              <button type="button" className="text-12 text-primary hover:underline" onClick={() => setOpen(true)} data-testid="client-exit-edit">
                {exit ? 'Change' : 'Mark as former client'}
              </button>
            ) : null}
          </span>
        }
      />
      {isAdmin ? (
        <Detail
          label="Client data"
          value={
            <button
              type="button" className="text-12 text-primary hover:underline" data-testid="client-data-export"
              title="Everything held about this client, as JSON plus the uploaded files (DPDP access request). The export is logged."
              onClick={() => dataProtectionApi.exportClient(client.id, client.client_id).catch((e: Error) => toast.push('error', e.message))}
            >
              Export (DPDP request)
            </button>
          }
        />
      ) : null}
      {canManage && open ? <ClientExitModal client={client} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function ClientExitModal({ client, onClose }: { client: ClientDetail; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [date, setDate] = useState(client.exit_date ?? todayIst());
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => workstationApi.updateClient(client.id, body),
    onSuccess: (_d, body) => {
      void qc.invalidateQueries({ queryKey: ['workstation'] });
      toast.push('success', body.exit_date ? 'Client marked inactive with an exit date.' : 'Exit date cleared.');
      onClose();
    },
  });
  const e = fieldErrors(save.error);
  return (
    <Modal
      open title={`Former client — ${client.company_name}`} onClose={onClose}
      footer={<>
        {client.exit_date ? (
          <Button variant="ghost" disabled={save.isPending} onClick={() => save.mutate({ status: 'active', exit_date: null })}>
            Clear (client is back)
          </Button>
        ) : null}
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={save.isPending || !date} onClick={() => save.mutate({ status: 'inactive', exit_date: date })}>
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
      </>}
    >
      <p className="text-12 text-neutral-500 mb-4">
        Sets the status to Inactive. The firm keeps this client's records for the retention period set in
        Settings → Data protection, counted from this date; invoices and payments are always kept.
      </p>
      <Field label="Exit date (the day the firm stopped acting)" error={e.exit_date}>
        <input type="date" className={inputClass} value={date} onChange={(ev) => setDate(ev.target.value)} max={todayIst()} />
      </Field>
      {save.error && !Object.keys(e).length ? <p className="text-12 text-danger">{(save.error as Error).message}</p> : null}
    </Modal>
  );
}
