/**
 * Types shared by the GST return composer, validator, and (later) the
 * route handlers. Kept in a leaf module so a route can import a shape
 * without pulling in Prisma.
 *
 * All monetary values are in paise as `bigint`. Rate percentages are in
 * basis points (1800 = 18%), matching BooksTaxRate and the composer's
 * seed of GstRateSlab rows.
 */

/**
 * Section codes used in GSTR-1. We support the five that carry 95% of
 * a normal firm's outward supplies. Exports (`exp`), advances (`at`
 * and `atadj`) and nil-rated (`nil`) are placeholders — the schema
 * accepts them but the composer does not emit them yet.
 *
 * - `b2b`   Invoices to registered buyers (has buyer GSTIN)
 * - `b2cl`  Large B2C inter-state ≥ ₹1L (no buyer GSTIN)
 * - `b2cs`  Small B2C — aggregated per (rate, place-of-supply)
 * - `cdnr`  Credit / debit notes to registered buyers
 * - `cdnur` Credit / debit notes to unregistered buyers
 * - `hsn`   HSN-wise summary of taxable value and tax
 * - `nil`   Nil-rated / exempt / non-GST outward supplies
 * - `exp`   Exports (with or without payment of tax)
 * - `at`    Advance receipts
 * - `atadj` Advance receipt adjustments
 * - `docs`  Document summary (invoice number ranges issued/cancelled)
 */
export type Gstr1Section =
  | 'b2b' | 'b2cl' | 'b2cs' | 'cdnr' | 'cdnur'
  | 'hsn' | 'nil' | 'exp' | 'at' | 'atadj' | 'docs'

/** GST treatment on BooksContact — how the customer is classified. */
export type GstTreatment =
  | 'business_gst'    // registered — has a valid GSTIN
  | 'business_none'   // unregistered business
  | 'overseas'        // export customer
  | 'consumer'        // individual consumer

/**
 * A single BooksDocument (invoice or credit note) reshaped into the
 * fields the composer needs. Purpose-built so the pure sectionizer can
 * be tested without a Prisma client.
 */
export interface NormalizedInvoice {
  id: string
  kind: 'invoice' | 'credit_note'
  number: string
  /** 'YYYY-MM-DD' */
  date: string

  /** Buyer context. `buyerGstin` is null for B2C. */
  buyerGstin: string | null
  buyerName: string
  /** GSTN state code — '33' for Tamil Nadu. */
  buyerStateCode: string | null
  gstTreatment: GstTreatment

  /** Place-of-supply state code on the document; falls back to buyer state. */
  placeOfSupply: string | null
  isInterState: boolean

  /** All amounts in paise. Credit notes carry the same sign as invoices; the
   * composer flips signs when it computes 3B netting, not here. */
  taxableTotal: bigint
  cgstTotal:    bigint
  sgstTotal:    bigint
  igstTotal:    bigint
  cessTotal:    bigint
  total:        bigint

  /** Line-level detail — used for the HSN summary. Optional so tests can
   * omit it when they only care about document-level sectionization. */
  lines?: NormalizedInvoiceLine[]
}

export interface NormalizedInvoiceLine {
  hsnSac:       string | null
  /** Free text — used only to help the HSN aggregator name blank codes. */
  description?: string
  quantity:     number
  taxable:      bigint
  cgst:         bigint
  sgst:         bigint
  igst:         bigint
  cess:         bigint
  /** Rate in basis points, e.g. 1800 = 18%. */
  taxPercentBp: number
}

/**
 * One sectionised row in the composed return, mirroring the
 * GstReturnSection Prisma model 1:1 (minus DB-only id / createdAt).
 * The composer emits these; the persistence layer in PR 3 inserts them
 * as `GstReturnSection` rows.
 */
export interface SectionRow {
  section:           Gstr1Section
  ordinal:           number
  counterpartyGstin: string | null
  counterpartyName:  string | null
  /** Rate in bp; NULL for docs / hsn header rows. */
  rateBp:            number | null
  hsnCode:           string | null
  invoiceNumber:     string | null
  invoiceDate:       string | null
  placeOfSupply:     string | null
  isInterState:      boolean
  taxableValue:      bigint
  cgst:              bigint
  sgst:              bigint
  igst:              bigint
  cess:              bigint
  sourceDocumentId:  string | null
}

/** Roll-up totals matching `GstReturnDraft.total*` columns. */
export interface DraftTotals {
  totalTaxableValue: bigint
  totalCgst:         bigint
  totalSgst:         bigint
  totalIgst:         bigint
  totalCess:         bigint
  invoiceCount:      number
}

/** The composed GSTR-1 draft — what the composer returns. */
export interface Gstr1Draft {
  returnType: 'GSTR-1'
  period:     string
  sections:   SectionRow[]
  totals:     DraftTotals
}

/**
 * ITC input for GSTR-3B, pulled from the latest AaGstReconJob for the
 * client + period. `matched` and `partial` are the reconciled buckets
 * where ITC is claimable; `only_2b` and `only_pr` are flagged for
 * follow-up and don't feed 3B.
 */
export interface ItcInput {
  cgst: bigint
  sgst: bigint
  igst: bigint
  cess: bigint
}

/** Composed GSTR-3B liability shape. */
export interface Gstr3bLiability {
  outputCgst: bigint
  outputSgst: bigint
  outputIgst: bigint
  outputCess: bigint
  itcCgst:    bigint
  itcSgst:    bigint
  itcIgst:    bigint
  itcCess:    bigint
  cashCgst:   bigint
  cashSgst:   bigint
  cashIgst:   bigint
  cashCess:   bigint
  interest:   bigint
  lateFee:    bigint
}

/** Composed GSTR-3B draft — what composeGstr3b returns. */
export interface Gstr3bDraft {
  returnType: 'GSTR-3B'
  period:     string
  /** Reference to the GSTR-1 whose sections drove the output tax roll-up. */
  gstr1DraftId: string | null
  liability: Gstr3bLiability
}

/** A single validation finding. Grouped by severity so a route can decide
 * whether to block filing on `error` while surfacing `warning` as a
 * checklist. */
export interface ValidationFinding {
  code:        string
  severity:    'error' | 'warning' | 'info'
  message:     string
  /** Where the finding points to — a section row id or an invoice id. */
  ref?:        { kind: 'section'; index: number } | { kind: 'invoice'; id: string }
}
