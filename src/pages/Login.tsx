import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '@/platform/auth/AuthContext';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { demoCredentials } from '@/data/seed';

const MOCK_MODE = import.meta.env.VITE_MOCK_MODE === 'true';

export function LoginPage() {
  const { login, loading, error, session } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  if (session) {
    return <Navigate to="/" replace />;
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    try {
      await login(email, password);
      navigate('/', { replace: true });
    } catch {
      // AuthContext surfaces the message via `error`.
    }
  }

  return (
    <div className="min-h-screen grid grid-cols-1 md:grid-cols-2">
      {/* Left: form */}
      <div className="flex items-center justify-center p-6 bg-white">
        <div className="w-full max-w-[360px]">
          <div className="mb-8">
            <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">Audit OS</div>
            <h1 className="text-20 font-semibold text-neutral-900 mt-1">Sign in</h1>
          </div>

          <form onSubmit={onSubmit} className="space-y-3">
            <Input
              label="Email"
              type="email"
              name="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
            <Input
              label="Password"
              type="password"
              name="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            {error ? (
              <div className="text-12 text-red border-l-2 border-red pl-2">{error}</div>
            ) : null}
            <Button type="submit" variant="primary" disabled={loading} className="w-full">
              {loading ? 'Signing in…' : 'Sign in'}
            </Button>
          </form>
        </div>
      </div>

      {/* Right: demo credentials — only in mock mode (§11) */}
      <div className="hidden md:flex bg-neutral-50 border-l border-neutral-200 items-center justify-center p-6">
        {MOCK_MODE ? <DemoCredentials onPick={(e, p) => { setEmail(e); setPassword(p); }} /> : null}
      </div>
    </div>
  );
}

function DemoCredentials({ onPick }: { onPick: (email: string, password: string) => void }) {
  return (
    <div className="w-full max-w-[360px]">
      <div className="text-11 uppercase tracking-[0.06em] text-neutral-500 mb-2">
        Demo logins (mock mode)
      </div>
      <div className="bg-white border border-neutral-200 rounded">
        {demoCredentials.map((c, i) => (
          <button
            key={c.email}
            type="button"
            onClick={() => onPick(c.email, c.password)}
            className={
              'w-full text-left px-3 py-2 flex items-center justify-between hover:bg-neutral-50 ' +
              (i > 0 ? 'border-t border-neutral-200' : '')
            }
          >
            <div>
              <div className="text-13 text-neutral-900 font-medium">{c.role}</div>
              <div className="text-12 text-neutral-500">{c.email}</div>
            </div>
            <div className="text-11 text-neutral-500">pw: {c.password}</div>
          </button>
        ))}
      </div>
      <p className="text-11 text-neutral-500 mt-3">
        Shown only when <code className="text-neutral-700">VITE_MOCK_MODE=true</code>.
      </p>
    </div>
  );
}
