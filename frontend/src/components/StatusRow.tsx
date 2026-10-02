/**
 * §7 status encoding — 2px LEFT border on the row plus text weight.
 *
 *   Overdue / Rejected / Absent   2px danger, label weight 500
 *   Pending / Late / Missing      2px warning, label weight 500
 *   Awaiting action               2px inkFaint, label weight 400
 *   Approved / Present / Paid     no border, inkMuted, weight 400
 *
 * Inline labels (StatusLabel) are soft tinted chips, matching Workstation.
 */
import type { ReactNode } from 'react';

export type StatusVariant = 'ok' | 'pending' | 'attention' | 'problem' | 'awaiting';

interface StatusRowProps {
  variant: StatusVariant;
  label: string;
  right?: ReactNode;
  children?: ReactNode;
  className?: string;
}

const BORDER: Record<StatusVariant, string> = {
  ok: 'border-transparent',
  pending: 'border-warning',
  attention: 'border-warning',
  problem: 'border-danger',
  awaiting: 'border-inkFaint',
};

const LABEL: Record<StatusVariant, string> = {
  ok: 'text-inkMuted font-normal',
  pending: 'text-ink font-medium',
  attention: 'text-ink font-medium',
  problem: 'text-ink font-medium',
  awaiting: 'text-ink font-normal',
};

/**
 * Chip colours for an inline status — the same tinted chip with a dot the
 * Workstation registers use (modules/workstation/listUi.tsx StatusChip), so
 * HRMS and Workstation read alike.
 */
const CHIP: Record<StatusVariant, { bg: string; fg: string; dot: string }> = {
  ok: { bg: '#ecfdf5', fg: '#047857', dot: '#10b981' },
  pending: { bg: '#fffbeb', fg: '#b45309', dot: '#f59e0b' },
  attention: { bg: '#fffbeb', fg: '#b45309', dot: '#f59e0b' },
  problem: { bg: '#fef2f2', fg: '#b91c1c', dot: '#ef4444' },
  awaiting: { bg: '#f1f5f9', fg: '#475569', dot: '#94a3b8' },
};

/** Inline status (for use inside a cell): a soft tinted chip with a dot. */
export function StatusLabel({ variant, label, className = '' }: { variant: StatusVariant; label: string; className?: string }) {
  const c = CHIP[variant];
  return (
    <span
      className={`inline-flex items-center gap-2 h-6 px-3 rounded-full text-12 font-medium whitespace-nowrap ${className}`}
      style={{ background: c.bg, color: c.fg }}
    >
      <span className="rounded-full" style={{ background: c.dot, width: 6, height: 6 }} />
      {label}
    </span>
  );
}

/** Left-border row wrapper — for lists where the row is the primary carrier. */
export function StatusRow({ variant, label, right, children, className = '' }: StatusRowProps) {
  return (
    <div className={`flex items-center border-l-2 ${BORDER[variant]} pl-3 pr-2 h-10 ${className}`}>
      <span className={`text-13 ${LABEL[variant]}`}>{label}</span>
      {children ? <div className="ml-3 flex-1">{children}</div> : <div className="flex-1" />}
      {right}
    </div>
  );
}
