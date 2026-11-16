import { describe, expect, it } from 'vitest'
import { extractTransit } from '../parsers/transitPdf.js'
import type { ExtractedPage } from '../lib/pdfInspect.js'

/** Lay out a block of text as PDF text items — one item per line. */
function page(text: string): ExtractedPage {
  const lines = text.trim().split('\n').map((l) => l.trim()).filter(Boolean)
  return {
    pageNumber: 1,
    width: 595, height: 842,
    items: lines.map((str, i) => ({ str, x: 50, y: 800 - i * 20, width: str.length * 5, height: 12, fontName: 'Helvetica' })),
  }
}

describe('transit (LR / delivery challan) parser', () => {
  it('reads a standard lorry receipt: LR no, date, consignor/consignee, vehicle, from/to', () => {
    const p = page(`
      SRI LAKSHMI TRANSPORTS
      LR No: LR/2026/0427 Date: 18/05/2026
      Consignor: ABC Textiles Pvt Ltd
      GSTIN 33AABCV1234N1ZE
      Consignee: XYZ Retail Ltd
      GSTIN 29AACCX9876K1Z5
      From: Coimbatore To: Bengaluru
      Vehicle No: TN 38 BZ 4213
      Description of goods: Cotton fabric rolls
      Quantity: 50 bundles
      Invoice Value: Rs. 2,45,000.00
    `)
    const r = extractTransit([p])
    expect(r.docType).toBe('lorry_receipt')
    expect(r.docNumber.value).toBe('LR/2026/0427')
    expect(r.docNumber.confidence).toBe('high')
    expect(r.docDate.value).toBe('2026-05-18')
    expect(r.consignorGstin.value).toBe('33AABCV1234N1ZE')
    expect(r.consigneeGstin.value).toBe('29AACCX9876K1Z5')
    expect(r.vehicleNumber.value).toBe('TN38BZ4213')
    expect(r.vehicleNumber.confidence).toBe('high')
    expect(r.fromPlace.value).toBe('Coimbatore')
    expect(r.toPlace.value).toBe('Bengaluru')
    expect(r.quantity.value).toBe('50 bundles')
    expect(r.valuePaise.value).toBe(24500000)
  })

  it('reads a delivery challan: detects docType, picks challan no and goods', () => {
    const p = page(`
      MARUTHI FABRICS
      Delivery Challan No: DC-2026-112
      Date 02/06/2026
      Consignor: Maruthi Fabrics
      Consignee: Raj Garments
      Vehicle KA01AB5566
      Goods: Blended yarn cones
      Qty 12 cartons
    `)
    const r = extractTransit([p])
    expect(r.docType).toBe('delivery_challan')
    expect(r.docNumber.value).toBe('DC-2026-112')
    expect(r.docDate.value).toBe('2026-06-02')
    expect(r.vehicleNumber.value).toBe('KA01AB5566')
    expect(r.goodsDescription.value).toContain('Blended yarn cones')
    expect(r.quantity.value).toBe('12 cartons')
  })

  it('handles a hyphenated vehicle plate and omitted value', () => {
    const p = page(`
      LR No 00981 Date 11-11-2026
      Vehicle: TN-01-AB-1234
      From Erode To Tiruppur
      Description: Grey fabric
    `)
    const r = extractTransit([p])
    expect(r.vehicleNumber.value).toBe('TN01AB1234')
    expect(r.valuePaise.value).toBeNull()
    expect(r.docDate.value).toBe('2026-11-11')
  })

  it('returns low confidence on an empty page without crashing', () => {
    const r = extractTransit([page('Some unrelated header')])
    expect(r.docType).toBe('unknown')
    expect(r.docNumber.value).toBeNull()
    expect(r.docNumber.confidence).toBe('low')
    expect(r.vehicleNumber.value).toBeNull()
  })
})
