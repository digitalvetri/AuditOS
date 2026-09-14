/**
 * Compose GST returns for a period from Books data.
 *
 * `composeGstr1` walks the period's outward BooksDocument rows and
 * calls the pure sectionizer to produce a GSTR-1 draft.
 *
 * `composeGstr3b` derives the liability roll-up from a composed GSTR-1
 * plus the latest 2B reconciliation output for the period. It does
 * NOT re-run reconciliation — that's the audit-automation module's job.
 *
 * Neither function writes to the database. The route layer in PR 3
 * persists the draft via GstReturnDraft / GstReturnSection inserts.
 */
import type { PrismaClient } from '@prisma/client'
import { sectionizeGstr1 } from './sectionize.js'
import type {
  Gstr1Draft,
  Gstr3bDraft,
  Gstr3bLiability,
  ItcInput,
  NormalizedInvoice,
  NormalizedInvoiceLine,
} from '../types.js'

export interface ComposeGstr1Args {
  booksOrgId: string
  /** 'YYYY-MM' — the return period. */
  period:     string
}

/**
 * Compose a GSTR-1 draft for a period from Books outward supplies.
 *
 * We pull invoices and credit notes whose `date` falls in the period
 * and whose status is not `draft` or `void`. Drafts are excluded on
 * purpose — an unfinalised invoice must not leak into a filed return.
 * Voids are excluded because they represent a cancellation before
 * despatch; they never left the firm.
 */
export async function composeGstr1(
  prisma: PrismaClient,
  { booksOrgId, period }: ComposeGstr1Args,
): Promise<Gstr1Draft> {
  const [year, month] = period.split('-').map(Number)
  if (!year || !month || month < 1 || month > 12) {
    throw new Error(`Invalid period '${period}'; expected 'YYYY-MM'`)
  }
  const firstDay = `${year}-${String(month).padStart(2, '0')}-01`
  // Prisma keeps BooksDocument.date as a string — a 'YYYY-MM-DD' range
  // filter is a lexicographic prefix match. Compute the first-of-next-
  // month string ourselves rather than relying on Date arithmetic.
  const nextMonth = month === 12
    ? `${year + 1}-01-01`
    : `${year}-${String(month + 1).padStart(2, '0')}-01`

  const docs = await prisma.booksDocument.findMany({
    where: {
      booksOrgId,
      kind: { in: ['invoice', 'credit_note'] },
      status: { notIn: ['draft', 'void'] },
      date: { gte: firstDay, lt: nextMonth },
    },
    include: { lines: true },
    orderBy: [{ date: 'asc' }, { number: 'asc' }],
  })

  const contactIds = [...new Set(docs.map(d => d.contactId))]
  const contacts = contactIds.length === 0
    ? []
    : await prisma.booksContact.findMany({ where: { id: { in: contactIds } } })
  const contactById = new Map(contacts.map(c => [c.id, c] as const))

  const invoices: NormalizedInvoice[] = docs.map(d => {
    const c = contactById.get(d.contactId)
    const lines: NormalizedInvoiceLine[] = d.lines.map(l => ({
      hsnSac:       l.hsnSac,
      description:  l.description,
      quantity:     l.quantity,
      taxable:      l.taxable,
      cgst:         l.cgst,
      sgst:         l.sgst,
      igst:         l.igst,
      cess:         0n,
      taxPercentBp: l.taxPercentBp,
    }))
    return {
      id:              d.id,
      kind:            d.kind as 'invoice' | 'credit_note',
      number:          d.number,
      date:            d.date,
      buyerGstin:      c?.gstin ?? null,
      buyerName:       c?.displayName ?? '',
      buyerStateCode:  c?.placeOfSupplyState ?? null,
      gstTreatment:    (c?.gstTreatment ?? 'consumer') as NormalizedInvoice['gstTreatment'],
      placeOfSupply:   d.placeOfSupply ?? c?.placeOfSupplyState ?? null,
      isInterState:    d.isInterState,
      taxableTotal:    d.taxableTotal,
      cgstTotal:       d.cgstTotal,
      sgstTotal:       d.sgstTotal,
      igstTotal:       d.igstTotal,
      cessTotal:       0n,
      total:           d.total,
      lines,
    }
  })

  return sectionizeGstr1(invoices, period)
}

export interface ComposeGstr3bArgs {
  gstr1: Gstr1Draft
  /** ITC input for the period, typically from AaGstReconJob totals. Pass
   * zeros when no recon has been run — the composer will produce a
   * warning-worthy but still filed 3B. */
  itc: ItcInput
  /** Interest and late fee, if any. Not derived here — the operator
   * enters them when filing late. */
  interest?: bigint
  lateFee?:  bigint
  /** Optional reference to the persisted GSTR-1 draft. Null in tests. */
  gstr1DraftId?: string | null
}

/**
 * Compose the GSTR-3B liability roll-up from a GSTR-1 draft plus ITC.
 * Credit notes (cdnr / cdnur) reduce output tax. Cash payable per head
 * is floored at zero — a credit balance carries forward, not a refund.
 */
export function composeGstr3b(args: ComposeGstr3bArgs): Gstr3bDraft {
  const { gstr1, itc } = args
  const interest = args.interest ?? 0n
  const lateFee  = args.lateFee  ?? 0n

  // Sum outward: invoices add, credit notes subtract. Exclude the HSN
  // summary — HSN rows echo the same taxes we already counted on the
  // b2b/b2cs/b2cl rows they came from.
  let outputCgst = 0n, outputSgst = 0n, outputIgst = 0n, outputCess = 0n
  for (const row of gstr1.sections) {
    if (row.section === 'hsn') continue
    const sign = row.section === 'cdnr' || row.section === 'cdnur' ? -1n : 1n
    outputCgst += sign * row.cgst
    outputSgst += sign * row.sgst
    outputIgst += sign * row.igst
    outputCess += sign * row.cess
  }

  const cashCgst = outputCgst > itc.cgst ? outputCgst - itc.cgst : 0n
  const cashSgst = outputSgst > itc.sgst ? outputSgst - itc.sgst : 0n
  const cashIgst = outputIgst > itc.igst ? outputIgst - itc.igst : 0n
  const cashCess = outputCess > itc.cess ? outputCess - itc.cess : 0n

  const liability: Gstr3bLiability = {
    outputCgst, outputSgst, outputIgst, outputCess,
    itcCgst: itc.cgst, itcSgst: itc.sgst, itcIgst: itc.igst, itcCess: itc.cess,
    cashCgst, cashSgst, cashIgst, cashCess,
    interest, lateFee,
  }

  return {
    returnType:   'GSTR-3B',
    period:       gstr1.period,
    gstr1DraftId: args.gstr1DraftId ?? null,
    liability,
  }
}

/**
 * Extract ITC from an AaGstReconJob's totalsJson. Returns zeros if the
 * job has no totals yet. Reads only the matched + partial buckets, per
 * design: only reconciled ITC feeds 3B; unmatched entries need
 * follow-up before they can be claimed.
 */
export function itcFromReconTotals(totalsJson: string | null): ItcInput {
  const zero: ItcInput = { cgst: 0n, sgst: 0n, igst: 0n, cess: 0n }
  if (!totalsJson) return zero
  try {
    const parsed = JSON.parse(totalsJson) as {
      matched?: { cgst?: number; sgst?: number; igst?: number; cess?: number }
      partial?: { cgst?: number; sgst?: number; igst?: number; cess?: number }
    }
    const add = (k: keyof ItcInput) => {
      const m = BigInt(parsed.matched?.[k] ?? 0)
      const p = BigInt(parsed.partial?.[k] ?? 0)
      return m + p
    }
    return { cgst: add('cgst'), sgst: add('sgst'), igst: add('igst'), cess: add('cess') }
  } catch {
    return zero
  }
}
