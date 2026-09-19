/**
 * GST module landing — Workstation → Services → GST.
 *
 * Compact list view (v2). One stats bar, one search input, one row per
 * service. All the functionality of the previous card grid — click a row
 * for the guided handoff, use the external-link icon to skip straight to
 * the portal — laid out with much less visual weight.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  AlertOctagon,
  BellRing,
  Briefcase,
  ChevronRight,
  ExternalLink,
  RefreshCcw,
  Search,
} from 'lucide-react';
import { workstationApi } from '@/modules/workstation/api';
import { checklistApi } from '@/modules/workstation/checklist/api';
import { ClientChecklists } from './ClientChecklists';
import { GST_SERVICES, SHAPE_TINT, type GstService } from './services';
import {
  caseStageFor,
  daysSinceNoticeCheck,
  obligationStatusFor,
} from './placeholder';

/**
 * Two views of GST, and the tabs are the line between them:
 *
 *   Service catalogue  — what the firm offers (the master list, unchanged)
 *   Client checklists  — what each client actually owes, rolled up
 *
 * The second is a read-only report over the clients' own checklist rows; the
 * work itself is still done on a client's GST tab.
 */
type View = 'catalogue' | 'checklists';

export function GstServicesLanding() {
  const [view, setView] = useState<View>('catalogue');
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return GST_SERVICES;
    return GST_SERVICES.filter((s) =>
      s.name.toLowerCase().includes(q) ||
      s.form.toLowerCase().includes(q) ||
      s.shape.toLowerCase().includes(q)
    );
  }, [query]);

  return (
    <div className="space-y-4">
      <header>
        <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">Workstation · Services</div>
        <h1 className="text-20 font-semibold text-neutral-900 mt-1">GST</h1>
      </header>

      <nav className="flex gap-x-4 border-b border-neutral-200">
        {([['catalogue', 'Service catalogue'], ['checklists', 'Client checklists']] as [View, string][]).map(([k, l]) => (
          <button
            key={k}
            type="button"
            onClick={() => setView(k)}
            className={
              'h-8 flex items-center text-13 whitespace-nowrap border-b-2 -mb-px transition-colors ' +
              (view === k
                ? 'border-gold text-neutral-900 font-medium'
                : 'border-transparent text-neutral-500 hover:text-neutral-900')
            }
          >
            {l}
          </button>
        ))}
      </nav>

      {view === 'checklists' ? <ClientChecklists /> : (
      <>
      <StatsBar />

      <div className="relative">
        <Search
          size={14}
          strokeWidth={2}
          className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400"
        />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search services…"
          className="w-full h-10 pl-9 pr-3 text-14 bg-white border border-neutral-200 rounded-md focus:outline-none focus:border-gold"
        />
      </div>

      <section className="bg-white border border-neutral-200 rounded-lg shadow-card overflow-hidden">
        <ul>
          {filtered.length === 0 ? (
            <li className="px-4 py-8 text-center text-13 text-neutral-500">
              No services match “{query}”.
            </li>
          ) : (
            filtered.map((s, i) => (
              <ServiceRow key={s.slug} service={s} first={i === 0} />
            ))
          )}
        </ul>
      </section>

      <FirmAddedServices />

      <p className="text-11 text-neutral-500">
        {GST_SERVICES.length} services · Spec at{' '}
        <code className="text-neutral-700">docs/gst-services/README.md</code>
      </p>
      </>
      )}
    </div>
  );
}

/**
 * Services the firm added itself, from a client's GST checklist with "also add
 * to GST master services" ticked. The eleven statutory services above are the
 * fixed catalogue; this is the extension point, so it is listed separately and
 * reads from the checklist catalogue API rather than the file.
 */
function FirmAddedServices() {
  const q = useQuery({ queryKey: ['checklist', 'gst', 'catalog'], queryFn: () => checklistApi.catalog() });
  const custom = (q.data?.services ?? []).filter((s) => s.is_custom);
  const categories = new Map((q.data?.categories ?? []).map((c) => [c.id, c.name]));
  if (custom.length === 0) return null;

  return (
    <section className="bg-white border border-neutral-200 rounded-lg shadow-card overflow-hidden">
      <div className="h-9 px-4 flex items-center border-b border-neutral-200">
        <span className="text-11 uppercase tracking-[0.06em] text-neutral-500">Added by your firm</span>
      </div>
      <ul>
        {custom.map((s) => (
          <li key={s.id} className="px-4 py-2.5 border-b border-neutral-100 last:border-0">
            <div className="text-14 text-neutral-900">
              {s.name}
              {s.code ? <span className="text-neutral-500"> · {s.code}</span> : null}
            </div>
            <div className="text-11 text-neutral-500">
              {s.category_id ? categories.get(s.category_id) ?? 'Uncategorised' : 'Uncategorised'} · {s.default_frequency}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function StatsBar() {
  const clientsQuery = useQuery({
    queryKey: ['workstation', 'clients', { for: 'gst-at-a-glance' }],
    queryFn: () => workstationApi.listClients({}),
  });
  const clients = clientsQuery.data?.items ?? [];

  const counts = useMemo(() => {
    let overdue = 0;
    let openObligations = 0;
    let openCases = 0;
    let noticeChecksDue = 0;

    const recurring = GST_SERVICES.filter((s) => s.shape === 'recurring').map((s) => s.slug);
    const project = GST_SERVICES
      .filter((s) => s.shape === 'project' || s.shape === 'externally-triggered')
      .map((s) => s.slug);

    for (const c of clients) {
      if (daysSinceNoticeCheck(c.id) >= 7) noticeChecksDue++;
      for (const slug of recurring) {
        const st = obligationStatusFor(c.id, slug);
        if (st !== 'filed') openObligations++;
        if (st === 'overdue') overdue++;
      }
      for (const slug of project) {
        const st = caseStageFor(c.id, slug);
        if (st !== 'completed' && st !== 'failed') openCases++;
      }
    }
    return { overdue, openObligations, openCases, noticeChecksDue };
  }, [clients]);

  const loading = clientsQuery.isLoading;

  return (
    <section className="bg-white border border-neutral-200 rounded-lg shadow-card">
      <div className="flex items-stretch divide-x divide-neutral-100">
        <Stat
          icon={<AlertOctagon size={14} strokeWidth={2} />}
          label="Overdue"
          value={counts.overdue}
          tint="#B91C1C"
          loading={loading}
          to="/workstation/services/gst/return-filing/workspace"
        />
        <Stat
          icon={<RefreshCcw size={14} strokeWidth={2} />}
          label="Open obligations"
          value={counts.openObligations}
          tint="#166534"
          loading={loading}
          to="/workstation/services/gst/return-filing/workspace"
        />
        <Stat
          icon={<Briefcase size={14} strokeWidth={2} />}
          label="Open cases"
          value={counts.openCases}
          tint="#1D4ED8"
          loading={loading}
          to="/workstation/services/gst/registration/workspace"
        />
        <Stat
          icon={<BellRing size={14} strokeWidth={2} />}
          label="Notice checks due"
          value={counts.noticeChecksDue}
          tint="#B45309"
          loading={loading}
          to="/workstation/services/gst/notice-check"
        />
      </div>
    </section>
  );
}

function Stat({
  icon, label, value, tint, loading, to,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  tint: string;
  loading?: boolean;
  to: string;
}) {
  return (
    <Link
      to={to}
      className="flex-1 min-w-0 group px-4 py-3 hover:bg-neutral-50 transition-colors"
    >
      <div className="flex items-center gap-2">
        <span style={{ color: tint }} aria-hidden>{icon}</span>
        <span className="text-11 uppercase tracking-[0.06em] text-neutral-500 truncate">{label}</span>
      </div>
      <div className="text-20 font-semibold text-neutral-900 tabular-nums mt-1">
        {loading ? <span className="text-neutral-300">—</span> : value}
      </div>
    </Link>
  );
}

function ServiceRow({ service, first }: { service: GstService; first: boolean }) {
  const Icon = service.icon;
  const tint = SHAPE_TINT[service.shape];
  return (
    // The portal link is a SIBLING of the row link, not a child: an <a> inside
    // an <a> is invalid HTML and React warns about it. The row link takes
    // flex-1, which pushes the row-end actions right exactly as the old
    // spacer did.
    <li
      className={
        (first ? '' : 'border-t border-neutral-100 ') +
        'flex items-center gap-4 px-4 py-3 hover:bg-neutral-50 transition-colors group'
      }
    >
      <Link
        to={`/workstation/services/gst/${service.slug}`}
        className="flex items-center gap-4 flex-1 min-w-0"
      >
        {/* icon */}
        <span
          className="inline-flex items-center justify-center w-8 h-8 rounded-md shrink-0"
          style={{ backgroundColor: tint.bg, color: tint.fg }}
          aria-hidden
        >
          <Icon size={16} strokeWidth={1.75} />
        </span>
        {/* name — fixed column so form + chip align tabularly across rows */}
        <div className="w-56 md:w-64 lg:w-72 min-w-0">
          <div className="text-14 font-medium text-neutral-900 group-hover:text-gold truncate">
            {service.name}
          </div>
        </div>
        {/* form */}
        <div className="hidden sm:block w-32 lg:w-40 text-12 text-neutral-500 font-mono tabular-nums truncate">
          {service.form}
        </div>
        {/* shape chip */}
        <span
          className="hidden md:inline-flex items-center justify-center w-32 h-6 text-11 font-medium rounded-md whitespace-nowrap"
          style={{ backgroundColor: tint.bg, color: tint.fg }}
        >
          {tint.label}
        </span>
      </Link>
        <a
          href={service.portalUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          title={service.portalLabel}
          aria-label={`Open ${service.portalLabel} in a new tab`}
          className="inline-flex items-center justify-center w-8 h-8 rounded-md text-neutral-400 hover:text-neutral-800 hover:bg-white"
        >
          <ExternalLink size={14} strokeWidth={2} />
        </a>
        <ChevronRight size={16} strokeWidth={2} className="text-neutral-400 group-hover:text-gold shrink-0" />
    </li>
  );
}
