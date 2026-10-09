import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { BadgeCheck, Plus } from 'lucide-react';
import { QueryState } from '@/modules/workstation/components';
import {
  FilterSelect, ListAction, ListCard, ListEmpty, ListHeader, ListRow, ListTable, ListToolbar, SearchBox, Spacer,
  StatusPills, TD, TogglePill, TwoLine, fmtDay,
} from '@/modules/workstation/listUi';
import { workstationApi } from '@/modules/workstation/api';
import { clientNameWithOrg } from '@/modules/workstation/organization/badges';
import { auditApi } from '@/modules/audit/api';
import { AUDIT_TYPES, Chip, ProgressBar, auditTypeLabel, fyOptions, useMe } from '@/modules/audit/components';
import { NewAuditModal } from './NewAuditModal';

/**
 * /workstation/audits — every audit file the caller can see: one per
 * client × financial year × audit type, with how far its working papers
 * have got and what is still open.
 */

const STATUSES = [
  { value: '', label: 'All' },
  { value: 'planning', label: 'Planning' },
  { value: 'fieldwork', label: 'Fieldwork' },
  { value: 'review', label: 'Review' },
  { value: 'reporting', label: 'Reporting' },
  { value: 'signed', label: 'Signed' },
  { value: 'archived', label: 'Archived' },
];

export function AuditListPage() {
  const navigate = useNavigate();
  const me = useMe();
  const [q, setQ] = useState('');
  const [clientId, setClientId] = useState('');
  const [fy, setFy] = useState('');
  const [type, setType] = useState('');
  const [status, setStatus] = useState('');
  const [mine, setMine] = useState(false);
  const [creating, setCreating] = useState(false);

  const list = useQuery({
    queryKey: ['audits', 'list', { q, clientId, fy, type, status, mine }],
    queryFn: () => auditApi.list({
      q: q.trim() || undefined, client_id: clientId || undefined, financial_year: fy || undefined,
      audit_type: type || undefined, status: status || undefined, mine,
    }),
  });
  const clients = useQuery({ queryKey: ['audits.clients'], queryFn: () => workstationApi.listClients(), staleTime: 120_000 });

  const total = list.data?.total ?? list.data?.count ?? list.data?.items.length;
  const filtered = Boolean(q || clientId || fy || type || status || mine);

  return (
    <div className="max-w-[1400px]">
      <ListHeader
        title="Audit files"
        meta={total === undefined ? 'Loading…' : <>
          {total} file{total === 1 ? '' : 's'} · <Link to="/workstation/audits/udins" className="text-primary hover:underline">UDIN register</Link>
        </>}
        action={me.canManage ? (
          <ListAction onClick={() => setCreating(true)} icon={<Plus size={15} />}>New audit file</ListAction>
        ) : null}
      />

      <ListToolbar>
        <SearchBox value={q} onChange={setQ} placeholder="Code, title or client" />
        <FilterSelect label="Client" value={clientId} onChange={setClientId}
          options={(clients.data?.items ?? []).map((c) => ({ value: c.id, label: clientNameWithOrg(c) }))} />
        <FilterSelect label="FY" value={fy} onChange={setFy} options={fyOptions().map((y) => ({ value: y, label: y }))} />
        <FilterSelect label="Type" value={type} onChange={setType} options={AUDIT_TYPES} />
        <TogglePill on={mine} onChange={setMine}>My audits</TogglePill>
        <Spacer />
        <StatusPills options={STATUSES} value={status} onChange={setStatus} />
      </ListToolbar>

      <ListCard>
        <QueryState query={list}>
          {(data) => data.items.length === 0 ? (
            filtered ? <ListEmpty>Nothing matches these filters.</ListEmpty> : (
              <div className="px-5 py-10 text-center max-w-[560px] mx-auto">
                <BadgeCheck size={28} className="mx-auto text-primary mb-3" strokeWidth={1.5} />
                <div className="text-14 font-semibold text-neutral-900">No audit files yet</div>
                <p className="text-13 text-neutral-500 mt-1">
                  An audit file holds one engagement — client acceptance, team independence, materiality, risks,
                  working papers with preparer and reviewer sign-offs, review notes, CARO / Form 3CD checklists and the
                  UDIN — and is locked once assembled, as SA 230 requires.
                </p>
                {me.canManage ? (
                  <button type="button" onClick={() => setCreating(true)} className="mt-4 h-9 px-4 inline-flex items-center gap-2 text-13 font-medium rounded-lg bg-primary text-white hover:bg-primaryHover">
                    <Plus size={15} /> New audit file
                  </button>
                ) : null}
              </div>
            )
          ) : (
            <ListTable cols={['File', 'Client', 'FY', 'Type', 'Status', 'Signing partner', 'Report by', 'Progress', { label: 'Open notes', align: 'right' }]}>
              {data.items.map((a) => (
                <ListRow key={a.id} onOpen={() => navigate(`/workstation/audits/${a.id}`)}>
                  <TD first><div className="min-w-[150px]"><TwoLine top={<span className="tracking-[0.02em] whitespace-nowrap">{a.audit_code}</span>} sub={a.title} /></div></TD>
                  <TD><TwoLine avatar={a.client?.company_name ?? '—'} square top={a.client?.company_name ?? '—'} /></TD>
                  <TD muted nowrap>{a.financial_year}</TD>
                  <TD muted nowrap>{auditTypeLabel(a.audit_type)}</TD>
                  <TD nowrap>
                    <span className="inline-flex items-center gap-1">
                      <Chip value={a.status} />
                      {a.locked || a.locked_at ? <Chip value="locked" text="Locked" /> : null}
                    </span>
                  </TD>
                  <TD muted nowrap>{a.signing_partner_name ?? '—'}</TD>
                  <TD muted nowrap>{fmtDay(a.report_date ?? a.planned_report_date)}</TD>
                  <TD><ProgressBar done={a.progress?.working_papers.reviewed ?? 0} total={a.progress?.working_papers.total ?? 0} /></TD>
                  <TD last right nowrap className="tabular-nums">
                    {(a.progress?.review_notes_open ?? 0) > 0
                      ? <span className="font-semibold text-danger">{a.progress?.review_notes_open}</span>
                      : <span className="text-neutral-400">0</span>}
                  </TD>
                </ListRow>
              ))}
            </ListTable>
          )}
        </QueryState>
      </ListCard>

      {creating ? <NewAuditModal open onClose={() => setCreating(false)} /> : null}
    </div>
  );
}
