import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, setSessionEndedHandler, type ApiError } from '@/services/api';
import { useToast } from '@/components/Toast';
import { useIdleLogout } from './useIdleLogout';
import type { RoleCode } from '@/data/models';
import { setLiveGrants, type Grant } from '@/platform/rbac/matrix';
import { currentSubscription } from '@/platform/pwa/push';

interface Session {
  user: { id: string; email: string };
  /** Signed in with an Admin-issued password: must set a new one first. */
  must_change_password?: boolean;
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
    /** An owner's staff record: in Messages, never in attendance/leave/payroll. */
    exclude_from_hr?: boolean;
  } | null;
}

interface AuthState {
  session: Session | null;
  loading: boolean;
  error: string | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  /** Change the signed-in user's password; this browser stays signed in. */
  changePassword: (current: string, next: string) => Promise<void>;
  /** The session check could not reach the server (offline / API down). */
  unreachable: boolean;
  /** Try the session check again (after coming back online). */
  retry: () => void;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  // Cached API data belongs to whoever was signed in. It must not outlive
  // them: on a shared office PC the next person would see the previous
  // user's lists until each query refetched.
  const queryClient = useQueryClient();
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
        // Always a 200 — null when signed out — so the sign-in page logs no
        // 401 to the console on every visit.
        const s = await api.get<Session | null>('/api/auth/session');
        if (!cancelled) { setSession(s); setUnreachable(false); }
      } catch (e) {
        // No status at all means the server was never reached (offline):
        // that is not "signed out", so don't bounce the installed app to the
        // login screen.
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
      queryClient.clear();
      setSession(s);
    } catch (e) {
      const ae = e as ApiError;
      setError(ae.message);
      throw e;
    } finally {
      setLoading(false);
    }
  }, [queryClient]);

  const logout = useCallback(async () => {
    try {
      // Detach this browser's push endpoint so the next person to sign in
      // here never receives the previous user's notifications.
      const sub = await currentSubscription().catch(() => null);
      await api.post('/api/auth/logout', sub ? { push_endpoint: sub.endpoint } : undefined);
    } finally {
      queryClient.clear();
      setSession(null);
    }
  }, [queryClient]);

  // The server ended the session mid-use (expired, signed out elsewhere,
  // password changed, account disabled): drop it here too. ProtectedRoute
  // then sends the user to /login.
  const toast = useToast();
  const sessionRef = useRef(session);
  sessionRef.current = session;
  useEffect(() => {
    setSessionEndedHandler((message) => {
      if (!sessionRef.current) return;
      sessionRef.current = null;
      toast.push('info', message || 'Your session has ended. Sign in again.');
      queryClient.clear();
      setSession(null);
    });
    return () => setSessionEndedHandler(null);
  }, [queryClient, toast, setSession]);

  // Idle sign-out: 30 minutes with no activity, with a one-minute warning.
  useIdleLogout({
    enabled: !!session,
    onWarn: () => toast.push('info', 'You will be signed out in 1 minute because of inactivity. Move the mouse or press a key to stay signed in.'),
    onTimeout: () => {
      toast.push('info', 'You were signed out after 30 minutes of inactivity.');
      void logout().catch(() => undefined);
    },
  });

  const changePassword = useCallback(async (current: string, next: string) => {
    const s = await api.post<Session>('/api/auth/change-password', {
      current_password: current, new_password: next,
    });
    setSession(s);
  }, [setSession]);

  const value = useMemo<AuthState>(
    () => ({ session, loading, error, login, logout, changePassword, unreachable, retry }),
    [session, loading, error, login, logout, changePassword, unreachable, retry],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** True when the signed-in person is tracked for attendance, leave and payroll. */
export function tracksHr(session: { employee: { exclude_from_hr?: boolean } | null } | null | undefined): boolean {
  return Boolean(session?.employee && !session.employee.exclude_from_hr);
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth must be used inside <AuthProvider>');
  return v;
}
