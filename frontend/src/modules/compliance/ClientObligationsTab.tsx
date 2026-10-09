/**
 * Client Workspace → Compliance: which statutory forms this client files.
 * Suggested forms (for the client's entity type) come first; ticking a form
 * and saving switches it on and generates its calendar items.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock } from 'lucide-react';
import { useAuth } from '@/platform/auth/AuthContext';
import { can } from '@/platform/rbac/can';
import { useToast } from '@/components/Toast';
import { Button } from '@/components/Button';
import { QueryState } from '@/modules/workstation/components';
import { ListCard, ListEmpty } from '@/modules/workstation/listUi';
import {
  AUTHORITY_LABEL, complianceApi, complianceKeys, type ComplianceForm, type ObligationsResponse,
} from './api';
import { Chip, errorText, useAssignees } from './ui';

interface Pick { on: boolean; assignee: string; remind: boolean }

export function ClientObligationsTab({ clientId, entityType }: { clientId: string; entityType?: string | null }) {
  const { session } = useAuth();
  const canManage = can(session?.role.code, 'workstation.compliance.manage', 'self');
  const canRead = canManage || can(session?.role.code, 'workstation.compliance.read', 'self');
  const forms = useQuery({ queryKey: complianceKeys.forms, queryFn: complianceApi.forms, enabled: canRead, staleTime: 600_000 });
  const obligations = useQuery({
    queryKey: complianceKeys.obligations(clientId),
    queryFn: () => complianceApi.obligations(clientId),
    enabled: canRead,
  });

  if (!canRead) return <ListCard><ListEmpty>You do not have access to the compliance calendar.</ListEmpty></ListCard>;

  return (
    <QueryState query={obligations}>
      {(data) => (
        <QueryState query={forms}>
          {(catalogue) => (
            <ObligationsEditor clientId={clientId} entityType={data.client?.entity_type ?? data.entity_type ?? entityType ?? null}
              data={data} catalogue={catalogue} canManage={canManage} />
          )}
        </QueryState>
      )}
    </QueryState>
  );
}

function ObligationsEditor({ clientId, entityType, data, catalogue, canManage }: {
  clientId: string; entityType: string | null; data: ObligationsResponse; catalogue: ComplianceForm[]; canManage: boolean;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const assignees = useAssignees(true);
  const current = data.obligations ?? data.items ?? [];
  const suggested = useMemo(() => new Set((data.suggested ?? []).map((s) => (typeof s === 'string' ? s : s.code ?? s.form_code ?? ''))), [data.suggested]);

  const initial = useMemo(() => {
    const m: Record<string, Pick> = {};
    for (const f of catalogue) m[f.code] = { on: false, assignee: '', remind: true };
    for (const o of current) {
      m[o.form_code] = { on: o.is_active !== false, assignee: o.assigned_employee_id ?? '', remind: o.remind_client ?? true };
    }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalogue, data]);
  const [picks, setPicks] = useState<Record<string, Pick>>(initial);
  useEffect(() => setPicks(initial), [initial]);
  const [showAll, setShowAll] = useState(false);

  const dirty = JSON.stringify(picks) !== JSON.stringify(initial);
  const setPick = (code: string, patch: Partial<Pick>) => setPicks((p) => ({ ...p, [code]: { ...p[code], ...patch } }));

  const save = useMutation({
    mutationFn: () => complianceApi.saveObligations(clientId,
      Object.entries(picks).filter(([, p]) => p.on).map(([code, p]) => ({
        form_code: code, assigned_employee_id: p.assignee || null, remind_client: p.remind,
      }))),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: complianceKeys.all });
      toast.push('success', 'Compliance forms saved — calendar updated');
    },
    onError: (e) => toast.push('error', errorText(e)),
  });

  const activeOrSuggested = catalogue.filter((f) => suggested.has(f.code) || picks[f.code]?.on);
  const others = catalogue.filter((f) => !suggested.has(f.code) && !picks[f.code]?.on);
  const onCount = Object.values(picks).filter((p) => p.on).length;

  const rows = (list: ComplianceForm[]) => list.map((f) => {
    const p = picks[f.code] ?? { on: false, assignee: '', remind: true };
    return (
      <div key={f.code} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3 border-b border-neutral-100 last:border-b-0">
        <label className="flex items-start gap-3 min-w-0 flex-1 basis-[260px] cursor-pointer">
          <input type="checkbox" className="mt-1" checked={p.on} disabled={!canManage} onChange={(e) => setPick(f.code, { on: e.target.checked })} />
          <span className="min-w-0">
            <span className="block text-13 font-semibold text-neutral-900">{f.name}</span>
            <span className="block text-11 text-neutral-500">
              {AUTHORITY_LABEL[f.authority] ?? f.authority} · {f.frequency.replace(/_/g, ' ')} · {f.code}
            </span>
          </span>
          {suggested.has(f.code) ? <Chip tone="blue" dot={false}>Suggested</Chip> : null}
        </label>
        <select aria-label={`Assignee for ${f.name}`} value={p.assignee} disabled={!canManage || !p.on}
          onChange={(e) => setPick(f.code, { assignee: e.target.value })}
          className="h-8 px-2 text-13 bg-white border border-neutral-200 rounded-lg w-full sm:w-[200px] disabled:opacity-50">
          <option value="">Account manager</option>
          {assignees.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <label className={'inline-flex items-center gap-2 text-13 text-neutral-700 ' + (!p.on ? 'opacity-50' : '')}>
          <input type="checkbox" checked={p.remind} disabled={!canManage || !p.on} onChange={(e) => setPick(f.code, { remind: e.target.checked })} />
          Remind client
        </label>
      </div>
    );
  });

  return (
    <div className="space-y-4">
      <ListCard
        title={<>Compliance forms{entityType ? <span className="font-normal text-neutral-500"> · {entityType}</span> : null}</>}
        right={
          <div className="flex items-center gap-2">
            <Link to={`/workstation/compliance?client=${clientId}`} className="inline-flex items-center gap-1 text-13 text-primary hover:underline">
              <CalendarClock size={14} /> Calendar
            </Link>
            {canManage ? (
              <Button size="sm" variant="primary" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
                {save.isPending ? 'Saving…' : `Save (${onCount})`}
              </Button>
            ) : null}
          </div>
        }>
        {activeOrSuggested.length ? rows(activeOrSuggested) : <ListEmpty>No forms are suggested for this entity type. Pick from the full list below.</ListEmpty>}
      </ListCard>
      {others.length ? (
        <ListCard
          title={`Other forms (${others.length})`}
          right={<button type="button" className="text-13 text-primary hover:underline" onClick={() => setShowAll((v) => !v)}>{showAll ? 'Hide' : 'Show'}</button>}>
          {showAll ? rows(others) : null}
        </ListCard>
      ) : null}
    </div>
  );
}
