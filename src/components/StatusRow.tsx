/**
 * §7 status encoding — 2px LEFT border on the row plus text weight.
 *
 *   Overdue / Rejected / Absent   2px danger, label weight 500
 *   Pending / Late / Missing      2px warning, label weight 500
 *   Awaiting action               2px inkFaint, label weight 400
 *   Approved / Present / Paid     no border, inkMuted, weight 400
 *
 * Never filled pill badges. Never coloured backgrounds.
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

/** Inline status text (for use inside a cell). */
export function StatusLabel({ variant, label, className = '' }: { variant: StatusVariant; label: string; className?: string }) {
  return <span className={`text-13 ${LABEL[variant]} ${className}`}>{label}</span>;
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
