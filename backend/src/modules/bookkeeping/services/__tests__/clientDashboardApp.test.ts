import { describe, expect, it } from 'vitest'
import { esc, renderClientDashboardHtml, scriptJson } from '../clientDashboardApp.js'
import type { ClientDashboardBundle } from '../clientDashboardBundle.js'

function bundle(overrides: Partial<ClientDashboardBundle> = {}): ClientDashboardBundle {
  const months = ['2026-04', '2026-05', '2026-06']
  return {
    v: 1,
    company: { name: 'KS Company', legalName: null, gstin: '33AABCU9603R1ZM', pan: null, state: 'Tamil Nadu', address: null },
    firm: { preparedBy: 'JNS Accounting Solutions', contact: 'accounts@jns.example', preparedAt: '28 Sep 2026', reportRef: 'CR-1234ABCD' },
    fy: { label: '2026-27', start: '2026-04-01', end: '2027-03-31' },
    months,
    initial: { from: '2026-04-01', to: '2026-06-30' },
    ledgers: [
      { n: 'Sales', g: 'Sales Accounts', p: 'Sales Accounts', nat: 'income', pl: true, ob: 0, dr: [0, 0, 0], cr: [100_00, 200_00, 0] },
      { n: 'HDFC Bank', g: 'Bank Accounts', p: 'Bank Accounts', nat: 'assets', pl: false, ob: 0, dr: [100_00, 200_00, 0], cr: [0, 0, 0] },
    ],
    vouchers: [],
    vouchersTruncated: false,
    items: [],
    bills: [],
    bank: [],
    regs: [],
    ...overrides,
  }
}

describe('esc / scriptJson', () => {
  it('escapes the five HTML metacharacters', () => {
    expect(esc('<script>&"\'/</script>')).toBe('&lt;script&gt;&amp;&quot;&#39;/&lt;/script&gt;')
    expect(esc(null)).toBe('')
  })

  it('cannot close the data script tag, and keeps line separators valid', () => {
    const out = scriptJson({ name: '</script><img src=x onerror=alert(1)>', sep: 'a b c' })
    expect(out).not.toContain('</script>')
    expect(out).not.toContain('<')
    expect(out).toContain('\\u2028')
    expect(JSON.parse(out)).toEqual({ name: '</script><img src=x onerror=alert(1)>', sep: 'a b c' })
  })
})

describe('renderClientDashboardHtml', () => {
  it('is one offline document: inline CSS and script, no links, imports or absolute URLs', () => {
    const html = renderClientDashboardHtml(bundle())
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true)
    expect(html).toContain('<style>')
    expect(html).not.toMatch(/<script[^>]*\bsrc=/i)
    expect(html).not.toMatch(/<link\s/i)
    expect(html).not.toMatch(/@import/i)
    expect(html).not.toMatch(/\bhttps?:\/\//i)
    // One data block and one executable script.
    expect((html.match(/<script/g) ?? []).length).toBe(2)
    expect(html).toContain('<script type="application/json" id="dashboard-data">')
  })

  it('has the FinAccounting navigation, period controls and actions', () => {
    const html = renderClientDashboardHtml(bundle())
    for (const view of ['dashboard', 'pl', 'bs', 'sales', 'ledger', 'trial', 'bank', 'debtors', 'creditors', 'journal', 'salesreg', 'purchases']) {
      expect(html).toContain(`data-view="${view}"`)
    }
    for (const mode of ['monthly', 'quarterly', 'yearly']) expect(html).toContain(`data-mode="${mode}"`)
    for (const action of ['export', 'pdf', 'print', 'share']) expect(html).toContain(`data-action="${action}"`)
    expect(html).toContain('id="period-select"')
    expect(html).toContain('id="compare-toggle"')
  })

  it('escapes untrusted names in the markup and carries them safely in the data', () => {
    const html = renderClientDashboardHtml(bundle({ company: { name: '<img src=x>', legalName: null, gstin: null, pan: null, state: null, address: null } }))
    expect(html).not.toContain('<img src=x>')
    expect(html).toContain('&lt;img src=x&gt;')
    expect(html).toContain('\\u003cimg src=x>')
  })

  it('carries the footer, reference and print stylesheet', () => {
    const html = renderClientDashboardHtml(bundle())
    expect(html).toContain('Not for circulation')
    expect(html).toContain('Ref CR-1234ABCD')
    expect(html).toContain('@media print')
  })

  it('embeds a script that is self-contained (no module syntax or outside references)', () => {
    const html = renderClientDashboardHtml(bundle())
    const script = html.slice(html.lastIndexOf('<script>'))
    expect(script).not.toMatch(/\bimport\b|\brequire\(|\bexports\b/)
    expect(script).toContain('(window, document, JSON.parse(')
  })
})
