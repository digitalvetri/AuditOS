import { Navigate, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useAuth } from './AuthContext';

/**
 * Route guard. Redirects to /login when there's no session.
 *
 * This is UI convenience — the security control is the API's 401/403. Never
 * rely on this alone (§4.3).
 */
export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { session, loading } = useAuth();
  const location = useLocation();

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
