/**
 * BOOKKEEPING · CLIENT DASHBOARD HTML GENERATOR (BOOKKEEPING-REBUILD §6).
 *
 * Pure functions. No IO, no Prisma. Given a data payload, return a
 * complete self-contained HTML file the firm sends over WhatsApp:
 *
 *   • ONE file. CSS, data and any SVG are inlined. No CDN, no font
 *     link, no network calls. The file must render identically in
 *     eighteen months on a phone with no signal.
 *   • Charts are inline SVG generated here. No chart library.
 *   • A print stylesheet is included so "Save as PDF" from the
 *     browser produces something sendable.
 *
 * Design constraint (spec §6): Sovereign, NOT FinAccounting's look.
 *   One gold accent per screen. 2px left-border to mark what needs
 *   attention (>90 bucket, aged invoices). No filled status pills.
 *   Tabular numerals. 13px body. TWO deviations:
 *     KPI numbers at 28-32px; top 10 outstanding only, not the full list.
 */

// ---------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------

export interface ClientReportCompany {
  name: string
  gstin: string | null
  addressLine: string | null
}

export interface ClientReportHeader {
  periodLabel: string        // "April – September 2025"
  from: string               // "2025-04-01"
  to: string                 // "2025-09-30"
  fyLabel: string            // "2025-26"
  preparedBy: string         // "JNS Accounting Solutions"
  preparedAt: string         // "28 Sep 2026"
  firmContact: string | null // "accounts@jns.example · +91 …"
}

export interface ClientReportKpis {
  revenuePaise: number
  grossProfitPaise: number
  grossMarginPct: number | null
  netProfitPaise: number
  netMarginPct: number | null
  receivablePaise: number
  receivableCount: number
  payablePaise: number
  payableCount: number
  workingCapitalPaise: number
}

export interface ClientReportMonthlyBar {
  label: string        // "Apr", "May", ...
  incomePaise: number
  expensePaise: number
}

export interface ClientReportAgeingBucket {
  key: 'not_due' | '0_30' | '31_60' | '61_90' | '90_plus'
  label: string
  amountPaise: number
  invoiceCount: number
}

export interface ClientReportOutstandingRow {
  billRef: string
  partyName: string
  date: string       // YYYY-MM-DD
  amountPaise: number
  daysOverdue: number
}

export interface ClientReportInput {
  company: ClientReportCompany
  header: ClientReportHeader
  kpis: ClientReportKpis
  monthly: ClientReportMonthlyBar[]
  ageing: ClientReportAgeingBucket[]
  outstandingTop10: ClientReportOutstandingRow[]
  outstandingTotalPaise: number
  outstandingBillCount: number
}

// ---------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------

/** Indian rupee format with two decimals, no symbol. */
export function inr(paise: number): string {
  return (paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/** Same but with the ₹ prefix. */
export function inrRupees(paise: number): string {
  return `₹ ${inr(paise)}`
}

/** HTML-escape untrusted strings so a client name with an ampersand
 *  can't corrupt the output. Applied to every field the caller passes
 *  before it lands in the template. */
export function esc(s: string | null | undefined): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// ---------------------------------------------------------------------
// SVG chart primitives
// ---------------------------------------------------------------------

/**
 * Grouped bar chart for Revenue vs Expenses by month. Height fixed,
 * width scales with monthly count. Two bars per month, gold + neutral.
 * All positioning is arithmetic — no dependencies, no viewBox tricks
 * that break on old phone browsers.
 */
export function renderMonthlyTrendSvg(months: ClientReportMonthlyBar[]): string {
  if (months.length === 0) {
    return `<svg viewBox="0 0 100 40" width="100%" height="40" role="img" aria-label="No monthly data"><text x="50" y="24" text-anchor="middle" font-size="4" fill="#888">No monthly data</text></svg>`
  }
  const W = 720
  const H = 200
  const PAD_L = 40
  const PAD_R = 12
  const PAD_T = 12
  const PAD_B = 28
  const chartW = W - PAD_L - PAD_R
  const chartH = H - PAD_T - PAD_B
  const max = Math.max(1, ...months.flatMap((m) => [m.incomePaise, m.expensePaise]))
  const slot = chartW / months.length
  const barW = Math.min(18, slot * 0.35)
  const gap = 3
  const bars: string[] = []
  const labels: string[] = []
  months.forEach((m, i) => {
    const cx = PAD_L + slot * (i + 0.5)
    const hInc = (m.incomePaise / max) * chartH
    const hExp = (m.expensePaise / max) * chartH
    // Income bar (gold), expenses bar (neutral) side-by-side.
    bars.push(
      `<rect x="${(cx - barW - gap / 2).toFixed(1)}" y="${(PAD_T + chartH - hInc).toFixed(1)}" ` +
      `width="${barW}" height="${hInc.toFixed(1)}" fill="#B8860B" />`,
    )
    bars.push(
      `<rect x="${(cx + gap / 2).toFixed(1)}" y="${(PAD_T + chartH - hExp).toFixed(1)}" ` +
      `width="${barW}" height="${hExp.toFixed(1)}" fill="#525252" />`,
    )
    labels.push(
      `<text x="${cx.toFixed(1)}" y="${(H - 10).toFixed(1)}" text-anchor="middle" font-size="11" fill="#525252" font-family="system-ui, sans-serif">${esc(m.label)}</text>`,
    )
  })
  // Y-axis: three gridlines at 0, 50%, 100% of max.
  const grid: string[] = []
  for (const p of [0, 0.5, 1]) {
    const y = PAD_T + chartH - chartH * p
    grid.push(`<line x1="${PAD_L}" y1="${y.toFixed(1)}" x2="${(W - PAD_R).toFixed(1)}" y2="${y.toFixed(1)}" stroke="#e5e5e5" stroke-width="1" />`)
    grid.push(
      `<text x="${(PAD_L - 6).toFixed(1)}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="10" fill="#a3a3a3" font-family="system-ui, sans-serif">₹${inr(max * p).replace(/\.00$/, '')}</text>`,
    )
  }
  return (
    `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" ` +
    `aria-label="Revenue vs expenses by month" font-family="system-ui, sans-serif">` +
    grid.join('') + bars.join('') + labels.join('') +
    `</svg>`
  )
}

/**
 * Horizontal ageing bars, one row per bucket. Over-90 gets a 2px left
 * border and a danger fill per the spec's attention pattern.
 */
export function renderAgeingBarsHtml(buckets: ClientReportAgeingBucket[]): string {
  const overdueOnly = buckets.filter((b) => b.key !== 'not_due')
  const max = Math.max(1, ...overdueOnly.map((b) => Math.abs(b.amountPaise)))
  return overdueOnly.map((b) => {
    const pct = Math.round((Math.abs(b.amountPaise) / max) * 100)
    const isDanger = b.key === '90_plus' && b.amountPaise !== 0
    return `
      <div class="ageing-row${isDanger ? ' ageing-row--attention' : ''}">
        <div class="ageing-label">${esc(b.label)}</div>
        <div class="ageing-bar-track">
          <div class="ageing-bar-fill${isDanger ? ' ageing-bar-fill--danger' : ''}" style="width:${pct}%"></div>
        </div>
        <div class="ageing-amount">${inrRupees(b.amountPaise)}</div>
        <div class="ageing-count">${b.invoiceCount === 0 ? '—' : `${b.invoiceCount} bill${b.invoiceCount === 1 ? '' : 's'}`}</div>
      </div>`
  }).join('')
}

// ---------------------------------------------------------------------
// HTML template
// ---------------------------------------------------------------------

/**
 * The full standalone HTML file. Everything inlined. Includes a print
 * stylesheet so browser Save-as-PDF produces a sendable document.
 */
export function renderClientReportHtml(input: ClientReportInput): string {
  const { company, header, kpis, monthly, ageing, outstandingTop10, outstandingTotalPaise, outstandingBillCount } = input
  const marginText = (pct: number | null) => (pct === null ? '' : `${pct.toFixed(1)}% margin`)
  const trendSvg = renderMonthlyTrendSvg(monthly)
  const ageingRows = renderAgeingBarsHtml(ageing)

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(company.name)} — Statement · ${esc(header.periodLabel)}</title>
<style>
/* Sovereign palette — matches the workstation shell, deliberately quiet.
   One gold accent (#B8860B), 2px left border for attention, tabular
   numerals throughout, 13px body. No filled status pills. No JS.
   Everything targets phone-first: 375px width readable. */
:root {
  --ink-900: #171717;
  --ink-700: #404040;
  --ink-500: #737373;
  --ink-400: #a3a3a3;
  --line-200: #e5e5e5;
  --line-100: #f5f5f5;
  --gold: #B8860B;
  --danger: #b91c1c;
  --paper: #fff;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #f5f5f5; }
body {
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  font-size: 13px;
  line-height: 1.5;
  color: var(--ink-900);
  font-variant-numeric: tabular-nums;
}
.page {
  max-width: 720px;
  margin: 0 auto;
  padding: 20px 16px 40px;
  background: var(--paper);
}
h1, h2, h3 { margin: 0; font-weight: 600; }
h1 { font-size: 20px; }
h2 { font-size: 15px; letter-spacing: 0.02em; text-transform: uppercase; color: var(--ink-500); }
h3 { font-size: 14px; }

.header { padding-bottom: 12px; border-bottom: 1px solid var(--line-200); }
.header .company { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
.header .gstin { font-size: 11px; color: var(--ink-500); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.header .period {
  margin-top: 8px; font-size: 13px; color: var(--ink-700);
}
.header .prepared { margin-top: 4px; font-size: 11px; color: var(--ink-500); }

.section { padding: 20px 0; border-top: 1px solid var(--line-100); }
.section:first-of-type { border-top: none; }
.section > h2 { margin-bottom: 12px; }

.kpi-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20px 24px; }
@media (min-width: 560px) {
  .kpi-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}
.kpi-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--ink-500); }
/* Spec deviation for this file only: KPI numbers at 28-32px. */
.kpi-value { font-size: 30px; font-weight: 600; color: var(--ink-900); margin-top: 2px; line-height: 1.15; }
.kpi-sub { font-size: 12px; color: var(--ink-500); margin-top: 2px; }
.kpi-negative .kpi-value { color: var(--danger); }

.trend-chart { margin-top: 8px; }
.legend { display: flex; gap: 16px; font-size: 12px; color: var(--ink-500); margin-top: 8px; }
.legend .swatch { display: inline-block; width: 10px; height: 10px; margin-right: 6px; vertical-align: middle; }

/* Ageing */
.ageing-row {
  display: grid; grid-template-columns: 110px 1fr 120px 80px; gap: 12px;
  align-items: center; padding: 4px 0;
}
.ageing-row--attention { border-left: 2px solid var(--danger); padding-left: 8px; }
.ageing-label { font-size: 13px; color: var(--ink-700); }
.ageing-bar-track { background: var(--line-100); height: 10px; border-radius: 2px; overflow: hidden; }
.ageing-bar-fill { background: var(--ink-500); height: 100%; }
.ageing-bar-fill--danger { background: var(--danger); }
.ageing-amount { text-align: right; font-size: 13px; }
.ageing-count { text-align: right; font-size: 12px; color: var(--ink-500); }

/* Top-10 outstanding */
table { width: 100%; border-collapse: collapse; }
th, td { padding: 8px 6px; text-align: left; font-weight: normal; vertical-align: top; }
th { font-size: 11px; text-transform: uppercase; color: var(--ink-500); border-bottom: 1px solid var(--line-200); }
tr td { border-bottom: 1px solid var(--line-100); }
tr.attention td { background: transparent; border-left: 2px solid var(--danger); }
td.num { text-align: right; }
tr.total td { border-top: 1px solid var(--ink-900); border-bottom: none; font-weight: 600; padding-top: 10px; }

.footer {
  margin-top: 24px; padding-top: 16px; border-top: 1px solid var(--line-200);
  font-size: 11px; color: var(--ink-500); line-height: 1.6;
}
.footer strong { color: var(--ink-700); }

@media print {
  html, body { background: #fff; }
  .page { max-width: none; padding: 0; }
  .section { break-inside: avoid; }
}
</style>
</head>
<body>
<main class="page">

  <header class="header">
    <div class="company">
      <h1>${esc(company.name)}</h1>
      ${company.gstin ? `<span class="gstin">${esc(company.gstin)}</span>` : ''}
    </div>
    <div class="period">FY ${esc(header.fyLabel)} · ${esc(header.periodLabel)}</div>
    <div class="prepared">Prepared by ${esc(header.preparedBy)} · ${esc(header.preparedAt)}</div>
  </header>

  <section class="section">
    <h2>The numbers</h2>
    <div class="kpi-grid">
      <div>
        <div class="kpi-label">Revenue</div>
        <div class="kpi-value">${inrRupees(kpis.revenuePaise)}</div>
      </div>
      <div class="${kpis.grossProfitPaise < 0 ? 'kpi-negative' : ''}">
        <div class="kpi-label">Gross profit</div>
        <div class="kpi-value">${inrRupees(kpis.grossProfitPaise)}</div>
        ${kpis.grossMarginPct !== null ? `<div class="kpi-sub">${marginText(kpis.grossMarginPct)}</div>` : ''}
      </div>
      <div class="${kpis.netProfitPaise < 0 ? 'kpi-negative' : ''}">
        <div class="kpi-label">Net profit</div>
        <div class="kpi-value">${inrRupees(kpis.netProfitPaise)}</div>
        ${kpis.netMarginPct !== null ? `<div class="kpi-sub">${marginText(kpis.netMarginPct)}</div>` : ''}
      </div>
      <div>
        <div class="kpi-label">Receivable</div>
        <div class="kpi-value">${inrRupees(kpis.receivablePaise)}</div>
        <div class="kpi-sub">${kpis.receivableCount} customer${kpis.receivableCount === 1 ? '' : 's'}</div>
      </div>
      <div>
        <div class="kpi-label">Payable</div>
        <div class="kpi-value">${inrRupees(kpis.payablePaise)}</div>
        <div class="kpi-sub">${kpis.payableCount} supplier${kpis.payableCount === 1 ? '' : 's'}</div>
      </div>
      <div>
        <div class="kpi-label">Working capital</div>
        <div class="kpi-value">${inrRupees(kpis.workingCapitalPaise)}</div>
      </div>
    </div>
  </section>

  <section class="section">
    <h2>Revenue vs expenses</h2>
    <div class="trend-chart">${trendSvg}</div>
    <div class="legend">
      <span><span class="swatch" style="background:#B8860B"></span>Revenue</span>
      <span><span class="swatch" style="background:#525252"></span>Expenses</span>
    </div>
  </section>

  <section class="section">
    <h2>What is outstanding</h2>
    <div style="font-size:20px;font-weight:600;margin-bottom:12px;">${inrRupees(outstandingTotalPaise)} <span style="font-size:12px;color:var(--ink-500);font-weight:normal">across ${outstandingBillCount} bill${outstandingBillCount === 1 ? '' : 's'}</span></div>
    ${ageingRows}
  </section>

  ${outstandingTop10.length > 0 ? `
  <section class="section">
    <h2>Top ${outstandingTop10.length} bill${outstandingTop10.length === 1 ? '' : 's'} outstanding</h2>
    <table>
      <thead>
        <tr>
          <th>Bill ref</th>
          <th>Party</th>
          <th>Date</th>
          <th class="num">Amount</th>
          <th class="num">Age</th>
        </tr>
      </thead>
      <tbody>
        ${outstandingTop10.map((b) => `
          <tr class="${b.daysOverdue > 90 ? 'attention' : ''}">
            <td>${esc(b.billRef)}</td>
            <td>${esc(b.partyName)}</td>
            <td>${esc(b.date)}</td>
            <td class="num">${inrRupees(b.amountPaise)}</td>
            <td class="num">${b.daysOverdue > 0 ? `${b.daysOverdue} days` : '—'}</td>
          </tr>`).join('')}
        <tr class="total">
          <td colspan="3">Total shown</td>
          <td class="num">${inrRupees(outstandingTop10.reduce((s, x) => s + x.amountPaise, 0))}</td>
          <td></td>
        </tr>
      </tbody>
    </table>
  </section>
  ` : ''}

  <footer class="footer">
    <div>Figures in INR. Foreign invoices are converted at the exchange rate on each invoice.</div>
    <div><strong>Prepared for ${esc(company.name)}. Not for circulation.</strong></div>
    ${header.firmContact ? `<div>Questions: ${esc(header.firmContact)}</div>` : ''}
  </footer>

</main>
</body>
</html>`
}
