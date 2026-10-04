import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { workstationApi } from '@/modules/workstation/api';
import { Plus } from 'lucide-react';
import { QueryState } from '@/modules/workstation/components';
import {
  FilterSelect, ListAction, ListCard, ListEmpty, ListHeader, ListRow, ListTable, ListToolbar, Spacer, StatusChip,
  StatusChipSelect, StatusPills, TD, TwoLine, fmtDay,
} from '@/modules/workstation/listUi';
import { NewFollowUpModal } from '@/modules/workstation/NewFollowUpModal';
import type { FollowUp, FollowUpStatus, ListResponse } from '@/modules/workstation/types';

const FOLLOW_UP_STATUSES: FollowUpStatus[] = ['pending', 'completed', 'rescheduled', 'cancelled', 'missed'];
const FOLLOW_UP_STATUS_LABEL: Record<FollowUpStatus, string> = {
  pending: 'Pending', completed: 'Completed', rescheduled: 'Rescheduled', cancelled: 'Cancelled', missed: 'Missed',
};
import { useToast } from '@/components/Toast';
import { fmtTime } from '@/lib/format';
import { can } from '@/platform/rbac/can';
import { useAuth } from '@/platform/auth/AuthContext';

/**
 * §7.5 — ONE follow-up list covering leads AND clients. There is no separate
 * lead-follow-up screen anywhere in Workstation; this is the only one.
 */
export function FollowUpsPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { session } = useAuth();
  const [addOpen, setAddOpen] = useState(false);

  const range = params.get('range') ?? '';
  const status = params.get('status') ?? '';
  const employeeId = params.get('employee_id') ?? '';

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const followUps = useQuery({
    queryKey: ['workstation', 'follow-ups', { range, status, employeeId }],
    queryFn: () => workstationApi.listFollowUps({
      range: (range || undefined) as 'today' | 'upcoming' | 'overdue' | undefined,
      status, employee_id: employeeId,
    }),
  });
  const employees = useQuery({ queryKey: ['workstation', 'employees'], queryFn: workstationApi.assignableEmployees });

  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: FollowUpStatus }) =>
      workstationApi.updateFollowUp(id, { status }),
    onSuccess: (_row, { status }) => {
      toast.push('success', `Follow-up marked ${FOLLOW_UP_STATUS_LABEL[status].toLowerCase()}.`);
    },
    onError: (e: Error) => toast.push('error', e.message),
    // Refetch either way so a rejected change snaps back to the saved value.
    onSettled: () => { void qc.invalidateQueries({ queryKey: ['workstation'] }); },
  });

  const canManage = can(session?.role.code, 'workstation.followup.manage', 'self');

  return (
    <div className="max-w-[1400px]">
      <ListHeader
        title="Follow-ups"
        meta={followUps.data
          ? <>{followUps.data.count} follow-up{followUps.data.count === 1 ? '' : 's'} · one list for leads and clients alike</>
          : 'One list for leads and clients alike.'}
        action={canManage ? <ListAction onClick={() => setAddOpen(true)} icon={<Plus size={15} />}>New Follow-up</ListAction> : undefined}
      />

      <ListToolbar>
        <FilterSelect
          label="Status" value={status} onChange={(v) => setParam('status', v)}
          options={FOLLOW_UP_STATUSES.map((v) => ({ value: v, label: FOLLOW_UP_STATUS_LABEL[v] }))}
        />
        <FilterSelect
          label="Employee" value={employeeId} onChange={(v) => setParam('employee_id', v)}
          options={(employees.data?.items ?? []).map((e) => ({ value: e.id, label: e.full_name }))}
        />
        <Spacer />
        <StatusPills value={range} onChange={(v) => setParam('range', v)} options={[
          { value: '', label: 'Any time' },
          { value: 'today', label: 'Today' },
          { value: 'upcoming', label: 'Upcoming' },
          { value: 'overdue', label: 'Overdue' },
        ]} />
      </ListToolbar>

      <ListCard>
        <QueryState query={followUps} empty={<ListEmpty>No follow-ups match these filters.</ListEmpty>}>
          {(data: ListResponse<FollowUp>) => data.items.length === 0 ? <ListEmpty>No follow-ups match these filters.</ListEmpty> : (
            <ListTable cols={['Follow-up', 'Lead / Client', 'Contact', 'Service', 'When', 'Assigned to', 'Status']}>
              {data.items.map((f) => {
                return (
                  <ListRow
                    key={f.id}
                    onOpen={() =>
                      navigate(f.subject_type === 'lead'
                        ? `/workstation/leads/${f.lead_id}`
                        : `/workstation/clients/${f.client_id}/follow-ups`)
                    }
                  >
                    <TD first strong className="min-w-[200px]">{f.title}</TD>
                    <TD><TwoLine avatar={f.subject_name} square={f.subject_type === 'client'} top={f.subject_name} sub={<>{f.subject_type === 'lead' ? 'Lead' : 'Client'} · {f.subject_code}{f.sent_to_organization ? <> · <span className="text-primary">via {f.sent_to_organization.name}</span></> : null}</>} /></TD>
                    <TD muted nowrap>
                      {f.contact_number ?? '—'}
                      {/* An organization's client is followed up through the organization. */}
                      {f.sent_to_organization ? <div className="text-11 text-primary">{f.contact_name ? `${f.contact_name}, ` : ''}{f.sent_to_organization.name}</div> : null}
                    </TD>
                    <TD muted>{f.service_name ?? '—'}</TD>
                    <TD muted nowrap>
                      {fmtDay(f.scheduled_at)} <span className="text-neutral-400">{fmtTime(f.scheduled_at)}</span>
                    </TD>
                    <TD muted>{f.assigned_employee?.full_name ?? '—'}</TD>
                    <TD last nowrap>
                      <div className="flex items-center gap-2">
                        {canManage ? (
                          // A chip you can change; clicks never open the row.
                          <StatusChipSelect
                            value={f.status}
                            label={`Status of ${f.title}`}
                            options={FOLLOW_UP_STATUSES.map((v) => ({ value: v, label: FOLLOW_UP_STATUS_LABEL[v] }))}
                            onChange={(v) => setStatus.mutate({ id: f.id, status: v as FollowUpStatus })}
                          />
                        ) : (
                          <StatusChip value={f.status} />
                        )}
                      </div>
                    </TD>
                  </ListRow>
                );
              })}
            </ListTable>
          )}
        </QueryState>
      </ListCard>

      <NewFollowUpModal open={addOpen} onClose={() => setAddOpen(false)} />
    </div>
  );
}
