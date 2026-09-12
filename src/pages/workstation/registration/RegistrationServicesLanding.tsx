/**
 * Registration board — Workstation → Services → Registration.
 *
 * A record of registrations actually DONE, not a catalogue of ones on offer.
 * Each row is a registration recorded against a client: which client, which
 * registration, the document they hold, its version and verification state,
 * and when it was recorded.
 *
 * WHERE THE ROWS COME FROM: the run panel on each registration's page files
 * its outcome through the client-documents API, so a "registration done" is
 * exactly a client document whose name matches a catalogue entry's
 * `outputDocument`. There is no separate registrations table and this screen
 * does not invent one — it reads what Workstation → Documents already holds.
 *
 * The ten registrations themselves are reached from the sidebar
 * (Workstation → Services → Registration), which lists every one.
 *
 * NOTHING HERE IS CHECKED AGAINST A GOVERNMENT SYSTEM. A row means an
 * employee recorded an outcome, not that a portal confirmed one.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { workstationApi } from '@/modules/workstation/api';
import {
  Cell, FilterBar, PageHeader, QueryState, Row, SearchInput, Select, Status, Table,
} from '@/modules/workstation/components';
import { fmtDate } from '@/lib/format';
import type { ClientDocument } from '@/modules/workstation/types';
import { KIND_TINT, REGISTRATION_SERVICES, type RegistrationService } from './services';

/**
 * `outputDocument` → the registration that produces it. Built once; it is the
 * only link between a stored document and this module, so a registration
 * renamed in the catalogue stops matching its old rows on purpose rather than
 * silently mis-labelling them.
 */
const BY_OUTPUT = new Map<string, RegistrationService>(
  REGISTRATION_SERVICES.map((s) => [s.outputDocument, s]),
);

/** A document that is one of our registrations, paired with which one. */
interface RegistrationRecord {
  doc: ClientDocument;
  service: RegistrationService;
  /** When the outcome was last recorded — the newest version, else the row. */
  recordedAt: string;
}

function toRecords(docs: ClientDocument[]): RegistrationRecord[] {
  const out: RegistrationRecord[] = [];
  for (const doc of docs) {
    const service = BY_OUTPUT.get(doc.name);
    if (!service) continue;
    const newest = doc.versions?.reduce<string | null>(
      (max, v) => (!max || v.uploaded_at > max ? v.uploaded_at : max), null);
    out.push({ doc, service, recordedAt: newest ?? doc.updated_at });
  }
  // Most recently recorded first — the board answers "what just happened".
  return out.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
}

export function RegistrationServicesLanding() {
  const [slug, setSlug] = useState('');
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');

  const docsQ = useQuery({
    queryKey: ['workstation', 'documents', { for: 'registration' }],
    queryFn: () => workstationApi.listDocuments({}),
  });

  return (
    <div className="m-page space-y-4">
      <PageHeader
        title="Registration"
        subtitle="Registrations recorded against clients — what was done, for whom, and what they now hold."
      />

      <QueryState query={docsQ}>
        {(data) => {
          const records = toRecords(data.items ?? []);

          const needle = search.trim().toLowerCase();
          const shown = records.filter((r) =>
            (!slug || r.service.slug === slug) &&
            (!status || r.doc.status === status) &&
            (!needle ||
              (r.doc.client_name ?? '').toLowerCase().includes(needle) ||
              (r.doc.client_code ?? '').toLowerCase().includes(needle)));

          return (
            <>
              <Summary records={records} />

              <FilterBar>
                <Select
                  label="Registration"
                  value={slug}
                  onChange={setSlug}
                  allLabel="All registrations"
                  options={REGISTRATION_SERVICES.map((s) => ({ value: s.slug, label: s.name }))}
                />
                <Select
                  label="Status"
                  value={status}
                  onChange={setStatus}
                  allLabel="Any status"
                  options={[
                    { value: 'uploaded', label: 'Recorded, unverified' },
                    { value: 'under_review', label: 'Under review' },
                    { value: 'verified', label: 'Verified' },
                    { value: 'rejected', label: 'Rejected' },
                    { value: 'expired', label: 'Expired' },
                  ]}
                />
                <SearchInput
                  value={search}
                  onChange={setSearch}
                  placeholder="Client ID or company name"
                />
              </FilterBar>

              {records.length === 0 ? (
                <Empty />
              ) : shown.length === 0 ? (
                <div className="bg-white border border-neutral-200 rounded-lg shadow-card px-4 py-6 text-13 text-neutral-500">
                  No registration matches those filters.
                </div>
              ) : (
                <div className="bg-white border border-neutral-200 rounded-lg shadow-card overflow-hidden">
                  <Table head={['Client', 'Registration', 'Document', 'Version', 'Status', 'Recorded']}>
                    {shown.map((r) => (
                      <Row key={r.doc.id} status={r.doc.status}>
                        <Cell>
                          <Link
                            to={`/workstation/clients/${r.doc.client_id}/documents`}
                            className="font-medium text-neutral-900 hover:text-primary"
                          >
                            {r.doc.client_name ?? '—'}
                          </Link>
                          <span className="block text-12 text-neutral-500 font-mono">
                            {r.doc.client_code ?? '—'}
                          </span>
                        </Cell>
                        <Cell>
                          <Link
                            to={`/workstation/services/registration/${r.service.slug}`}
                            className="text-neutral-900 hover:text-primary"
                          >
                            {r.service.name}
                          </Link>
                          <KindChip service={r.service} />
                        </Cell>
                        <Cell muted>{r.doc.name}</Cell>
                        <Cell className="tabular-nums">v{r.doc.version}</Cell>
                        <Cell><Status value={r.doc.status} /></Cell>
                        <Cell muted className="whitespace-nowrap">{fmtDate(r.recordedAt)}</Cell>
                      </Row>
                    ))}
                  </Table>
                </div>
              )}

              <p className="text-12 text-neutral-500">
                A row means an employee recorded an outcome here. Nothing on this board has been
                checked against a government system, and this build stores no file bytes — the
                document and its versions are metadata only.
              </p>
            </>
          );
        }}
      </QueryState>
    </div>
  );
}

/** Counts across every record, not the filtered view — filters narrow the
    table below, but the totals describe the whole book of work. */
function Summary({ records }: { records: RegistrationRecord[] }) {
  const verified = records.filter((r) => r.doc.status === 'verified').length;
  const awaiting = records.filter(
    (r) => r.doc.status === 'uploaded' || r.doc.status === 'under_review').length;
  const covered = new Set(records.map((r) => r.service.slug)).size;

  const tiles = [
    { label: 'Recorded', value: records.length },
    { label: 'Verified', value: verified },
    { label: 'Awaiting verification', value: awaiting },
    { label: 'Registrations covered', value: `${covered} of ${REGISTRATION_SERVICES.length}` },
  ];

  return (
    <section className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      {tiles.map((t) => (
        <div key={t.label} className="bg-white border border-neutral-200 rounded-lg shadow-card p-4">
          <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">{t.label}</div>
          <div className="text-20 font-semibold text-neutral-900 mt-1 tabular-nums">{t.value}</div>
        </div>
      ))}
    </section>
  );
}

function KindChip({ service }: { service: RegistrationService }) {
  const tint = KIND_TINT[service.kind];
  return (
    <span
      className="inline-flex items-center h-5 px-1.5 ml-2 text-11 font-medium rounded align-middle whitespace-nowrap"
      style={{ backgroundColor: tint.bg, color: tint.fg }}
    >
      {tint.label}
    </span>
  );
}

/** Nothing recorded yet. Says where the work starts rather than showing an
    empty table with no way out of it. */
function Empty() {
  return (
    <div className="bg-white border border-neutral-200 rounded-lg shadow-card px-4 py-8">
      <div className="text-14 font-medium text-neutral-900">No registration recorded yet</div>
      <p className="text-13 text-neutral-500 mt-1 max-w-[560px]">
        This board fills in as registrations are filed. Open a registration from the sidebar
        (Workstation → Services → Registration), do the work on the department's portal, and
        record the outcome against the client — it appears here.
      </p>
      <div className="flex flex-wrap gap-2 mt-4">
        {REGISTRATION_SERVICES.slice(0, 4).map((s) => (
          <Link
            key={s.slug}
            to={`/workstation/services/registration/${s.slug}`}
            className="inline-flex items-center h-8 px-3 text-13 font-medium rounded-md border border-neutral-300 text-neutral-700 hover:border-neutral-400 hover:text-neutral-900"
          >
            {s.shortName}
          </Link>
        ))}
      </div>
    </div>
  );
}
