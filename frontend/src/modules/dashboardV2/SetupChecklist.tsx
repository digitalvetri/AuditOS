/**
 * Dashboard → first-run setup checklist (Admin / Super Admin only), until it
 * is dismissed. Completion is live from GET /api/settings/onboarding; each
 * step links to the page that does it.
 */
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, ChevronRight, Circle, Rocket, X } from 'lucide-react';
import { api } from '@/services/api';
import { useAuth } from '@/platform/auth/AuthContext';
import { useToast } from '@/components/Toast';

export interface OnboardingStep { key: string; label: string; description: string; done: boolean; count: number; href: string }
export interface OnboardingState { dismissed_at: string | null; steps: OnboardingStep[]; done: number; total: number; complete: boolean }

export const onboardingApi = {
  get: () => api.get<OnboardingState>('/api/settings/onboarding'),
  setDismissed: (dismissed: boolean) => api.post<OnboardingState>('/api/settings/onboarding', { dismissed }),
};

const OWNER_ROLES = ['md', 'hr_admin'];

export function SetupChecklist() {
  const { session } = useAuth();
  const owner = OWNER_ROLES.includes(session?.role.code ?? '');
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['onboarding'], queryFn: onboardingApi.get, enabled: owner, staleTime: 60_000 });
  const dismiss = useMutation({
    mutationFn: () => onboardingApi.setDismissed(true),
    onSuccess: (d) => { qc.setQueryData(['onboarding'], d); toast.push('info', 'Setup checklist hidden.'); },
    onError: (e) => toast.push('error', (e as Error).message),
  });

  const d = q.data;
  if (!owner || !d || d.dismissed_at) return null;
  const pct = Math.round((d.done / Math.max(d.total, 1)) * 100);

  return (
    <section className="dash-card dash-rise p-5 min-w-0" aria-labelledby="setup-title" data-testid="setup-checklist">
      <header className="flex items-start gap-3 mb-4">
        <span className="h-9 w-9 shrink-0 rounded-lg inline-flex items-center justify-center bg-[#f1edff] text-primary" aria-hidden>
          <Rocket size={17} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id="setup-title" className="text-15 font-semibold text-ink tracking-[-0.005em]">
            {d.complete ? 'Your firm is set up' : 'Set up your firm'}
          </h2>
          <p className="text-12 text-inkMuted">{d.done} of {d.total} done — each step ticks itself off as you go.</p>
        </div>
        <button type="button" onClick={() => dismiss.mutate()} disabled={dismiss.isPending}
          className="h-8 px-3 inline-flex items-center gap-1 rounded-full text-12 font-medium text-inkMuted hover:text-ink hover:bg-neutral-100">
          <X size={14} aria-hidden /> {d.complete ? 'Done' : 'Dismiss'}
        </button>
      </header>
      <div className="h-2 rounded-full bg-neutral-100 overflow-hidden mb-4" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Setup progress">
        <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
      </div>
      <ol className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {d.steps.map((s) => (
          <li key={s.key}>
            <Link to={s.href} className={'flex items-start gap-3 rounded-lg px-3 py-3 h-full transition-colors ' + (s.done ? 'bg-neutral-50' : 'bg-white ring-1 ring-inset ring-border hover:bg-neutral-50')}>
              {s.done
                ? <CheckCircle2 size={18} className="shrink-0 text-success mt-0.5" aria-label="Done" />
                : <Circle size={18} className="shrink-0 text-inkFaint mt-0.5" aria-label="To do" />}
              <span className="min-w-0 flex-1">
                <span className={'block text-13 font-semibold ' + (s.done ? 'text-inkMuted line-through' : 'text-ink')}>{s.label}</span>
                <span className="block text-12 text-inkMuted">{s.description}</span>
              </span>
              {!s.done ? <ChevronRight size={16} className="shrink-0 text-inkFaint mt-0.5" aria-hidden /> : null}
            </Link>
          </li>
        ))}
      </ol>
    </section>
  );
}
