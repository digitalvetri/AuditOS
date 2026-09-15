/**
 * Persistence layer for composed GST returns.
 *
 * These helpers wrap the composer output in Prisma writes:
 *   - `ensureGstFiling` upserts the GstFiling parent that owns the draft.
 *   - `saveGstr1Draft` and `saveGstr3bDraft` insert the draft + its
 *     sections / liability rows in a transaction so a partial write can
 *     never leave a draft with half its sections.
 *   - `listReturnDrafts`, `getReturnDraft`, `markReturnReady` cover the
 *     query side.
 *
 * Kept out of GstReturnComposer.ts so tests can compose without ever
 * touching the DB.
 */
import type { PrismaClient, Prisma } from '@prisma/client'
import type { Gstr1Draft, Gstr3bDraft, SectionRow, ValidationFinding } from '../types.js'
import { composeGstr1, composeGstr3b, itcFromReconTotals } from './GstReturnComposer.js'
import { validateGstr1 } from './GstReturnValidator.js'

// ── GstProfile / GstFiling resolution ─────────────────────────────────

/**
 * Locate the GstProfile for a client. Returns null if the client has no
 * GST profile yet — the caller should surface that so the operator sets
 * it up via the Workstation UI, not silently auto-create.
 */
export async function findGstProfile(prisma: PrismaClient, clientId: string) {
  return prisma.gstProfile.findUnique({ where: { clientId } })
}

/**
 * Get or create the GstFiling row for (client, period, returnType).
 * A composer run for a period that has never been touched creates the
 * lifecycle record on the fly, so the API is usable from day one —
 * the operator doesn't have to pre-create rows in the Workstation UI
 * before the composer can save anything.
 */
export async function ensureGstFiling(
  prisma: PrismaClient,
  args: {
    gstProfileId:       string
    period:             string
    returnType:         'GSTR-1' | 'GSTR-3B' | 'GSTR-9'
    assignedEmployeeId: string
  },
) {
  const { gstProfileId, period, returnType, assignedEmployeeId } = args
  const existing = await prisma.gstFiling.findUnique({
    where: { gstProfileId_period_returnType: { gstProfileId, period, returnType } },
  })
  if (existing) return existing
  return prisma.gstFiling.create({
    data: {
      gstProfileId,
      period,
      returnType,
      status: 'data_preparation',
      assignedEmployeeId,
    },
  })
}

// ── Save composed drafts ─────────────────────────────────────────────

/**
 * Persist a composed GSTR-1 draft. Runs in a transaction so an
 * exception mid-way through the sections insert doesn't leave a naked
 * draft header behind.
 *
 * If a previous draft exists for the same filing and it's still
 * `draft`, we mark it `superseded` and point the new draft's
 * `supersedesId` at it. Prior drafts already `submitted` or beyond
 * are immutable and stay put.
 */
export async function saveGstr1Draft(
  prisma: PrismaClient,
  args: { gstFilingId: string; draft: Gstr1Draft; userId: string },
) {
  const { gstFilingId, draft, userId } = args
  const payloadJson = JSON.stringify(draft, bigintReplacer)

  return prisma.$transaction(async (tx) => {
    // Every prior non-submitted draft on this filing is superseded —
    // a re-compose invalidates anything not yet actually filed. Submitted
    // / filed drafts are immutable audit records and stay.
    const supersedable = await tx.gstReturnDraft.findMany({
      where: { gstFilingId, status: { in: ['draft', 'ready_to_file'] } },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    })
    if (supersedable.length) {
      await tx.gstReturnDraft.updateMany({
        where: { id: { in: supersedable.map((r) => r.id) } },
        data: { status: 'superseded', updatedBy: userId },
      })
    }
    const previous = supersedable[0] ?? null

    const created = await tx.gstReturnDraft.create({
      data: {
        gstFilingId,
        period:            draft.period,
        returnType:        draft.returnType,
        status:            'draft',
        payloadJson,
        totalTaxableValue: draft.totals.totalTaxableValue,
        totalCgst:         draft.totals.totalCgst,
        totalSgst:         draft.totals.totalSgst,
        totalIgst:         draft.totals.totalIgst,
        totalCess:         draft.totals.totalCess,
        invoiceCount:      draft.totals.invoiceCount,
        supersedesId:      previous?.id ?? null,
        createdBy:         userId,
        updatedBy:         userId,
      },
    })

    if (draft.sections.length) {
      await tx.gstReturnSection.createMany({
        data: draft.sections.map((s) => ({
          returnDraftId:     created.id,
          section:           s.section,
          ordinal:           s.ordinal,
          counterpartyGstin: s.counterpartyGstin,
          counterpartyName:  s.counterpartyName,
          rateBp:            s.rateBp,
          hsnCode:           s.hsnCode,
          invoiceNumber:     s.invoiceNumber,
          invoiceDate:       s.invoiceDate,
          placeOfSupply:     s.placeOfSupply,
          isInterState:      s.isInterState,
          taxableValue:      s.taxableValue,
          cgst:              s.cgst,
          sgst:              s.sgst,
          igst:              s.igst,
          cess:              s.cess,
          sourceDocumentId:  s.sourceDocumentId,
        })),
      })
    }

    return created
  })
}

/**
 * Persist a composed GSTR-3B draft. The 3B draft carries the
 * liability snapshot rather than sections. It always references the
 * GSTR-1 draft it was built from, so a later re-work regenerates both.
 */
export async function saveGstr3bDraft(
  prisma: PrismaClient,
  args: { gstFilingId: string; draft: Gstr3bDraft; userId: string },
) {
  const { gstFilingId, draft, userId } = args
  const payloadJson = JSON.stringify(draft, bigintReplacer)
  const totals = deriveGstr3bTotals(draft)

  return prisma.$transaction(async (tx) => {
    // Every prior non-submitted draft on this filing is superseded —
    // a re-compose invalidates anything not yet actually filed. Submitted
    // / filed drafts are immutable audit records and stay.
    const supersedable = await tx.gstReturnDraft.findMany({
      where: { gstFilingId, status: { in: ['draft', 'ready_to_file'] } },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    })
    if (supersedable.length) {
      await tx.gstReturnDraft.updateMany({
        where: { id: { in: supersedable.map((r) => r.id) } },
        data: { status: 'superseded', updatedBy: userId },
      })
    }
    const previous = supersedable[0] ?? null

    const created = await tx.gstReturnDraft.create({
      data: {
        gstFilingId,
        period:            draft.period,
        returnType:        draft.returnType,
        status:            'draft',
        payloadJson,
        totalTaxableValue: 0n,
        totalCgst:         totals.cgst,
        totalSgst:         totals.sgst,
        totalIgst:         totals.igst,
        totalCess:         totals.cess,
        invoiceCount:      0,
        supersedesId:      previous?.id ?? null,
        createdBy:         userId,
        updatedBy:         userId,
      },
    })

    await tx.gstLiabilitySnapshot.create({
      data: {
        returnDraftId: created.id,
        outputCgst: draft.liability.outputCgst,
        outputSgst: draft.liability.outputSgst,
        outputIgst: draft.liability.outputIgst,
        outputCess: draft.liability.outputCess,
        itcCgst:    draft.liability.itcCgst,
        itcSgst:    draft.liability.itcSgst,
        itcIgst:    draft.liability.itcIgst,
        itcCess:    draft.liability.itcCess,
        cashCgst:   draft.liability.cashCgst,
        cashSgst:   draft.liability.cashSgst,
        cashIgst:   draft.liability.cashIgst,
        cashCess:   draft.liability.cashCess,
        interest:   draft.liability.interest,
        lateFee:    draft.liability.lateFee,
      },
    })

    return created
  })
}

function deriveGstr3bTotals(draft: Gstr3bDraft) {
  const { liability: l } = draft
  return {
    cgst: l.outputCgst,
    sgst: l.outputSgst,
    igst: l.outputIgst,
    cess: l.outputCess,
  }
}

// ── Read side ────────────────────────────────────────────────────────

export interface ListFilter {
  gstProfileId?: string
  clientId?:     string
  periodFrom?:   string
  periodTo?:     string
  returnType?:   string
  status?:       string
}

export async function listReturnDrafts(prisma: PrismaClient, filter: ListFilter) {
  const where: Prisma.GstReturnDraftWhereInput = {}
  if (filter.periodFrom || filter.periodTo) {
    where.period = {
      gte: filter.periodFrom,
      lte: filter.periodTo,
    }
  }
  if (filter.returnType) where.returnType = filter.returnType
  if (filter.status)     where.status     = filter.status

  // clientId filter routes through GstFiling → GstProfile.
  if (filter.clientId || filter.gstProfileId) {
    where.gstFiling = {
      gstProfileId: filter.gstProfileId,
      gstProfile: filter.clientId ? { clientId: filter.clientId } : undefined,
    }
  }

  const drafts = await prisma.gstReturnDraft.findMany({
    where,
    include: {
      gstFiling: {
        select: { id: true, period: true, returnType: true, status: true, arn: true, gstProfile: { select: { clientId: true, gstin: true } } },
      },
    },
    orderBy: [{ period: 'desc' }, { createdAt: 'desc' }],
    take: 200,
  })

  return { items: drafts }
}

/**
 * Full draft with all sections and (if present) the liability snapshot.
 * Sections are ordered by (section, ordinal) so the payload reads
 * top-to-bottom the way the GSTN return does.
 */
export async function getReturnDraft(prisma: PrismaClient, id: string) {
  return prisma.gstReturnDraft.findUnique({
    where: { id },
    include: {
      sections: { orderBy: [{ section: 'asc' }, { ordinal: 'asc' }] },
      liability: true,
      gstFiling: {
        include: { gstProfile: true },
      },
    },
  })
}

/**
 * Validate a stored draft against the composer rules. Re-runs the
 * validator against the sections currently persisted; catches any
 * drift a manual PATCH may have introduced (PR 3 doesn't ship PATCH
 * yet — but the endpoint is idempotent and ready when it does).
 */
export async function validateStoredDraft(
  prisma: PrismaClient,
  id: string,
): Promise<ValidationFinding[]> {
  const draft = await getReturnDraft(prisma, id)
  if (!draft) return []
  if (draft.returnType !== 'GSTR-1') return [] // only GSTR-1 has section rules today

  const sections: SectionRow[] = draft.sections.map((s) => ({
    section:           s.section as SectionRow['section'],
    ordinal:           s.ordinal,
    counterpartyGstin: s.counterpartyGstin,
    counterpartyName:  s.counterpartyName,
    rateBp:            s.rateBp,
    hsnCode:           s.hsnCode,
    invoiceNumber:     s.invoiceNumber,
    invoiceDate:       s.invoiceDate,
    placeOfSupply:     s.placeOfSupply,
    isInterState:      s.isInterState,
    taxableValue:      s.taxableValue,
    cgst:              s.cgst,
    sgst:              s.sgst,
    igst:              s.igst,
    cess:              s.cess,
    sourceDocumentId:  s.sourceDocumentId,
  }))

  const supplierStateCode = draft.gstFiling.gstProfile.gstin?.slice(0, 2) ?? null

  return validateGstr1(
    { returnType: 'GSTR-1', period: draft.period, sections, totals: {
      totalTaxableValue: draft.totalTaxableValue, totalCgst: draft.totalCgst, totalSgst: draft.totalSgst,
      totalIgst: draft.totalIgst, totalCess: draft.totalCess, invoiceCount: draft.invoiceCount,
    } },
    [],
    { supplierStateCode },
  )
}

/**
 * Flip a draft from `draft` → `ready_to_file`. Refuses transitions
 * from any other status because they lose information (a submitted
 * draft cannot go back to draft) or are meaningless (already ready).
 */
export async function markReturnReady(prisma: PrismaClient, id: string, userId: string) {
  const draft = await prisma.gstReturnDraft.findUnique({ where: { id } })
  if (!draft) return null
  if (draft.status !== 'draft') {
    throw new Error(`Cannot mark a ${draft.status} return as ready_to_file`)
  }
  return prisma.gstReturnDraft.update({
    where: { id },
    data: { status: 'ready_to_file', updatedBy: userId },
  })
}

// ── Compose-and-save flow ────────────────────────────────────────────

/**
 * The route entry point. Given (booksOrgId, gstFilingId, period),
 * compose the return and save it in one round trip.
 *
 * For GSTR-3B, `itcJson` is the totalsJson from the caller-provided
 * AaGstReconJob (usually the latest for the client + period). Pass
 * null when no recon has been run — the composer emits a 3B with
 * zero ITC and the operator can amend later.
 */
export async function composeAndSaveGstr1(
  prisma: PrismaClient,
  args: { booksOrgId: string; gstFilingId: string; period: string; userId: string },
) {
  const draft = await composeGstr1(prisma, { booksOrgId: args.booksOrgId, period: args.period })
  const saved = await saveGstr1Draft(prisma, {
    gstFilingId: args.gstFilingId,
    draft,
    userId: args.userId,
  })
  return { draft, saved }
}

export async function composeAndSaveGstr3b(
  prisma: PrismaClient,
  args: {
    booksOrgId:  string
    gstFilingId: string
    period:      string
    userId:      string
    /** Optional totalsJson from a reconciled AaGstReconJob. */
    reconTotalsJson?: string | null
    gstr1DraftId?:    string | null
  },
) {
  const gstr1 = await composeGstr1(prisma, { booksOrgId: args.booksOrgId, period: args.period })
  const itc = itcFromReconTotals(args.reconTotalsJson ?? null)
  const draft = composeGstr3b({ gstr1, itc, gstr1DraftId: args.gstr1DraftId ?? null })
  const saved = await saveGstr3bDraft(prisma, {
    gstFilingId: args.gstFilingId,
    draft,
    userId: args.userId,
  })
  return { draft, saved }
}

// ── JSON with BigInt support ─────────────────────────────────────────

/** Turn bigints into strings so JSON.stringify doesn't throw. Numbers
 * larger than 2^53 need to survive — this only matters for the very
 * largest firms, but if we ever hit one, silent truncation would be
 * catastrophic. */
function bigintReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString()
  return value
}
