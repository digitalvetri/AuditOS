/**
 * One registration — Workstation → Services → Registration → <service>.
 *
 * Describes the registration, links out to the official portal, and lets an
 * employee record what came back against the client. Audit OS never contacts
 * a portal itself — the filing happens in the other tab. No case is created
 * and no application status is claimed.
 */
import { Link, useParams } from 'react-router-dom';
import { ChevronLeft } from 'lucide-react';
import { Card, PageHeader } from '@/modules/workstation/components';
import { KIND_TINT, registrationBySlug } from './services';
import { RegistrationRunPanel } from './RegistrationRunPanel';

export function RegistrationServiceDetail() {
  const { slug } = useParams();
  const service = registrationBySlug(slug);

  if (!service) {
    return (
      <div className="m-page space-y-4">
        <PageHeader
          title="Registration not found"
          subtitle="No registration matches that address."
        />
        <Link
          to="/workstation/services/registration"
          className="inline-flex items-center gap-1 text-13 text-primary"
        >
          <ChevronLeft size={16} strokeWidth={2} />
          Back to Registration
        </Link>
      </div>
    );
  }

  const Icon = service.icon;
  const tint = KIND_TINT[service.kind];

  return (
    <div className="m-page space-y-4">
      <Link
        to="/workstation/services/registration"
        className="inline-flex items-center gap-1 min-h-[44px] md:min-h-0 text-13 text-neutral-500 hover:text-neutral-900"
      >
        <ChevronLeft size={16} strokeWidth={2} />
        Registration
      </Link>

      <header className="flex items-start gap-4">
        <span
          className="inline-flex items-center justify-center w-12 h-12 rounded-md shrink-0"
          style={{ backgroundColor: tint.bg, color: tint.fg }}
          aria-hidden
        >
          <Icon size={24} strokeWidth={1.75} />
        </span>
        <div className="min-w-0">
          <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">
            Workstation · Services · Registration
          </div>
          <h1 className="text-20 font-semibold text-neutral-900 mt-1">{service.name}</h1>
          <p className="text-13 text-neutral-500 mt-1 max-w-[720px]">{service.summary}</p>
        </div>
      </header>

      <Card title="At a glance">
        <dl className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-px bg-neutral-200">
          <Fact label="Category" value={tint.label} />
          <Fact label="Granted under" value={service.authority} />
          <Fact label="Client receives" value={service.form} />
          <Fact
            label="Portal"
            value={
              service.portalScope === 'tamil-nadu' ? 'Tamil Nadu (state)'
                : service.portalScope === 'india' ? 'Government of India'
                : 'No registry exists'
            }
          />
        </dl>
      </Card>

      <Card title="What this registration is">
        <div className="p-4">
          <p className="text-13 text-neutral-700 leading-relaxed">{service.description}</p>
        </div>
      </Card>

      <RegistrationRunPanel service={service} />

      {/* The truth-of-data rule this codebase holds elsewhere: say what the
          system has and has not done, rather than implying a capability. */}
      <div className="border-l-2 border-neutral-400 bg-white px-3 py-2 text-12 text-neutral-600">
        Audit OS does not file this registration and never contacts a government portal. The link
        above opens the official site in a new tab; an employee does the work there and records
        the outcome here. Nothing on this page has been checked against any government system.
      </div>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white px-4 py-3 min-w-0">
      <dt className="text-11 uppercase tracking-[0.06em] text-neutral-500">{label}</dt>
      <dd className="text-13 text-neutral-900 mt-1 break-words">{value}</dd>
    </div>
  );
}
