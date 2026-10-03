/**
 * Client 360 — the side panel opened from a Clients row.
 *
 * A quick read of one client without leaving the list: who they are, what
 * they owe, their GST record for the last six periods, open TDS work, their
 * services and the primary contact. Every tab and action links into the full
 * client workspace (/workstation/clients/:id/…), which stays the place where
 * work is done — the panel only reads.
 */
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight, Copy, Mail, Phone, Pin, PinOff, Plus, X } from 'lucide-react';
import { useAuth } from '@/platform/auth/AuthContext';
import { can } from '@/platform/rbac/can';
import { workstationApi } from '@/modules/workstation/api';
import { paymentSummaryApi } from '@/modules/paymentSummary/api';
import type { ClientSummary } from '@/modules/paymentSummary/api';
import type { ClientListItem } from '@/modules/workstation/types';
import type { TdsOverviewRow } from '@/modules/tds/api';
import { StatusChip } from '@/modules/workstation/listUi';
import { Avatar, Ring } from '@/components/viz';
import { usePinnedClients } from '@/modules/workstation/pins';
import { formatINR } from '@/modules/dashboardV2/format';
import type { GstHistory, Health } from '@/modules/workstation/clientInsights';
import { useToast } from '@/components/Toast';

const inr = (p: number) => formatINR(p / 100);
const monthShort = (period: string) => new Date(`${period}-01T00:00:00`).toLocaleString('en-IN', { month: 'short' }).toUpperCase();

export function ClientPanel({ client, money, gst, tds, health, onClose }: {
  client: ClientListItem;
  money?: ClientSummary;
  gst?: GstHistory;
  tds: TdsOverviewRow[];
  health: Health | null;
  onClose: () => void;
}) {
  const { session } = useAuth();
  const role = session?.role.code;
  const toast = useToast();
  const { isPinned, toggle } = usePinnedClients();
  const pinned = isPinned(client.id);
  const base = `/workstation/clients/${client.id}`;

  const detail = useQuery({ queryKey: ['workstation', 'client', client.id], queryFn: () => workstationApi.getClient(client.id) });
  const services = useQuery({
    queryKey: ['workstation', 'client', client.id, 'services'],
    queryFn: () => workstationApi.clientServices(client.id),
    enabled: can(role, 'workstation.service.read', 'self'),
  });
  const seesBilling = can(role, 'payment_summary.read', 'organisation');
  const invoices = useQuery({
    queryKey: ['payment-summary', 'client', client.id],
    queryFn: () => paymentSummaryApi.client(client.id),
    enabled: seesBilling,
  });

  const contact = detail.data?.contacts.find((c) => c.is_primary) ?? detail.data?.contacts[0];
  // The most overdue invoice — "Send reminder" opens it, where email / WhatsApp reminders live.
  const oldestOverdue = (invoices.data?.invoices ?? []).filter((i) => i.state === 'overdue').sort((x, y) => y.days_overdue - x.days_overdue)[0];
  const openServices = (services.data?.items ?? []).filter((s) => s.status !== 'completed');
  const rows = gst?.byClient.get(client.id);
  const tabs: [string, string, boolean][] = [
    ['Overview', base, true],
    ['GST', `${base}/gst`, can(role, 'workstation.gst.read', 'self')],
    ['Invoices', `${base}/invoices`, can(role, 'workstation.invoice.read', 'self')],
    ['Documents', `${base}/documents`, can(role, 'workstation.document.read', 'self')],
    ['Activity', `${base}/activity`, true],
  ];

  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); toast.push('success', 'GSTIN copied'); } catch { /* clipboard blocked */ }
  };

  return (
    <aside className="dash-card cp-panel flex flex-col overflow-hidden" aria-label={`${client.company_name} — client summary`}>
      {/* Header */}
      <div className="cp-head relative px-5 pt-5 pb-4 border-b border-border">
        <div className="absolute top-3 right-3 flex gap-1">
          <button type="button" onClick={() => toggle({ id: client.id, name: client.company_name })}
            className="h-8 w-8 grid place-items-center rounded-[9px] bg-surface shadow-card text-inkMuted hover:text-ink"
            title={pinned ? 'Unpin from sidebar' : 'Pin to sidebar'} aria-pressed={pinned}>
            {pinned ? <PinOff size={15} /> : <Pin size={15} />}
          </button>
          <button type="button" onClick={onClose} className="h-8 w-8 grid place-items-center rounded-[9px] bg-surface shadow-card text-inkMuted hover:text-ink" aria-label="Close panel">
            <X size={15} />
          </button>
        </div>
        <div className="flex items-center gap-3 pr-20">
          <Avatar name={client.company_name} size={48} square className="shadow-raised" />
          <div className="min-w-0">
            <h2 className="text-18 font-semibold text-ink tracking-[-0.02em] leading-tight truncate">{client.company_name}</h2>
            <div className="flex items-center gap-2 text-12 text-inkMuted font-mono">
              <span>{client.client_id}</span>
              {client.gstin ? (
                <button type="button" onClick={() => copy(client.gstin!)} className="inline-flex items-center gap-1 hover:text-ink" title="Copy GSTIN">
                  · {client.gstin} <Copy size={11} />
                </button>
              ) : null}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap gap-[6px] mt-3">
          <StatusChip value={client.status} />
          {client.business_type ? <Tag>{client.business_type}</Tag> : null}
          {client.onboarding_date ? <Tag>Client since {new Date(client.onboarding_date).getFullYear()}</Tag> : null}
          {money && money.overdue_paise > 0 ? <Tag tone="bad">● Payment overdue</Tag> : null}
        </div>
        <div className="flex flex-wrap gap-2 mt-4">
          {can(role, 'workstation.invoice.read', 'self') ? (
            <Link to={`${base}/invoices`} className="inline-flex items-center gap-[6px] h-8 px-3 rounded-[9px] bg-primary text-white text-13 font-semibold">Record payment</Link>
          ) : null}
          {can(role, 'workstation.invoice.manage', 'self') ? (
            <Link to={`/workstation/invoices/new?client_id=${client.id}`} className="inline-flex items-center gap-[6px] h-8 px-3 rounded-[9px] bg-surface shadow-card text-13 font-semibold text-ink hover:shadow-raised"><Plus size={14} />Invoice</Link>
          ) : null}
          {oldestOverdue ? (
            <Link to={`/workstation/invoices/${oldestOverdue.id}`} title={`Remind about ${oldestOverdue.invoice_number}`}
              className="inline-flex items-center gap-[6px] h-8 px-3 rounded-[9px] bg-danger text-white text-13 font-semibold">Send reminder</Link>
          ) : null}
          <Link to={base} className="inline-flex items-center gap-[6px] h-8 px-3 rounded-[9px] bg-surface shadow-card text-13 font-semibold text-ink hover:shadow-raised">Open workspace <ArrowUpRight size={14} /></Link>
        </div>
      </div>

      {/* Tabs → full workspace */}
      <nav className="flex gap-1 px-3 border-b border-border overflow-x-auto">
        {tabs.filter(([, , show]) => show).map(([label, to], i) => (
          <Link key={label} to={to} className={'cp-tab px-2 py-[10px] text-13 font-medium whitespace-nowrap ' + (i === 0 ? 'is-on text-ink' : 'text-inkMuted hover:text-ink')}>{label}</Link>
        ))}
      </nav>

      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
        {/* Money + health */}
        <div className="grid grid-cols-3 gap-2">
          {money ? (
            <>
              <Stat label="Billed" value={inr(money.invoiced_paise)} />
              <Stat label={money.overdue_paise ? 'Overdue' : 'Outstanding'} value={inr(money.overdue_paise || money.pending_paise)} bad={money.overdue_paise > 0} />
            </>
          ) : (
            <>
              <Stat label="Services" value={String(client.service_names.length)} />
              <Stat label="Documents" value={String(client.document_count)} />
            </>
          )}
          <div className="rounded-[11px] bg-neutral-100 px-3 py-2 flex items-center gap-2" title={health?.reasons.join(' · ') || 'No issues found'}>
            {health ? <Ring value={health.score / 100} size={30} stroke={3.5} /> : null}
            <div className="min-w-0">
              <div className="text-11 text-inkMuted">Health</div>
              <div className="num-display text-16 text-ink leading-tight">{health ? health.score : '—'}</div>
            </div>
          </div>
        </div>
        {health && health.reasons.length ? (
          <ul className="-mt-3 flex flex-wrap gap-[6px]">
            {health.reasons.map((r) => <li key={r}><Tag tone="warn">{r}</Tag></li>)}
          </ul>
        ) : null}

        {/* GST record */}
        {gst && rows ? (
          <Section title="GST filing record" link={can(role, 'workstation.gst.read', 'self') ? { label: 'All filings', to: `${base}/gst` } : undefined}>
            <div className="grid gap-1 items-center text-12" style={{ gridTemplateColumns: `68px repeat(${gst.periods.length}, minmax(0,1fr))` }}>
              <span />
              {gst.periods.map((p) => <span key={p} className="text-center text-[10.5px] font-semibold text-inkFaint">{monthShort(p)}</span>)}
              {(['gstr1', 'gstr3b'] as const).map((k) => (
                <GstRow key={k} label={k === 'gstr1' ? 'GSTR-1' : 'GSTR-3B'} cells={gst.periods.map((p) => rows.get(p)?.[k] ?? null)} />
              ))}
            </div>
          </Section>
        ) : null}

        {/* TDS */}
        {tds.length ? (
          <Section title="TDS" link={{ label: 'Open TDS', to: '/workstation/services/tds' }}>
            <ul className="cp-list">
              {tds.flatMap((r) => r.open_items.slice(0, 4).map((it) => (
                <li key={`${r.tan}-${it.label}-${it.due}`}>
                  <span className={'cp-tag ' + (it.state === 'overdue' ? 'is-bad' : 'is-coral')}>TDS</span>
                  <b className="truncate">{it.label}</b>
                  <small className={it.state === 'overdue' ? 'text-danger' : ''}>{it.state === 'overdue' ? 'Overdue · ' : 'Due '}{new Date(`${it.due}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</small>
                </li>
              )))}
            </ul>
          </Section>
        ) : null}

        {/* Services */}
        {services.data ? (
          <Section title="Services" link={{ label: 'All services', to: `${base}/services` }}>
            {openServices.length === 0 ? <p className="text-13 text-inkMuted">No open services.</p> : (
              <ul className="cp-list">
                {openServices.slice(0, 5).map((s) => (
                  <li key={s.id}>
                    <span className="cp-tag is-teal">SVC</span>
                    <b className="truncate">{s.service_name ?? 'Service'}</b>
                    <small>{s.due_date ? `Due ${new Date(`${s.due_date.slice(0, 10)}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}` : s.status.replace(/_/g, ' ')}</small>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        ) : null}

        {/* Recent invoices */}
        {invoices.data && invoices.data.invoices.length ? (
          <Section title="Recent invoices" link={{ label: 'All invoices', to: `${base}/invoices` }}>
            <ul className="cp-list">
              {invoices.data.invoices.slice(0, 4).map((inv) => (
                <li key={inv.id}>
                  <span className={'cp-tag ' + (inv.state === 'overdue' ? 'is-bad' : inv.state === 'paid' ? 'is-ok' : 'is-amber')}>{inv.state.toUpperCase()}</span>
                  <b className="truncate font-mono text-12">{inv.invoice_number}</b>
                  <small className="tabular-nums">{inr(inv.total_paise)}</small>
                </li>
              ))}
            </ul>
          </Section>
        ) : null}

        {/* Contact */}
        {contact || client.contact_person ? (
          <Section title="Primary contact">
            <div className="flex items-center gap-3 rounded-[11px] px-3 py-[10px] ring-1 ring-inset ring-border">
              <Avatar name={contact?.name ?? client.contact_person} size={34} />
              <div className="min-w-0 flex-1">
                <div className="text-13 font-semibold text-ink truncate">{contact?.name ?? client.contact_person}</div>
                <div className="text-12 text-inkMuted truncate">{[contact?.designation, contact?.phone ?? client.contact_number].filter(Boolean).join(' · ')}</div>
              </div>
              {(contact?.phone ?? client.contact_number) ? (
                <a href={`tel:${contact?.phone ?? client.contact_number}`} className="h-8 w-8 grid place-items-center rounded-[9px] bg-surface shadow-card text-inkMuted hover:text-ink" aria-label="Call"><Phone size={14} /></a>
              ) : null}
              {(contact?.email ?? client.email) ? (
                <a href={`mailto:${contact?.email ?? client.email}`} className="h-8 w-8 grid place-items-center rounded-[9px] bg-surface shadow-card text-inkMuted hover:text-ink" aria-label="Email"><Mail size={14} /></a>
              ) : null}
            </div>
          </Section>
        ) : null}
      </div>
    </aside>
  );
}

function GstRow({ label, cells }: { label: string; cells: ({ state: string; due_date: string | null } | null)[] }) {
  return (
    <>
      <span className="font-medium text-ink">{label}</span>
      {cells.map((c, i) => {
        const cls = !c ? 'is-none' : c.state === 'done' ? 'is-done' : c.state === 'overdue' ? 'is-late' : 'is-open';
        const text = !c ? '–' : c.state === 'done' ? '✓' : c.state === 'overdue' ? '!' : 'due';
        return <i key={i} className={'cp-cell ' + cls} title={c ? `${label}: ${c.state.replace('_', ' ')}${c.due_date ? ` · due ${c.due_date}` : ''}` : 'Nothing due'}>{text}</i>;
      })}
    </>
  );
}

function Section({ title, link, children }: { title: string; link?: { label: string; to: string }; children: React.ReactNode }) {
  return (
    <section>
      <h4 className="flex items-center justify-between mb-2 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-inkFaint">
        {title}
        {link ? <Link to={link.to} className="normal-case tracking-normal text-12 font-semibold text-primary">{link.label} →</Link> : null}
      </h4>
      {children}
    </section>
  );
}

function Stat({ label, value, bad }: { label: string; value: string; bad?: boolean }) {
  return (
    <div className={'rounded-[11px] px-3 py-2 min-w-0 ' + (bad ? 'bg-danger/10' : 'bg-neutral-100')}>
      <div className={'text-11 ' + (bad ? 'text-danger' : 'text-inkMuted')}>{label}</div>
      <div className={'num-display text-16 leading-tight truncate ' + (bad ? 'text-danger' : 'text-ink')}>{value}</div>
    </div>
  );
}

function Tag({ children, tone }: { children: React.ReactNode; tone?: 'bad' | 'warn' }) {
  const cls = tone === 'bad' ? 'text-danger bg-danger/10' : tone === 'warn' ? 'text-warning bg-warning/10' : 'text-inkMuted bg-surface shadow-card';
  return <span className={'inline-flex items-center h-6 px-[10px] rounded-full text-11 font-semibold ' + cls}>{children}</span>;
}
