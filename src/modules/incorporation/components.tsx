import type { ReactNode } from 'react';
import { StatusLabel, type StatusVariant } from '@/components/StatusRow';
import { statusMeta } from '@/modules/workstation/components';
import { fmtDate } from '@/lib/format';
import type { Provenance } from './types';

/**
 * Incorporation UI kit — thin. It adds no colour, no radius and no shadow of
 * its own: everything visual comes from the Workstation kit, which in turn
 * comes from the platform tokens. What lives here is the vocabulary this
 * module speaks and the one component the truth-of-data rule requires.
 */

/**
 * Statuses this module owns. Anything not listed falls through to the shared
 * Workstation map, so "pending" and "completed" read the same here as they do
 * on the client list.
 *
 * NOTE the DSC entry. The stored value is `verified`, but it is labelled
 * "Verified by employee" — an employee physically checked a token. The shared
 * map's plain "Verified" would imply a check this system never performs.
 */
const LOCAL: Record<string, { variant: StatusVariant; label: string }> = {
  // Case stages
  information_collection: { variant: 'awaiting', label: 'Information Collection' },
  dsc_pending: { variant: 'pending', label: 'DSC Pending' },
  name_preparation: { variant: 'awaiting', label: 'Name Preparation' },
  name_submitted: { variant: 'pending', label: 'Name Submitted' },
  name_approved: { variant: 'ok', label: 'Name Approved' },
  name_rework: { variant: 'problem', label: 'Name Rework' },
  filing_preparation: { variant: 'awaiting', label: 'Filing Preparation' },
  filing_submitted: { variant: 'pending', label: 'Filing Submitted' },
  government_processing: { variant: 'pending', label: 'Government Processing' },
  government_query: { variant: 'problem', label: 'Government Query' },
  resubmission: { variant: 'problem', label: 'Resubmission' },
  approved: { variant: 'ok', label: 'Approved' },
  certificate_received: { variant: 'ok', label: 'Certificate Received' },
  post_registration_setup: { variant: 'awaiting', label: 'Post-Registration Setup' },
  post_incorporation_handover: { variant: 'awaiting', label: 'Handover' },
  // Item statuses
  required: { variant: 'awaiting', label: 'Required' },
  received: { variant: 'ok', label: 'Received' },
  not_applicable: { variant: 'ok', label: 'Not Applicable' },
  not_required: { variant: 'ok', label: 'Not Required' },
  blocked: { variant: 'problem', label: 'Blocked' },
  /** Employee-verified. Never an API check — see the file comment. */
  verified: { variant: 'ok', label: 'Verified by employee' },
  issue: { variant: 'problem', label: 'Issue' },
  draft: { variant: 'awaiting', label: 'Draft' },
  rework: { variant: 'problem', label: 'Rework' },
  preparing: { variant: 'awaiting', label: 'Preparing' },
  ready_for_review: { variant: 'pending', label: 'Ready for Review' },
  processing: { variant: 'pending', label: 'Processing' },
  query: { variant: 'problem', label: 'Query' },
  closed: { variant: 'ok', label: 'Closed' },
  assigned: { variant: 'awaiting', label: 'Assigned' },
  preparing_response: { variant: 'pending', label: 'Preparing Response' },
  resolved: { variant: 'ok', label: 'Resolved' },
  escalated: { variant: 'problem', label: 'Escalated' },
  prepared: { variant: 'pending', label: 'Prepared' },
  delivered: { variant: 'ok', label: 'Delivered' },
  invoiced: { variant: 'pending', label: 'Invoiced' },
  partly_paid: { variant: 'pending', label: 'Partly Paid' },
  paid: { variant: 'ok', label: 'Paid' },
  waived: { variant: 'ok', label: 'Waived' },
  // Task vocabulary (the existing Task model)
  open: { variant: 'awaiting', label: 'Open' },
  done: { variant: 'ok', label: 'Done' },
  // Priority
  critical: { variant: 'problem', label: 'Critical' },
  medium: { variant: 'awaiting', label: 'Medium' },
  low: { variant: 'ok', label: 'Low' },
  high: { variant: 'pending', label: 'High' },
};

export function incStatusMeta(value: string) {
  return LOCAL[value] ?? statusMeta(value);
}

/** Inline status for a table cell, using this module's vocabulary first. */
export function IncStatus({ value }: { value: string }) {
  const { variant, label } = incStatusMeta(value);
  return <StatusLabel variant={variant} label={label} />;
}

export function incStatusBorder(value: string): string {
  const { variant } = incStatusMeta(value);
  if (variant === 'problem') return 'border-l-2 border-red';
  if (variant === 'pending' || variant === 'attention') return 'border-l-2 border-amber';
  if (variant === 'awaiting') return 'border-l-2 border-neutral-400';
  return 'border-l-2 border-transparent';
}

/** Title-cases an enum value that has no explicit label. */
export const titleCase = (v: string) =>
  v.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * PROVENANCE LINE (§1.4) — the component the truth-of-data rule is built on.
 *
 * Every government-sourced value on a screen sits above one of these. It says
 * who typed the value in and when. There is no green tick, no sync icon and
 * no "last checked" timestamp, because this system has never spoken to a
 * portal and must not look like it has.
 */
export function RecordedBy({ row, className = '' }: { row: Provenance; className?: string }) {
  if (!row.recorded_by && !row.recorded_at) {
    return (
      <span className={`text-12 text-neutral-500 ${className}`}>
        Recorded manually · attribution not captured
      </span>
    );
  }
  return (
    <span className={`text-12 text-neutral-500 ${className}`}>
      Recorded by {row.recorded_by?.full_name ?? 'an employee'}
      {row.recorded_at ? ` · ${fmtDate(row.recorded_at)}` : ''}
    </span>
  );
}

/**
 * The standing note that this module records employee entries and calls
 * nothing. Shown once per screen that holds government-sourced values, not on
 * every row, so it informs without nagging.
 */
export function ManualEntryNote({ children }: { children?: ReactNode }) {
  return (
    <div className="border-l-2 border-neutral-400 bg-white px-3 py-2 text-12 text-neutral-600">
      {children ?? (
        <>
          Everything on this tab is <strong className="font-medium">entered by an employee</strong> from
          what they saw on the portal or on paper. Audit OS does not contact any government
          system, and nothing here has been checked against one.
        </>
      )}
    </div>
  );
}

/** A sample case carries obviously-sample references. Say so, on the case. */
export function DemoNote() {
  return (
    <div className="border-l-2 border-amber bg-white px-3 py-2 text-12 text-neutral-600">
      Sample case. Every reference number on it begins <code className="font-mono">DEMO-</code> and
      stands for nothing.
    </div>
  );
}

/** A thin progress bar. Neutral fill — progress is information, not an alarm. */
export function ProgressBar({ percent, className = '' }: { percent: number; className?: string }) {
  return (
    <div className={`h-1 w-full bg-neutral-200 rounded-full overflow-hidden ${className}`}>
      <div
        className="h-full bg-neutral-700"
        style={{ width: `${Math.max(0, Math.min(100, percent))}%` }}
      />
    </div>
  );
}
