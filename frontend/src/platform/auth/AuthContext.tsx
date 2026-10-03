import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { api, type ApiError } from '@/services/api';
import type { RoleCode } from '@/data/models';
import { setLiveGrants, type Grant } from '@/platform/rbac/matrix';
import { currentSubscription } from '@/platform/pwa/push';

interface Session {
  user: { id: string; email: string };
  role: { id: string; code: RoleCode; name: string };
  /** Live grants from the server; drives can() for menus. */
  grants?: Grant[];
  employee: {
    id: string;
    full_name: string;
    department_id: string;
    designation_id: string;
    photo_url: string | null;
    employee_code: string;
  } | null;
}

interface AuthState {
  session: Session | null;
  loading: boolean;
  error: string | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  /** The session check could not reach the server (offline / API down). */
  unreachable: boolean;
  /** Try the session check again (after coming back online). */
  retry: () => void;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSessionState] = useState<Session | null>(null);
  // Keep can()'s live grants in step with the session, before React renders it.
  const setSession = useCallback((next: Session | null | ((s: Session | null) => Session | null)) => {
    setSessionState((prev) => {
      const s = typeof next === 'function' ? next(prev) : next;
      setLiveGrants(s?.role.code ?? null, s?.grants);
      return s;
    });
  }, []);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => { setLoading(true); setAttempt((a) => a + 1); }, []);

  // Boot: try to resume an existing session.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await api.get<Session>('/api/auth/me');
        if (!cancelled) { setSession(s); setUnreachable(false); }
      } catch (e) {
        // 401 is the expected first-run state — swallow. No status at all
        // means the server was never reached (offline): that is not "signed
        // out", so don't bounce the installed app to the login screen.
        if (!cancelled) setUnreachable((e as ApiError).status === 0);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  // Back online after an unreachable boot: check the session again.
  useEffect(() => {
    if (!unreachable) return;
    const onOnline = () => retry();
    window.addEventListener('online', onOnline);
    // Not every network change fires `online` (the API itself may have been
    // down), so keep checking quietly too.
    const t = setInterval(retry, 10_000);
    return () => { window.removeEventListener('online', onOnline); clearInterval(t); };
  }, [unreachable, retry]);

  const login = useCallback(async (email: string, password: string) => {
    setError(null);
    setLoading(true);
    try {
      const s = await api.post<Session>('/api/auth/login', { email, password });
      setSession(s);
    } catch (e) {
      const ae = e as ApiError;
      setError(ae.message);
      throw e;
    } finally {
      setLoading(false);
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      // Detach this browser's push endpoint so the next person to sign in
      // here never receives the previous user's notifications.
      const sub = await currentSubscription().catch(() => null);
      await api.post('/api/auth/logout', sub ? { push_endpoint: sub.endpoint } : undefined);
    } finally {
      setSession(null);
    }
  }, []);

  const value = useMemo<AuthState>(
    () => ({ session, loading, error, login, logout, unreachable, retry }),
    [session, loading, error, login, logout, unreachable, retry],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth must be used inside <AuthProvider>');
  return v;
}
