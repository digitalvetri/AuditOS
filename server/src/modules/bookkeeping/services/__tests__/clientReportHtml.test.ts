import { describe, expect, it } from 'vitest'
import {
  esc,
  inr,
  inrRupees,
  renderClientReportHtml,
  renderMonthlyTrendSvg,
  renderAgeingBarsHtml,
  type ClientReportInput,
} from '../clientReportHtml.js'

function sampleInput(overrides: Partial<ClientReportInput> = {}): ClientReportInput {
  return {
    company: { name: 'KS Company', gstin: '33AABCU9603R1ZM', addressLine: null },
    header: {
      periodLabel: 'April – September 2025',
      from: '2025-04-01',
      to: '2025-09-30',
      fyLabel: '2025-26',
      preparedBy: 'JNS Accounting Solutions',
      preparedAt: '28 Sep 2026',
      firmContact: 'accounts@jns.example',
    },
    kpis: {
      revenuePaise: 108_431_700,
      grossProfitPaise: 62_144_000,
      grossMarginPct: 57.3,
      netProfitPaise: 38_820_500,
      netMarginPct: 35.8,
      receivablePaise: 41_266_000,
      receivableCount: 9,
      payablePaise: 10_520_000,
      payableCount: 3,
      workingCapitalPaise: 30_746_000,
    },
    monthly: [
      { label: 'Apr', incomePaise: 20_000_000, expensePaise: 12_000_000 },
      { label: 'May', incomePaise: 25_000_000, expensePaise: 14_000_000 },
      { label: 'Jun', incomePaise: 15_000_000, expensePaise: 10_000_000 },
    ],
    ageing: [
      { key: 'not_due', label: 'Not due', amountPaise: 0, invoiceCount: 0 },
      { key: '0_30', label: 'Under 30 days', amountPaise: 24_100_000, invoiceCount: 4 },
      { key: '31_60', label: '31 – 60 days', amountPaise: 9_240_000, invoiceCount: 2 },
      { key: '61_90', label: '61 – 90 days', amountPaise: 4_826_000, invoiceCount: 2 },
      { key: '90_plus', label: 'Over 90 days', amountPaise: 3_100_000, invoiceCount: 1 },
    ],
    outstandingTop10: [
      { billRef: 'INV/25-26/03', partyName: 'Alexandra', date: '2025-04-08', amountPaise: 3_100_000, daysOverdue: 173 },
      { billRef: 'INV/25-26/11', partyName: 'Oh Wee P',   date: '2025-05-10', amountPaise: 2_514_000, daysOverdue: 98 },
      { billRef: 'INV/25-26/17', partyName: 'PinaPop',    date: '2025-06-01', amountPaise: 7_399_900, daysOverdue: 46 },
    ],
    outstandingTotalPaise: 41_266_000,
    outstandingBillCount: 9,
    ...overrides,
  }
}

describe('esc', () => {
  it('escapes the five HTML metacharacters', () => {
    expect(esc('<script>&"\'/</script>')).toBe('&lt;script&gt;&amp;&quot;&#39;/&lt;/script&gt;')
  })

  it('is safe on null and undefined', () => {
    expect(esc(null)).toBe('')
    expect(esc(undefined)).toBe('')
  })
})

describe('inr / inrRupees', () => {
  it('formats paise using the Indian grouping — 10,84,317.00 shape', () => {
    const formatted = inr(108_431_700)
    // ICU whitespace varies across Node builds so we assert on the
    // digits, not the raw string.
    expect(formatted.replace(/[^\d.,]/g, '')).toBe('10,84,317.00')
    expect(inrRupees(108_431_700)).toContain('₹')
    expect(inrRupees(108_431_700)).toContain('10,84,317.00')
  })

  it('handles zero', () => {
    expect(inr(0)).toBe('0.00')
  })
})

describe('renderMonthlyTrendSvg', () => {
  it('renders one gold + one neutral bar per month', () => {
    const svg = renderMonthlyTrendSvg(sampleInput().monthly)
    // 3 months × 2 bars = 6 rects
    const rectCount = (svg.match(/<rect /g) ?? []).length
    expect(rectCount).toBe(6)
    // Each month gets an <text> label
    expect(svg).toContain('Apr')
    expect(svg).toContain('May')
    expect(svg).toContain('Jun')
    // Contains both palette hex values
    expect(svg).toContain('#B8860B')
    expect(svg).toContain('#525252')
  })

  it('renders an empty-state SVG when there are no months', () => {
    const svg = renderMonthlyTrendSvg([])
    expect(svg).toContain('No monthly data')
    // But is still valid SVG root
    expect(svg).toMatch(/^<svg[^>]*>/)
  })
})

describe('renderAgeingBarsHtml', () => {
  it('excludes the not_due bucket', () => {
    const html = renderAgeingBarsHtml(sampleInput().ageing)
    expect(html).not.toContain('Not due')
    expect(html).toContain('Under 30 days')
    expect(html).toContain('Over 90 days')
  })

  it('applies the danger fill + attention border to the over-90 bucket only', () => {
    const html = renderAgeingBarsHtml(sampleInput().ageing)
    // Danger fill appears on the >90 row only.
    const dangerCount = (html.match(/ageing-bar-fill--danger/g) ?? []).length
    expect(dangerCount).toBe(1)
    // Attention border also once.
    const attentionCount = (html.match(/ageing-row--attention/g) ?? []).length
    expect(attentionCount).toBe(1)
  })

  it('renders "—" when a bucket has zero invoices', () => {
    const html = renderAgeingBarsHtml([
      { key: '0_30', label: 'Under 30 days', amountPaise: 0, invoiceCount: 0 },
    ])
    expect(html).toContain('—')
  })
})

describe('renderClientReportHtml — full file', () => {
  it('is a single well-formed HTML document with inline CSS and no external references', () => {
    const html = renderClientReportHtml(sampleInput())
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true)
    expect(html).toContain('<style>')
    expect(html).not.toMatch(/<script/i)
    expect(html).not.toMatch(/<link\s/i)
    expect(html).not.toMatch(/@import/i)
    expect(html).not.toMatch(/\bhttps?:\/\//i) // no absolute URLs anywhere
  })

  it('includes every KPI label from the spec', () => {
    const html = renderClientReportHtml(sampleInput())
    for (const label of ['Revenue', 'Gross profit', 'Net profit', 'Receivable', 'Payable', 'Working capital']) {
      expect(html).toContain(label)
    }
  })

  it('carries the "Not for circulation" footer', () => {
    const html = renderClientReportHtml(sampleInput())
    expect(html).toContain('Not for circulation')
  })

  it('includes a print stylesheet block', () => {
    const html = renderClientReportHtml(sampleInput())
    expect(html).toContain('@media print')
  })

  it('escapes untrusted company names', () => {
    const html = renderClientReportHtml(sampleInput({ company: { name: '<img src=x>', gstin: null, addressLine: null } }))
    expect(html).not.toContain('<img src=x>')
    expect(html).toContain('&lt;img src=x&gt;')
  })

  it('omits the top-10 table entirely when the list is empty', () => {
    const html = renderClientReportHtml(sampleInput({ outstandingTop10: [] }))
    expect(html).not.toContain('Top 0')
    expect(html).not.toContain('Bill ref')
  })

  it('marks the top-10 rows over 90 days with the attention class', () => {
    const html = renderClientReportHtml(sampleInput())
    // The sample has one row at 173 days overdue.
    expect(html).toMatch(/<tr class="attention">/)
  })
})
