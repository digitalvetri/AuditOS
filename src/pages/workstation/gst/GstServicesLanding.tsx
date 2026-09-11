/**
 * GST module landing — Workstation → Services → GST.
 *
 * Lists the eight GST services from docs/gst-services/README.md as an entry
 * grid. Each card summarises the service (form, shape, portal destination)
 * and links to the per-service handoff page. A quick "Open portal" button on
 * the card skips the handoff and jumps straight to the portal for users who
 * already know what they’re doing.
 */
import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  AlertOctagon,
  BellRing,
  Briefcase,
  ChevronRight,
  ExternalLink,
  Layers,
  RefreshCcw,
} from 'lucide-react';
import { workstationApi } from '@/modules/workstation/api';
import { GST_SERVICES, SHAPE_TINT, type GstService, type Shape } from './services';
import {
  caseStageFor,
  daysSinceNoticeCheck,
  obligationStatusFor,
} from './placeholder';

export function GstServicesLanding() {
  return (
    <div className="space-y-6">
      <header>
        <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">Workstation · Services</div>
        <h1 className="text-20 font-semibold text-neutral-900 mt-1">GST</h1>
        <p className="text-13 text-neutral-500 mt-1 max-w-[720px]">
          {GST_SERVICES.length} services covering the GST portal work JNS Accounting Solutions
          runs for its clients. Click any card for the guided handoff — open the portal, follow
          the click path, capture the output. Full spec:
          {' '}<code className="text-neutral-700">docs/gst-services/README.md</code>.
        </p>
      </header>

      <AtAGlance />

      {/* Highest-value single feature per spec §8 — get the notice-check
          workflow visible at the top of the module. */}
      <NoticeCheckShortcut />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {GST_SERVICES.map((s) => (
          <ServiceCard key={s.slug} service={s} />
        ))}
      </div>

      <ShapeLegend />
    </div>
  );
}

function AtAGlance() {
  const clientsQuery = useQuery({
    queryKey: ['workstation', 'clients', { for: 'gst-at-a-glance' }],
    queryFn: () => workstationApi.listClients({}),
  });
  const clients = clientsQuery.data?.items ?? [];

  const counts = useMemo(() => {
    let overdue = 0;
    let openObligations = 0;   // recurring, non-filed
    let openCases = 0;         // project, non-completed
    let noticeChecksDue = 0;   // clients unchecked >= 7 days

    const recurringSlugs = GST_SERVICES.filter((s) => s.shape === 'recurring').map((s) => s.slug);
    const projectSlugs   = GST_SERVICES
      .filter((s) => s.shape === 'project' || s.shape === 'externally-triggered')
      .map((s) => s.slug);

    for (const c of clients) {
      if (daysSinceNoticeCheck(c.id) >= 7) noticeChecksDue++;
      for (const slug of recurringSlugs) {
        const st = obligationStatusFor(c.id, slug);
        if (st !== 'filed') openObligations++;
        if (st === 'overdue') overdue++;
      }
      for (const slug of projectSlugs) {
        const st = caseStageFor(c.id, slug);
        if (st !== 'completed' && st !== 'failed') openCases++;
      }
    }
    return { overdue, openObligations, openCases, noticeChecksDue };
  }, [clients]);

  const loading = clientsQuery.isLoading;

  return (
    <section className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      <GlanceTile
        label="Overdue obligations"
        value={counts.overdue}
        icon={<AlertOctagon size={18} strokeWidth={1.75} />}
        tone={{ bg: '#FDE7EA', fg: '#B91C1C' }}
        loading={loading}
        to="/workstation/services/gst/return-filing/workspace"
      />
      <GlanceTile
        label="Open obligations"
        value={counts.openObligations}
        icon={<RefreshCcw size={18} strokeWidth={1.75} />}
        tone={{ bg: '#E7F5EE', fg: '#166534' }}
        loading={loading}
        to="/workstation/services/gst/return-filing/workspace"
      />
      <GlanceTile
        label="Open cases"
        value={counts.openCases}
        icon={<Briefcase size={18} strokeWidth={1.75} />}
        tone={{ bg: '#E6EEFC', fg: '#1D4ED8' }}
        loading={loading}
        to="/workstation/services/gst/registration/workspace"
      />
      <GlanceTile
        label="Notice checks due"
        value={counts.noticeChecksDue}
        icon={<BellRing size={18} strokeWidth={1.75} />}
        tone={{ bg: '#FEF3C7', fg: '#B45309' }}
        loading={loading}
        to="/workstation/services/gst/notice-check"
      />
    </section>
  );
}

function GlanceTile({
  label, value, icon, tone, loading, to,
}: {
  label: string;
  value: number;
  icon: React.ReactNode;
  tone: { bg: string; fg: string };
  loading?: boolean;
  to: string;
}) {
  return (
    <Link
      to={to}
      className="group block bg-white border border-neutral-200 rounded-lg shadow-card p-4 hover:border-neutral-300 transition-colors"
    >
      <div className="flex items-start justify-between gap-2">
        <span
          className="inline-flex items-center justify-center w-9 h-9 rounded-md shrink-0"
          style={{ backgroundColor: tone.bg, color: tone.fg }}
          aria-hidden
        >
          {icon}
        </span>
        <ChevronRight size={14} strokeWidth={2} className="text-neutral-400 group-hover:text-gold" />
      </div>
      <div className="text-11 uppercase tracking-[0.06em] text-neutral-500 mt-3">{label}</div>
      <div className="text-28 font-semibold text-neutral-900 tabular-nums mt-1">
        {loading ? <span className="text-neutral-300">—</span> : value}
      </div>
    </Link>
  );
}

function NoticeCheckShortcut() {
  return (
    <Link
      to="/workstation/services/gst/notice-check"
      className="group flex items-center gap-4 rounded-lg p-5 border border-neutral-200 bg-white shadow-card hover:border-neutral-300 transition-colors"
    >
      <span
        className="inline-flex items-center justify-center w-12 h-12 rounded-lg shrink-0"
        style={{ backgroundColor: '#FDE7EA', color: '#B91C1C' }}
        aria-hidden
      >
        <BellRing size={22} strokeWidth={1.75} />
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="text-15 font-semibold text-neutral-900 group-hover:text-gold">
            Weekly notice check
          </div>
          <span
            className="inline-flex items-center h-5 px-2 text-11 font-medium rounded-md"
            style={{ backgroundColor: '#FDE7EA', color: '#B91C1C' }}
          >
            Highest-value feature
          </span>
        </div>
        <p className="text-13 text-neutral-600 mt-1">
          The portal doesn’t push notifications reliably. Walk the client list, check each
          notices tab, and file replies before quiet ASMT-10s become DRC-01 demand orders.
        </p>
      </div>
      <ChevronRight size={18} strokeWidth={2} className="text-neutral-400 group-hover:text-gold shrink-0" />
    </Link>
  );
}

function ServiceCard({ service }: { service: GstService }) {
  const Icon = service.icon;
  const tint = SHAPE_TINT[service.shape];
  return (
    <section className="flex flex-col bg-white border border-neutral-200 rounded-lg shadow-card p-5">
      <Link
        to={`/workstation/services/gst/${service.slug}`}
        className="group flex-1 focus:outline-none focus:ring-2 focus:ring-gold rounded-md -m-1 p-1"
      >
        <div className="flex items-start justify-between gap-3">
          <span
            className="inline-flex items-center justify-center w-10 h-10 rounded-md shrink-0"
            style={{ backgroundColor: tint.bg, color: tint.fg }}
            aria-hidden
          >
            <Icon size={20} strokeWidth={1.75} />
          </span>
          <span
            className="inline-flex items-center h-6 px-2 text-11 font-medium rounded-md whitespace-nowrap"
            style={{ backgroundColor: tint.bg, color: tint.fg }}
          >
            {tint.label}
          </span>
        </div>

        <div className="mt-4 flex items-baseline gap-2 flex-wrap">
          <h3 className="text-16 font-semibold text-neutral-900 group-hover:text-gold">
            {service.name}
          </h3>
          <span className="text-12 text-neutral-500 tabular-nums">{service.form}</span>
        </div>

        <p className="text-13 text-neutral-600 mt-2 leading-relaxed">{service.summary}</p>
      </Link>

      <div className="mt-4 pt-4 border-t border-neutral-100">
        <div className="text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1">
          Portal destination
        </div>
        <div className="text-12 text-neutral-700 mb-3">
          {service.navPath.length ? service.navPath.join(' › ') : service.portalUrl.replace(/^https?:\/\//, '')}
        </div>
        <div className="flex gap-2">
          <Link
            to={`/workstation/services/gst/${service.slug}`}
            className="flex-1 inline-flex items-center justify-center h-9 px-3 text-13 font-medium text-white bg-gold hover:bg-gold-hover rounded-md"
          >
            Open guided handoff
          </Link>
          <a
            href={service.portalUrl}
            target="_blank"
            rel="noopener noreferrer"
            title={service.portalLabel}
            className="inline-flex items-center justify-center h-9 w-9 border border-neutral-200 rounded-md text-neutral-600 hover:bg-neutral-50"
            aria-label={`Open ${service.portalLabel} in a new tab`}
          >
            <ExternalLink size={14} strokeWidth={2} />
          </a>
        </div>
      </div>
    </section>
  );
}

function ShapeLegend() {
  return (
    <section className="bg-white border border-neutral-200 rounded-lg shadow-card p-5">
      <div className="flex items-center gap-2 mb-3">
        <Layers size={16} strokeWidth={1.75} className="text-neutral-500" />
        <h2 className="text-13 font-semibold uppercase tracking-[0.06em] text-neutral-900">
          Workspace shapes
        </h2>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <LegendCell
          tone="recurring"
          copy="Period board, deadline-driven, obligation per period. Return Filing · Annual Return · LUT."
        />
        <LegendCell
          tone="project"
          copy="Case pipeline, stage-driven, one-off. Registration · Amendment · Cancellation."
        />
        <LegendCell
          tone="externally-triggered"
          copy="Project shape but the deadline comes from the notice, and cases are created by discovery. Notice Reply."
        />
        <LegendCell
          tone="retainer"
          copy="Continuous, no deadline. E-Invoicing Support."
        />
      </div>
      <p className="text-11 text-neutral-500 mt-3">
        Per §7 of the spec: build the shape first, then services are configuration. Shapes
        themselves are not yet built — this landing is the entry point that will link to each
        workspace once the engine ships.
      </p>
    </section>
  );
}

function LegendCell({ tone, copy }: { tone: Shape; copy: string }) {
  const tint = SHAPE_TINT[tone];
  return (
    <div className="rounded-md border border-neutral-200 p-3">
      <span
        className="inline-flex items-center h-6 px-2 text-11 font-medium rounded-md"
        style={{ backgroundColor: tint.bg, color: tint.fg }}
      >
        {tint.label}
      </span>
      <p className="text-12 text-neutral-600 mt-2 leading-snug">{copy}</p>
    </div>
  );
}
