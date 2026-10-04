/**
 * REPOTIC Phase 3 — build a GSTR-1 preview from parsed rows.
 *
 * The output structure follows the GSTN offline tool's commonly-used shape
 * (b2cs, b2cl, cdnur, hsn) but is labelled "GSTR-1 preview JSON" in the
 * download because we have NOT yet verified against a real offline-tool
 * sample. Phase 3.1 adds a round-trip check against an actual tool-produced
 * JSON; until then this is a human-review preview, not a drop-into-portal
 * file. REPOTIC-MODULE.md §3 is the acceptance ground truth for the number
 * work; the JSON wrapper may still rename fields when 3.1 verifies.
 *
 * Scope — called with (organisation, client, gstin, period). Pulls every
 * parsed row from every upload under that scope and buckets them:
 *
 *   Shipment rows      → B2CS or B2CL depending on invoice amount
 *   Cancel / Refund    → CDN (Table 9B) when they carry a credit-note ref
 *   Free Replacement   → excluded (no taxable supply)
 *
 * Rate math is kept conservative — we use the rate the marketplace wrote,
 * not a re-derived rate from taxable_value / tax_amount, because a row with
 * zero taxable (zero-rated or exempt) would divide by zero and because
 * matching the marketplace's rate column keeps our output stable even if
 * we fix a rounding bug later.
 */
import type { PrismaClient, RpParsedRow } from '@prisma/client'
import { gstinStateCode, stateNameToCode } from './states.js'

/** B2CL threshold — ₹1 lakh, effective 2024-08-01 (REPOTIC-MODULE.md §3.1).
 *  Stored in paise so we never compare across unit boundaries. */
export const B2CL_THRESHOLD_PAISE = 1_00_000 * 100

export interface Gstr1BuildScope {
  organisationId: string
  clientId: string
  gstin: string
  period: string  // YYYY-MM
}

export interface Gstr1Preview {
  gstin: string
  fp: string  // "122025" style — GSTN's filing-period format
  version: 'preview-1'
  generated_at: string
  disclaimer: string
  b2cs: B2csEntry[]
  b2cl: B2clEntry[]
  cdnur: CdnurEntry[]
  hsn: HsnEntry[]
}

export interface B2csEntry {
  sply_ty: 'INTRA' | 'INTER'
  pos: string          // place-of-supply state code
  rt: number           // rate percent (float — "18" or "18.5")
  typ: 'OE'            // "other" category — ecommerce supplies
  txval: number        // rupees, 2dp
  iamt: number
  camt: number
  samt: number
  csamt: number
}

export interface B2clEntry {
  pos: string
  inv: Array<{
    inum: string
    idt: string        // DD-MM-YYYY per GSTN convention
    val: number        // invoice value in rupees
    itms: Array<{
      num: number
      itm_det: { txval: number; rt: number; iamt: number; camt: number; samt: number; csamt: number }
    }>
  }>
}

export interface CdnurEntry {
  ntty: 'C' | 'D'   // credit / debit
  nt_num: string
  nt_dt: string     // DD-MM-YYYY
  val: number
  pos: string
  itms: Array<{ num: number; itm_det: { txval: number; rt: number; iamt: number; camt: number; samt: number; csamt: number } }>
}

export interface HsnEntry {
  num: number
  hsn_sc: string
  desc: string
  uqc: string
  qty: number
  val: number
  txval: number
  iamt: number
  camt: number
  samt: number
  csamt: number
}

export interface Gstr1BuildResult {
  preview: Gstr1Preview
  counts: Record<'b2cs' | 'b2cl' | 'cdnur' | 'hsn' | 'excluded_free_replacement' | 'excluded_other' | 'total_rows', number>
}

/** Build the GSTR-1 preview for one scope. Pure — same inputs give the
 *  same output; the only I/O is the prisma query at the start. */
export async function buildGstr1Preview(scope: Gstr1BuildScope, prisma: PrismaClient): Promise<Gstr1BuildResult> {
  const rows = await prisma.rpParsedRow.findMany({
    where: {
      organisationId: scope.organisationId,
      upload: {
        organisationId: scope.organisationId,
        clientId: scope.clientId,
        gstin: scope.gstin,
        period: scope.period,
        deletedAt: null,
        detectStatus: { in: ['matched', 'drifted'] },
      },
    },
    orderBy: [{ invoiceDate: 'asc' }, { sourceRowIndex: 'asc' }],
  })
  return buildFromRows(rows, scope.gstin, scope.period)
}

/** Pure aggregation step — exported for tests. */
export function buildFromRows(rows: RpParsedRow[], gstin: string, period: string): Gstr1BuildResult {
  const sellerStateCode = gstinStateCode(gstin) ?? '00'

  const b2cs = new Map<string, B2csEntry>()   // key: pos|rate|sply_ty
  const b2cl: B2clEntry[] = []
  const b2clByPos = new Map<string, B2clEntry>()
  const cdnur: CdnurEntry[] = []
  const hsn = new Map<string, HsnEntry>()     // key: hsn|rate
  const counts = {
    b2cs: 0, b2cl: 0, cdnur: 0, hsn: 0,
    excluded_free_replacement: 0, excluded_other: 0, total_rows: rows.length,
  }

  for (const r of rows) {
    if (r.txType === 'free_replacement') { counts.excluded_free_replacement++; continue }
    if (r.txType === 'other') { counts.excluded_other++; continue }

    const pos = stateNameToCode(r.shipToState) ?? sellerStateCode
    const ratePct = r.rate / 100  // 1800 → 18

    if (r.txType === 'cancel' || r.txType === 'refund') {
      // Table 9B — Credit/Debit Notes. Needs a credit-note reference; the
      // row is otherwise dropped (we can't file a note without a number).
      if (!r.creditNoteNumber) { counts.excluded_other++; continue }
      cdnur.push({
        ntty: r.txType === 'cancel' ? 'C' : 'C',  // refunds go as credit notes too
        nt_num: r.creditNoteNumber,
        nt_dt: toDdMmYyyy(r.creditNoteDate ?? r.invoiceDate),
        val: paiseToRupees(Math.abs(r.invoiceAmount)),
        pos,
        itms: [{
          num: 1,
          itm_det: {
            txval: paiseToRupees(Math.abs(r.taxableValue)),
            rt: ratePct,
            iamt: paiseToRupees(Math.abs(r.igstTax)),
            camt: paiseToRupees(Math.abs(r.cgstTax)),
            samt: paiseToRupees(Math.abs(r.sgstTax)),
            csamt: paiseToRupees(Math.abs(r.cessTax)),
          },
        }],
      })
      counts.cdnur++
    } else if (r.txType === 'shipment') {
      const interState = !r.stateCodeIntra
      // §3.1 — B2CL threshold is ₹1 lakh, and only applies to inter-state.
      if (interState && r.invoiceAmount >= B2CL_THRESHOLD_PAISE) {
        // Table 5A — B2CL. Grouped by place-of-supply, one invoice per entry.
        if (!r.invoiceNumber) continue
        let bucket = b2clByPos.get(pos)
        if (!bucket) {
          bucket = { pos, inv: [] }
          b2clByPos.set(pos, bucket)
          b2cl.push(bucket)
        }
        bucket.inv.push({
          inum: r.invoiceNumber,
          idt: toDdMmYyyy(r.invoiceDate),
          val: paiseToRupees(r.invoiceAmount),
          itms: [{
            num: 1,
            itm_det: {
              txval: paiseToRupees(r.taxableValue),
              rt: ratePct,
              iamt: paiseToRupees(r.igstTax),
              camt: paiseToRupees(r.cgstTax),
              samt: paiseToRupees(r.sgstTax),
              csamt: paiseToRupees(r.cessTax),
            },
          }],
        })
        counts.b2cl++
      } else {
        // Table 7 — B2CS, consolidated across invoices by (pos, rate, intra/inter).
        const splyTy: 'INTRA' | 'INTER' = r.stateCodeIntra ? 'INTRA' : 'INTER'
        const key = `${pos}|${ratePct}|${splyTy}`
        let bucket = b2cs.get(key)
        if (!bucket) {
          bucket = { sply_ty: splyTy, pos, rt: ratePct, typ: 'OE', txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0 }
          b2cs.set(key, bucket)
        }
        bucket.txval = round2(bucket.txval + paiseToRupees(r.taxableValue))
        bucket.iamt = round2(bucket.iamt + paiseToRupees(r.igstTax))
        bucket.camt = round2(bucket.camt + paiseToRupees(r.cgstTax))
        bucket.samt = round2(bucket.samt + paiseToRupees(r.sgstTax))
        bucket.csamt = round2(bucket.csamt + paiseToRupees(r.cessTax))
        counts.b2cs++
      }
    }

    // Table 12 — HSN summary. All contributing rows roll up (shipment only;
    // cancels adjust via CDN not HSN).
    if (r.hsn && r.txType === 'shipment') {
      const key = `${r.hsn}|${ratePct}`
      let bucket = hsn.get(key)
      if (!bucket) {
        bucket = {
          num: 0,  // assigned when we finalise
          hsn_sc: r.hsn,
          desc: '',
          uqc: 'NOS',
          qty: 0, val: 0, txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0,
        }
        hsn.set(key, bucket)
      }
      bucket.qty += r.quantity
      bucket.val = round2(bucket.val + paiseToRupees(r.invoiceAmount))
      bucket.txval = round2(bucket.txval + paiseToRupees(r.taxableValue))
      bucket.iamt = round2(bucket.iamt + paiseToRupees(r.igstTax))
      bucket.camt = round2(bucket.camt + paiseToRupees(r.cgstTax))
      bucket.samt = round2(bucket.samt + paiseToRupees(r.sgstTax))
      bucket.csamt = round2(bucket.csamt + paiseToRupees(r.sgstTax))
    }
  }
  // Finalise HSN numbering.
  const hsnList = [...hsn.values()]
  hsnList.forEach((h, i) => { h.num = i + 1 })
  counts.hsn = hsnList.length

  const preview: Gstr1Preview = {
    gstin,
    fp: periodToFp(period),
    version: 'preview-1',
    generated_at: new Date().toISOString(),
    disclaimer: 'GSTR-1 PREVIEW — not verified against the GSTN offline tool schema. See REPOTIC-MODULE.md Phase 3.1.',
    b2cs: [...b2cs.values()].sort((a, b) => a.pos.localeCompare(b.pos) || a.rt - b.rt),
    b2cl,
    cdnur,
    hsn: hsnList,
  }
  return { preview, counts }
}

function paiseToRupees(paise: number): number {
  return round2(paise / 100)
}
function round2(n: number): number {
  return Math.round(n * 100) / 100
}
/** '2025-12' → '122025' — GSTN uses MMYYYY. */
function periodToFp(period: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(period)
  return m ? `${m[2]}${m[1]}` : period
}
/** 'YYYY-MM-DD' → 'DD-MM-YYYY'. Null → ''. */
function toDdMmYyyy(iso: string | null): string {
  if (!iso) return ''
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  return m ? `${m[3]}-${m[2]}-${m[1]}` : iso
}
