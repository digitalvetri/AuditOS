import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { ArrowRight, Eye, EyeOff, FileText, Lock, Mail, ShieldCheck, Users } from 'lucide-react';
import { useAuth } from '@/platform/auth/AuthContext';
import { BrandLogo } from '@/components/BrandLogo';
import { useParallax } from './login/useParallax';
import './login/login.css';

/**
 * Sign-in. Left: the brand scene — the desk illustration with depth motion
 * (pointer parallax, floating cards, lamp glow; see login.css). Right: the
 * sign-in card. Below 900px the scene becomes a short banner above the card.
 *
 * This is a pre-auth brand screen, so it keeps its light lavender look in the
 * dark theme too; its colours live in login.css, not in the theme tokens.
 */
const FEATURES = [
  { Icon: ShieldCheck, title: 'GST & TDS', text: 'Every return and challan, with its deadline' },
  { Icon: FileText, title: 'Clients & billing', text: 'Quotations, invoices and what each client owes' },
  { Icon: Users, title: 'People', text: 'Attendance, leave, expenses and payroll' },
];

export function LoginPage() {
  const { login, loading, error, session } = useAuth();
  const navigate = useNavigate();
  const sceneRef = useParallax<HTMLDivElement>();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [remember, setRemember] = useState(false);
  const [forgotOpen, setForgotOpen] = useState(false);

  if (session) {
    return <Navigate to={session.must_change_password ? '/set-password' : '/'} replace />;
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
    <div className="lg-page" ref={sceneRef}>
      {/* ── Brand scene ─────────────────────────────────────────────────── */}
      <section className="lg-hero" aria-label="JNS Accounting Solutions">
        <span className="lg-orb lg-orb--a" aria-hidden />
        <span className="lg-orb lg-orb--b" aria-hidden />
        <div className="lg-scene" aria-hidden>
          <img src="/login/desk-scene.jpg" alt="" className="lg-scene-img" draggable={false} />
          <span className="lg-lamp" />
        </div>

        <header className="lg-brand">
          <span className="lg-brand-chip">
            <img src="/jns-mark.png" alt="" />
          </span>
          <span className="lg-brand-name">Accounting<br />Solutions</span>
        </header>

        <div className="lg-copy">
          <h2 className="lg-title">
            Your whole practice,<br /><em>in one place.</em>
          </h2>
          <p className="lg-lead">
            Clients, compliance, billing and your team — the daily work of JNS Accounting Solutions, together.
          </p>
          <ul className="lg-features">
            {FEATURES.map(({ Icon, title, text }, i) => (
              <li key={title} className="lg-feature" style={{ ['--i' as string]: i }}>
                <div className="lg-feature-card">
                  <span className="lg-feature-icon"><Icon size={20} strokeWidth={1.8} /></span>
                  <span>
                    <span className="lg-feature-title">{title}</span>
                    <span className="lg-feature-text">{text}</span>
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <footer className="lg-copyright">© JNS Accounting Solutions</footer>
      </section>

      {/* ── Sign-in ─────────────────────────────────────────────────────── */}
      <main className="lg-side">
        <span className="lg-blob lg-blob--top" aria-hidden />
        <span className="lg-blob lg-blob--bottom" aria-hidden />

        <div className="lg-card">
          <BrandLogo src="/jns-logo-tight.png" alt="JNS Accounting Solutions" className="lg-card-logo" />
          <h1 className="lg-welcome">Welcome back</h1>
          <p className="lg-sub">Sign in to your workspace and stay productive.</p>

          <form onSubmit={onSubmit} className="lg-form">
            <div>
              <label htmlFor="email" className="lg-label">Work email</label>
              <div className="lg-field">
                <Mail className="lg-field-icon" size={18} strokeWidth={1.7} aria-hidden />
                <input
                  id="email"
                  type="email"
                  name="email"
                  autoComplete="email"
                  placeholder="name@company.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  className="lg-input"
                />
              </div>
            </div>

            <div>
              <label htmlFor="password" className="lg-label">Password</label>
              <div className="lg-field">
                <Lock className="lg-field-icon" size={18} strokeWidth={1.7} aria-hidden />
                <input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  name="password"
                  autoComplete="current-password"
                  placeholder="Enter your password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  className="lg-input lg-input--eye"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  className="lg-eye"
                >
                  {showPassword ? <EyeOff size={18} strokeWidth={1.7} /> : <Eye size={18} strokeWidth={1.7} />}
                </button>
              </div>
            </div>

            <div className="lg-row">
              <label className="lg-remember">
                <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
                Remember me
              </label>
              <a
                href="#"
                onClick={(e) => { e.preventDefault(); setForgotOpen((v) => !v); }}
                aria-expanded={forgotOpen}
                className="lg-link"
              >
                Forgot password?
              </a>
            </div>

            {forgotOpen ? (
              <div role="note" className="lg-note">
                Ask your Admin to reset your password. You’ll sign in with the temporary password they give you and then choose a new one.
              </div>
            ) : null}

            {error ? <div role="alert" className="lg-error">{error}</div> : null}

            <button type="submit" disabled={loading} className="lg-submit">
              {loading ? 'Signing in…' : (<>Sign in <ArrowRight size={18} strokeWidth={2} /></>)}
            </button>
          </form>

        </div>

        <nav className="lg-legal" aria-label="Legal">
          <a href="#" onClick={(e) => e.preventDefault()}>Privacy</a>
          <span aria-hidden>|</span>
          <a href="#" onClick={(e) => e.preventDefault()}>Terms</a>
        </nav>
      </main>
    </div>
  );
}
