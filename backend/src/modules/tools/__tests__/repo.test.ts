import { describe, expect, it } from 'vitest'
import { convertAmazonMtrCsv } from '../services/tools/RepoService.js'

/**
 * Repo tool — Amazon MTR-B2C CSV → GSTR-1 preview JSON.
 *
 * These synthetic rows cover the three correctness-blockers found while
 * reverse-engineering Repotic's output:
 *
 *   1. txval aggregates per (sply_ty, pos, rt), insertion-ordered.
 *   2. iamt / camt / samt are computed per-row then summed (NOT sum-then-
 *      round) — the only way to match Repotic to the paise.
 *   3. supeco.clttx cross-totals every b2cs row under one marketplace ETIN.
 *
 * Shape invariants (key order within b2cs/supeco entries, filename format,
 * omit-empty behaviour) are asserted explicitly — they are what makes a
 * portal-uploadable JSON.
 */

/** Minimal column set — the service ignores unmapped columns. */
const HEADER = [
  'Seller Gstin', 'Invoice Number', 'Invoice Date', 'Transaction Type',
  'Ship To State',
  'Tax Exclusive Gross',
  'Cgst Rate', 'Sgst Rate', 'Utgst Rate', 'Igst Rate', 'Compensatory Cess Rate',
]

function csvOf(rows: string[][]): string {
  return [HEADER, ...rows].map((r) => r.join(',')).join('\n')
}

const SELLER_TN = '33CPQPS2226M2ZD'

describe('Repo — convertAmazonMtrCsv', () => {
  it('aggregates INTER shipments by (pos, rate) and rounds tax per row', () => {
    // Two rows to Andhra Pradesh (37) @ 18% IGST: 465.25 + 338.14.
    // JS float (0.18 is 0.17999…) rounds row 1 to 83.74 and row 2 to 60.87.
    // Summed iamt = 83.74 + 60.87 = 144.61.
    const csv = csvOf([
      [SELLER_TN, 'INV-1', '02-08-2026 10:00', 'Shipment', 'ANDHRA PRADESH', '465.25', '0', '0', '0', '0.18', '0'],
      [SELLER_TN, 'INV-2', '05-08-2026 10:00', 'Shipment', 'ANDHRA PRADESH', '338.14', '0', '0', '0', '0.18', '0'],
    ])

    const r = convertAmazonMtrCsv(csv)
    const json = JSON.parse(r.bytes.toString('utf8'))

    expect(json.gstin).toBe(SELLER_TN)
    expect(json.fp).toBe('082026')
    expect(json.b2cs).toHaveLength(1)
    expect(json.b2cs[0]).toEqual({
      sply_ty: 'INTER', rt: 18, typ: 'OE', pos: '37',
      txval: 803.39, iamt: 144.61, samt: 0, camt: 0, csamt: 0,
    })
  })

  it('splits tax across CGST+SGST for INTRA (same-state) shipments', () => {
    // Seller in TN (33); ship-to TN → intra. Rate 9% + 9% = 18%.
    // 930.52 * 0.09 = 83.7468 → 83.75 per row for each of cgst and sgst.
    const csv = csvOf([
      [SELLER_TN, 'INV-1', '04-08-2026', 'Shipment', 'TAMIL NADU', '930.52', '0.09', '0.09', '0', '0', '0'],
    ])

    const r = convertAmazonMtrCsv(csv)
    const json = JSON.parse(r.bytes.toString('utf8'))

    expect(json.b2cs[0]).toEqual({
      sply_ty: 'INTRA', rt: 18, typ: 'OE', pos: '33',
      txval: 930.52, iamt: 0, samt: 83.75, camt: 83.75, csamt: 0,
    })
  })

  it('excludes Cancel / Refund / FreeReplacement rows from b2cs', () => {
    const csv = csvOf([
      [SELLER_TN, 'INV-1', '02-08-2026', 'Shipment', 'ANDHRA PRADESH', '465.25', '0', '0', '0', '0.18', '0'],
      [SELLER_TN, '',       '03-08-2026', 'Cancel', 'ANDHRA PRADESH', '0', '0', '0', '0', '0', '0'],
      [SELLER_TN, 'INV-2', '04-08-2026', 'Refund', 'ANDHRA PRADESH', '-465.25', '0', '0', '0', '0.18', '0'],
      [SELLER_TN, '',       '05-08-2026', 'FreeReplacement', 'KARNATAKA', '0', '0', '0', '0', '0.18', '0'],
    ])

    const r = convertAmazonMtrCsv(csv)
    expect(r.rowsExcluded.cancel).toBe(1)
    expect(r.rowsExcluded.refund).toBe(1)
    expect(r.rowsExcluded.free_replacement).toBe(1)

    const json = JSON.parse(r.bytes.toString('utf8'))
    expect(json.b2cs).toHaveLength(1)
    expect(json.b2cs[0].txval).toBe(465.25)
  })

  it('emits supeco.clttx with Amazon ETIN for a TN seller (totals cross-check b2cs)', () => {
    const csv = csvOf([
      [SELLER_TN, 'INV-1', '02-08-2026', 'Shipment', 'ANDHRA PRADESH', '465.25', '0', '0', '0', '0.18', '0'],
      [SELLER_TN, 'INV-2', '03-08-2026', 'Shipment', 'TAMIL NADU',     '930.52', '0.09', '0.09', '0', '0', '0'],
    ])

    const r = convertAmazonMtrCsv(csv)
    const json = JSON.parse(r.bytes.toString('utf8'))

    expect(json.supeco).toBeDefined()
    expect(json.supeco.clttx).toHaveLength(1)
    // suppval = 465.25 + 930.52 = 1395.77
    // igst — only the AP row contributes (TN is intra): 83.74
    // cgst/sgst — only the TN row: 930.52 * 0.09 = 83.7468 → 83.75 each
    expect(json.supeco.clttx[0]).toEqual({
      etin: '33AAICA3918J1C0',
      suppval: 1395.77,
      igst: 83.74,
      cgst: 83.75,
      sgst: 83.75,
      cess: 0,
      flag: 'N',
    })
  })

  it('preserves insertion order of pos (states appear in first-seen order)', () => {
    const csv = csvOf([
      [SELLER_TN, 'INV-1', '02-08-2026', 'Shipment', 'ANDHRA PRADESH', '465.25', '0', '0', '0', '0.18', '0'],
      [SELLER_TN, 'INV-2', '03-08-2026', 'Shipment', 'TAMIL NADU',     '930.52', '0.09', '0.09', '0', '0', '0'],
      [SELLER_TN, 'INV-3', '04-08-2026', 'Shipment', 'KARNATAKA',      '465.25', '0', '0', '0', '0.18', '0'],
      // Another AP row — should MERGE into the existing AP entry, not append.
      [SELLER_TN, 'INV-4', '05-08-2026', 'Shipment', 'ANDHRA PRADESH', '100.00', '0', '0', '0', '0.18', '0'],
    ])
    const r = convertAmazonMtrCsv(csv)
    const json = JSON.parse(r.bytes.toString('utf8'))
    expect(json.b2cs.map((e: { pos: string }) => e.pos)).toEqual(['37', '33', '29'])
    expect(json.b2cs[0].txval).toBe(565.25)   // 465.25 + 100.00
  })

  it('preserves the key order inside each b2cs entry (portal-sensitive)', () => {
    const csv = csvOf([
      [SELLER_TN, 'INV-1', '02-08-2026', 'Shipment', 'ANDHRA PRADESH', '465.25', '0', '0', '0', '0.18', '0'],
    ])
    const r = convertAmazonMtrCsv(csv)
    const serialised = r.bytes.toString('utf8')
    const entry = JSON.parse(serialised).b2cs[0] as Record<string, unknown>
    expect(Object.keys(entry)).toEqual(['sply_ty', 'rt', 'typ', 'pos', 'txval', 'iamt', 'samt', 'camt', 'csamt'])
  })

  it('names the output file R1_<GSTIN>_<MM>_<YYYY>.json', () => {
    const csv = csvOf([
      [SELLER_TN, 'INV-1', '02-08-2026', 'Shipment', 'ANDHRA PRADESH', '465.25', '0', '0', '0', '0.18', '0'],
    ])
    const r = convertAmazonMtrCsv(csv)
    expect(r.filename).toBe('R1_33CPQPS2226M2ZD_08_2026.json')
  })

  it('omits supeco (with a warning) when no ETIN is registered for the seller state', () => {
    // A seller in Karnataka (29) — the ETIN table only has TN today, so
    // Table 14 should be withheld rather than emit a wrong ETIN.
    const sellerKa = '29ABCDE1234F1Z5'
    const csv = csvOf([
      [sellerKa, 'INV-1', '02-08-2026', 'Shipment', 'ANDHRA PRADESH', '465.25', '0', '0', '0', '0.18', '0'],
    ])
    const r = convertAmazonMtrCsv(csv)
    const json = JSON.parse(r.bytes.toString('utf8'))
    expect(json.supeco).toBeUndefined()
    expect(r.warnings.join(' ')).toMatch(/Table 14/)
  })
})
