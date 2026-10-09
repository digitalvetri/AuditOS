import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CalendarDays, CalendarClock, ChevronLeft, ChevronRight, Download, ExternalLink, List, Settings2, Upload,
} from 'lucide-react';
import { useAuth } from '@/platform/auth/AuthContext';
import { can } from '@/platform/rbac/can';
import { useToast } from '@/components/Toast';
import { useIsMobile } from '@/lib/useIsMobile';
import { inr } from '@/lib/format';
import { addDaysISO, istToday } from '@/modules/dashboardV2/brief';
import { QueryState } from '@/modules/workstation/components';
import {
  FilterSelect, ListCard, ListEmpty, ListHeader, ListRow, ListTable, ListToolbar, StatusChip, StatusChipSelect,
  TD, TogglePill, TwoLine,
} from '@/modules/workstation/listUi';
import {
  AUTHORITY_LABEL, ITEM_STATUSES, complianceApi, complianceKeys, toPaise,
  type ComplianceForm, type ComplianceItem, type ItemFilters,
} from '@/modules/compliance/api';
import {
  Chip, DaysChip, DueDate, day, daysUntil, downloadText, errorText, smallBtn, toCsv, useAssignees, useClientOptions,
} from '@/modules/compliance/ui';
import { AgmDialog, FiledDialog, ImportCsvDialog } from '@/modules/compliance/dialogs';

/**
 * Compliance calendar — every statutory obligation of every client, as a
 * month grid or a list. GST and TDS items are merged in read-only and link
 * to their own pages. Filters live in the URL so the dashboard can deep-link
 * (?overdue=1, ?mine=1, ?within=7).
 */
export function ComplianceCalendarPage() {
  const { session } = useAuth();
  const role = session?.role.code;
  const canManage = can(role, 'workstation.compliance.manage', 'self');
  const canRead = canManage || can(role, 'workstation.compliance.read', 'self');
  const isMobile = useIsMobile();
  const toast = useToast();
  const qc = useQueryClient();
  const today = istToday();

  const [params, setParams] = useSearchParams();
  const get = (k: string) => params.get(k) ?? '';
  const set = (k: string, v: string | boolean) => {
    const next = new URLSearchParams(params);
    if (v === '' || v === false) next.delete(k); else next.set(k, v === true ? '1' : v);
    setParams(next, { replace: true });
  };

  const view: 'list' | 'month' = get('view') === 'month' ? 'month' : 'list';
  const month = /^\d{4}-\d{2}$/.test(get('month')) ? get('month') : today.slice(0, 7);
  const within = Number(get('within')) || 0;
  const mine = get('mine') === '1';
  const overdue = get('overdue') === '1';
  const includeOthers = get('include') !== '0';
  const showFiled = get('filed') === '1';
  const [pickedDay, setPickedDay] = useState<string | null>(null);

  const monthStart = `${month}-01`;
  const monthEnd = lastDayOf(month);
  const filters: ItemFilters = {
    client_id: get('client') || undefined,
    authority: get('authority') || undefined,
    form_code: get('form') || undefined,
    status: get('status') || undefined,
    assigned_to: get('assignee') || undefined,
    mine: mine || undefined,
    overdue: overdue || undefined,
    include: includeOthers ? 'gst,tds' : undefined,
    ...(view === 'month'
      ? { from: monthStart, to: monthEnd }
      : within ? { to: addDaysISO(today, within) } : { to: addDaysISO(today, 90) }),
  };

  const forms = useQuery({ queryKey: complianceKeys.forms, queryFn: complianceApi.forms, enabled: canRead, staleTime: 600_000 });
  const items = useQuery({ queryKey: complianceKeys.items(filters), queryFn: () => complianceApi.items(filters), enabled: canRead });
  const clients = useClientOptions(canRead);
  const assignees = useAssignees(canRead);

  const formByCode = useMemo(() => new Map((forms.data ?? []).map((f) => [f.code, f])), [forms.data]);

  const rows = useMemo(() => {
    const list = (items.data ?? []).filter((i) => showFiled || view === 'month' || overdue || get('status') ? true : !isDone(i));
    return [...list].sort((a, b) => a.due_date.localeCompare(b.due_date) || (a.client_name ?? '').localeCompare(b.client_name ?? ''));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.data, showFiled, view, overdue, params]);

  // ── Selection + bulk ──
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const selectedItems = rows.filter((r) => selected.has(r.id));

  const [filing, setFiling] = useState<ComplianceItem[] | null>(null);
  const [agm, setAgm] = useState<ComplianceItem | null>(null);
  const [importing, setImporting] = useState(false);
  const [bulkStatus, setBulkStatus] = useState('');
  const [bulkAssignee, setBulkAssignee] = useState('');

  const patch = useMutation({
    mutationFn: (v: { id: string; body: Parameters<typeof complianceApi.patchItem>[1] }) => complianceApi.patchItem(v.id, v.body),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: complianceKeys.all }); toast.push('success', 'Saved'); },
    onError: (e) => toast.push('error', errorText(e)),
  });
  const bulk = useMutation({
    mutationFn: (body: { status?: string; assigned_employee_id?: string | null }) =>
      complianceApi.bulk({ ids: [...selected], ...body }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: complianceKeys.all });
      const failed = r?.results?.filter((x) => !x.ok).length ?? 0;
      toast.push(failed ? 'error' : 'success', failed ? `${selected.size - failed} updated, ${failed} failed` : `${selected.size} updated`);
      setSelected(new Set()); setBulkStatus(''); setBulkAssignee('');
    },
    onError: (e) => toast.push('error', errorText(e)),
  });

  const applyBulk = () => {
    if (bulkStatus === 'filed') { setFiling(selectedItems); return; }
    const body: { status?: string; assigned_employee_id?: string | null } = {};
    if (bulkStatus) body.status = bulkStatus;
    if (bulkAssignee) body.assigned_employee_id = bulkAssignee === '__none' ? null : bulkAssignee;
    if (Object.keys(body).length) bulk.mutate(body);
  };

  const onStatus = (item: ComplianceItem, status: string) => {
    if (status === 'filed') setFiling([item]);
    else patch.mutate({ id: item.id, body: { status } });
  };

  const exportCsv = () => {
    const head = ['Client code', 'Client', 'Form', 'Form name', 'Authority', 'Period', 'Statutory due', 'Due date',
      'Extension', 'Days left', 'Status', 'Assignee', 'Filed on', 'Acknowledgement', 'Late fee estimate (₹)', 'Late fee note', 'Source'];
    const body = rows.map((i) => {
      const f = formByCode.get(i.form_code);
      const fee = toPaise(i.late_fee_estimate?.amount_paise);
      return [
        i.client_code ?? '', i.client_name ?? '', i.form_code, i.form_name ?? f?.name ?? '', AUTHORITY_LABEL[i.authority ?? f?.authority ?? ''] ?? '',
        i.period_label ?? i.period_key, i.statutory_due_date, i.due_date, i.extension?.reference ?? '',
        i.days_left ?? daysUntil(i.due_date, today) ?? '', i.status,
        i.assigned_employee_name ?? assignees.nameOf(i.assigned_employee_id) ?? '', i.filed_on ?? '', i.acknowledgement_no ?? '',
        fee !== null ? (fee / 100).toFixed(2) : '', i.late_fee_estimate?.note ?? '', i.source ?? 'compliance',
      ];
    });
    downloadText(`compliance-${view === 'month' ? month : today}.csv`, toCsv([head, ...body]));
  };

  if (!canRead) {
    return (
      <div className="max-w-[1400px]">
        <ListHeader title="Compliance" />
        <ListCard><ListEmpty>You do not have access to the compliance calendar.</ListEmpty></ListCard>
      </div>
    );
  }

  const formOptions = (forms.data ?? [])
    .filter((f) => !get('authority') || f.authority === get('authority'))
    .map((f) => ({ value: f.code, label: f.name }));

  const table = (list: ComplianceItem[]) => (
    <ItemsTable
      items={list} today={today} formByCode={formByCode} canManage={canManage}
      selected={selected} onToggle={toggle}
      onToggleAll={(on) => setSelected(on ? new Set(list.filter(editable).map((i) => i.id)) : new Set())}
      assignees={assignees}
      onStatus={onStatus}
      onAssign={(item, id) => patch.mutate({ id: item.id, body: { assigned_employee_id: id || null } })}
      onFiled={(item) => setFiling([item])}
      onAgm={setAgm}
    />
  );

  return (
    <div className="max-w-[1400px]">
      <ListHeader
        title="Compliance"
        meta={<>Income tax, GST, MCA and labour due dates for every client{includeOthers ? ' — GST returns and TDS included' : ''}.</>}
        action={canManage ? (
          <div className="flex flex-wrap items-center gap-2">
            <Link to="/workstation/compliance/extensions" className={smallBtn + ' h-9'}><Settings2 size={14} /> Extensions</Link>
            <button type="button" className={smallBtn + ' h-9'} onClick={() => setImporting(true)}><Upload size={14} /> Import filed status</button>
          </div>
        ) : undefined}
      />

      <ListToolbar>
        <div className="inline-flex rounded-lg border border-neutral-200 bg-white p-0.5" role="radiogroup" aria-label="View">
          {(['list', 'month'] as const).map((v) => (
            <button key={v} type="button" role="radio" aria-checked={view === v} onClick={() => { set('view', v === 'list' ? '' : v); setPickedDay(null); }}
              className={'h-8 px-3 inline-flex items-center gap-1 text-13 rounded ' + (view === v ? 'bg-[#f1edff] text-primary font-medium' : 'text-neutral-600 hover:text-neutral-900')}>
              {v === 'list' ? <List size={14} /> : <CalendarDays size={14} />} {v === 'list' ? 'List' : 'Month'}
            </button>
          ))}
        </div>
        <FilterSelect label="Client" value={get('client')} onChange={(v) => set('client', v)} options={clients.options} />
        <FilterSelect label="Authority" value={get('authority')} onChange={(v) => { set('authority', v); }}
          options={['income_tax', 'gst', 'mca', 'labour'].map((a) => ({ value: a, label: AUTHORITY_LABEL[a] }))} />
        <FilterSelect label="Form" value={get('form')} onChange={(v) => set('form', v)} options={formOptions} />
        <FilterSelect label="Status" value={get('status')} onChange={(v) => set('status', v)} options={ITEM_STATUSES} />
        <FilterSelect label="Assignee" value={get('assignee')} onChange={(v) => set('assignee', v)} options={assignees.options} />
        <TogglePill on={mine} onChange={(v) => set('mine', v)}>Mine</TogglePill>
        <TogglePill on={overdue} onChange={(v) => set('overdue', v)}>Overdue</TogglePill>
        <TogglePill on={includeOthers} onChange={(v) => set('include', v ? '' : '0')}>GST &amp; TDS</TogglePill>
        {view === 'list' ? <TogglePill on={showFiled} onChange={(v) => set('filed', v)}>Show filed</TogglePill> : null}
        {within ? (
          <button type="button" className={smallBtn} onClick={() => set('within', '')} title="Clear the date window">Next {within} days ✕</button>
        ) : null}
        <div className="flex-1" />
        <button type="button" className={smallBtn + ' h-9'} onClick={exportCsv} disabled={!rows.length}><Download size={14} /> Export CSV</button>
      </ListToolbar>

      {canManage && selected.size ? (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-[#cbbdf2] bg-[#f5f1ff] px-4 py-2">
          <span className="text-13 font-medium text-primary">{selected.size} selected</span>
          <select aria-label="Set status" value={bulkStatus} onChange={(e) => setBulkStatus(e.target.value)}
            className="h-8 px-2 text-13 bg-white border border-neutral-200 rounded-lg">
            <option value="">Status: no change</option>
            {ITEM_STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
          <select aria-label="Assign to" value={bulkAssignee} onChange={(e) => setBulkAssignee(e.target.value)}
            className="h-8 px-2 text-13 bg-white border border-neutral-200 rounded-lg max-w-[200px]">
            <option value="">Assignee: no change</option>
            <option value="__none">Unassigned</option>
            {assignees.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <button type="button" className={smallBtn} disabled={(!bulkStatus && !bulkAssignee) || bulk.isPending} onClick={applyBulk}>
            {bulk.isPending ? 'Applying…' : 'Apply'}
          </button>
          <button type="button" className="text-13 text-neutral-600 hover:text-neutral-900 underline" onClick={() => setSelected(new Set())}>Clear</button>
        </div>
      ) : null}

      {view === 'month' ? (
        <ListCard>
          <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-neutral-200">
            <div className="flex items-center gap-2">
              <button type="button" aria-label="Previous month" onClick={() => { set('month', shiftMonth(month, -1)); setPickedDay(null); }}
                className="h-8 w-8 inline-flex items-center justify-center rounded border border-neutral-200 hover:bg-neutral-50"><ChevronLeft size={16} /></button>
              <button type="button" disabled={month === today.slice(0, 7)} onClick={() => { set('month', ''); setPickedDay(null); }}
                className="h-8 px-3 inline-flex items-center gap-1 text-13 rounded border border-neutral-200 hover:bg-neutral-50 disabled:opacity-50">
                <CalendarClock size={14} /> Today
              </button>
              <button type="button" aria-label="Next month" onClick={() => { set('month', shiftMonth(month, 1)); setPickedDay(null); }}
                className="h-8 w-8 inline-flex items-center justify-center rounded border border-neutral-200 hover:bg-neutral-50"><ChevronRight size={16} /></button>
            </div>
            <div className="text-14 font-semibold text-neutral-900">{monthTitle(month)}</div>
          </div>
          <QueryState query={items}>
            {() => (
              <MonthGrid month={month} today={today} items={rows} compact={isMobile} picked={pickedDay}
                onPick={(d) => setPickedDay((p) => (p === d ? null : d))} />
            )}
          </QueryState>
        </ListCard>
      ) : null}

      {view === 'month' && pickedDay ? (
        <div className="mt-4">
          <div className="flex items-center gap-2 mb-2">
            <h2 className="text-15 font-semibold text-neutral-900">Due {day(pickedDay)}</h2>
            <button type="button" className="text-12 text-neutral-500 underline" onClick={() => setPickedDay(null)}>Close</button>
          </div>
          {table(rows.filter((r) => r.due_date === pickedDay))}
        </div>
      ) : null}

      {view === 'list' ? (
        <QueryState query={items}>
          {() => (rows.length ? table(rows) : (
            <ListCard><ListEmpty>
              Nothing due{within ? ` in the next ${within} days` : ''} for these filters.
              {canManage ? <> Switch forms on for a client under its <b>Compliance</b> tab.</> : null}
            </ListEmpty></ListCard>
          ))}
        </QueryState>
      ) : null}

      {filing ? <FiledDialog items={filing} onClose={() => { setFiling(null); setSelected(new Set()); setBulkStatus(''); }} /> : null}
      {agm ? <AgmDialog item={agm} onClose={() => setAgm(null)} /> : null}
      {importing ? <ImportCsvDialog onClose={() => setImporting(false)} /> : null}
    </div>
  );
}

// ── Table ─────────────────────────────────────────────────────────────────

const editable = (i: ComplianceItem) => !i.read_only && (!i.source || i.source === 'compliance');
const isDone = (i: ComplianceItem) => i.status === 'filed' || i.status === 'not_applicable' || i.status === 'completed';

function sourceLink(i: ComplianceItem): string {
  if (i.source === 'tds') return i.link?.startsWith('/workstation/services/tds') ? i.link : `/workstation/services/tds?client=${i.client_id}`;
  // GST returns are worked from the client's page in the GST module.
  return i.link?.startsWith('/workstation/services/registration/gst') ? i.link : `/workstation/services/registration/gst/clients/${i.client_id}`;
}

function ItemsTable({
  items, today, formByCode, canManage, selected, onToggle, onToggleAll, assignees, onStatus, onAssign, onFiled, onAgm,
}: {
  items: ComplianceItem[];
  today: string;
  formByCode: Map<string, ComplianceForm>;
  canManage: boolean;
  selected: Set<string>;
  onToggle: (id: string) => void;
  onToggleAll: (on: boolean) => void;
  assignees: ReturnType<typeof useAssignees>;
  onStatus: (i: ComplianceItem, s: string) => void;
  onAssign: (i: ComplianceItem, id: string) => void;
  onFiled: (i: ComplianceItem) => void;
  onAgm: (i: ComplianceItem) => void;
}) {
  const editableIds = items.filter(editable).map((i) => i.id);
  const allOn = editableIds.length > 0 && editableIds.every((id) => selected.has(id));
  return (
    <ListCard>
      {canManage && editableIds.length ? (
        <label className="flex items-center gap-2 px-5 pt-3 text-12 text-neutral-500">
          <input type="checkbox" checked={allOn} onChange={(e) => onToggleAll(e.target.checked)} /> Select all editable ({editableIds.length})
        </label>
      ) : null}
      <ListTable cols={['Client', 'Form', 'Period', 'Due date', 'Days', 'Status', 'Assignee', 'Filing / late fee', '']}>
        {items.map((i) => {
          const form = formByCode.get(i.form_code);
          const ro = !editable(i);
          const done = isDone(i);
          const days = i.days_left ?? daysUntil(i.due_date, today);
          const late = !done && (i.overdue ?? (days !== null && days < 0));
          const fee = toPaise(i.late_fee_estimate?.amount_paise);
          const isAgm = (form?.anchor ?? '') === 'agm' || i.form_code === 'AGM';
          const assignee = i.assigned_employee_name ?? assignees.nameOf(i.assigned_employee_id);
          return (
            <ListRow key={`${i.source ?? 'c'}:${i.id}`}>
              <TD first>
                <div className="flex items-start gap-2">
                  {canManage && !ro ? (
                    <input type="checkbox" className="mt-1" aria-label={`Select ${i.client_name ?? ''} ${i.form_code}`}
                      checked={selected.has(i.id)} onChange={() => onToggle(i.id)} />
                  ) : null}
                  <TwoLine top={<Link to={`/workstation/clients/${i.client_id}/compliance`} className="hover:underline">{i.client_name ?? '—'}</Link>}
                    sub={i.client_code ?? undefined} />
                </div>
              </TD>
              <TD>
                <TwoLine top={i.form_name ?? form?.name ?? i.form_code}
                  sub={<>{AUTHORITY_LABEL[i.authority ?? form?.authority ?? ''] ?? ''}{ro ? ` · from ${i.source === 'tds' ? 'TDS' : 'GST'}` : ''}</>} />
              </TD>
              <TD nowrap muted>{i.period_label ?? i.period_key}</TD>
              <TD>
                <DueDate due={i.due_date} statutory={i.statutory_due_date} extension={i.extension} />
                {i.anchor_missing ? <div className="mt-0.5"><Chip tone="amber" title="Due date assumes an AGM on 30 September">AGM date not entered</Chip></div> : null}
              </TD>
              <TD nowrap><DaysChip days={days} done={done} /></TD>
              <TD>
                {ro || !canManage ? <StatusChip value={i.status} /> : (
                  <StatusChipSelect value={i.status} options={ITEM_STATUSES} onChange={(s) => onStatus(i, s)} />
                )}
              </TD>
              <TD>
                {ro || !canManage ? <span className="text-neutral-700">{assignee ?? '—'}</span> : (
                  <select aria-label="Assignee" value={i.assigned_employee_id ?? ''} onChange={(e) => onAssign(i, e.target.value)}
                    className="h-8 px-2 text-13 bg-white border border-neutral-200 rounded-lg max-w-[160px]">
                    <option value="">Unassigned</option>
                    {assignees.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                )}
              </TD>
              <TD>
                {done && (i.filed_on || i.acknowledgement_no) ? (
                  <TwoLine top={i.filed_on ? `Filed ${day(i.filed_on)}` : 'Filed'} sub={i.acknowledgement_no ?? undefined} />
                ) : late && i.late_fee_estimate ? (
                  <span title={i.late_fee_estimate.note ?? undefined}>
                    {fee !== null ? <span className="font-medium text-[#b91c1c]">≈ {inr(fee)}</span> : null}
                    <span className="block text-11 text-neutral-500 max-w-[220px]">
                      {fee !== null ? 'estimate so far' : (i.late_fee_estimate.note ?? 'Late fee may apply')}
                    </span>
                  </span>
                ) : <span className="text-neutral-400">—</span>}
              </TD>
              <TD last>
                {ro ? (
                  <Link to={sourceLink(i)} className="inline-flex items-center gap-1 text-13 text-primary hover:underline whitespace-nowrap">
                    Open <ExternalLink size={13} />
                  </Link>
                ) : canManage ? (
                  <div className="flex items-center justify-end gap-1">
                    {isAgm ? <button type="button" className={smallBtn} onClick={() => onAgm(i)}>AGM date</button> : null}
                    {!done ? <button type="button" className={smallBtn} onClick={() => onFiled(i)}>Mark filed</button> : null}
                  </div>
                ) : null}
              </TD>
            </ListRow>
          );
        })}
      </ListTable>
    </ListCard>
  );
}

// ── Month grid (IST date strings throughout) ─────────────────────────────

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function MonthGrid({ month, today, items, compact, picked, onPick }: {
  month: string; today: string; items: ComplianceItem[]; compact: boolean; picked: string | null; onPick: (d: string) => void;
}) {
  const first = `${month}-01`;
  const startDow = new Date(`${first}T00:00:00Z`).getUTCDay();
  const start = addDaysISO(first, -startDow);
  const cells = Array.from({ length: 42 }, (_, i) => addDaysISO(start, i));
  const byDay = new Map<string, ComplianceItem[]>();
  for (const i of items) {
    const b = byDay.get(i.due_date);
    if (b) b.push(i); else byDay.set(i.due_date, [i]);
  }
  return (
    <div>
      <div className="grid grid-cols-7 border-b border-neutral-200 text-11 text-neutral-500">
        {WEEKDAYS.map((d) => <div key={d} className="px-1 py-2 text-center uppercase tracking-[0.06em]">{compact ? d[0] : d}</div>)}
      </div>
      <div className="grid grid-cols-7">
        {cells.map((d) => {
          const list = byDay.get(d) ?? [];
          const other = d.slice(0, 7) !== month;
          const isToday = d === today;
          const open = list.filter((i) => !isDone(i));
          const late = open.length > 0 && d < today;
          return (
            <button key={d} type="button" onClick={() => list.length && onPick(d)}
              className={'text-left border-b border-r border-neutral-100 p-1 flex flex-col gap-0.5 min-w-0 '
                + (compact ? 'min-h-[56px] ' : 'min-h-[112px] ')
                + (other ? 'bg-neutral-50 ' : 'bg-white ')
                + (picked === d ? 'ring-2 ring-inset ring-primary/40 ' : '')
                + (list.length ? 'cursor-pointer hover:bg-neutral-50' : 'cursor-default')}
              aria-label={`${day(d)}: ${list.length} due`}>
              <div className="flex items-center justify-between gap-1">
                <span className={'text-12 h-6 w-6 inline-flex items-center justify-center rounded-full '
                  + (isToday ? 'bg-primary text-white font-semibold' : other ? 'text-neutral-400' : 'text-neutral-700')}>
                  {Number(d.slice(8))}
                </span>
                {compact && list.length ? (
                  <span className={'h-5 min-w-[20px] px-1 rounded-full text-11 font-semibold inline-flex items-center justify-center '
                    + (late ? 'bg-[#fef2f2] text-[#b91c1c]' : open.length ? 'bg-[#f5f1ff] text-[#5b33c4]' : 'bg-[#ecfdf5] text-[#047857]')}>
                    {list.length}
                  </span>
                ) : null}
              </div>
              {!compact ? (
                <>
                  {list.slice(0, 3).map((i) => (
                    <span key={`${i.source ?? 'c'}:${i.id}`} title={`${i.client_name ?? ''} · ${i.form_name ?? i.form_code} · ${i.period_label ?? i.period_key}`}
                      className={'block truncate rounded px-1 py-0.5 text-11 border '
                        + (isDone(i) ? 'bg-[#ecfdf5] text-[#047857] border-[#a7f3d0] line-through opacity-70'
                          : d < today ? 'bg-[#fef2f2] text-[#b91c1c] border-[#fecaca]'
                          : i.extension ? 'bg-[#f5f1ff] text-[#5b33c4] border-[#ddd6fe]'
                          : 'bg-[#f1f5f9] text-[#475569] border-[#e2e8f0]')}>
                      <b className="font-semibold">{i.form_code}</b> {i.client_name}
                    </span>
                  ))}
                  {list.length > 3 ? <span className="text-11 text-neutral-500 px-1">+{list.length - 3} more</span> : null}
                </>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function lastDayOf(month: string): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m, 0));
  return d.toISOString().slice(0, 10);
}
function shiftMonth(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}
function monthTitle(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}
