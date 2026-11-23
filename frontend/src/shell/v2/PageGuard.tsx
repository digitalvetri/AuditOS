/**
 * A page an Admin switched off for this login (Employees → Page access) shows
 * a plain notice instead of the page — even when opened from a link or
 * bookmark. Menu-rendering only; the API enforces its own part
 * (backend src/platform/pages.ts).
 */
import type { ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '@/platform/auth/AuthContext';
import { pageKeyForPath } from './Sidebar';

export function PageGuard({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  const { pathname } = useLocation();
  const hidden = session?.hidden_pages ?? [];
  const key = hidden.length ? pageKeyForPath(session?.role.code, session, pathname) : null;
  if (!key || !hidden.includes(key)) return <>{children}</>;
  return (
    <div className="max-w-[560px] mx-auto" data-testid="page-switched-off">
      <div className="bg-white border border-neutral-200 rounded p-6">
        <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">No access</div>
        <h1 className="text-20 font-semibold text-neutral-900 mt-1">This page is switched off for you</h1>
        <p className="text-13 text-neutral-500 mt-2">An Admin can turn it on from Employees → your profile → Page access.</p>
        <div className="mt-4">
          <Link to="/" className="text-13 text-primary hover:underline">Return to Dashboard</Link>
        </div>
      </div>
    </div>
  );
}
