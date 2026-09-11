/**
 * Shared placeholder generators for the GST module.
 *
 * Every workspace (recurring, project, notice check) uses the same
 * deterministic hash on (clientId, servicSlug) so a client that shows
 * "Overdue" in the Return Filing period board also contributes to the
 * "8 overdue obligations" tile on the landing summary. Consistent
 * placeholder data across screens; the real engine replaces all of this.
 */

export type ObligationStatus =
  | 'not_started'
  | 'in_progress'
  | 'ready'
  | 'filed'
  | 'overdue';

export type CaseStage =
  | 'not_started'
  | 'documents_pending'
  | 'in_progress'
  | 'under_review'
  | 'submitted'
  | 'officer_query'
  | 'completed'
  | 'failed';

export const OBLIGATION_STATUS_CYCLE: ObligationStatus[] = [
  'filed', 'ready', 'in_progress', 'not_started', 'overdue', 'not_started',
];

export const CASE_STAGE_CYCLE: CaseStage[] = [
  'documents_pending', 'in_progress', 'submitted', 'officer_query', 'completed', 'not_started',
];

/** Deterministic string → int hash. Not for security. */
export function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function obligationStatusFor(clientId: string, serviceSlug: string): ObligationStatus {
  return OBLIGATION_STATUS_CYCLE[hash(clientId + serviceSlug) % OBLIGATION_STATUS_CYCLE.length];
}

export function caseStageFor(clientId: string, serviceSlug: string): CaseStage {
  return CASE_STAGE_CYCLE[hash(clientId + serviceSlug) % CASE_STAGE_CYCLE.length];
}

/** Days since last weekly notice check — placeholder, keyed on client only. */
export function daysSinceNoticeCheck(clientId: string): number {
  return hash(clientId) % 14;
}
