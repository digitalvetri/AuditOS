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
import { lookupEtin, type MarketplaceKey } from './eco-etins.js'

/** B2CL threshold — ₹1 lakh, effective 2024-08-01 (REPOTIC-MODULE.md §3.1).
 *  An invoice goes to B2CL when its value is MORE THAN this (GSTR-1 Table 5).
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
  /**
   * Table 14 — Supplies made through E-Commerce Operators (mandatory since
   * Oct-2024 for every seller using Amazon/Flipkart/etc.). One entry per
   * marketplace ETIN. Flag 'N' = seller pays GST, marketplace only TCS.
   * Omitted when no ETIN is registered for the seller's state in
   * eco-etins.ts — the portal rejects a wrong ETIN, so an unknown is better
   * than a guess.
   */
  supeco?: { clttx: SupecoEntry[] }
}

export interface SupecoEntry {
  etin: string
  suppval: number
  igst: number
  cgst: number
  sgst: number
  cess: number
  flag: 'N'
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
      itm_det: { txval: number; rt: number; iamt: number; csamt: number }
    }>
  }>
}

export interface CdnurEntry {
  typ: 'B2CL'       // UR type: notes against B2C-large invoices only
  ntty: 'C' | 'D'   // credit / debit
  nt_num: string
  nt_dt: string     // DD-MM-YYYY
  val: number
  pos: string
  itms: Array<{ num: number; itm_det: { txval: number; rt: number; iamt: number; csamt: number } }>
}

export interface HsnEntry {
  num: number
  hsn_sc: string
  desc: string
  uqc: string
  qty: number
  rt: number
  txval: number
  iamt: number
  camt: number
  samt: number
  csamt: number
}

export interface Gstr1BuildResult {
  preview: Gstr1Preview
  counts: Record<'b2cs' | 'b2cl' | 'cdnur' | 'hsn' | 'b2cs_returns' | 'excluded_free_replacement' | 'excluded_other' | 'excluded_other_gstin' | 'excluded_out_of_period' | 'excluded_b2b' | 'total_rows', number>
  warnings: string[]
}

/** Report kinds that carry B2B (registered-buyer) sales. This builder does
 *  not produce Table 4 (B2B), so their rows are left out of every table
 *  rather than being filed as B2C. */
export const B2B_REPORT_KINDS = new Set(['mtr_b2b', 'b2b_sheet', 'tcs_b2b'])

/** Build the GSTR-1 preview for one scope. Pure — same inputs give the
 *  same output; the only I/O is the prisma query at the start. */
export async function buildGstr1Preview(scope: Gstr1BuildScope, prisma: PrismaClient): Promise<Gstr1BuildResult> {
  // The current file of each (marketplace, report): the newest upload that
  // parsed and was not replaced. Re-uploads mark older ones `superseded`
  // (routes.ts); taking only the newest here also keeps scopes that held
  // two uploads from before that rule from doubling.
  const uploads = await prisma.rpEcommerceUpload.findMany({
    where: {
      organisationId: scope.organisationId, clientId: scope.clientId, gstin: scope.gstin, period: scope.period,
      deletedAt: null, status: 'parsed',
      // `auto_detected` is the auto-mapper fallback (routes.ts).
      detectStatus: { in: ['matched', 'drifted', 'auto_detected'] },
    },
    orderBy: { uploadedAt: 'desc' },
    select: { id: true, marketplace: true, reportKind: true },
  })
  const current = new Map<string, (typeof uploads)[number]>()
  for (const u of uploads) if (!current.has(`${u.marketplace}|${u.reportKind}`)) current.set(`${u.marketplace}|${u.reportKind}`, u)
  const marketplaceOf: Record<string, string> = {}
  const b2bUploads = new Set<string>()
  for (const u of current.values()) {
    marketplaceOf[u.id] = u.marketplace
    if (B2B_REPORT_KINDS.has(u.reportKind)) b2bUploads.add(u.id)
  }
  const rows = await prisma.rpParsedRow.findMany({
    where: { organisationId: scope.organisationId, uploadId: { in: [...current.values()].map((u) => u.id) } },
    orderBy: [{ invoiceDate: 'asc' }, { sourceRowIndex: 'asc' }],
  })
  const b2c = rows.filter((r) => !b2bUploads.has(r.uploadId))

  // A return in this period against an invoice of an earlier one: find the
  // original sale in that period's current uploads, so a return on a B2C
  // large invoice still goes to CDNUR.
  const sold = new Set(b2c.filter((r) => r.txType === 'shipment' && r.invoiceNumber).map((r) => r.invoiceNumber!))
  const orphanReturns = [...new Set(b2c.filter((r) => (r.txType === 'refund' || r.txType === 'cancel') && r.invoiceNumber && !sold.has(r.invoiceNumber)).map((r) => r.invoiceNumber!))]
  const originalValues: Record<string, number> = {}
  if (orphanReturns.length) {
    const earlier = await prisma.rpParsedRow.findMany({
      where: {
        organisationId: scope.organisationId, txType: 'shipment', invoiceNumber: { in: orphanReturns },
        upload: { clientId: scope.clientId, gstin: scope.gstin, period: { not: scope.period }, deletedAt: null, status: 'parsed' },
      },
      select: { invoiceNumber: true, invoiceAmount: true, sellerGstin: true },
    })
    for (const r of earlier) {
      if (r.sellerGstin && r.sellerGstin.toUpperCase() !== scope.gstin.toUpperCase()) continue
      originalValues[r.invoiceNumber!] = (originalValues[r.invoiceNumber!] ?? 0) + r.invoiceAmount
    }
  }

  const result = buildFromRows(b2c, scope.gstin, scope.period, { marketplaceOf, originalValues })
  if (b2bUploads.size) {
    const n = rows.length - b2c.length
    result.counts.excluded_b2b += n
    result.counts.total_rows += n
    result.warnings.unshift(`${n} row(s) from B2B reports are not included: this preview does not build Table 4 (B2B). File B2B invoices separately.`)
  }
  return result
}

type Totals = { txval: number; iamt: number; camt: number; samt: number; csamt: number }
const zeroTotals = (): Totals => ({ txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0 })

/** Intra-state when the row carries CGST/SGST and no IGST. Works for return
 *  rows too, whose tax may be written negative. */
function isIntra(r: RpParsedRow): boolean {
  return r.stateCodeIntra || (r.igstTax === 0 && (r.cgstTax !== 0 || r.sgstTax !== 0))
}

/** Pure aggregation step — exported for tests.
 *
 *  `marketplaceOf` maps uploadId → marketplace key; Table 14 is built per
 *  marketplace from it (no map → no Table 14). */
export function buildFromRows(
  allRows: RpParsedRow[], gstin: string, period: string,
  opts: {
    marketplaceOf?: Record<string, string>
    /** Invoice number → value (paise) of sales found in earlier periods,
     *  for returns whose sale is not in these rows. */
    originalValues?: Record<string, number>
  } = {},
): Gstr1BuildResult {
  const sellerStateCode = gstinStateCode(gstin) ?? '00'
  const marketplaceOf = opts.marketplaceOf ?? {}

  const b2cs = new Map<string, B2csEntry>()   // key: pos|rate|sply_ty
  const b2cl: B2clEntry[] = []
  const b2clByPos = new Map<string, B2clEntry>()
  const cdnurByNote = new Map<string, CdnurEntry>()
  const hsn = new Map<string, HsnEntry>()     // key: hsn|rate
  const eco = new Map<string, Totals>()       // key: marketplace|etin from the row
  const counts: Gstr1BuildResult['counts'] = {
    b2cs: 0, b2cl: 0, cdnur: 0, hsn: 0, b2cs_returns: 0,
    excluded_free_replacement: 0, excluded_other: 0, excluded_other_gstin: 0, excluded_out_of_period: 0,
    excluded_b2b: 0, total_rows: allRows.length,
  }
  const warnings: string[] = []

  // 1. Only this GSTIN's rows, and only this period's. A marketplace report
  //    (Amazon MTR) covers every GSTIN of a multi-state seller, and a file can
  //    straddle months. A return counts in the month of its credit note.
  const scopeGstin = gstin.trim().toUpperCase()
  const rows: RpParsedRow[] = []
  for (const r of allRows) {
    if (r.sellerGstin && r.sellerGstin.trim().toUpperCase() !== scopeGstin) { counts.excluded_other_gstin++; continue }
    const isReturn = r.txType === 'cancel' || r.txType === 'refund'
    const when = isReturn ? (r.creditNoteDate ?? r.invoiceDate) : r.invoiceDate
    if (when && !when.startsWith(period)) { counts.excluded_out_of_period++; continue }
    rows.push(r)
  }
  if (counts.excluded_other_gstin) warnings.push(`${counts.excluded_other_gstin} row(s) belong to another seller GSTIN and were left out.`)
  if (counts.excluded_out_of_period) warnings.push(`${counts.excluded_out_of_period} row(s) are dated outside ${period} and were left out.`)

  // B2CL is decided on the INVOICE value, not the line: a marketplace report
  // has one row per item, so add up every shipment line of an invoice first.
  // Keyed by invoice number alone so a return finds its original sale.
  const invoiceValue = new Map<string, number>()
  const returnValue = new Map<string, number>()
  for (const r of rows) {
    if (!r.invoiceNumber) continue
    if (r.txType === 'shipment') invoiceValue.set(r.invoiceNumber, (invoiceValue.get(r.invoiceNumber) ?? 0) + r.invoiceAmount)
    else if (r.txType === 'cancel' || r.txType === 'refund') returnValue.set(r.invoiceNumber, (returnValue.get(r.invoiceNumber) ?? 0) + Math.abs(r.invoiceAmount))
  }
  const b2clInvoices = new Map<string, B2clEntry['inv'][number]>()
  const unknownOriginals = new Set<string>()

  const addB2cs = (pos: string, ratePct: number, splyTy: 'INTRA' | 'INTER', sign: 1 | -1, t: Totals) => {
    const key = `${pos}|${ratePct}|${splyTy}`
    let bucket = b2cs.get(key)
    if (!bucket) {
      bucket = { sply_ty: splyTy, pos, rt: ratePct, typ: 'OE', txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0 }
      b2cs.set(key, bucket)
    }
    bucket.txval = round2(bucket.txval + sign * t.txval)
    bucket.iamt = round2(bucket.iamt + sign * t.iamt)
    bucket.camt = round2(bucket.camt + sign * t.camt)
    bucket.samt = round2(bucket.samt + sign * t.samt)
    bucket.csamt = round2(bucket.csamt + sign * t.csamt)
  }

  for (const r of rows) {
    if (r.txType === 'free_replacement') { counts.excluded_free_replacement++; continue }
    if (r.txType === 'other') { counts.excluded_other++; continue }

    const pos = stateNameToCode(r.shipToState) ?? sellerStateCode
    const ratePct = r.rate / 100  // 1800 → 18
    const intra = isIntra(r)
    const t: Totals = {
      txval: paiseToRupees(Math.abs(r.taxableValue)),
      iamt: paiseToRupees(Math.abs(r.igstTax)),
      camt: paiseToRupees(Math.abs(r.cgstTax)),
      samt: paiseToRupees(Math.abs(r.sgstTax)),
      csamt: paiseToRupees(Math.abs(r.cessTax)),
    }
    const isReturn = r.txType === 'cancel' || r.txType === 'refund'
    const sign: 1 | -1 = isReturn ? -1 : 1

    if (isReturn) {
      // A return against a B2C-large invoice (inter-state, invoice value
      // more than ₹1 lakh) is a credit note in Table 9B (CDNUR, typ B2CL).
      // Every other B2C return reduces Table 7 (B2CS) of this period —
      // B2CS is reported net. When the original invoice is not in this
      // period's rows, the returned value stands in for it.
      const known = r.invoiceNumber ? (invoiceValue.get(r.invoiceNumber) ?? opts.originalValues?.[r.invoiceNumber]) : undefined
      const original = known ?? (r.invoiceNumber ? (returnValue.get(r.invoiceNumber) ?? 0) : Math.abs(r.invoiceAmount))
      if (known === undefined && !intra) unknownOriginals.add(r.invoiceNumber ?? r.creditNoteNumber ?? '(no number)')
      if (!intra && original > B2CL_THRESHOLD_PAISE) {
        if (!r.creditNoteNumber) {
          counts.excluded_other++
          warnings.push(`A return against B2C-large invoice ${r.invoiceNumber ?? '(no number)'} has no credit note number and was left out of Table 9B.`)
          continue
        }
        let note = cdnurByNote.get(r.creditNoteNumber)
        if (!note) {
          note = { typ: 'B2CL', ntty: 'C', nt_num: r.creditNoteNumber, nt_dt: toDdMmYyyy(r.creditNoteDate ?? r.invoiceDate), val: 0, pos, itms: [] }
          cdnurByNote.set(r.creditNoteNumber, note)
        }
        note.val = round2(note.val + paiseToRupees(Math.abs(r.invoiceAmount)))
        note.itms.push({ num: note.itms.length + 1, itm_det: { txval: t.txval, rt: ratePct, iamt: t.iamt, csamt: t.csamt } })
        counts.cdnur++
      } else {
        addB2cs(pos, ratePct, intra ? 'INTRA' : 'INTER', -1, t)
        counts.b2cs_returns++
      }
    } else if (r.txType === 'shipment') {
      // §3.1 — B2CL threshold is ₹1 lakh, and only applies to inter-state.
      const value = r.invoiceNumber ? (invoiceValue.get(r.invoiceNumber) ?? r.invoiceAmount) : r.invoiceAmount
      if (!intra && value > B2CL_THRESHOLD_PAISE && r.invoiceNumber) {
        // Table 5A — B2CL. Grouped by place-of-supply, one entry per invoice
        // carrying every line of it.
        let bucket = b2clByPos.get(pos)
        if (!bucket) {
          bucket = { pos, inv: [] }
          b2clByPos.set(pos, bucket)
          b2cl.push(bucket)
        }
        let inv = b2clInvoices.get(r.invoiceNumber)
        if (!inv) {
          inv = { inum: r.invoiceNumber, idt: toDdMmYyyy(r.invoiceDate), val: paiseToRupees(value), itms: [] }
          b2clInvoices.set(r.invoiceNumber, inv)
          bucket.inv.push(inv)
        }
        inv.itms.push({ num: inv.itms.length + 1, itm_det: { txval: t.txval, rt: ratePct, iamt: t.iamt, csamt: t.csamt } })
        counts.b2cl++
      } else {
        // Table 7 — B2CS, consolidated across invoices by (pos, rate, intra/inter).
        addB2cs(pos, ratePct, intra ? 'INTRA' : 'INTER', 1, t)
        counts.b2cs++
      }
    } else {
      continue
    }

    // Table 14 — every B2C supply here went through the marketplace whose
    // report it came from; returns reduce it.
    const mp = marketplaceOf[r.uploadId]
    if (mp) {
      const ecoKey = `${mp}|${r.ecoGstin ?? ''}`
      const e = eco.get(ecoKey) ?? zeroTotals()
      e.txval = round2(e.txval + sign * t.txval)
      e.iamt = round2(e.iamt + sign * t.iamt)
      e.camt = round2(e.camt + sign * t.camt)
      e.samt = round2(e.samt + sign * t.samt)
      e.csamt = round2(e.csamt + sign * t.csamt)
      eco.set(ecoKey, e)
    }

    // Table 12 — HSN summary, net of returns.
    if (r.hsn) {
      const key = `${r.hsn}|${ratePct}`
      let bucket = hsn.get(key)
      if (!bucket) {
        bucket = { num: 0, hsn_sc: r.hsn, desc: '', uqc: 'NOS', qty: 0, rt: ratePct, txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0 }
        hsn.set(key, bucket)
      }
      bucket.qty += sign * Math.abs(r.quantity)
      bucket.txval = round2(bucket.txval + sign * t.txval)
      bucket.iamt = round2(bucket.iamt + sign * t.iamt)
      bucket.camt = round2(bucket.camt + sign * t.camt)
      bucket.samt = round2(bucket.samt + sign * t.samt)
      bucket.csamt = round2(bucket.csamt + sign * t.csamt)
    }
  }
  if (unknownOriginals.size) {
    const list = [...unknownOriginals]
    warnings.push(`${list.length} inter-state return(s) have no original sale in the uploaded files (${list.slice(0, 5).join(', ')}${list.length > 5 ? ', …' : ''}). They are netted in B2CS; if the original invoice was over ₹1 lakh, report the return in CDNUR (Table 9B) instead.`)
  }
  const hsnList = [...hsn.values()].filter((h) => h.qty !== 0 || h.txval !== 0)
  hsnList.forEach((h, i) => { h.num = i + 1 })
  counts.hsn = hsnList.length

  const b2csList = [...b2cs.values()]
    .filter((e) => e.txval !== 0 || e.iamt !== 0 || e.camt !== 0 || e.samt !== 0 || e.csamt !== 0)
    .sort((a, b) => a.pos.localeCompare(b.pos) || a.rt - b.rt)
  for (const e of b2csList) {
    if (e.txval < 0) warnings.push(`B2CS ${e.sply_ty} POS ${e.pos} at ${e.rt}% is negative (₹${e.txval}): returns this month exceed sales. The portal does not take a negative Table 7 row — adjust it through B2CS amendments.`)
  }

  // Table 14 — supeco.clttx, one entry per marketplace with an ETIN known
  // for the seller's state (eco-etins.ts), carrying that marketplace's own
  // B2C supplies (B2CS + B2CL, net of returns).
  const supecoEntries: SupecoEntry[] = []
  // The ETIN is the one the report states on the row (Meesho), else the
  // one known for the seller's state.
  const merged = new Map<string, { mp: string; e: Totals }>()
  for (const [key, e] of eco) {
    const [mp, rowEtin] = key.split('|')
    const etin = (rowEtin && isValidEtin(rowEtin) ? rowEtin : null)
      ?? ((mp === 'amazon' || mp === 'flipkart' || mp === 'myntra' || mp === 'meesho') ? lookupEtin(mp as MarketplaceKey, sellerStateCode) : null)
    const k = etin ?? `?${mp}`
    const m = merged.get(k) ?? { mp, e: zeroTotals() }
    for (const f of ['txval', 'iamt', 'camt', 'samt', 'csamt'] as const) m.e[f] = round2(m.e[f] + e[f])
    merged.set(k, m)
  }
  for (const [k, { mp, e }] of merged) {
    const etin = k.startsWith('?') ? null : k
    if (!etin) {
      warnings.push(`Table 14 omitted for ${mp}: no ETIN registered for state ${sellerStateCode}. Add it to backend/src/modules/repotic/eco-etins.ts before uploading to the GST portal.`)
      continue
    }
    supecoEntries.push({ etin, suppval: e.txval, igst: e.iamt, cgst: e.camt, sgst: e.samt, cess: e.csamt, flag: 'N' })
  }

  const preview: Gstr1Preview = {
    gstin,
    fp: periodToFp(period),
    version: 'preview-1',
    generated_at: new Date().toISOString(),
    disclaimer: 'GSTR-1 PREVIEW — not verified against the GSTN offline tool schema. Covers Tables 5A (B2CL), 7 (B2CS), 9B (CDNUR, B2CL returns), 12 (HSN) and 14 (ECO) only.',
    b2cs: b2csList,
    b2cl,
    cdnur: [...cdnurByNote.values()],
    hsn: hsnList,
    ...(supecoEntries.length ? { supeco: { clttx: supecoEntries } } : {}),
  }
  return { preview, counts, warnings }
}

const GSTIN_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'
/** An e-commerce operator's TCS registration (e.g. 33AAICA3918J1C0): the
 *  GSTIN shape with "C" (not "Z") at position 14, and the same check digit. */
function isValidEtin(g: string): boolean {
  if (!/^\d{2}[A-Z]{5}\d{4}[A-Z][0-9A-Z]{3}$/.test(g)) return false
  let sum = 0
  for (let i = 0; i < 14; i++) {
    const v = GSTIN_CHARS.indexOf(g[i]) * (i % 2 ? 2 : 1)
    sum += Math.floor(v / 36) + (v % 36)
  }
  return GSTIN_CHARS[(36 - (sum % 36)) % 36] === g[14]
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
