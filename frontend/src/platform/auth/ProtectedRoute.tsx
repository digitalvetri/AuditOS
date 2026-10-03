import { Navigate, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { WifiOff } from 'lucide-react';
import { useAuth } from './AuthContext';

/**
 * Route guard. Redirects to /login when there's no session.
 *
 * This is UI convenience — the security control is the API's 401/403. Never
 * rely on this alone (§4.3).
 */
export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { session, loading, unreachable, retry } = useAuth();
  const location = useLocation();

  if (!session && unreachable) {
    return (
      <div className="min-h-screen grid place-items-center bg-canvas p-6">
        <div className="max-w-[380px] text-center" data-testid="offline-screen">
          <div className="mx-auto h-14 w-14 rounded-[16px] grid place-items-center bg-coral/15 text-coral mb-4"><WifiOff size={24} /></div>
          <h1 className="text-[22px] font-extrabold text-ink">You’re offline</h1>
          <p className="text-13 text-inkMuted mt-2">AuditOS can’t reach the server right now. Your data is safe — we’ll reconnect automatically as soon as the connection is back.</p>
          <button type="button" onClick={retry} className="mt-5 h-10 px-5 rounded-[12px] bg-primary text-white text-13 font-semibold">Try again</button>
        </div>
      </div>
    );
  }

  if (loading) {
    // Static block per §7 — no spinner, no shimmer.
    return (
      <div className="min-h-screen grid place-items-center bg-neutral-50">
        <div className="w-24 h-24 bg-neutral-100" aria-label="Loading" />
      </div>
    );
  }

  if (!session) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  return <>{children}</>;
}
