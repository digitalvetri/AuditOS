/**
 * Organization identifiers, shared so an organization and its clients look
 * the same everywhere. A client's own name is never replaced — the
 * organization is shown as an extra line or chip next to it.
 */
import { Building2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { OrganizationRef } from '../types';

/** "Organization" chip for the organization client itself. */
export function OrganizationBadge({ count }: { count?: number }) {
  return (
    <span className="inline-flex items-center gap-1 h-5 px-2 rounded-full text-11 font-semibold bg-primary/10 text-primary whitespace-nowrap">
      <Building2 size={11} strokeWidth={2} />
      Organization{count !== undefined ? ` · ${count} client${count === 1 ? '' : 's'}` : ''}
    </span>
  );
}

/** "Organization: ABC Business Solutions" under a client's name. */
export function OrganizationOf({ org, link = true }: { org: OrganizationRef | null | undefined; link?: boolean }) {
  if (!org) return null;
  const text = (
    <>
      <Building2 size={11} strokeWidth={2} className="shrink-0" />
      <span className="truncate">Organization: {org.name}</span>
    </>
  );
  const cls = 'inline-flex items-center gap-1 text-11 text-primary min-w-0';
  return link
    ? <Link to={`/workstation/clients/${org.id}/organization`} onClick={(e) => e.stopPropagation()} className={cls + ' hover:underline'}>{text}</Link>
    : <span className={cls}>{text}</span>;
}

/** Option text for client pickers: the client's name, plus its organization. */
export function clientOptionLabel(c: { client_id: string; company_name: string; organization?: OrganizationRef | null; is_organization?: boolean }): string {
  const base = `${c.client_id} · ${c.company_name}`;
  if (c.is_organization) return `${base} (Organization)`;
  return c.organization ? `${base} — ${c.organization.name}` : base;
}

/** Mirrors the server's default: "ABC Business Solutions" → "ABC", "Greenleaf Organics LLP" → "GOL". */
export function deriveShortName(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';
  if (words.length === 1 || words[0].length <= 5) return words[0].replace(/[^A-Za-z0-9]/g, '').slice(0, 8).toUpperCase();
  return words.slice(0, 4).map((w) => w[0]).join('').toUpperCase();
}

/** A client's name with its organization, for one-line labels: "ABC DV Client 1 — ABC Business Solutions". */
export function clientNameWithOrg(c: { company_name: string; organization?: OrganizationRef | null; is_organization?: boolean }): string {
  if (c.is_organization) return `${c.company_name} (Organization)`;
  return c.organization ? `${c.company_name} — ${c.organization.name}` : c.company_name;
}
