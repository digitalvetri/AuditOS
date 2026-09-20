/**
 * BOOKKEEPING IMPORT — the two blocking validations (spec §5).
 *
 * Every file the firm pulls into a period is validated for two things:
 *
 *   PERIOD   the period boundary declared for the file must match the
 *            period being imported into (both `periodFrom` and `periodTo`).
 *   COMPANY  the company name declared for the file must match the client
 *            record exactly. Only outer whitespace is trimmed — no fuzzy
 *            matching, no case folding, no punctuation normalisation.
 *
 * "Rejected" is the failure mode this module is designed for: importing
 * another client's books silently is the worst thing this module can
 * produce, and a blocked import is a minor annoyance. Both checks must
 * pass for a file to land as `imported`; the first one to fail decides
 * the rejection reason.
 *
 * The function below is deliberately pure so it can be unit-tested
 * without a database, a filesystem or a session. The route handler that
 * calls it owns the side-effects (file storage, row insertion, audit log).
 */

export type ImportValidationOutcome =
  | { status: 'imported'; reason: null }
  | { status: 'rejected_period_mismatch'; reason: string }
  | { status: 'rejected_company_mismatch'; reason: string }

export interface ImportValidationInput {
  /** The client's canonical company name — Client.companyName from the DB. */
  clientCompanyName: string
  /** The period window in 'YYYY-MM-DD' — periodStart and periodEnd on the target period. */
  periodStart: string
  periodEnd: string
  /** What the caller declared the file contains (typed today; parsed later). */
  companyNameInFile: string
  periodFromInFile: string
  periodToInFile: string
  /** A human label for the target period, used to phrase the rejection. */
  periodLabel: string
}

export function validateImport(input: ImportValidationInput): ImportValidationOutcome {
  // Company check runs FIRST because a wrong company is the worse failure —
  // importing another client's books silently is the mistake spec §5 calls
  // out by name. If both are wrong, this reason wins.
  const client = input.clientCompanyName.trim()
  const declared = input.companyNameInFile.trim()
  if (client !== declared) {
    return {
      status: 'rejected_company_mismatch',
      reason: `Company in file "${declared}" does not match the client record "${client}".`,
    }
  }

  if (
    input.periodFromInFile !== input.periodStart ||
    input.periodToInFile !== input.periodEnd
  ) {
    return {
      status: 'rejected_period_mismatch',
      reason:
        `Period in file ${input.periodFromInFile}${
          input.periodFromInFile === input.periodToInFile
            ? ''
            : ` – ${input.periodToInFile}`
        } does not match ${input.periodLabel} (${input.periodStart} – ${input.periodEnd}).`,
    }
  }

  return { status: 'imported', reason: null }
}
