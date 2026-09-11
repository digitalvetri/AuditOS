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
import { GST_SERVICES, SHAPE_TINT, type GstService } from './services';
import {
  caseStageFor,
  daysSinceNoticeCheck,
  obligationStatusFor,
} from './placeholder';

export function GstServicesLanding() {
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

      <p className="text-11 text-neutral-500">
        {GST_SERVICES.length} services · Spec at{' '}
        <code className="text-neutral-700">docs/gst-services/README.md</code>
      </p>
    </div>
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
    <li className={first ? '' : 'border-t border-neutral-100'}>
      <Link
        to={`/workstation/services/gst/${service.slug}`}
        className="flex items-center gap-4 px-4 py-3 hover:bg-neutral-50 transition-colors group"
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
        {/* spacer pushes the row-end actions to the right */}
        <div className="flex-1" />
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
      </Link>
    </li>
  );
}
