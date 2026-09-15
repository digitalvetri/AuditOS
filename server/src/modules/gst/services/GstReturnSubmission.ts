/**
 * Submit a return draft to GSTN and record the outcome.
 *
 *   ready_to_file  →  submit()  →  submitted (arn, gstn response)
 *
 * We deliberately keep `submitted` and `filed` distinct in the schema
 * even though the fake client collapses them. Real GSTN needs a
 * subsequent DSC / EVC step to convert `submitted` to `filed`, and
 * this design lets that step land later without a data migration.
 *
 * On success we also stamp `arn` and `filedAt` (for the fake client
 * only, `filedAt` is set immediately — the fake collapses the two
 * steps) on the parent GstFiling so a workstation-side dashboard can
 * read the filing status without joining through drafts.
 */
import type { PrismaClient } from '@prisma/client'
import type { GstnClient, GstnStatusResult, GstnSubmitInput, GstnSubmitResult } from './gstn/index.js'
import { GstnError } from './gstn/index.js'

export class SubmissionError extends Error {
  constructor(public code: string, message: string, public detail?: unknown) {
    super(message)
    this.name = 'SubmissionError'
  }
}

/**
 * Load a draft with everything the submission flow needs. Kept
 * separate from getReturnDraft in the persistence file because that
 * one includes sections/liability payload the submission does not
 * need — a portal round-trip has to be quick.
 */
async function loadForSubmit(prisma: PrismaClient, draftId: string) {
  const draft = await prisma.gstReturnDraft.findUnique({
    where: { id: draftId },
    include: { gstFiling: { include: { gstProfile: true } } },
  })
  return draft
}

/**
 * Submit a ready_to_file draft. Transactional: the status flip, arn
 * stamp and GstFiling roll-up all commit together, or none does. If
 * the portal rejects, we mark the draft `rejected` with the response
 * captured for audit.
 */
export async function submitReturn(
  prisma: PrismaClient,
  args: { draftId: string; userId: string; client: GstnClient },
) {
  const draft = await loadForSubmit(prisma, args.draftId)
  if (!draft) throw new SubmissionError('not_found', 'Return draft not found.')
  if (draft.status !== 'ready_to_file') {
    throw new SubmissionError(
      'bad_transition',
      `Return is in status '${draft.status}'; only 'ready_to_file' returns can be submitted.`,
    )
  }
  const gstin = draft.gstFiling.gstProfile.gstin
  if (!gstin) {
    throw new SubmissionError('missing_gstin', 'GstProfile has no GSTIN; cannot submit.')
  }

  const input: GstnSubmitInput = {
    gstin,
    period:      draft.period,
    returnType:  draft.returnType,
    payloadJson: draft.payloadJson,
  }

  let result: GstnSubmitResult
  try {
    result = draft.returnType === 'GSTR-3B'
      ? await args.client.submitGstr3b(input)
      : await args.client.submitGstr1(input)
  } catch (err) {
    // Record the rejection on the draft so an operator can see WHY
    // without spelunking logs. Then rethrow so the route surfaces a
    // proper 4xx / 5xx.
    const detail = err instanceof GstnError ? err.detail : undefined
    const message = err instanceof Error ? err.message : 'GSTN submission failed'
    await prisma.gstReturnDraft.update({
      where: { id: draft.id },
      data: {
        status: 'rejected',
        gstnMode: args.client.mode,
        gstnResponseJson: JSON.stringify({ error: message, detail }),
        updatedBy: args.userId,
      },
    })
    throw new SubmissionError('portal_rejected', message, detail)
  }

  // Success path — commit the paperwork atomically.
  return prisma.$transaction(async (tx) => {
    const updated = await tx.gstReturnDraft.update({
      where: { id: draft.id },
      data: {
        status:           args.client.mode === 'fake' ? 'filed' : 'submitted',
        arn:              result.arn,
        gstnMode:         args.client.mode,
        submittedAt:      result.submittedAt,
        // Fake client is one-shot; live client's filedAt is set later
        // when the DSC/EVC step lands and the return is finalised.
        filedAt:          args.client.mode === 'fake' ? result.submittedAt : null,
        gstnResponseJson: result.responseJson,
        updatedBy:        args.userId,
      },
    })
    await tx.gstFiling.update({
      where: { id: draft.gstFilingId },
      data: {
        status:  args.client.mode === 'fake' ? 'filed' : 'ready_to_file',
        arn:     result.arn,
        filedAt: args.client.mode === 'fake' ? result.submittedAt : null,
      },
    })
    return updated
  })
}

/**
 * Poll GSTN for the current state of an ARN. Used by the UI to refresh
 * a `submitted` draft once the operator has completed the portal-side
 * DSC / EVC step out-of-band; the return then flips to `filed`.
 */
export async function refreshSubmissionStatus(
  prisma: PrismaClient,
  args: { draftId: string; userId: string; client: GstnClient },
): Promise<{ draftStatus: string; portal: GstnStatusResult | null }> {
  const draft = await prisma.gstReturnDraft.findUnique({ where: { id: args.draftId } })
  if (!draft) throw new SubmissionError('not_found', 'Return draft not found.')
  if (!draft.arn) return { draftStatus: draft.status, portal: null }

  const portal = await args.client.getStatus(draft.arn)
  if (portal.status === 'filed' && draft.status !== 'filed') {
    await prisma.$transaction(async (tx) => {
      await tx.gstReturnDraft.update({
        where: { id: draft.id },
        data: { status: 'filed', filedAt: portal.filedAt ?? new Date(), updatedBy: args.userId },
      })
      await tx.gstFiling.update({
        where: { id: draft.gstFilingId },
        data:  { status: 'filed', filedAt: portal.filedAt ?? new Date() },
      })
    })
    return { draftStatus: 'filed', portal }
  }
  return { draftStatus: draft.status, portal }
}
