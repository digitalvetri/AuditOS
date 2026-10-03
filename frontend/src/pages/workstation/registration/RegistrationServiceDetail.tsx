/**
 * One registration — Workstation → Services → Registration → <service>.
 *
 * Describes the registration, links out to the official portal, and lets an
 * employee record what came back against the client. Audit OS never contacts
 * a portal itself — the filing happens in the other tab. No case is created
 * and no application status is claimed.
 */
import { Link, useParams } from 'react-router-dom';
import { BadgeCheck, Building, ChevronLeft, FileCheck2, Globe2, Info } from 'lucide-react';
import { PageHeader } from '@/modules/workstation/components';
import { KIND_TINT, MINIMAL_REGISTRATION_PAGES, registrationBySlug } from './services';
import { RegistrationRunPanel } from './RegistrationRunPanel';

/**
 * `slug` and `embedded` are for the GST shell, which mounts this at the
 * literal path `registration/gst` — there is no `:slug` param to read there,
 * and the shell already supplies the back link and page padding.
 */
export function RegistrationServiceDetail({
  slug: slugProp, embedded = false,
}: { slug?: string; embedded?: boolean } = {}) {
  const { slug: slugParam } = useParams();
  const slug = slugProp ?? slugParam;
  const service = registrationBySlug(slug);

  if (!service) {
    return (
      <div className="m-page space-y-4">
        <PageHeader
          title="Registration not found"
          subtitle="No registration matches that address."
        />
        <Link
          to="/workstation/services"
          className="inline-flex items-center gap-1 text-13 text-primary"
        >
          <ChevronLeft size={16} strokeWidth={2} />
          Back to Services
        </Link>
      </div>
    );
  }

  const Icon = service.icon;
  const tint = KIND_TINT[service.kind];
  const showOverview = !MINIMAL_REGISTRATION_PAGES.has(service.slug);

  return (
    <div className={embedded ? 'space-y-4' : 'm-page space-y-4'}>
      {embedded ? null : (
        <Link
          to="/workstation/services"
          className="inline-flex items-center gap-1 min-h-[44px] md:min-h-0 text-13 text-neutral-500 hover:text-neutral-900"
        >
          <ChevronLeft size={16} strokeWidth={2} />
          Services
        </Link>
      )}

      <header className="dash-card reg-hero flex items-start gap-4 p-5">
        <span
          className="inline-flex items-center justify-center w-14 h-14 rounded-lg shrink-0"
          style={{ backgroundColor: tint.bg, color: tint.fg, boxShadow: `inset 0 0 0 1px ${tint.fg}22` }}
          aria-hidden
        >
          <Icon size={26} strokeWidth={1.75} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-12 font-medium text-neutral-500">Services · Registration</span>
            <span className="inline-flex items-center h-6 px-3 rounded-full text-11 font-semibold" style={{ background: tint.bg, color: tint.fg }}>{tint.label}</span>
          </div>
          <h1 className="text-[26px] leading-tight font-semibold tracking-[-0.01em] text-neutral-900 mt-1">{service.name}</h1>
          {showOverview ? (
            <p className="text-13 text-neutral-500 mt-1 max-w-[760px]">{service.summary}</p>
          ) : null}
        </div>
      </header>

      {showOverview ? (
        <>
          <dl className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
            <Fact icon={BadgeCheck} label="Category" value={tint.label} />
            <Fact icon={Building} label="Granted under" value={service.authority} />
            <Fact icon={FileCheck2} label="Client receives" value={service.form} />
            <Fact
              icon={Globe2}
              label="Portal"
              value={
                service.portalScope === 'tamil-nadu' ? 'Tamil Nadu (state)'
                  : service.portalScope === 'india' ? 'Government of India'
                  : 'No registry exists'
              }
            />
          </dl>

          <section className="dash-card p-5">
            <h2 className="text-14 font-semibold text-neutral-900">What this registration is</h2>
            <p className="text-13 text-neutral-600 leading-relaxed mt-2">{service.description}</p>
          </section>
        </>
      ) : null}

      <RegistrationRunPanel service={service} />

      {/* The truth-of-data rule this codebase holds elsewhere: say what the
          system has and has not done, rather than implying a capability. */}
      {showOverview ? (
        <div className="flex items-start gap-3 rounded-lg px-4 py-3 text-12 text-neutral-600" style={{ background: '#f7f5ff', boxShadow: 'inset 3px 0 0 #3a3358, inset 0 0 0 1px #e6dffa' }}>
          <Info size={15} strokeWidth={1.9} className="text-primary shrink-0 mt-px" aria-hidden />
          <span>Audit OS does not file this registration and never contacts a government portal. The link
          above opens the official site in a new tab; an employee does the work there and records
          the outcome here. Nothing on this page has been checked against any government system.</span>
        </div>
      ) : null}
    </div>
  );
}

function Fact({ icon: FactIcon, label, value }: { icon: typeof Info; label: string; value: string }) {
  return (
    <div className="dash-card card-zoom flex items-start gap-3 px-4 py-3 min-w-0">
      <span className="h-9 w-9 rounded-lg inline-flex items-center justify-center shrink-0" style={{ background: '#efeafd', color: '#6941d9', boxShadow: 'inset 0 0 0 1px #ddd5f6' }}>
        <FactIcon size={16} strokeWidth={1.9} />
      </span>
      <div className="min-w-0">
        <dt className="text-12 font-medium text-neutral-500">{label}</dt>
        <dd className="text-13 font-medium text-neutral-900 mt-0.5 break-words">{value}</dd>
      </div>
    </div>
  );
}
