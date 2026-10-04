/**
 * "Post-Registration Compliance" on a registration service's own Dashboard
 * (the LLP Dashboard, below Client Progress). Separate from the registration
 * tiles above it: those count registration work, this counts what falls due
 * AFTER incorporation. Everything comes from the compliance endpoint — the
 * cards, reminders and table are the live records, nothing is hard-coded.
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { fmtDate } from '@/lib/format';
import { Card, Cell, PageHeader, QueryState, Row, Table, inputClass } from '@/modules/workstation/components';
import { postRegistrationApi, postRegistrationKeys, type ComplianceItem, type ComplianceKind, type ComplianceStatus } from './api';
import { ComplianceStatusBadge, REG_NO_LABEL, daysClass, daysText } from './ui';

type Filter = 'ALL' | 'UPCOMING' | 'DUE_SOON' | 'DUE_TODAY' | 'OVERDUE' | 'COMPLETED';

/** Upcoming includes the ones still awaiting their date (Not Started). */
const inFilter = (f: Filter, s: ComplianceStatus) => f === 'ALL' || s === f || (f === 'UPCOMING' && s === 'NOT_STARTED');

const ENTITY: Record<ComplianceKind, string> = { LLP: 'LLP', PRIVATE_LIMITED: 'Company' };

/**
 * LLP → Post-Registration Compliance tab: the same section as on the LLP
 * Dashboard, as its own page (like Private Limited's tab).
 */
export function LlpCompliancePage() {
  return (
    <>
      <PageHeader
        title="Post-Registration Compliance"
        subtitle="LLP Form 3 – Initial LLP Agreement is due 30 days after the Date of Incorporation. Reminders go to the case team at 20, 10 and 3 days left, on the due date, and weekly while overdue."
      />
      <RegistrationComplianceSection kind="LLP" base="/workstation/services/registration/llp" heading={false} />
    </>
  );
}

export function RegistrationComplianceSection({ kind, base, heading = true }: { kind: ComplianceKind; base: string; heading?: boolean }) {
  const navigate = useNavigate();
  const q = useQuery({ queryKey: postRegistrationKeys.list({ kind }), queryFn: () => postRegistrationApi.list({ kind }) });
  const [filter, setFilter] = useState<Filter>('ALL');
  const [search, setSearch] = useState('');
  const [client, setClient] = useState('');
  const [type, setType] = useState('');
  const [staff, setStaff] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const all = q.data?.items ?? [];
  const options = useMemo(() => {
    const uniq = (pairs: [string, string][]) => [...new Map(pairs).entries()].sort((a, b) => a[1].localeCompare(b[1]));
    return {
      clients: uniq(all.map((i) => [i.client.id, i.client.name])),
      types: uniq(all.map((i) => [i.code, i.title])),
      staff: uniq(all.flatMap((i) => (i.assigned_to ? [[i.assigned_to.id, i.assigned_to.name] as [string, string]] : []))),
    };
  }, [all]);

  const needle = search.trim().toLowerCase();
  const matches = (i: ComplianceItem) =>
    (!client || i.client.id === client)
    && (!type || i.code === type)
    && (!staff || (staff === '-' ? !i.assigned_to : i.assigned_to?.id === staff))
    && (!from || (!!i.due_date && i.due_date >= from))
    && (!to || (!!i.due_date && i.due_date <= to))
    && (!needle || [i.client.name, i.registration_number ?? '', i.title, i.label, i.assigned_to?.name ?? ''].some((v) => v.toLowerCase().includes(needle)));
  const scoped = all.filter(matches);
  const rows = scoped.filter((i) => inFilter(filter, i.status));
  const count = (f: Filter) => scoped.filter((i) => inFilter(f, i.status)).length;
  const awaitingDate = scoped.filter((i) => i.status === 'NOT_STARTED').length;
  // Reminders: anything overdue, due today, or due within 20 days.
  const reminders = scoped
    .filter((i) => i.reminder_message && i.days_remaining !== null && i.days_remaining <= 20)
    .sort((a, b) => (a.days_remaining ?? 0) - (b.days_remaining ?? 0));
  const filtered = !!(search || client || type || staff || from || to);

  const cards: { key: Filter; label: string; note?: string; tone: string }[] = [
    { key: 'ALL', label: 'Total Compliance', tone: 'text-neutral-900' },
    { key: 'UPCOMING', label: 'Upcoming', note: awaitingDate ? `${awaitingDate} awaiting date` : undefined, tone: 'text-neutral-900' },
    { key: 'DUE_SOON', label: 'Due Soon', tone: 'text-amber' },
    { key: 'DUE_TODAY', label: 'Due Today', tone: 'text-amber' },
    { key: 'OVERDUE', label: 'Overdue', tone: 'text-red' },
    { key: 'COMPLETED', label: 'Completed', tone: 'text-green-700' },
  ];
  const sel = inputClass + ' !h-9 min-w-0';

  return (
    <section className={heading ? 'mt-6' : ''} data-testid="post-registration-compliance" aria-label="Post-Registration Compliance">
      <div className={`flex flex-wrap items-baseline gap-x-3 gap-y-1 mb-3 ${heading ? '' : 'hidden'}`}>
        <h2 id="prc-title" className="text-[18px] font-semibold text-neutral-900">Post-Registration Compliance</h2>
        <span className="text-12 text-neutral-500">
          After incorporation — separate from registration work above{q.data ? ` · today ${fmtDate(q.data.today)}` : ''}
        </span>
      </div>

      <QueryState query={q}>
        {() => (
          <>
            <div className="reg-tiles grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3 mb-4" role="group" aria-label="Filter compliance by status">
              {cards.map((c) => {
                const n = count(c.key);
                return (
                  <button
                    key={c.key}
                    type="button"
                    aria-pressed={filter === c.key}
                    onClick={() => setFilter(filter === c.key ? 'ALL' : c.key)}
                    className={`reg-tile text-left bg-white border rounded-lg px-4 py-3 transition-all hover:border-primary/40 hover:shadow-raised ${filter === c.key ? 'border-primary ring-1 ring-primary/40' : 'border-neutral-200'}`}
                  >
                    <div className="text-12 text-neutral-500">{c.label}</div>
                    <div className={`text-[24px] leading-tight font-semibold mt-1 tabular-nums ${n > 0 ? c.tone : 'text-neutral-900'}`}>{n}</div>
                    {c.note ? <div className="text-11 text-neutral-500 mt-0.5">{c.note}</div> : null}
                  </button>
                );
              })}
            </div>

            {reminders.length ? (
              <Card title="Reminders" className="mb-4">
                <ul className="divide-y divide-neutral-100">
                  {reminders.slice(0, 6).map((i) => (
                    <li key={i.id} className="px-5 py-2.5 flex items-center gap-3 text-13">
                      <ComplianceStatusBadge status={i.status} />
                      <span className={`flex-1 min-w-0 ${daysClass(i)}`}>{i.reminder_message}</span>
                      <button type="button" className="underline text-neutral-700 hover:text-neutral-900 shrink-0" onClick={() => navigate(`${base}/clients/${i.case.id}?tab=compliance`)}>View</button>
                    </li>
                  ))}
                </ul>
                {reminders.length > 6 ? <div className="px-5 pb-2 text-12 text-neutral-500">+{reminders.length - 6} more in the table below.</div> : null}
              </Card>
            ) : null}

            <Card title="Post-Registration Compliance">
              <div className="px-5 py-3 border-b border-neutral-200 grid gap-2 grid-cols-1 sm:grid-cols-2 lg:grid-cols-[minmax(200px,1.4fr)_repeat(3,minmax(140px,1fr))_auto_auto_auto] items-end">
                <input className={sel} placeholder={`Search ${ENTITY[kind]}, ${REG_NO_LABEL[kind]}, compliance, staff…`} value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search compliance" />
                <select className={sel} value={client} onChange={(e) => setClient(e.target.value)} aria-label={ENTITY[kind]}>
                  <option value="">All {kind === 'LLP' ? 'LLPs' : 'companies'}</option>
                  {options.clients.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
                </select>
                <select className={sel} value={type} onChange={(e) => setType(e.target.value)} aria-label="Compliance type">
                  <option value="">All types</option>
                  {options.types.map(([code, title]) => <option key={code} value={code}>{title}</option>)}
                </select>
                <select className={sel} value={staff} onChange={(e) => setStaff(e.target.value)} aria-label="Assigned staff">
                  <option value="">All staff</option>
                  <option value="-">Unassigned</option>
                  {options.staff.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
                </select>
                <label className="block">
                  <span className="block text-11 text-neutral-500 mb-0.5">Due from</span>
                  <input type="date" className={sel} value={from} onChange={(e) => setFrom(e.target.value)} />
                </label>
                <label className="block">
                  <span className="block text-11 text-neutral-500 mb-0.5">Due to</span>
                  <input type="date" className={sel} value={to} onChange={(e) => setTo(e.target.value)} />
                </label>
                {filtered || filter !== 'ALL' ? (
                  <button
                    type="button"
                    className="h-9 px-3 text-13 underline text-neutral-600 hover:text-neutral-900 justify-self-start"
                    onClick={() => { setSearch(''); setClient(''); setType(''); setStaff(''); setFrom(''); setTo(''); setFilter('ALL'); }}
                  >
                    Clear
                  </button>
                ) : null}
              </div>
              {rows.length === 0 ? (
                <div className="px-5 py-6 text-13 text-neutral-500">
                  {all.length === 0
                    ? `No post-registration compliance yet. It starts when an ${ENTITY[kind]} registration is marked Completed.`
                    : 'No compliance matches these filters.'}
                </div>
              ) : (
                <Table head={[ENTITY[kind], 'Compliance', 'Trigger Date', 'Due Date', 'Days Remaining', 'Status', 'Assigned To', 'Action']}>
                  {rows.map((i) => (
                    <Row key={i.id} status={i.status === 'OVERDUE' ? 'overdue' : undefined} onClick={() => navigate(`${base}/clients/${i.case.id}?tab=compliance`)}>
                      <Cell>
                        <div className="font-medium">{i.client.name}</div>
                        <div className="text-12 text-neutral-500">{i.registration_number ? `${REG_NO_LABEL[kind]} ${i.registration_number}` : i.case.code}</div>
                      </Cell>
                      <Cell>{i.title}</Cell>
                      <Cell className="whitespace-nowrap tabular-nums">{i.trigger_date ? fmtDate(i.trigger_date) : <span className="text-neutral-400">Awaiting Incorporation Date</span>}</Cell>
                      <Cell className="whitespace-nowrap tabular-nums">{i.due_date ? fmtDate(i.due_date) : '—'}</Cell>
                      <Cell className={`whitespace-nowrap ${daysClass(i)}`}>{daysText(i)}</Cell>
                      <Cell><ComplianceStatusBadge status={i.status} /></Cell>
                      <Cell muted>{i.assigned_to?.name ?? '—'}</Cell>
                      <Cell>
                        <button
                          type="button"
                          className="underline text-neutral-900"
                          onClick={(e) => { e.stopPropagation(); navigate(`${base}/clients/${i.case.id}?tab=compliance`); }}
                        >
                          View
                        </button>
                      </Cell>
                    </Row>
                  ))}
                </Table>
              )}
            </Card>
          </>
        )}
      </QueryState>
    </section>
  );
}
