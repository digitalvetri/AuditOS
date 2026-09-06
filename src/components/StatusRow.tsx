/**
 * §7 status encoding — 2px LEFT border on the row plus text weight.
 *
 *   Overdue / Rejected / Absent   2px warm-red, label weight 500
 *   Pending / Late / Missing      2px amber, label weight 500
 *   Awaiting action               2px neutral-400, label weight 400
 *   Approved / Present / Paid     no border, neutral-500, weight 400
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
  pending: 'border-amber',
  attention: 'border-amber',
  problem: 'border-red',
  awaiting: 'border-neutral-400',
};

const LABEL: Record<StatusVariant, string> = {
  ok: 'text-neutral-500 font-normal',
  pending: 'text-neutral-900 font-medium',
  attention: 'text-neutral-900 font-medium',
  problem: 'text-neutral-900 font-medium',
  awaiting: 'text-neutral-700 font-normal',
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
