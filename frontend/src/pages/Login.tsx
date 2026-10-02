import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '@/platform/auth/AuthContext';
import { demoCredentials } from '@/data/seed';

const MOCK_MODE = import.meta.env.VITE_MOCK_MODE === 'true';
/**
 * The demo list is on by default in mock mode. Against the real backend it is
 * off unless explicitly enabled, so a deployed build never advertises the
 * development logins.
 */
const SHOW_DEMO_LOGINS =
  MOCK_MODE || import.meta.env.VITE_SHOW_DEMO_LOGINS === 'true';

// Login-page brand blues. Scoped to this file — the rest of the app keeps
// the sage+gold system from tailwind.config.ts, so we use arbitrary values
// rather than adding tokens that would leak into other screens.
/**
 * Read from the platform tokens rather than literals, so the sign-in button
 * is the same navy as the sidebar rail and every other primary action, and a
 * palette change reaches this screen like it reaches the rest of the app.
 * These are inline styles, so they carry the `rgb(var(--x))` form.
 */
const BRAND = {
  panel: 'rgb(var(--c-sidebar))',        // deep navy behind the hero artwork
  primary: 'rgb(var(--c-primary))',      // sign-in button + link
  primaryHover: 'rgb(var(--c-primary-hover))',
};

export function LoginPage() {
  const { login, loading, error, session } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [remember, setRemember] = useState(false);

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
    <div className="min-h-screen grid grid-cols-1 md:grid-cols-2 bg-white">
      {/* Left: hero artwork */}
      <div
        className="hidden md:block relative overflow-hidden"
        style={{ backgroundColor: BRAND.panel }}
      >
        <img
          src="/login-hero.png"
          alt=""
          aria-hidden="true"
          className="absolute inset-0 h-full w-full object-cover"
        />
        <div className="relative z-10 h-full flex flex-col p-8">
          <div className="flex items-start justify-end">
            <a
              href="#"
              className="text-white/85 text-13 hover:text-white"
              onClick={(e) => e.preventDefault()}
            >
              Help
            </a>
          </div>
          <div className="flex-1" />
        </div>
      </div>

      {/* Right: sign-in form */}
      <div className="relative flex items-center justify-center p-6 md:p-12">
        <div className="w-full max-w-[380px]">
          <img
            src="/jns-logo-tight.png"
            alt="JNS Accounting Solutions"
            className="block h-16 w-auto mb-8"
          />
          <h1 className="text-28 font-semibold text-neutral-900 leading-tight">
            Welcome back
          </h1>
          <p className="text-14 text-neutral-500 mt-1">Sign in to your workspace</p>

          <form onSubmit={onSubmit} className="mt-8 space-y-4">
            <div>
              <label
                htmlFor="email"
                className="block text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1"
              >
                Work email
              </label>
              <input
                id="email"
                type="email"
                name="email"
                autoComplete="email"
                placeholder="name@company.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                onFocus={(e) => (e.currentTarget.style.borderColor = BRAND.primary)}
                onBlur={(e) => (e.currentTarget.style.borderColor = '')}
                className="block w-full h-11 px-3 text-14 bg-white text-neutral-900 placeholder-neutral-400 border border-neutral-300 rounded-md focus:outline-none"
              />
            </div>

            <div>
              <label
                htmlFor="password"
                className="block text-11 uppercase tracking-[0.06em] text-neutral-500 mb-1"
              >
                Password
              </label>
              <div className="relative">
                <input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  name="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  onFocus={(e) => (e.currentTarget.style.borderColor = BRAND.primary)}
                  onBlur={(e) => (e.currentTarget.style.borderColor = '')}
                  className="block w-full h-11 pl-3 pr-11 text-14 bg-white text-neutral-900 placeholder-neutral-400 border border-neutral-300 rounded-md focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  className="absolute right-2 top-1/2 -translate-y-1/2 h-8 w-8 inline-flex items-center justify-center text-neutral-500 hover:text-neutral-800 rounded"
                >
                  {showPassword ? <EyeOffIcon /> : <EyeIcon />}
                </button>
              </div>
            </div>

            <div className="flex items-center justify-between pt-1">
              <label className="flex items-center gap-2 text-13 text-neutral-700 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={(e) => setRemember(e.target.checked)}
                  className="h-4 w-4 rounded border-neutral-300"
                  style={{ accentColor: BRAND.primary }}
                />
                Remember me
              </label>
              <a
                href="#"
                onClick={(e) => e.preventDefault()}
                className="text-13 hover:underline"
                style={{ color: BRAND.primary }}
              >
                Forgot password?
              </a>
            </div>

            {error ? (
              <div className="text-12 text-red border-l-2 border-red pl-2">{error}</div>
            ) : null}

            <button
              type="submit"
              disabled={loading}
              className="w-full h-11 inline-flex items-center justify-center gap-2 text-14 font-medium text-white rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-60"
              style={{ backgroundColor: BRAND.primary }}
              onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = BRAND.primaryHover)}
              onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = BRAND.primary)}
            >
              {loading ? 'Signing in…' : (
                <>
                  Sign in
                  <ArrowRightIcon />
                </>
              )}
            </button>
          </form>

          <p className="mt-6 text-center text-13 text-neutral-500">
            Need access? Contact your administrator
          </p>

          {SHOW_DEMO_LOGINS ? (
            <DemoCredentials onPick={(e, p) => { setEmail(e); setPassword(p); }} />
          ) : null}
        </div>

        <div className="absolute bottom-4 right-6 flex items-center gap-3 text-12 text-neutral-400">
          <a href="#" onClick={(e) => e.preventDefault()} className="hover:text-neutral-600">
            Privacy
          </a>
          <span aria-hidden>·</span>
          <a href="#" onClick={(e) => e.preventDefault()} className="hover:text-neutral-600">
            Terms
          </a>
        </div>
      </div>
    </div>
  );
}

function DemoCredentials({ onPick }: { onPick: (email: string, password: string) => void }) {
  return (
    <div className="mt-8 pt-6 border-t border-neutral-200">
      <div className="text-11 uppercase tracking-[0.06em] text-neutral-500 mb-2">
        Demo logins ({MOCK_MODE ? 'mock mode' : 'seeded development backend'})
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
        Shown when <code className="text-neutral-700">VITE_MOCK_MODE=true</code> or
        {' '}<code className="text-neutral-700">VITE_SHOW_DEMO_LOGINS=true</code>. These are
        development credentials from the seed — never enable this on a real deployment.
      </p>
    </div>
  );
}

function EyeIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M17.94 17.94A10.94 10.94 0 0 1 12 19c-6.5 0-10-7-10-7a19.7 19.7 0 0 1 4.22-5.19" />
      <path d="M9.9 4.24A10.94 10.94 0 0 1 12 4c6.5 0 10 7 10 7a19.72 19.72 0 0 1-3.16 4.19" />
      <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
      <line x1="2" y1="2" x2="22" y2="22" />
    </svg>
  );
}

function ArrowRightIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="5" y1="12" x2="19" y2="12" />
      <polyline points="12 5 19 12 12 19" />
    </svg>
  );
}
