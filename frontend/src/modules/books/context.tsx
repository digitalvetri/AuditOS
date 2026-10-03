import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { booksApi, type BooksOrg, type BooksStatus } from './api';

/**
 * Books state shared by every screen: the connection status, the active
 * Zoho organisation, and what the caller may do. The active organisation —
 * which also fixes its connection — is chosen from `?org=` (deep links, e.g.
 * from Bookkeeping), else this user's selection saved on the server (any
 * device), else the last one used on this browser, else the first active
 * one. Only Audit OS ids are remembered — never anything from Zoho.
 */
const KEY = 'books.activeOrg';
const readSaved = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
const save = (id: string) => { try { localStorage.setItem(KEY, id); } catch { /* private mode */ } };

interface BooksCtx {
  status: BooksStatus;
  activeOrgs: BooksOrg[];
  org: BooksOrg | null;
  setOrg: (id: string) => void;
  can: BooksStatus['permissions'];
  refetch: () => void;
}
const Ctx = createContext<BooksCtx | null>(null);

export function useBooks(): BooksCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useBooks must be used inside <BooksProvider>');
  return v;
}

/** The active organisation; screens under the org gate can rely on it. */
export function useOrg(): BooksOrg {
  const { org } = useBooks();
  if (!org) throw new Error('useOrg needs an active organisation');
  return org;
}

export const statusKey = ['books', 'status'] as const;

/** "Main Account — Meridian Logistics": connection and organisation together. */
export function orgLabel(o: BooksOrg): string {
  return o.connection_name ? `${o.connection_name} — ${o.name}` : o.name;
}

export function BooksProvider({ children }: { children: (q: { loading: boolean; error: unknown; ctx: BooksCtx | null }) => ReactNode }) {
  const q = useQuery({ queryKey: statusKey, queryFn: booksApi.status, staleTime: 30_000 });
  const [params, setParams] = useSearchParams();
  const [chosen, setChosen] = useState<string | null>(() => params.get('org'));

  // A ?org= deep link wins once, then leaves the URL clean.
  useEffect(() => {
    const p = params.get('org');
    if (p) {
      setChosen(p); save(p);
      const next = new URLSearchParams(params); next.delete('org'); setParams(next, { replace: true });
    }
  }, [params, setParams]);

  // Switching only points at an already-configured connection: no sign-in, no codes.
  const setOrg = useCallback((id: string) => { setChosen(id); save(id); booksApi.select(id).catch(() => undefined); }, []);

  const ctx = useMemo<BooksCtx | null>(() => {
    if (!q.data) return null;
    const activeOrgs = q.data.organizations.filter((o) => o.is_active);
    const pick = chosen ?? q.data.selected_org_ref ?? readSaved();
    const org = activeOrgs.find((o) => o.id === pick) ?? activeOrgs[0] ?? null;
    return { status: q.data, activeOrgs, org, setOrg, can: q.data.permissions, refetch: () => void q.refetch() };
  }, [q.data, chosen, setOrg, q]);

  return <Ctx.Provider value={ctx}>{children({ loading: q.isLoading, error: q.error, ctx })}</Ctx.Provider>;
}
