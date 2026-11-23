/**
 * Workstation → IT filing / MCA filing. The yearly returns the firm files for
 * its clients, created automatically on the day the work opens (backend
 * compliance/annual.ts):
 *   IT returns          1 May, every client with the Income Tax Filing service
 *   LLP Form 11 / 8     1 Apr (due 31 May) / 1 Sep (due 31 Oct), every LLP
 *   ADT-1, AOC-4, MGT-7 1 Aug (due 31 Oct / 31 Oct / 30 Nov), every company
 * Each row is a compliance item: status, assignee, "Mark filed" and AGM date
 * work exactly as on the compliance calendar.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { useAuth } from '@/platform/auth/AuthContext';
import { can } from '@/platform/rbac/can';
import { useToast } from '@/components/Toast';
import { istToday } from '@/modules/dashboardV2/brief';
import { QueryState } from '@/modules/workstation/components';
import { FilterSelect, ListEmpty, ListHeader, ListToolbar, TogglePill } from '@/modules/workstation/listUi';
import { complianceApi, complianceKeys, type AnnualGroup, type ComplianceItem } from '@/modules/compliance/api';
import { day, errorText, smallBtn, useAssignees } from '@/modules/compliance/ui';
import { AgmDialog, FiledDialog } from '@/modules/compliance/dialogs';
import { ItemsTable, editable, isDone } from './ComplianceCalendar';

const TITLES: Record<AnnualGroup, { title: string; blurb: string }> = {
  it: { title: 'IT returns', blurb: 'Created on 1 May each year for every client with the Income Tax Filing service, for the year that ended on 31 March.' },
  llp: { title: 'LLP forms', blurb: 'Form 11 and Form 8 for every active LLP client, created on their open date each year.' },
  company: { title: 'Pvt Ltd / Section 8 forms', blurb: 'ADT-1, AOC-4 and MGT-7 for every active company client, created on 1 August each year.' },
};

const md = (mmdd: string | null) => {
  if (!mmdd) return 'statutory date';
  const [m, d] = mmdd.split('-').map(Number);
  return `${d} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]}`;
};

export function AnnualFilingsPage({ group }: { group: AnnualGroup }) {
  const { session } = useAuth();
  const role = session?.role.code;
  const canManage = can(role, 'workstation.compliance.manage', 'self');
  const canRead = canManage || can(role, 'workstation.compliance.read', 'self');
  const seesAll = can(role, 'workstation.compliance.firm', 'organisation');
  const toast = useToast();
  const qc = useQueryClient();
  const today = istToday();

  const info = useQuery({ queryKey: ['compliance', 'annual', group], queryFn: () => complianceApi.annual(group), enabled: canRead });
  const codes = info.data?.form_codes.join(',') ?? '';
  const items = useQuery({
    queryKey: complianceKeys.items({ form_codes: codes }),
    queryFn: () => complianceApi.items({ form_codes: codes }),
    enabled: canRead && !!codes,
  });
  const forms = useQuery({ queryKey: complianceKeys.forms, queryFn: complianceApi.forms, enabled: canRead, staleTime: 600_000 });
  const formByCode = useMemo(() => new Map((forms.data ?? []).map((f) => [f.code, f])), [forms.data]);
  const assignees = useAssignees(canRead);

  const [fy, setFy] = useState('');
  const [form, setForm] = useState('');
  const [showDone, setShowDone] = useState(false);
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filing, setFiling] = useState<ComplianceItem[] | null>(null);
  const [agm, setAgm] = useState<ComplianceItem | null>(null);

  const all = items.data ?? [];
  const fys = [...new Set(all.map((i) => i.period_key))].sort().reverse();
  const rows = all
    .filter((i) => (!fy || i.period_key === fy) && (!form || i.form_code === form) && (showDone || !isDone(i)))
    .filter((i) => !q || `${i.client_name ?? ''} ${i.client_code ?? ''}`.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => a.due_date.localeCompare(b.due_date) || (a.client_name ?? '').localeCompare(b.client_name ?? ''));
  const open = all.filter((i) => !isDone(i));
  const overdue = open.filter((i) => i.due_date < today).length;

  const patch = useMutation({
    mutationFn: (v: { id: string; body: Parameters<typeof complianceApi.patchItem>[1] }) => complianceApi.patchItem(v.id, v.body),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: complianceKeys.all }); toast.push('success', 'Saved'); },
    onError: (e) => toast.push('error', errorText(e)),
  });
  const run = useMutation({
    mutationFn: complianceApi.runAnnual,
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: complianceKeys.all });
      toast.push('success', r.created ? `${r.created} new return${r.created === 1 ? '' : 's'} added.` : 'Everything due so far is already listed.');
    },
    onError: (e) => toast.push('error', errorText(e)),
  });

  const t = TITLES[group];
  if (!canRead) return <ListEmpty>You do not have access to the compliance calendar.</ListEmpty>;
  return (
    <div className="max-w-[1400px] space-y-4">
      <ListHeader
        title={t.title}
        meta={<>{t.blurb} {open.length} open{overdue ? <> · <span className="text-[#b91c1c] font-medium">{overdue} overdue</span></> : null}.</>}
        action={canManage && seesAll ? (
          <button type="button" className={smallBtn} disabled={run.isPending} onClick={() => run.mutate()}>
            <RefreshCw size={13} className="inline mr-1" />{run.isPending ? 'Checking…' : 'Check for new returns'}
          </button>
        ) : undefined}
      />

      {/* When each form opens and falls due — the firm's working calendar. */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {(info.data?.schedule ?? []).map((s) => {
          const count = open.filter((i) => (s.form_code === 'ITR' ? i.form_code.startsWith('ITR') : i.form_code === s.form_code)).length;
          return (
            <div key={s.form_code} className="bg-white border border-neutral-200 rounded p-4">
              <div className="text-14 font-semibold text-neutral-900">{s.form_name}</div>
              <div className="text-13 text-neutral-600 mt-1">Created {md(s.opens)} · due {md(s.due)}</div>
              <div className="text-12 text-neutral-500 mt-2">
                {count} open · next list {day(s.next_opens_on)} (FY {s.covers_fy})
              </div>
            </div>
          );
        })}
      </div>

      <ListToolbar>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search client"
          className="h-8 px-3 text-13 bg-white border border-neutral-200 rounded-lg w-[200px]" />
        <FilterSelect label="Year" value={fy} onChange={setFy} options={fys.map((f) => ({ value: f, label: `FY ${f}` }))} />
        {(info.data?.form_codes.length ?? 0) > 1 ? (
          <FilterSelect label="Form" value={form} onChange={setForm}
            options={(info.data?.form_codes ?? []).map((c) => ({ value: c, label: formByCode.get(c)?.name ?? c }))} />
        ) : null}
        <TogglePill on={showDone} onChange={setShowDone}>Show filed</TogglePill>
      </ListToolbar>

      <QueryState query={items}>
        {() => rows.length ? (
          <ItemsTable
            items={rows} today={today} formByCode={formByCode} canManage={canManage}
            selected={selected}
            onToggle={(id) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; })}
            onToggleAll={(on) => setSelected(on ? new Set(rows.filter(editable).map((i) => i.id)) : new Set())}
            assignees={assignees}
            onStatus={(i, s) => (s === 'filed' ? setFiling([i]) : patch.mutate({ id: i.id, body: { status: s } }))}
            onAssign={(i, id) => patch.mutate({ id: i.id, body: { assigned_employee_id: id || null } })}
            onFiled={(i) => setFiling([i])}
            onAgm={setAgm}
          />
        ) : (
          <ListEmpty>
            {all.length ? 'Nothing matches these filters.' : 'No returns yet. They appear here by themselves on the dates above.'}
          </ListEmpty>
        )}
      </QueryState>

      {selected.size && canManage ? (
        <div className="flex justify-end">
          <button type="button" className={smallBtn} onClick={() => setFiling(rows.filter((r) => selected.has(r.id)))}>
            Mark {selected.size} filed
          </button>
        </div>
      ) : null}
      {filing ? <FiledDialog items={filing} onClose={() => { setFiling(null); setSelected(new Set()); }} /> : null}
      {agm ? <AgmDialog item={agm} onClose={() => setAgm(null)} /> : null}
    </div>
  );
}

export const ItReturnsPage = () => <AnnualFilingsPage group="it" />;
export const LlpFormsPage = () => <AnnualFilingsPage group="llp" />;
export const CompanyFormsPage = () => <AnnualFilingsPage group="company" />;
