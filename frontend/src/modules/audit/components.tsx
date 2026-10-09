import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/components/Toast';
import { useAuth } from '@/platform/auth/AuthContext';
import { can } from '@/platform/rbac/can';
import { fmtDay } from '@/modules/workstation/listUi';
import type { AddendumFields, AuditFile, AuditStatus, AuditType } from './types';

/**
 * Audit files UI kit — vocabulary, chips, the progress bar, a side drawer
 * and the file context that carries the lock / addendum state to every tab.
 * Colours are the Workstation register's own chip tones (listUi), nothing new.
 */

// ── Vocabulary ────────────────────────────────────────────────────────────

export const AUDIT_TYPES: { value: AuditType; label: string }[] = [
  { value: 'statutory', label: 'Statutory audit' },
  { value: 'tax', label: 'Tax audit' },
  { value: 'internal', label: 'Internal audit' },
  { value: 'stock', label: 'Stock audit' },
  { value: 'bank', label: 'Bank audit' },
  { value: 'gst', label: 'GST audit' },
  { value: 'concurrent', label: 'Concurrent audit' },
  { value: 'other', label: 'Other audit' },
];
export const auditTypeLabel = (t: string) => AUDIT_TYPES.find((x) => x.value === t)?.label ?? t;

export const STATUS_FLOW: AuditStatus[] = ['planning', 'fieldwork', 'review', 'reporting', 'signed', 'archived'];

export const TEAM_ROLES = [
  { value: 'partner', label: 'Partner' },
  { value: 'manager', label: 'Manager' },
  { value: 'senior', label: 'Senior' },
  { value: 'assistant', label: 'Assistant' },
  { value: 'article', label: 'Article assistant' },
  { value: 'eqcr', label: 'EQCR' },
];

export const label = (s: string | null | undefined) => {
  if (!s) return '—';
  const t = s.replace(/_/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
};

// ── Chips ─────────────────────────────────────────────────────────────────

type Tone = 'grey' | 'blue' | 'green' | 'amber' | 'red';
const TONES: Record<Tone, { bg: string; fg: string; dot: string }> = {
  grey: { bg: '#f1f5f9', fg: '#475569', dot: '#94a3b8' },
  blue: { bg: '#f5f1ff', fg: '#5b33c4', dot: '#7a5af8' },
  green: { bg: '#ecfdf5', fg: '#047857', dot: '#10b981' },
  amber: { bg: '#fffbeb', fg: '#b45309', dot: '#f59e0b' },
  red: { bg: '#fef2f2', fg: '#b91c1c', dot: '#ef4444' },
};
const TONE_OF: Record<string, Tone> = {
  planning: 'grey', fieldwork: 'blue', review: 'amber', reporting: 'blue', signed: 'green', archived: 'grey',
  not_started: 'grey', in_progress: 'blue', prepared: 'amber', reviewed: 'green',
  open: 'amber', responded: 'blue', cleared: 'green',
  sent_to_client: 'blue', resolved: 'green', carried_forward: 'grey',
  low: 'grey', medium: 'amber', high: 'red', significant: 'red', critical: 'red',
  yes: 'green', no: 'red', na: 'grey', qualified: 'amber', adverse: 'red', pending: 'grey',
  active: 'green', revoked: 'red', locked: 'grey',
};

export function Chip({ value, text, tone }: { value?: string; text?: string; tone?: Tone }) {
  const t = TONES[tone ?? TONE_OF[value ?? ''] ?? 'grey'];
  return (
    <span className="inline-flex items-center gap-2 h-6 px-3 rounded-full text-12 font-medium whitespace-nowrap" style={{ background: t.bg, color: t.fg }}>
      <span className="rounded-full" style={{ background: t.dot, width: 6, height: 6 }} />
      {text ?? (value === 'na' ? 'N/A' : label(value))}
    </span>
  );
}

/** "Reviewed 8 / 23" bar. */
export function ProgressBar({ done, total, sub }: { done: number; total: number; sub?: ReactNode }) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <div className="min-w-[120px]">
      <div className="h-2 rounded-full bg-neutral-100 overflow-hidden" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
      </div>
      <div className="text-11 text-neutral-500 mt-1 tabular-nums">{sub ?? `${done} / ${total} reviewed`}</div>
    </div>
  );
}

export const initials = (name: string | null | undefined) =>
  name ? name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('') : '';

/** "AB · 12 Sep 2026" — a sign-off mark. */
export function SignOff({ who, at }: { who: string | null | undefined; at: string | null | undefined }) {
  if (!at) return <span className="text-neutral-400">—</span>;
  return (
    <span className="whitespace-nowrap" title={who ? `${who} · ${fmtDay(at)}` : fmtDay(at)}>
      <span className="font-semibold text-neutral-800">{initials(who) || '✓'}</span>
      <span className="text-neutral-500"> · {fmtDay(at)}</span>
    </span>
  );
}

// ── Side drawer ───────────────────────────────────────────────────────────

export function Drawer({ title, sub, onClose, children, footer }: {
  title: ReactNode; sub?: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/[0.24]" onClick={onClose} aria-hidden />
      <aside role="dialog" aria-modal="true"
        className="fixed inset-y-0 right-0 z-50 w-full sm:w-[560px] bg-white border-l border-neutral-200 shadow-drawer flex flex-col">
        <div className="min-h-[48px] px-4 py-2 flex items-center gap-3 border-b border-neutral-200 shrink-0">
          <div className="min-w-0 flex-1">
            <div className="text-14 font-semibold text-neutral-900 truncate">{title}</div>
            {sub ? <div className="text-12 text-neutral-500 truncate">{sub}</div> : null}
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="inline-flex items-center justify-center w-8 h-8 text-neutral-500 hover:text-neutral-900">
            <X size={16} strokeWidth={1.75} />
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-4">{children}</div>
        {footer ? <div className="px-4 py-3 border-t border-neutral-200 flex flex-wrap items-center justify-end gap-2 shrink-0">{footer}</div> : null}
      </aside>
    </>
  );
}

/** A disabled control explains itself: disabled buttons fire no hover, so the title sits on a wrapper. */
export function Why({ reason, children }: { reason?: string | null; children: ReactNode }) {
  return reason ? <span title={reason} className="inline-flex">{children}</span> : <>{children}</>;
}

export const sectionTitle = 'text-11 uppercase tracking-[0.06em] text-neutral-500 mb-2';
export const smallBtn = 'h-8 px-3 inline-flex items-center gap-1 text-13 rounded-lg border border-neutral-200 bg-white text-neutral-700 hover:border-neutral-300 hover:bg-neutral-50 disabled:opacity-50 disabled:cursor-not-allowed';
export const primaryBtn = 'h-8 px-3 inline-flex items-center gap-1 text-13 font-medium rounded-lg bg-primary text-white hover:bg-primaryHover disabled:opacity-50 disabled:cursor-not-allowed';
export const linkBtn = 'text-13 text-primary hover:underline disabled:opacity-50 disabled:no-underline disabled:cursor-not-allowed';

// ── Money ─────────────────────────────────────────────────────────────────

/** '1,25,000.50' typed in rupees → paise, or null when blank / not a number. */
export function rupeesToPaise(text: string): number | null {
  const t = text.replace(/[,₹\s]/g, '');
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}
export const paiseToRupeesText = (p: number | null | undefined) =>
  p === null || p === undefined ? '' : String(p / 100);

const INR2 = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 0, maximumFractionDigits: 2 });
export const inr = (p: number | null | undefined) => (p === null || p === undefined ? '—' : INR2.format(p / 100));

// ── Financial year ────────────────────────────────────────────────────────

/** '2026-27' for any date in Apr 2026 – Mar 2027 (IST calendar). */
export function currentFy(now = new Date()): string {
  const ist = new Date(now.getTime() + 330 * 60_000);
  const y = ist.getUTCMonth() >= 3 ? ist.getUTCFullYear() : ist.getUTCFullYear() - 1;
  return `${y}-${String((y + 1) % 100).padStart(2, '0')}`;
}
/** The year most audits look back at: the FY that ended last March. */
export function auditDefaultFy(now = new Date()): string {
  const y = Number(currentFy(now).slice(0, 4)) - 1;
  return `${y}-${String((y + 1) % 100).padStart(2, '0')}`;
}
export function fyOptions(back = 6, ahead = 1): string[] {
  const cur = Number(currentFy().slice(0, 4));
  const out: string[] = [];
  for (let y = cur + ahead; y >= cur - back; y--) out.push(`${y}-${String((y + 1) % 100).padStart(2, '0')}`);
  return out;
}

/** Whole days from today (IST) to an ISO date; negative when past. */
export function daysUntil(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ist = new Date(Date.now() + 330 * 60_000);
  const today = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate());
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - today) / 86_400_000);
}

// ── Who am I ──────────────────────────────────────────────────────────────

/**
 * The caller's identities. Team rows key on the employee id; sign-off columns
 * (prepared_by, raised_by …) may hold either the user or the employee id, so
 * both are checked.
 */
export function useMe() {
  const { session } = useAuth();
  const role = session?.role.code;
  return useMemo(() => {
    const employeeId = session?.employee?.id ?? null;
    const userId = session?.user.id ?? null;
    return {
      employeeId,
      userId,
      isMe: (id: string | null | undefined) => !!id && (id === employeeId || id === userId),
      canManage: can(role, 'workstation.audit.manage', 'self'),
      canReview: can(role, 'workstation.audit.review', 'self'),
      canSign: can(role, 'workstation.audit.sign', 'self'),
    };
  }, [session, role]);
}

// ── File context: lock + addendum ─────────────────────────────────────────

interface AuditCtx {
  file: AuditFile;
  locked: boolean;
  /** Signing partner or manager of this file. */
  isLead: boolean;
  isPartner: boolean;
  addendum: boolean;
  setAddendum: (v: boolean) => void;
  reason: string;
  setReason: (v: string) => void;
  /** The file is open for writes (not locked). */
  writable: boolean;
  /** `writable` and the caller holds workstation.audit.manage. */
  editable: boolean;
  /**
   * May ADD a working paper or an evidence file: as `editable`, or — after
   * the lock — with the addendum switched on and a reason given. Those are
   * the only writes the API accepts as an addendum; everything else is 423.
   */
  addable: boolean;
  /** Adds `{ addendum, addendum_reason }` to a write body when the file is locked. */
  w: (body?: Record<string, unknown>) => Record<string, unknown> & AddendumFields;
}

const Ctx = createContext<AuditCtx | null>(null);

export function AuditProvider({ file, children }: { file: AuditFile; children: ReactNode }) {
  const me = useMe();
  const [addendum, setAddendum] = useState(false);
  const [reason, setReason] = useState('');
  const locked = Boolean(file.locked || file.locked_at);
  const isPartner = me.isMe(file.signing_partner_id);
  const isLead = isPartner || me.isMe(file.manager_id);
  const value = useMemo<AuditCtx>(() => {
    const on = locked && isLead && addendum;
    return {
      file, locked, isLead, isPartner, addendum: on, setAddendum, reason, setReason,
      writable: !locked,
      editable: me.canManage && !locked,
      addable: me.canManage && (!locked || (on && reason.trim().length > 0)),
      w: (body?: Record<string, unknown>) =>
        ({ ...(body ?? {}), ...(on ? { addendum: true as const, addendum_reason: reason.trim() } : {}) }),
    };
  }, [file, locked, isLead, isPartner, addendum, reason, me.canManage]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAudit(): AuditCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAudit must be used inside <AuditProvider>');
  return v;
}

/**
 * Per-field messages from a 400: the audit API sends `details` as
 * `[{ path, message }]`; other Workstation routes send a `{ field: message }` map.
 */
export function apiFieldErrors(e: unknown): Record<string, string> {
  const d = (e as { details?: unknown })?.details;
  if (Array.isArray(d)) {
    const out: Record<string, string> = {};
    for (const x of d as { path?: string; message?: string }[]) if (x?.path && x.message && !out[x.path]) out[x.path] = x.message;
    return out;
  }
  return d && typeof d === 'object' ? (d as Record<string, string>) : {};
}

/** The current API error as text, for toasts. */
export const errText = (e: unknown) => (e as { message?: string })?.message ?? 'That could not be done.';

/**
 * A write against the file: toast on success or failure, then refetch
 * everything under ['audits'] (the file, its tabs, the list, the dashboard).
 */
export function useAuditMutation<V = void, T = unknown>(fn: (v: V) => Promise<T>, done: string | ((v: V) => string), after?: (v: V) => void) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: fn,
    onSuccess: (_d, v) => {
      toast.push('success', typeof done === 'function' ? done(v) : done);
      void qc.invalidateQueries({ queryKey: ['audits'] });
      after?.(v);
    },
    onError: (e) => toast.push('error', errText(e)),
  });
}
