/**
 * Unit tests for the pure GSTR-1 sectionizer.
 *
 * Every case here runs against fabricated NormalizedInvoice rows —
 * no Prisma, no DB. The composer's DB-facing layer is exercised
 * indirectly by the PR 3 route integration tests.
 */
import { describe, expect, it } from 'vitest'
import { sectionizeGstr1, rateForInvoice, B2CL_THRESHOLD_PAISE } from '../services/sectionize.js'
import { composeGstr3b, itcFromReconTotals } from '../services/GstReturnComposer.js'
import {
  b2bIntraState, b2bInterState, b2clSample, b2csSample, cdnrSample,
  invoiceWithLines, inv, rupees,
} from './fixtures.js'

describe('sectionizeGstr1 — buyer GSTIN drives b2b vs b2c', () => {
  it('routes registered buyers to b2b regardless of state', () => {
    const draft = sectionizeGstr1([b2bIntraState(), b2bInterState()], '2026-08')
    const b2b = draft.sections.filter(s => s.section === 'b2b')
    expect(b2b).toHaveLength(2)
    expect(b2b.map(r => r.counterpartyGstin).sort())
      .toEqual(['29AAACB1111B1Z5', '33AAACB0000B1Z5'])
  })

  it('routes unregistered inter-state ≥ ₹1L to b2cl', () => {
    const draft = sectionizeGstr1([b2clSample()], '2026-08')
    const b2cl = draft.sections.filter(s => s.section === 'b2cl')
    expect(b2cl).toHaveLength(1)
    expect(b2cl[0].placeOfSupply).toBe('07')
    expect(b2cl[0].isInterState).toBe(true)
  })

  it('routes small unregistered supplies to b2cs, aggregated per (rate, PoS)', () => {
    const draft = sectionizeGstr1([
      b2csSample(),
      { ...b2csSample(), id: 'b2cs-2', number: 'INV/2026/011' },
    ], '2026-08')
    const b2cs = draft.sections.filter(s => s.section === 'b2cs')
    expect(b2cs).toHaveLength(1)
    expect(b2cs[0].taxableValue).toBe(rupees(2_000))
    expect(b2cs[0].cgst).toBe(rupees(180))
    expect(b2cs[0].sgst).toBe(rupees(180))
    expect(b2cs[0].invoiceNumber).toBeNull() // aggregate — no per-invoice number
  })

  it('splits b2cs buckets by rate', () => {
    const at18 = { ...b2csSample(), id: 'b2cs-18' }
    const at5  = { ...b2csSample(), id: 'b2cs-5',
      taxableTotal: rupees(1_000), cgstTotal: rupees(25), sgstTotal: rupees(25), total: rupees(1_050) }
    const draft = sectionizeGstr1([at18, at5], '2026-08')
    const b2cs = draft.sections.filter(s => s.section === 'b2cs')
    expect(b2cs).toHaveLength(2)
    expect(b2cs.map(r => r.rateBp).sort((a, b) => (a ?? 0) - (b ?? 0)))
      .toEqual([500, 1800])
  })
})

describe('sectionizeGstr1 — credit notes', () => {
  it('routes credit notes to cdnr when buyer has GSTIN', () => {
    const draft = sectionizeGstr1([cdnrSample()], '2026-08')
    const cdnr = draft.sections.filter(s => s.section === 'cdnr')
    expect(cdnr).toHaveLength(1)
    expect(cdnr[0].counterpartyGstin).toBe('33AAACB0000B1Z5')
    expect(cdnr[0].sourceDocumentId).toBe('cdnr-1')
  })

  it('routes credit notes to cdnur when buyer is unregistered', () => {
    const cn = { ...cdnrSample(), buyerGstin: null }
    const draft = sectionizeGstr1([cn], '2026-08')
    expect(draft.sections.filter(s => s.section === 'cdnur')).toHaveLength(1)
    expect(draft.sections.filter(s => s.section === 'cdnr')).toHaveLength(0)
  })
})

describe('sectionizeGstr1 — HSN summary', () => {
  it('aggregates lines by (hsnSac, taxPercentBp)', () => {
    const draft = sectionizeGstr1([invoiceWithLines()], '2026-08')
    const hsn = draft.sections.filter(s => s.section === 'hsn')
    expect(hsn).toHaveLength(1)
    expect(hsn[0].hsnCode).toBe('998211')
    expect(hsn[0].rateBp).toBe(1800)
    expect(hsn[0].taxableValue).toBe(rupees(10_000))
  })

  it('emits no hsn rows when no invoice has lines', () => {
    const draft = sectionizeGstr1([b2csSample()], '2026-08')
    expect(draft.sections.filter(s => s.section === 'hsn')).toHaveLength(0)
  })
})

describe('sectionizeGstr1 — totals and stability', () => {
  it('roll-up totals sum every invoice (credit notes stay positive)', () => {
    const draft = sectionizeGstr1([b2bIntraState(), cdnrSample()], '2026-08')
    expect(draft.totals.invoiceCount).toBe(2)
    expect(draft.totals.totalTaxableValue).toBe(rupees(10_500))
    expect(draft.totals.totalCgst).toBe(rupees(945))
  })

  it('ordinals are dense per section', () => {
    const invoices = [b2bIntraState(), b2bInterState(), b2clSample()]
    const draft = sectionizeGstr1(invoices, '2026-08')
    const b2b = draft.sections.filter(s => s.section === 'b2b')
    expect(b2b.map(r => r.ordinal)).toEqual([0, 1])
    const b2cl = draft.sections.filter(s => s.section === 'b2cl')
    expect(b2cl.map(r => r.ordinal)).toEqual([0])
  })

  it('is deterministic — same input, same output', () => {
    const input = [b2bInterState(), b2bIntraState(), b2csSample()]
    const first = sectionizeGstr1(input, '2026-08')
    const second = sectionizeGstr1(input, '2026-08')
    expect(JSON.stringify(first, (_k, v) => typeof v === 'bigint' ? v.toString() : v))
      .toBe(JSON.stringify(second, (_k, v) => typeof v === 'bigint' ? v.toString() : v))
  })
})

describe('B2CL_THRESHOLD_PAISE — sanity', () => {
  it('is exactly ₹1,00,000 in paise', () => {
    expect(B2CL_THRESHOLD_PAISE).toBe(1_00_000n * 100n)
  })

  it('an invoice one paisa below threshold falls to b2cs, not b2cl', () => {
    const justBelow = inv({
      id: 'edge',
      buyerGstin: null,
      isInterState: true,
      placeOfSupply: '07',
      taxableTotal: rupees(84_745), // ₹84,745
      cgstTotal: 0n, sgstTotal: 0n,
      igstTotal: rupees(15_254),
      total: B2CL_THRESHOLD_PAISE - 1n, // total one paisa short of ₹1L
    })
    const draft = sectionizeGstr1([justBelow], '2026-08')
    expect(draft.sections.filter(s => s.section === 'b2cl')).toHaveLength(0)
    // B2CS aggregates unregistered inter-state under-threshold as well.
    expect(draft.sections.filter(s => s.section === 'b2cs')).toHaveLength(1)
  })
})

describe('rateForInvoice — snap to statutory slab', () => {
  it('recovers 18% from an intra-state invoice', () => {
    expect(rateForInvoice(b2bIntraState())).toBe(1800)
  })

  it('recovers 18% from an inter-state invoice (IGST)', () => {
    expect(rateForInvoice(b2bInterState())).toBe(1800)
  })

  it('returns 0 when taxable is zero', () => {
    const nil = inv({
      id: 'nil-1', taxableTotal: 0n, cgstTotal: 0n, sgstTotal: 0n, igstTotal: 0n, total: 0n,
    })
    expect(rateForInvoice(nil)).toBe(0)
  })

  it('snaps a rounded ratio to the nearest slab', () => {
    // ₹1,000 taxable, ₹181 tax — comes out to 1810 bp raw, should snap to 1800.
    const rounded = inv({
      id: 'rnd',
      taxableTotal: rupees(1_000),
      cgstTotal: rupees(90.5), sgstTotal: rupees(90.5),
      igstTotal: 0n,
      total: rupees(1_181),
    })
    expect(rateForInvoice(rounded)).toBe(1800)
  })
})

describe('composeGstr3b — output − ITC, floored at zero', () => {
  it('nets credit notes against output tax', () => {
    const gstr1 = sectionizeGstr1([b2bIntraState(), cdnrSample()], '2026-08')
    const g3b = composeGstr3b({ gstr1, itc: { cgst: 0n, sgst: 0n, igst: 0n, cess: 0n } })
    // Output = 900 - 45 = 855 rupees on each of CGST + SGST.
    expect(g3b.liability.outputCgst).toBe(rupees(855))
    expect(g3b.liability.outputSgst).toBe(rupees(855))
    expect(g3b.liability.cashCgst).toBe(rupees(855))
  })

  it('applies ITC and floors cash payable at zero', () => {
    const gstr1 = sectionizeGstr1([b2bIntraState()], '2026-08')
    const g3b = composeGstr3b({ gstr1, itc: { cgst: rupees(2_000), sgst: rupees(2_000), igst: 0n, cess: 0n } })
    // Output = 900, ITC = 2000, cash floored at 0.
    expect(g3b.liability.outputCgst).toBe(rupees(900))
    expect(g3b.liability.itcCgst).toBe(rupees(2_000))
    expect(g3b.liability.cashCgst).toBe(0n)
  })

  it('excludes the HSN section from output tax roll-up', () => {
    // Invoice has line-level tax that also appears at doc level. If we
    // double-counted the HSN block, output would be 2x.
    const gstr1 = sectionizeGstr1([invoiceWithLines()], '2026-08')
    const g3b = composeGstr3b({ gstr1, itc: { cgst: 0n, sgst: 0n, igst: 0n, cess: 0n } })
    expect(g3b.liability.outputCgst).toBe(rupees(900))
  })
})

describe('itcFromReconTotals', () => {
  it('returns zeros when totalsJson is null', () => {
    expect(itcFromReconTotals(null)).toEqual({ cgst: 0n, sgst: 0n, igst: 0n, cess: 0n })
  })

  it('sums matched + partial buckets, ignores only_2b / only_pr', () => {
    const json = JSON.stringify({
      matched: { cgst: 100000, sgst: 100000, igst: 200000, cess: 0 },
      partial: { cgst:  50000, sgst:  50000, igst:  25000, cess: 0 },
      only_2b: { cgst: 999999 },
      only_pr: { cgst: 999999 },
    })
    expect(itcFromReconTotals(json)).toEqual({
      cgst: 150_000n, sgst: 150_000n, igst: 225_000n, cess: 0n,
    })
  })

  it('is defensive against malformed JSON', () => {
    expect(itcFromReconTotals('{not valid')).toEqual({ cgst: 0n, sgst: 0n, igst: 0n, cess: 0n })
  })
})
