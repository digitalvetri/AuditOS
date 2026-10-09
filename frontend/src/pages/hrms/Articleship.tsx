/**
 * Articleship register (HRMS) — every articled assistant with principal,
 * training period and year, leave allowed / taken / excess under the ICAI
 * one-sixth rule, the extended end date, ICAI form status and stipend.
 * Leave figures are computed by the server from approved leave.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil } from 'lucide-react';
import { useAuth } from '@/platform/auth/AuthContext';
import { can } from '@/platform/rbac/can';
import { useToast } from '@/components/Toast';
import { Button } from '@/components/Button';
import { inr } from '@/lib/format';
import { Modal, QueryState, fieldErrors } from '@/modules/workstation/components';
import { ListCard, ListEmpty, ListHeader, ListRow, ListTable, ListToolbar, SearchBox, TD, TwoLine } from '@/modules/workstation/listUi';
import { Chip, Labelled, day, errorText, fieldClass, smallBtn, type ChipTone } from '@/modules/compliance/ui';
import { employeeApi, rupeesToPaise } from '@/modules/employees/api';
import {
  articleshipApi, articleshipKeys, type ArticleshipRow, type FormState, type TrainingPatch,
} from '@/modules/articleship/api';

const STATUS_TONE: Record<string, ChipTone> = { active: 'green', transferred: 'blue', completed: 'grey', terminated: 'red' };
const FORM_TONE: Record<FormState, ChipTone> = { filed: 'green', due: 'amber', overdue: 'red', not_due: 'grey' };

function FormChip({ label, state, date }: { label: string; state: FormState; date: string | null }) {
  if (state === 'not_due') return null;
  return (
    <Chip tone={FORM_TONE[state]} title={date ? `Filed ${day(date)}` : undefined}>
      {label}{state === 'filed' ? ' ✓' : state === 'overdue' ? ' overdue' : ' due'}
    </Chip>
  );
}

export function ArticleshipPage() {
  const { session } = useAuth();
  const role = session?.role.code;
  const canManage = can(role, 'employee.manage', 'organisation');
  const canRead = canManage || can(role, 'employee.read', 'organisation');
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<ArticleshipRow | null>(null);

  const list = useQuery({ queryKey: articleshipKeys.all, queryFn: articleshipApi.list, enabled: canRead });
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (list.data?.items ?? []).filter((r) => !needle || [r.employee.full_name, r.principal?.full_name, r.training?.icai_registration_no]
      .some((x) => (x ?? '').toLowerCase().includes(needle)));
  }, [list.data, q]);

  if (!canRead) {
    return <div className="max-w-[1400px]"><ListHeader title="Articleship" /><ListCard><ListEmpty>You do not have access to the articleship register.</ListEmpty></ListCard></div>;
  }

  return (
    <div className="max-w-[1400px]">
      <ListHeader
        title="Articleship"
        meta="Articled assistants under the CA Regulations — leave is allowed up to one-sixth of the period served; excess leave extends the training."
      />
      <ListToolbar>
        <SearchBox value={q} onChange={setQ} placeholder="Assistant, principal, ICAI no." />
      </ListToolbar>
      <QueryState query={list}>
        {() => rows.length ? (
          <ListCard>
            <ListTable cols={['Assistant', 'Principal', 'Period', 'Leave (allowed / taken)', 'Ends', 'ICAI forms', 'Stipend', '']}>
              {rows.map((r) => {
                const t = r.training;
                const l = r.leave;
                return (
                  <ListRow key={r.employee.id}>
                    <TD first>
                      <Link to={`/hrms/employees/${r.employee.id}`} className="hover:underline">
                        <TwoLine top={r.employee.full_name} sub={t?.icai_registration_no || r.employee.employee_code} />
                      </Link>
                    </TD>
                    <TD>{r.principal?.full_name ?? '—'}</TD>
                    <TD nowrap>
                      {t ? (
                        <span className="flex flex-col items-start gap-0.5">
                          <span>{day(t.training_start)} – {day(t.training_end)}</span>
                          <span className="flex items-center gap-1 text-12 text-neutral-500">
                            Year {t.current_year}
                            <Chip tone={STATUS_TONE[t.status] ?? 'grey'} dot={false}>{t.status}</Chip>
                          </span>
                        </span>
                      ) : <span className="text-neutral-500">No training record</span>}
                    </TD>
                    <TD nowrap>
                      {l ? (
                        <span className="flex flex-col items-start gap-0.5">
                          <span>{l.leave_allowed_days} / {l.leave_taken_days} days</span>
                          {l.excess_leave_days > 0
                            ? <Chip tone="red">{l.excess_leave_days} day{l.excess_leave_days === 1 ? '' : 's'} excess</Chip>
                            : <span className="text-12 text-neutral-500">of {l.leave_allowed_full_term_days} for the full term</span>}
                        </span>
                      ) : '—'}
                    </TD>
                    <TD nowrap>
                      {t ? (
                        <span className="flex flex-col items-start gap-0.5">
                          <span>{day(t.extended_training_end ?? t.training_end)}</span>
                          {t.extended_training_end ? <span className="text-12 text-neutral-500">extended from {day(t.training_end)}</span> : null}
                        </span>
                      ) : '—'}
                    </TD>
                    <TD>
                      {r.forms ? (
                        <span className="flex flex-wrap gap-1" title={r.forms.alerts.join('\n') || undefined}>
                          <FormChip label="102" {...r.forms.form102} />
                          <FormChip label="103" {...r.forms.form103} />
                          <FormChip label="108" {...r.forms.form108} />
                          <FormChip label="109" {...r.forms.form109} />
                        </span>
                      ) : '—'}
                    </TD>
                    <TD nowrap>{t?.stipend_paise != null ? `${inr(t.stipend_paise)}/mo` : <span className="text-neutral-500">{t?.stipend_slab || '—'}</span>}</TD>
                    <TD last>
                      {canManage ? (
                        <div className="flex justify-end">
                          <button type="button" className={smallBtn} onClick={() => setEditing(r)}>
                            <Pencil size={13} /> {t ? 'Edit' : 'Add'}
                          </button>
                        </div>
                      ) : null}
                    </TD>
                  </ListRow>
                );
              })}
            </ListTable>
          </ListCard>
        ) : <ListCard><ListEmpty>{q ? 'No assistant matches.' : 'No articled assistants. Add an employee of type “Articled” to start the register.'}</ListEmpty></ListCard>}
      </QueryState>
      {editing ? <ArticleshipForm row={editing} onClose={() => setEditing(null)} /> : null}
    </div>
  );
}

function ArticleshipForm({ row, onClose }: { row: ArticleshipRow; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const t = row.training;
  const staff = useQuery({ queryKey: ['employees', 'principal-options'], queryFn: () => employeeApi.list({ status: 'active' }) });
  const principals = (staff.data?.items ?? [])
    .map((e) => e as unknown as { id: string; full_name: string; type?: string })
    .filter((e) => e.type !== 'articled');
  const [f, setF] = useState({
    principal_employee_id: t?.principal_employee_id ?? '',
    icai_registration_no: t?.icai_registration_no ?? '',
    icai_region: t?.icai_region ?? '',
    training_start: t?.training_start ?? '',
    training_end: t?.training_end ?? '',
    current_year: String(t?.current_year ?? 1),
    status: t?.status ?? 'active',
    stipend: t?.stipend_paise != null ? String(t.stipend_paise / 100) : '',
    stipend_slab: t?.stipend_slab ?? '',
    form102_date: t?.form102_date ?? '',
    form103_date: t?.form103_date ?? '',
    form108_date: t?.form108_date ?? '',
    form109_date: t?.form109_date ?? '',
  });
  const up = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }));
  const save = useMutation({
    mutationFn: () => {
      const body: TrainingPatch = {
        principal_employee_id: f.principal_employee_id || undefined,
        icai_registration_no: f.icai_registration_no.trim(),
        icai_region: f.icai_region.trim() || null,
        training_start: f.training_start || undefined,
        training_end: f.training_end || undefined,
        current_year: Number(f.current_year) as 1 | 2 | 3,
        status: f.status as TrainingPatch['status'],
        stipend_paise: rupeesToPaise(f.stipend),
        stipend_slab: f.stipend_slab.trim(),
        form102_date: f.form102_date || null,
        form103_date: f.form103_date || null,
        form108_date: f.form108_date || null,
        form109_date: f.form109_date || null,
      };
      return articleshipApi.save(row.employee.id, body);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: articleshipKeys.all });
      void qc.invalidateQueries({ queryKey: ['employee', row.employee.id, 'training'] });
      toast.push('success', 'Articleship saved');
      onClose();
    },
    onError: (e) => toast.push('error', errorText(e)),
  });
  const errs = fieldErrors(save.error);
  const date = (k: keyof typeof f, label: string, hint?: string) => (
    <Labelled label={label} hint={errs[k] ?? hint}>
      <input type="date" className={fieldClass} value={f[k]} onChange={up(k)} />
    </Labelled>
  );
  return (
    <Modal open title={`Articleship — ${row.employee.full_name}`} onClose={onClose} width="w-[680px]"
      footer={<>
        <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
        <Button size="sm" variant="primary" disabled={!f.principal_employee_id || !f.training_start || !f.training_end || save.isPending} onClick={() => save.mutate()}>Save</Button>
      </>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Labelled label="Principal" hint={errs.principal_employee_id}>
          <select className={fieldClass} value={f.principal_employee_id} onChange={up('principal_employee_id')}>
            <option value="">Choose the principal…</option>
            {principals.map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}
          </select>
        </Labelled>
        <Labelled label="ICAI registration no.">
          <input className={fieldClass} value={f.icai_registration_no} onChange={up('icai_registration_no')} />
        </Labelled>
        <Labelled label="ICAI region / branch">
          <input className={fieldClass} value={f.icai_region} onChange={up('icai_region')} placeholder="SIRC — Chennai" />
        </Labelled>
        <Labelled label="Status">
          <select className={fieldClass} value={f.status} onChange={up('status')}>
            {['active', 'transferred', 'completed', 'terminated'].map((s) => <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>)}
          </select>
        </Labelled>
        {date('training_start', 'Training start')}
        {date('training_end', 'Training end', t?.extended_training_end ? `Extended to ${day(t.extended_training_end)} for excess leave.` : undefined)}
        <Labelled label="Current year">
          <select className={fieldClass} value={f.current_year} onChange={up('current_year')}>
            {[1, 2, 3].map((y) => <option key={y} value={y}>Year {y}</option>)}
          </select>
        </Labelled>
        <Labelled label="Monthly stipend (₹)" hint="Payroll pays this as the monthly amount, with no PF.">
          <input className={fieldClass} inputMode="decimal" value={f.stipend} onChange={up('stipend')} placeholder="e.g. 9000" />
        </Labelled>
        <Labelled label="Stipend slab" className="sm:col-span-2">
          <input className={fieldClass} value={f.stipend_slab} onChange={up('stipend_slab')} />
        </Labelled>
        {date('form102_date', 'Form 102 filed (registration)')}
        {date('form103_date', 'Form 103 filed (commencement)', f.training_start ? 'Due within 30 days of commencement.' : undefined)}
        {date('form108_date', 'Form 108 filed (completion / termination)')}
        {date('form109_date', 'Form 109 filed (transfer)')}
      </div>
    </Modal>
  );
}
