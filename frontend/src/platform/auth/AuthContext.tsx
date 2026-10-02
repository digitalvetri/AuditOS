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

  // Boot: try to resume an existing session.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await api.get<Session>('/api/auth/me');
        if (!cancelled) setSession(s);
      } catch {
        // 401 is the expected first-run state — swallow.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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
      await api.post('/api/auth/logout');
    } finally {
      setSession(null);
    }
  }, []);

  const value = useMemo<AuthState>(
    () => ({ session, loading, error, login, logout }),
    [session, loading, error, login, logout],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth must be used inside <AuthProvider>');
  return v;
}
