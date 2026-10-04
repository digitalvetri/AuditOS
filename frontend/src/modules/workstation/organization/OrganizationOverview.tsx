/**
 * Organization Overview — the organization tab of an organization client's
 * workspace. Every figure is computed live by the server from the child
 * clients' own records (only those the viewer may open); nothing here is a
 * copy. Clicking a service lists the clients that take it.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ArrowRight, Building2 } from 'lucide-react';
import { workstationApi } from '../api';
import { Card, QueryState } from '../components';
import type { ClientDetail, OrganizationOverview as Overview } from '../types';
import { fmtDateTime } from '@/lib/format';

export function OrganizationOverview({ org }: { org: ClientDetail }) {
  const q = useQuery({
    queryKey: ['workstation', 'organization', org.id, 'overview'],
    queryFn: () => workstationApi.organizationOverview(org.id),
  });
  const [openService, setOpenService] = useState<string | null>(null);

  return (
    <QueryState query={q}>
      {(d: Overview) => {
        const s = d.stats;
        const tiles: { label: string; value: number | string; sub?: string; to?: string }[] = [
          { label: 'Clients', value: s.clients, sub: `${s.active_clients} active · ${s.inactive_clients} inactive`, to: 'organization-clients' },
          { label: 'Services', value: s.services, sub: `${s.services_in_progress} in progress · ${s.services_not_started} not started` },
          { label: 'Completed services', value: s.services_completed },
          { label: 'Documents', value: s.documents ?? '—', sub: s.organization_documents != null ? `${s.organization_documents} at organization level` : undefined, to: 'organization-documents' },
        ];
        const selected = d.services_by_type.find((x) => x.service_id === openService) ?? null;
        return (
          <div className="space-y-4">
            <LevelBanner level="organization" name={org.company_name} />

            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              {tiles.map((t) => {
                const body = (
                  <>
                    <div className="text-12 text-neutral-500">{t.label}</div>
                    <div className="text-[26px] font-semibold text-neutral-900 tabular-nums leading-tight mt-1">{t.value}</div>
                    {t.sub ? <div className="text-11 text-neutral-500 mt-1">{t.sub}</div> : null}
                  </>
                );
                const cls = 'block bg-white border border-neutral-200 rounded-lg px-4 py-3';
                return t.to
                  ? <Link key={t.label} to={`/workstation/clients/${org.id}/${t.to}`} className={cls + ' hover:border-primary/40'}>{body}</Link>
                  : <div key={t.label} className={cls}>{body}</div>;
              })}
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <Card title="Services across clients">
                {d.services_by_type.length === 0 ? (
                  <p className="p-5 text-13 text-neutral-500">No services on the organization's clients yet.</p>
                ) : (
                  <ul className="divide-y divide-neutral-100">
                    {d.services_by_type.map((svc) => (
                      <li key={svc.service_id}>
                        <button
                          type="button"
                          onClick={() => setOpenService(openService === svc.service_id ? null : svc.service_id)}
                          className="w-full flex items-center gap-3 px-5 py-3 text-left hover:bg-neutral-50"
                          aria-expanded={openService === svc.service_id}
                        >
                          <span className="flex-1 min-w-0">
                            <span className="block text-13 font-medium text-neutral-900">{svc.name}</span>
                            <span className="block text-11 text-neutral-500">{svc.active} in progress · {svc.completed} completed</span>
                          </span>
                          <span className="text-13 text-neutral-700 tabular-nums">{svc.client_count} client{svc.client_count === 1 ? '' : 's'}</span>
                        </button>
                        {selected?.service_id === svc.service_id ? (
                          <div className="px-5 pb-3 flex flex-wrap gap-2">
                            {svc.clients.map((c) => (
                              <Link key={c.id} to={`/workstation/clients/${c.id}/services`} className="text-12 px-2 py-1 rounded-full bg-primary/10 text-primary hover:underline">
                                {c.name}
                              </Link>
                            ))}
                          </div>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </Card>

              <Card title="Recent activity" right={<span className="text-11 text-neutral-500">Organization and its clients</span>}>
                {d.recent_activity.length === 0 ? (
                  <p className="p-5 text-13 text-neutral-500">Nothing yet.</p>
                ) : (
                  <ul className="divide-y divide-neutral-100">
                    {d.recent_activity.slice(0, 12).map((a) => (
                      <li key={a.id} className="px-5 py-3">
                        <div className="text-13 text-neutral-900">{a.description}</div>
                        <div className="text-11 text-neutral-500 mt-0.5">
                          {a.is_organization_level
                            ? <span className="text-primary font-medium">Organization</span>
                            : <Link to={`/workstation/clients/${a.client_id}`} className="hover:underline">{a.client_name}</Link>}
                          {' · '}{fmtDateTime(a.created_at)}{a.actor ? ` · ${a.actor.full_name}` : ''}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>

            <Link
              to={`/workstation/clients/${org.id}/organization-clients`}
              className="inline-flex items-center gap-2 text-13 font-medium text-primary hover:underline"
            >
              See all {s.clients} organization client{s.clients === 1 ? '' : 's'} <ArrowRight size={14} />
            </Link>
          </div>
        );
      }}
    </QueryState>
  );
}

/** Says plainly which level the page is showing. */
export function LevelBanner({ level, name, org }: { level: 'organization' | 'client'; name: string; org?: { id: string; name: string } }) {
  return (
    <div className="flex items-center gap-2 rounded-lg bg-primary/5 border border-primary/15 px-3 py-2 text-12 text-neutral-700">
      <Building2 size={14} className="text-primary shrink-0" />
      {level === 'organization' ? (
        <span><b className="text-primary">Organization level</b> — figures combine all of {name}&apos;s clients you can access. Each client&apos;s own records stay in its workspace.</span>
      ) : (
        <span>
          <b className="text-primary">Client level</b> — {name} is a client of{' '}
          <Link to={`/workstation/clients/${org!.id}/organization`} className="underline">{org!.name}</Link>. Everything here belongs to {name} only.
        </span>
      )}
    </div>
  );
}
