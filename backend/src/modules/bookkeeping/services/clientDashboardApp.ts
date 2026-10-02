/**
 * BOOKKEEPING · CLIENT DASHBOARD — the page (BOOKKEEPING-REBUILD §6).
 *
 * One self-contained HTML file in the FinAccounting layout the firm asked
 * for: a sidebar of client reports, a top bar with Monthly / Quarterly /
 * Yearly switching, a period picker, "vs Prior" comparison, Export (CSV),
 * PDF / Print and Share. It is BOTH the file sent to the client and the
 * view shown inside Audit OS (served to an iframe), so the two never
 * drift apart.
 *
 *   • Offline: CSS, data and script are all inline. No CDN, no web font,
 *     no network call — it works on a phone with no signal.
 *   • The data bundle is embedded as JSON with `<` escaped, so no value in
 *     the books can close the script tag; the script builds every view
 *     from it and escapes each string it writes.
 *   • Earlier versions were script-free; interactive period switching
 *     needs a script, so the file now carries one small inline script
 *     (clientDashboardClient.ts) and nothing else.
 */
import { clientDashboardApp } from './clientDashboardClient.js'
import type { ClientDashboardBundle } from './clientDashboardBundle.js'

export function esc(s: string | null | undefined): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** JSON safe to place inside a <script> element. */
export function scriptJson(value: unknown): string {
  const LS = String.fromCharCode(0x2028), PS = String.fromCharCode(0x2029)
  return JSON.stringify(value).replace(/</g, '\\u003c').split(LS).join('\\u2028').split(PS).join('\\u2029')
}

const NAV: [group: string, items: [view: string, label: string, icon: string][]][] = [
  ['Client reports', [
    ['dashboard', 'Overview Dashboard', '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>'],
    ['pl', 'Profit & Loss', '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>'],
    ['bs', 'Balance Sheet', '<path d="M12 4v16M5 20h14M7 8l-3 6h6zM17 8l-3 6h6zM7 8h10"/>'],
    ['sales', 'Sales by Item', '<circle cx="9" cy="20" r="1.5"/><circle cx="18" cy="20" r="1.5"/><path d="M2 3h3l2.5 12h11L21 7H6.5"/>'],
  ]],
  ['Ledgers', [
    ['ledger', 'Ledger Accounts', '<path d="M4 6h16M4 12h16M4 18h10"/>'],
    ['trial', 'Trial Balance', '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 7h8M8 12h2M14 12h2M8 16h2M14 16h2"/>'],
    ['bank', 'Bank Reconciliation', '<path d="M3 10l9-6 9 6M5 10v8M19 10v8M9 10v8M15 10v8M3 20h18"/>'],
  ]],
  ['Data', [
    ['debtors', 'Debtors Ledger', '<circle cx="9" cy="8" r="3.5"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M18 8v6M15.5 10.5 18 8l2.5 2.5"/>'],
    ['creditors', 'Creditors Ledger', '<circle cx="9" cy="8" r="3.5"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M16 11h6"/>'],
    ['journal', 'Journal Entries', '<path d="M14 3H6a2 2 0 00-2 2v14a2 2 0 002 2h12a2 2 0 002-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/>'],
    ['salesreg', 'Sales Register', '<path d="M4 4h16v16H4zM4 9h16M9 9v11"/>'],
    ['purchases', 'Purchase Register', '<path d="M1 7h13v10H1zM14 10h4l3 3v4h-7z"/><circle cx="5.5" cy="18.5" r="1.5"/><circle cx="17.5" cy="18.5" r="1.5"/>'],
  ]],
]

const icon = (d: string, size = 16) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`

const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
:root{--navy:#1a1a2e;--indigo:#4f46e5;--indigo-lt:#eef2ff;--green:#059669;--green-bg:#d1fae5;--amber:#d97706;--amber-bg:#fef3c7;--red:#dc2626;--red-bg:#fee2e2;--blue:#2563eb;--blue-bg:#dbeafe;--purple:#7c3aed;--purple-bg:#f3e8ff;--gray:#6b7280;--border:#e8eaf0}
html,body{height:100%}
body{font-family:'Segoe UI',system-ui,-apple-system,Roboto,sans-serif;background:#f0f2f5;color:var(--navy);font-size:13px;font-variant-numeric:tabular-nums}
.app{display:flex;height:100vh;overflow:hidden}
.sidebar{width:236px;background:var(--navy);flex-shrink:0;display:flex;flex-direction:column;overflow-y:auto}
.sidebar-logo{padding:18px 16px;border-bottom:1px solid rgba(255,255,255,.08)}
.logo-icon{width:38px;height:38px;border-radius:10px;background:linear-gradient(135deg,var(--indigo),var(--purple));display:flex;align-items:center;justify-content:center;margin-bottom:8px;color:#fff;font-weight:800;font-size:17px}
.firm-name{font-size:13px;font-weight:700;color:#fff;letter-spacing:.3px}
.firm-sub{font-size:11px;color:rgba(255,255,255,.45);margin-top:2px}
.active-client{padding:12px 10px 4px}
.ac-label{font-size:9px;color:rgba(255,255,255,.35);letter-spacing:1px;text-transform:uppercase;margin-bottom:5px}
.ac-box{background:rgba(255,255,255,.1);border-radius:8px;padding:8px 10px;display:flex;align-items:center;gap:8px;color:#fff}
.ac-avatar{width:24px;height:24px;border-radius:6px;background:linear-gradient(135deg,#4f46e5,#7c3aed);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;flex-shrink:0}
.ac-name{font-size:12px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ac-meta{font-size:10px;color:rgba(255,255,255,.45);margin-top:1px;font-family:ui-monospace,Menlo,monospace}
.nav-group{padding:14px 8px 4px 16px;font-size:10px;color:rgba(255,255,255,.3);letter-spacing:1px;text-transform:uppercase}
.nav-item{display:flex;align-items:center;gap:10px;padding:9px 12px;margin:1px 8px;border-radius:8px;cursor:pointer;font-size:13px;color:rgba(255,255,255,.62);transition:.15s;border:0;background:none;width:calc(100% - 16px);text-align:left;font-family:inherit}
.nav-item:hover{background:rgba(255,255,255,.07);color:#fff}
.nav-item.active{background:linear-gradient(135deg,var(--indigo),var(--purple));color:#fff}
.sidebar-foot{margin-top:auto;padding:12px 16px;border-top:1px solid rgba(255,255,255,.08);font-size:10px;color:rgba(255,255,255,.4);line-height:1.6}
.sidebar-foot strong{color:rgba(255,255,255,.75);font-weight:600}
.main{flex:1;overflow-y:auto;display:flex;flex-direction:column;min-width:0}
.topbar{background:#fff;border-bottom:1px solid var(--border);padding:10px 22px;display:flex;align-items:center;justify-content:space-between;flex-shrink:0;gap:12px;flex-wrap:wrap;position:sticky;top:0;z-index:5}
.topbar-left,.topbar-right{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.btn.menu-btn{display:none}
.page-title{font-size:15px;font-weight:700}
.period-switcher{display:flex;gap:3px;background:#f0f2f5;border-radius:8px;padding:3px}
.ps-btn{padding:5px 12px;border-radius:6px;border:none;cursor:pointer;font-size:12px;color:#666;background:transparent;font-weight:500;font-family:inherit}
.ps-btn.active{background:#fff;color:var(--indigo);box-shadow:0 1px 3px rgba(0,0,0,.1)}
.period-selector{display:flex;align-items:center;gap:6px;background:#f8f9fc;border:1px solid var(--border);border-radius:8px;padding:4px 10px}
.period-selector label{font-size:11px;color:#888}
.period-selector select{border:none;background:transparent;font-size:12px;color:var(--navy);outline:none;cursor:pointer;font-weight:500;font-family:inherit}
.compare-toggle{display:flex;align-items:center;gap:8px;font-size:12px;color:#666}
.toggle-sw{position:relative;width:32px;height:18px;cursor:pointer;display:inline-block}
.toggle-sw input{opacity:0;width:0;height:0}
.toggle-track{position:absolute;inset:0;background:#ddd;border-radius:9px;transition:.3s}
.toggle-sw input:checked+.toggle-track{background:var(--indigo)}
.toggle-sw input:disabled+.toggle-track{opacity:.45;cursor:not-allowed}
.toggle-thumb{position:absolute;width:14px;height:14px;background:#fff;border-radius:50%;top:2px;left:2px;transition:.3s;box-shadow:0 1px 3px rgba(0,0,0,.2);pointer-events:none}
.toggle-sw input:checked~.toggle-thumb{left:16px}
.btn{padding:7px 13px;border-radius:8px;border:none;cursor:pointer;font-size:12px;font-weight:500;display:inline-flex;align-items:center;gap:6px;white-space:nowrap;font-family:inherit}
.btn-sm{padding:6px 11px;font-size:12px}
.btn-outline{background:#fff;color:var(--indigo);border:1px solid var(--border)}.btn-outline:hover{background:var(--indigo-lt)}
.btn-green{background:var(--green-bg);color:var(--green);border:1px solid #a7f3d0}
.btn-pdf{background:#ef4444;color:#fff}.btn-pdf:hover{background:#dc2626}
.btn-wa{background:#25d366;color:#fff}.btn-wa:hover{background:#1da851}
.content{padding:18px 22px;flex:1}
.kpi-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;margin-bottom:14px}
.kpi-card{background:#fff;border-radius:12px;border:1px solid var(--border);padding:15px 16px;transition:.2s}
.kpi-card.clickable{cursor:pointer}.kpi-card.clickable:hover{border-color:var(--hover);box-shadow:0 6px 18px rgba(79,70,229,.08)}
.kpi-icon{width:36px;height:36px;border-radius:9px;display:flex;align-items:center;justify-content:center;margin-bottom:10px}
.kpi-label{font-size:11px;color:#888;text-transform:uppercase;letter-spacing:.5px;margin-bottom:3px}
.kpi-value{font-size:22px;font-weight:700;margin-bottom:3px}
.kpi-change{font-size:11px;display:flex;align-items:center;gap:3px;margin-top:2px}
.kpi-change.up{color:var(--green)}.kpi-change.down{color:var(--red)}
.charts-grid{display:grid;grid-template-columns:2fr 1fr;gap:16px;margin-bottom:16px}
.two-col{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.two-col.pad,.three-col.pad{padding:16px}
.three-col{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px}
.chart-card{background:#fff;border-radius:12px;border:1px solid var(--border);overflow:hidden;margin-bottom:16px}
.chart-header{padding:13px 16px;border-bottom:1px solid #f0f0f5;display:flex;align-items:center;justify-content:space-between;gap:8px}
.chart-title{font-size:13px;font-weight:600}
.chart-body{padding:16px}
.chart-body.center{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:250px}
.legend{display:flex;gap:16px;justify-content:center;font-size:11px;color:#666;margin-top:8px;flex-wrap:wrap}
.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px;vertical-align:-1px}
.report-area{background:#fff;border-radius:12px;border:1px solid var(--border);overflow:hidden;margin-bottom:16px}
.report-header{padding:14px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;gap:10px;background:var(--indigo-lt);flex-wrap:wrap}
.report-right{display:flex;gap:8px;flex-wrap:wrap}
.report-title{font-size:14px;font-weight:700}
.report-meta{font-size:11px;color:#888;margin-top:1px}
.report-area>table,.breakup table,.chart-card table{display:table}
.report-area{overflow-x:auto}
.report-table{width:100%;border-collapse:collapse;font-size:13px}
.report-table th{background:#f8f9fc;padding:9px 16px;text-align:left;font-size:11px;color:#888;font-weight:600;letter-spacing:.5px;text-transform:uppercase;border-bottom:1px solid var(--border);white-space:nowrap}
.report-table td{padding:9px 16px;border-bottom:1px solid #f5f5f8;vertical-align:middle}
.report-table tr:hover td{background:#fafbff}
.section-hdr td{background:var(--navy)!important;color:#fff!important;font-weight:700;font-size:12px;letter-spacing:.5px;text-transform:uppercase;padding:8px 16px!important}
.sub-hdr td{background:var(--indigo-lt)!important;color:var(--indigo)!important;font-weight:600;font-size:12px;padding:7px 16px!important}
.total-row td{background:#f0f2f5!important;font-weight:700;border-top:2px solid var(--indigo)!important}
.grand-total td{background:var(--navy)!important;color:#fff!important;font-weight:700;font-size:14px}
.note-row td{background:#f8f9fc!important;font-size:11px;color:#888;padding:4px 16px!important}
.indent-1 td:first-child{padding-left:30px!important}
.indent-2 td{font-size:12px;color:#444;padding-top:5px;padding-bottom:5px}
.amount{text-align:right!important;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;white-space:nowrap}
.amount.neg,.neg{color:var(--red)}.amount.pos{color:var(--green)}
.vs-col{color:#888}
.change-col{font-size:11px;text-align:right}
.change-up{color:var(--green)}.change-dn{color:var(--red)}
tr.attention td:first-child{box-shadow:inset 2px 0 0 var(--red)}
.clickrow{cursor:pointer}
.badge{display:inline-flex;align-items:center;gap:3px;padding:3px 9px;border-radius:20px;font-size:11px;font-weight:500;white-space:nowrap}
.badge-green{background:var(--green-bg);color:var(--green)}.badge-amber{background:var(--amber-bg);color:var(--amber)}
.badge-red{background:var(--red-bg);color:var(--red)}.badge-blue{background:var(--blue-bg);color:var(--blue)}.badge-gray{background:#f3f4f6;color:var(--gray)}
.tag{display:inline-block;padding:2px 7px;border-radius:4px;font-size:11px;background:#f0f2f5;color:#666}
.mono{font-family:ui-monospace,Menlo,monospace}.small{font-size:11px}.muted{color:#888}
.hbar{margin-bottom:12px}.hbar-head{display:flex;justify-content:space-between;gap:10px;font-size:12px;margin-bottom:4px}
.hbar-track{height:6px;background:#e8eaf0;border-radius:3px;overflow:hidden}.hbar-fill{height:100%;border-radius:3px}
.share{display:flex;align-items:center;gap:6px}.share-track{flex:1;height:5px;background:#e8eaf0;border-radius:3px;min-width:50px}.share-track div{height:100%;background:var(--indigo);border-radius:3px}.share span{font-size:11px;color:#888}
.side-grid{display:grid;grid-template-columns:1fr 3fr;gap:16px;align-items:start}
.kv{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #f5f5f8;font-size:13px}.kv span{color:#666}
.age{margin-bottom:11px}.age-head{display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px}.age-count{font-size:10px;color:#aaa;margin-top:2px}.age-attn{box-shadow:inset 2px 0 0 var(--red);padding-left:8px}
.breakup{padding:14px 16px;border-top:1px solid var(--border);background:var(--indigo-lt)}.breakup-red{background:#fff8f8}.breakup strong{font-size:12px;color:var(--indigo);display:block;margin-bottom:8px}.breakup-red strong{color:var(--red)}
.stat{background:#f8f9fc;border:1px solid var(--border);border-radius:10px;padding:12px 14px}.stat-l{font-size:11px;color:#888;margin-bottom:4px}.stat-v{font-size:16px;font-weight:700;font-family:ui-monospace,Menlo,monospace}
.toolbar{display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap}
.search,.select{padding:8px 12px;border:1px solid var(--border);border-radius:8px;font-size:13px;background:#fff;font-family:inherit;color:var(--navy);min-width:240px}
.empty{padding:28px 16px;color:#888;font-size:13px;text-align:center}.empty.error{color:var(--red)}
.toast{position:fixed;bottom:24px;right:24px;background:var(--navy);color:#fff;padding:12px 18px;border-radius:10px;font-size:13px;z-index:99;display:none;box-shadow:0 8px 24px rgba(0,0,0,.2)}
.page-footer{padding:12px 22px 20px;font-size:11px;color:#999;line-height:1.7;border-top:1px solid var(--border);background:#f0f2f5}
.page-footer strong{color:#666}
.print-head{display:none}
noscript div{padding:40px;text-align:center;font-size:14px}
@media (max-width:980px){
  .sidebar{position:fixed;left:0;top:0;bottom:0;z-index:20;transform:translateX(-100%);transition:transform .2s}
  .sidebar.open{transform:none;box-shadow:0 0 0 100vmax rgba(0,0,0,.35)}
  .btn.menu-btn{display:inline-flex}
  .kpi-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
  .charts-grid,.two-col,.three-col,.side-grid{grid-template-columns:1fr}
  .content{padding:14px}
  .search,.select{min-width:0;flex:1}
}
@media (max-width:560px){.kpi-grid{grid-template-columns:1fr}.topbar{padding:10px 14px}}
@media print{
  @page{size:A4;margin:12mm}
  .sidebar,.topbar,.toast,.toolbar,.no-print{display:none!important}
  .app{display:block;height:auto;overflow:visible}.main{overflow:visible}
  body{background:#fff}.content{padding:0}
  .print-head{display:block;border-bottom:2px solid var(--navy);padding-bottom:8px;margin-bottom:14px}
  .print-head h1{font-size:18px}.print-head div{font-size:11px;color:#555}
  .chart-card,.kpi-card,.report-area,.side-grid>div{break-inside:avoid}
  .report-area{overflow:visible}
  *{-webkit-print-color-adjust:exact;print-color-adjust:exact}
}`

export function renderClientDashboardHtml(b: ClientDashboardBundle): string {
  const c = b.company
  const initial = (c.name.trim().charAt(0) || 'C').toUpperCase()
  const firmInitial = (b.firm.preparedBy.trim().charAt(0) || 'F').toUpperCase()
  const meta = [c.gstin ? `GSTIN ${c.gstin}` : null, c.pan && !c.gstin ? `PAN ${c.pan}` : null].filter(Boolean).join(' · ')
  const nav = NAV.map(([group, items]) =>
    `<div class="nav-group">${esc(group)}</div>` +
    items.map(([view, label, d]) => `<button type="button" class="nav-item" data-view="${view}">${icon(d)} ${esc(label)}</button>`).join(''),
  ).join('')

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(c.name)} — Financial Dashboard · FY ${esc(b.fy.label)}</title>
<style>${CSS}</style>
</head>
<body>
<noscript><div>This dashboard needs JavaScript. Open the file in Chrome, Safari or Edge.</div></noscript>
<div class="app">
  <aside class="sidebar">
    <div class="sidebar-logo">
      <div class="logo-icon">${esc(firmInitial)}</div>
      <div class="firm-name">${esc(b.firm.preparedBy || 'Financial Dashboard')}</div>
      <div class="firm-sub">Client Financial Dashboard</div>
    </div>
    <div class="active-client">
      <div class="ac-label">Active client</div>
      <div class="ac-box">
        <div class="ac-avatar">${esc(initial)}</div>
        <div style="min-width:0"><div class="ac-name" title="${esc(c.name)}">${esc(c.name)}</div>${meta ? `<div class="ac-meta">${esc(meta)}</div>` : ''}</div>
      </div>
    </div>
    <nav>${nav}</nav>
    <div class="sidebar-foot">
      <strong>FY ${esc(b.fy.label)}</strong> · ${esc(b.fy.start)} to ${esc(b.fy.end)}<br>
      Prepared ${esc(b.firm.preparedAt)}${b.firm.reportRef ? ` · Ref ${esc(b.firm.reportRef)}` : ''}
    </div>
  </aside>
  <div class="main">
    <header class="topbar">
      <div class="topbar-left">
        <button type="button" class="btn btn-outline btn-sm menu-btn" data-action="menu" aria-label="Open menu">☰</button>
        <div class="page-title" id="page-title">Overview Dashboard</div>
        <div class="period-switcher" role="group" aria-label="Period type">
          <button type="button" class="ps-btn" data-mode="monthly">Monthly</button>
          <button type="button" class="ps-btn" data-mode="quarterly">Quarterly</button>
          <button type="button" class="ps-btn" data-mode="yearly">Yearly</button>
        </div>
      </div>
      <div class="topbar-right">
        <div class="period-selector"><label for="period-select">Period:</label><select id="period-select"></select></div>
        <div class="compare-toggle" id="compare-wrap"><span>vs Prior</span><label class="toggle-sw"><input type="checkbox" id="compare-toggle" aria-label="Compare with the prior period"><span class="toggle-track"></span><span class="toggle-thumb"></span></label></div>
        <button type="button" class="btn btn-outline btn-sm" data-action="export">${icon('<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>', 14)} Export</button>
        <button type="button" class="btn btn-sm btn-pdf" data-action="pdf" title="Opens the print dialog — choose “Save as PDF”">${icon('<path d="M14 3H6a2 2 0 00-2 2v14a2 2 0 002 2h12a2 2 0 002-2V9z"/><path d="M14 3v6h6"/>', 14)} PDF</button>
        <button type="button" class="btn btn-outline btn-sm" data-action="print">${icon('<path d="M6 9V3h12v6M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2"/><rect x="6" y="14" width="12" height="7"/>', 14)} Print</button>
        <button type="button" class="btn btn-sm btn-wa" data-action="share">${icon('<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4"/>', 14)} Share</button>
      </div>
    </header>
    <main class="content">
      <div class="print-head"><h1>${esc(c.name)}</h1><div>${meta ? `${esc(meta)} · ` : ''}FY ${esc(b.fy.label)} · <span id="print-period"></span> · Prepared by ${esc(b.firm.preparedBy)} on ${esc(b.firm.preparedAt)}</div></div>
      <div id="main-content"></div>
    </main>
    <footer class="page-footer">
      Figures in INR, drawn from the books of account as recorded. Unaudited management information.
      <strong>Prepared for ${esc(c.name)}. Not for circulation.</strong>${b.firm.contact ? ` Questions: ${esc(b.firm.contact)}` : ''}
    </footer>
  </div>
</div>
<script type="application/json" id="dashboard-data">${scriptJson(b)}</script>
<script>
var __name = function (f) { return f };
(${clientDashboardApp.toString()})(window, document, JSON.parse(document.getElementById('dashboard-data').textContent));
</script>
</body>
</html>`
}
