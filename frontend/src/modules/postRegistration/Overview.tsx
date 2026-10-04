/**
 * Private Limited → Post-Registration Compliance tab. One row per company:
 * INC-20A and ADTC side by side with the due date, days remaining, status and
 * when the next reminder notification goes out. Same endpoint as the case tab
 * and the main Dashboard.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { fmtDate } from '@/lib/format';
import { Card, PageHeader, QueryState, inputClass } from '@/modules/workstation/components';
import { postRegistrationApi, postRegistrationKeys, type ComplianceItem, type ComplianceStatus } from './api';
import { ComplianceStatusBadge, daysClass, daysText } from './ui';

type Filter = 'PENDING' | 'DUE_SOON' | 'OVERDUE' | 'COMPLETED' | 'ALL';

interface CompanyRow {
  caseId: string;
  caseCode: string;
  client: string;
  incorporated: string | null;
  inc?: ComplianceItem;
  adtc?: ComplianceItem;
}

const URGENCY: Record<ComplianceStatus, number> = { OVERDUE: 0, DUE_TODAY: 1, DUE_SOON: 2, UPCOMING: 3, NOT_STARTED: 4, COMPLETED: 5 };
const urgency = (r: CompanyRow) => Math.min(...[r.inc, r.adtc].map((i) => (i ? URGENCY[i.status] : 9)));
const soonest = (r: CompanyRow) => [r.inc, r.adtc].map((i) => (i && i.status !== 'COMPLETED' ? i.due_date ?? '9' : '9')).sort()[0];
const any = (r: CompanyRow, f: (s: ComplianceStatus) => boolean) => [r.inc, r.adtc].some((i) => i && f(i.status));

const matches: Record<Filter, (r: CompanyRow) => boolean> = {
  PENDING: (r) => any(r, (s) => s !== 'COMPLETED'),
  DUE_SOON: (r) => any(r, (s) => s === 'DUE_SOON' || s === 'DUE_TODAY'),
  OVERDUE: (r) => any(r, (s) => s === 'OVERDUE'),
  COMPLETED: (r) => !any(r, (s) => s !== 'COMPLETED'),
  ALL: () => true,
};

function ComplianceCell({ i }: { i?: ComplianceItem }) {
  if (!i) return <span className="text-neutral-400">—</span>;
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 flex-wrap">
        <ComplianceStatusBadge status={i.status} />
        <span className={`text-13 whitespace-nowrap ${daysClass(i)}`}>{daysText(i)}</span>
      </div>
      {i.status !== 'COMPLETED' ? (
        <div className="text-12 text-neutral-500 tabular-nums">
          {i.due_date ? `Due ${fmtDate(i.due_date)}` : 'Enter the date on the case'}
          {i.next_reminder ? ` · next reminder ${fmtDate(i.next_reminder)}` : ''}
        </div>
      ) : null}
    </div>
  );
}

export function PostRegistrationOverview() {
  const q = useQuery({ queryKey: postRegistrationKeys.list({ kind: 'PRIVATE_LIMITED' }), queryFn: () => postRegistrationApi.list({ kind: 'PRIVATE_LIMITED' }) });
  const [filter, setFilter] = useState<Filter>('PENDING');
  const [search, setSearch] = useState('');

  const companies = useMemo(() => {
    const byCase = new Map<string, CompanyRow>();
    for (const i of q.data?.items ?? []) {
      const r = byCase.get(i.case.id) ?? { caseId: i.case.id, caseCode: i.case.code, client: i.client.name, incorporated: null };
      if (i.code === 'INC_20A') { r.inc = i; r.incorporated = i.trigger_date; } else if (i.code === 'ADTC') r.adtc = i;
      byCase.set(i.case.id, r);
    }
    return [...byCase.values()].sort((a, b) => urgency(a) - urgency(b) || soonest(a).localeCompare(soonest(b)) || a.client.localeCompare(b.client));
  }, [q.data]);

  const needle = search.trim().toLowerCase();
  const rows = companies.filter((r) => matches[filter](r) && (!needle || r.client.toLowerCase().includes(needle) || r.caseCode.toLowerCase().includes(needle)));
  const count = (f: Filter) => companies.filter(matches[f]).length;
  const every = (code: string) => q.data?.items.find((i) => i.code === code)?.reminder_every_days;
  const cards: { key: Filter; label: string; tone: string }[] = [
    { key: 'PENDING', label: 'Pending', tone: 'bg-blue-50' },
    { key: 'DUE_SOON', label: 'Due Soon', tone: 'bg-amber-50' },
    { key: 'OVERDUE', label: 'Overdue', tone: 'bg-red-50' },
    { key: 'COMPLETED', label: 'All Done', tone: 'bg-green-50' },
    { key: 'ALL', label: 'All Companies', tone: 'bg-white' },
  ];

  return (
    <>
      <PageHeader
        title="Post-Registration Compliance"
        subtitle={
          <>
            INC-20A is due 180 days and ADTC 30 days after the Date of Incorporation. Reminders go to the case team every{' '}
            {every('INC_20A') ?? 20} days for INC-20A and every {every('ADTC') ?? 7} days for ADTC until each is marked completed.
          </>
        }
      />
      <QueryState query={q}>
        {() => (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-5" role="group" aria-label="Filter companies">
              {cards.map((c) => (
                <button
                  key={c.key}
                  type="button"
                  aria-pressed={filter === c.key}
                  onClick={() => setFilter(c.key)}
                  className={`text-left rounded-lg px-4 py-3 border transition ${c.tone} ${filter === c.key ? 'border-neutral-900 ring-1 ring-neutral-900' : 'border-neutral-200 hover:border-neutral-300'}`}
                >
                  <div className="text-12 text-neutral-500">{c.label}</div>
                  <div className={`text-[24px] leading-tight font-semibold mt-1 tabular-nums ${c.key === 'OVERDUE' && count('OVERDUE') ? 'text-red' : 'text-neutral-900'}`}>{count(c.key)}</div>
                </button>
              ))}
            </div>

            <Card
              title="Companies"
              right={<input className={inputClass + ' w-56'} placeholder="Search company or case…" value={search} onChange={(e) => setSearch(e.target.value)} />}
            >
              <div className="overflow-x-auto">
                <table className="w-full text-13">
                  <thead>
                    <tr className="text-left text-11 uppercase tracking-[0.06em] text-neutral-500 border-b border-neutral-200">
                      <th className="px-5 py-2 font-medium">Company</th>
                      <th className="px-3 py-2 font-medium">Incorporated</th>
                      <th className="px-3 py-2 font-medium">INC-20A · 180 days</th>
                      <th className="px-3 py-2 font-medium">ADTC · 30 days</th>
                      <th className="px-5 py-2 font-medium text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="px-5 py-6 text-neutral-500">
                          {companies.length === 0
                            ? 'No completed Private Limited registrations yet. INC-20A and ADTC start when a case is marked Completed.'
                            : 'No companies in this view.'}
                        </td>
                      </tr>
                    ) : rows.map((r) => (
                      <tr key={r.caseId} className="border-b border-neutral-100 last:border-b-0 align-top">
                        <td className="px-5 py-3">
                          <div className="font-medium text-neutral-900">{r.client}</div>
                          <div className="text-12 text-neutral-500">{r.caseCode}</div>
                        </td>
                        <td className="px-3 py-3 whitespace-nowrap tabular-nums">{r.incorporated ? fmtDate(r.incorporated) : <span className="text-neutral-400">Not entered</span>}</td>
                        <td className="px-3 py-3"><ComplianceCell i={r.inc} /></td>
                        <td className="px-3 py-3"><ComplianceCell i={r.adtc} /></td>
                        <td className="px-5 py-3 text-right">
                          <Link className="underline text-neutral-900" to={`../clients/${r.caseId}?tab=compliance`}>View</Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </>
        )}
      </QueryState>
    </>
  );
}
