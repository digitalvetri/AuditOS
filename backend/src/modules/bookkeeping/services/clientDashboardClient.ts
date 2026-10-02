/**
 * BOOKKEEPING · CLIENT DASHBOARD — the script that runs INSIDE the page.
 *
 * This function is never called on the server. clientDashboardApp.ts
 * embeds its source text (`clientDashboardApp.toString()`) in the HTML and
 * invokes it in the browser with the data bundle. So it must stay fully
 * self-contained: no imports, no references to anything outside its own
 * body, and every DOM object reached through the `win` / `doc` parameters
 * (the server build has no DOM types, hence `any`).
 *
 * It computes every report from the bundle for the chosen period — month,
 * quarter or full year, optionally against the prior period — and renders
 * the FinAccounting-style views: Overview, Profit & Loss, Balance Sheet,
 * Sales by Item, Ledger Accounts, Trial Balance, Bank Reconciliation,
 * Debtors, Creditors, Journal Entries and the Sales / Purchase registers.
 * Every string that reaches innerHTML goes through esc().
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export function clientDashboardApp(win: any, doc: any, B: any): void {
  // ── formatting ───────────────────────────────────────────────────────────
  const esc = (s: any) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
  const num = (paise: number, d = 2) => (Math.abs(paise) / 100).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d })
  const amt = (paise: number, d = 2) => (paise === 0 ? '—' : paise < 0 ? `(${num(paise, d)})` : num(paise, d))
  const rs = (paise: number) => `${paise < 0 ? '−' : ''}₹${num(paise, 0)}`
  const pct = (v: number | null) => (v === null || !isFinite(v) ? '—' : `${v.toFixed(1)}%`)
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const monthName = (ym: string, long = false) => {
    const [y, m] = ym.split('-').map(Number)
    return long ? new Date(y, m - 1, 1).toLocaleString('en-IN', { month: 'long', year: 'numeric' }) : `${MONTHS[m - 1]} ${String(y).slice(2)}`
  }
  const fmtDate = (iso: string | null) => {
    if (!iso) return '—'
    const [y, m, d] = iso.split('-').map(Number)
    return `${String(d).padStart(2, '0')} ${MONTHS[m - 1]} ${String(y).slice(2)}`
  }
  const daysBetween = (a: string, b: string) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000)
  const lastDay = (ym: string) => { const [y, m] = ym.split('-').map(Number); return `${ym}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}` }

  // ── model ────────────────────────────────────────────────────────────────
  const L: any[] = B.ledgers
  const M: string[] = B.months
  const DIRECT_INC = ['Sales Accounts', 'Direct Incomes']
  const DIRECT_EXP = ['Purchase Accounts', 'Direct Expenses']
  const CUR_ASSETS = ['Current Assets', 'Sundry Debtors', 'Bank Accounts', 'Cash-in-Hand']
  const CUR_LIAB = ['Current Liabilities', 'Sundry Creditors', 'Duties & Taxes']

  type Period = { key: string; label: string; start: number; end: number } // month indexes, inclusive
  const quarters: Period[] = []
  for (let q = 0; q * 3 < M.length; q++) {
    const s = q * 3, e = Math.min(M.length - 1, s + 2)
    quarters.push({ key: `Q${q + 1}`, label: `Q${q + 1} (${MONTHS[Number(M[s].slice(5)) - 1]}–${MONTHS[Number(M[e].slice(5)) - 1]} ${M[e].slice(0, 4)})`, start: s, end: e })
  }
  const monthly: Period[] = M.map((m, i) => ({ key: m, label: monthName(m, true), start: i, end: i }))
  const yearly: Period[] = [{ key: 'FY', label: `Full year FY ${B.fy.label}`, start: 0, end: M.length - 1 }]

  const state: any = { view: 'dashboard', mode: 'yearly', period: yearly[0], compare: false, ledger: null, search: '', vtype: '' }
  // Open on the period the operator was looking at.
  ;(() => {
    const s = M.indexOf(B.initial.from.slice(0, 7)), e = M.indexOf(B.initial.to.slice(0, 7))
    if (s < 0 || e < 0) return
    if (s === e) { state.mode = 'monthly'; state.period = monthly[s]; return }
    const q = quarters.find((x) => x.start === s && x.end === e)
    if (q) { state.mode = 'quarterly'; state.period = q }
  })()

  const periodsFor = (mode: string) => (mode === 'monthly' ? monthly : mode === 'quarterly' ? quarters : yearly)
  const priorOf = (p: Period): Period | null => {
    const list = periodsFor(state.mode)
    const i = list.findIndex((x) => x.key === p.key)
    return i > 0 ? list[i - 1] : null
  }
  const endDate = (p: Period) => lastDay(M[p.end])
  const startDate = (p: Period) => `${M[p.start]}-01`

  /** Debit-positive movement of a ledger over a period. */
  const move = (l: any, p: Period) => { let dr = 0, cr = 0; for (let i = p.start; i <= p.end; i++) { dr += l.dr[i]; cr += l.cr[i] } return { dr, cr } }
  /** Balance at the start of a period (FY opening + earlier months). */
  const openAt = (l: any, p: Period) => { let b = l.ob; for (let i = 0; i < p.start; i++) b += l.dr[i] - l.cr[i]; return b }
  const closeAt = (l: any, p: Period) => { const mv = move(l, p); return openAt(l, p) + mv.dr - mv.cr }

  function pl(p: Period) {
    const rows = L.filter((l) => l.pl).map((l) => { const mv = move(l, p); return { l, inc: mv.cr - mv.dr, exp: mv.dr - mv.cr } })
    const pick = (f: (r: any) => boolean, key: 'inc' | 'exp') => rows.filter(f).map((r) => ({ name: r.l.n, group: r.l.g, amt: r[key] })).filter((x) => x.amt !== 0)
    const directInc = pick((r) => r.l.nat === 'income' && DIRECT_INC.includes(r.l.p), 'inc')
    const otherInc = pick((r) => r.l.nat === 'income' && !DIRECT_INC.includes(r.l.p), 'inc')
    const cogs = pick((r) => r.l.nat === 'expenses' && DIRECT_EXP.includes(r.l.p), 'exp')
    const opex = pick((r) => r.l.nat === 'expenses' && !DIRECT_EXP.includes(r.l.p), 'exp')
    const sum = (xs: any[]) => xs.reduce((s, x) => s + x.amt, 0)
    const revenue = sum(directInc), other = sum(otherInc), cogsT = sum(cogs), opexT = sum(opex)
    const gross = revenue - cogsT
    const net = gross + other - opexT
    return {
      directInc, otherInc, cogs, opex, revenue, other, totalIncome: revenue + other, cogsT, opexT, gross, net,
      grossPct: revenue ? (gross / revenue) * 100 : null, netPct: revenue + other ? (net / (revenue + other)) * 100 : null,
    }
  }

  /** Open bills of one side as at a date. */
  function outstanding(side: 'receivable' | 'payable', asOf: string) {
    const grp = side === 'receivable' ? 'Sundry Debtors' : 'Sundry Creditors'
    const sign = side === 'receivable' ? 1 : -1
    const bills = (B.bills as any[]).filter((b) => L[b.l].p === grp && b.d <= asOf).map((b) => {
      const settled = b.set.filter((s: any) => s[0] <= asOf).reduce((t: number, s: any) => t + s[1], 0)
      const age = daysBetween(b.due || b.d, asOf)
      return { party: L[b.l].n, li: b.l, ref: b.ref, d: b.d, due: b.due, amt: Math.abs(b.amt), settled: Math.abs(settled), pending: Math.abs(b.amt) - Math.abs(settled), age }
    }).filter((b) => b.pending > 0)
    const byParty = new Map<string, any>()
    for (const l of L.filter((x) => x.p === grp)) {
      const li = L.indexOf(l)
      let bal = l.ob
      for (let i = 0; i < M.length && M[i] <= asOf.slice(0, 7); i++) bal += l.dr[i] - l.cr[i]
      const out = sign * bal
      if (out <= 0) continue
      byParty.set(l.n, { name: l.n, li, outstanding: out, bills: [], billed: 0, settled: 0, last: null, oldest: null })
    }
    for (const b of bills) {
      const p = byParty.get(b.party)
      if (!p) continue
      p.bills.push(b); p.billed += b.amt; p.settled += b.settled
      p.last = !p.last || b.d > p.last ? b.d : p.last
      p.oldest = p.oldest === null || b.age > p.oldest ? b.age : p.oldest
    }
    const parties = [...byParty.values()].sort((a, b) => b.outstanding - a.outstanding)
    const total = parties.reduce((s, p) => s + p.outstanding, 0)
    const buckets = [
      { label: '< 30 days', color: '#10b981', min: -99999, max: 30, amount: 0, count: 0 },
      { label: '31–60 days', color: '#3b82f6', min: 31, max: 60, amount: 0, count: 0 },
      { label: '61–90 days', color: '#f59e0b', min: 61, max: 90, amount: 0, count: 0 },
      { label: '> 90 days', color: '#dc2626', min: 91, max: 99999, amount: 0, count: 0 },
    ]
    for (const b of bills) { const k = buckets.find((x) => b.age >= x.min && b.age <= x.max); if (k && byParty.has(b.party)) { k.amount += b.pending; k.count++ } }
    return { parties, total, bills: bills.filter((b) => byParty.has(b.party)).sort((a, b) => b.age - a.age), buckets }
  }

  function workingCapital(p: Period) {
    let ca = 0, cl = 0
    for (const l of L) {
      if (CUR_ASSETS.includes(l.p)) ca += closeAt(l, p)
      else if (CUR_LIAB.includes(l.p)) cl -= closeAt(l, p)
    }
    return { ca, cl, wc: ca - cl }
  }

  const inPeriod = (d: string, p: Period) => d >= startDate(p) && d <= endDate(p)

  // ── small renderers ──────────────────────────────────────────────────────
  const badge = (tone: string, text: string) => `<span class="badge badge-${tone}">${esc(text)}</span>`
  const ageBadge = (days: number | null) => days === null ? badge('gray', 'On account') : days > 90 ? badge('red', '90+ days') : days > 60 ? badge('amber', '61–90 days') : days > 30 ? badge('blue', '31–60 days') : badge('green', '< 30 days')
  const change = (cur: number, prior: number | null | undefined) => {
    if (prior === null || prior === undefined) return ''
    if (prior === 0) return '<td class="change-col muted">—</td>'
    const c = ((cur - prior) / Math.abs(prior)) * 100
    return `<td class="change-col"><span class="${c >= 0 ? 'change-up' : 'change-dn'}">${c >= 0 ? '▲' : '▼'} ${Math.abs(c).toFixed(1)}%</span></td>`
  }
  const kpiDelta = (cur: number, prior: number | null | undefined) => {
    if (prior === null || prior === undefined || prior === 0) return ''
    const c = ((cur - prior) / Math.abs(prior)) * 100
    return `<div class="kpi-change ${c >= 0 ? 'up' : 'down'}">${c >= 0 ? '▲' : '▼'} ${Math.abs(c).toFixed(1)}% vs prior</div>`
  }
  const empty = (text: string) => `<div class="empty">${esc(text)}</div>`
  const reportArea = (title: string, meta: string, right: string, body: string) =>
    `<div class="report-area"><div class="report-header"><div><div class="report-title">${esc(title)}</div><div class="report-meta">${meta}</div></div><div class="report-right">${right}</div></div>${body}</div>`
  const card = (title: string, right: string, body: string, cls = '') =>
    `<div class="chart-card ${cls}"><div class="chart-header"><div class="chart-title">${esc(title)}</div>${right}</div>${body}</div>`

  function trendSvg() {
    const data = M.map((m, i) => {
      let inc = 0, exp = 0
      for (const l of L) {
        if (!l.pl) continue
        if (l.nat === 'income') inc += l.cr[i] - l.dr[i]
        else exp += l.dr[i] - l.cr[i]
      }
      return { label: MONTHS[Number(m.slice(5)) - 1], inc, exp, profit: inc - exp, sel: i >= state.period.start && i <= state.period.end }
    })
    if (!data.some((d) => d.inc || d.exp)) return empty('No income or expenses recorded in this financial year yet.')
    // Months after the last one with any entry are still to come: bars stay empty and the profit line stops.
    let last = data.length - 1
    while (last > 0 && !data[last].inc && !data[last].exp) last--
    const highlight = state.mode !== 'yearly'
    const W = 720, H = 240, PL = 66, PR = 12, PT = 12, PB = 28
    const cw = W - PL - PR, ch = H - PT - PB
    const nice = (v: number) => { if (v <= 0) return 0; const p = Math.pow(10, Math.floor(Math.log10(v))); const f = v / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p }
    const max = nice(Math.max(100, ...data.flatMap((d) => [d.inc, d.exp, d.profit])))
    const min = -nice(-Math.min(0, ...data.map((d) => d.profit)))
    const y = (v: number) => PT + ch - ((v - min) / (max - min)) * ch
    const slot = cw / data.length, bw = Math.min(18, slot * 0.3)
    let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="Revenue vs expenses by month">`
    for (const f of [0, 0.25, 0.5, 0.75, 1]) {
      const v = min + (max - min) * f, yy = y(v)
      s += `<line x1="${PL}" y1="${yy}" x2="${W - PR}" y2="${yy}" stroke="#eef0f5"/><text x="${PL - 6}" y="${yy + 4}" text-anchor="end" font-size="10" fill="#9ca3af">₹${Math.round(v / 100).toLocaleString('en-IN')}</text>`
    }
    const pts: string[] = []
    data.forEach((d, i) => {
      const cx = PL + slot * (i + 0.5), y0 = y(0)
      if (d.sel && highlight) s += `<rect x="${cx - slot / 2 + 2}" y="${PT}" width="${slot - 4}" height="${ch}" fill="#eef2ff" rx="4"/>`
      s += `<rect x="${cx - bw - 1.5}" y="${y(d.inc)}" width="${bw}" height="${Math.max(0, y0 - y(d.inc))}" rx="3" fill="#4f46e5" fill-opacity=".85"><title>${d.label} revenue ₹${num(d.inc, 0)}</title></rect>`
      s += `<rect x="${cx + 1.5}" y="${y(d.exp)}" width="${bw}" height="${Math.max(0, y0 - y(d.exp))}" rx="3" fill="#dc2626" fill-opacity=".6"><title>${d.label} expenses ₹${num(d.exp, 0)}</title></rect>`
      s += `<text x="${cx}" y="${H - 8}" text-anchor="middle" font-size="11" fill="${d.sel && highlight ? '#4f46e5' : '#6b7280'}" font-weight="${d.sel && highlight ? 700 : 400}">${d.label}</text>`
      if (i <= last) pts.push(`${cx},${y(d.profit)}`)
    })
    s += `<polyline points="${pts.join(' ')}" fill="none" stroke="#10b981" stroke-width="2.5" stroke-linejoin="round"/>`
    s += pts.map((p, i) => { const [cx, cy] = p.split(','); return `<circle cx="${cx}" cy="${cy}" r="3.5" fill="#10b981" stroke="#fff" stroke-width="1.5"><title>${data[i].label} profit ₹${num(data[i].profit, 0)}</title></circle>` }).join('')
    return s + '</svg><div class="legend"><span><i style="background:#4f46e5"></i>Revenue</span><span><i style="background:#dc2626"></i>Expenses</span><span><i style="background:#10b981"></i>Profit</span></div>'
  }

  function doughnutSvg(a: number, b: number, center: string, centerColor: string, la: string, lb: string) {
    const total = Math.max(0, a) + Math.max(0, b)
    const R = 62, C = 2 * Math.PI * R
    let s = '<svg viewBox="0 0 180 180" width="190" height="190" role="img" aria-label="Profit and loss breakdown">'
    if (!total) s += `<circle cx="90" cy="90" r="${R}" fill="none" stroke="#e8eaf0" stroke-width="24"/>`
    else {
      const seg = (v: number, off: number, col: string) => `<circle cx="90" cy="90" r="${R}" fill="none" stroke="${col}" stroke-width="24" stroke-dasharray="${(v / total) * C} ${C}" stroke-dashoffset="${(-off / total) * C}" transform="rotate(-90 90 90)"/>`
      s += seg(Math.max(0, a), 0, '#10b981') + seg(Math.max(0, b), Math.max(0, a), '#dc2626')
    }
    s += `<text x="90" y="84" text-anchor="middle" font-size="10" fill="#6b7280">${esc(center)}</text><text x="90" y="103" text-anchor="middle" font-size="15" font-weight="700" fill="${centerColor}">${esc(la)}</text></svg>`
    return s + `<div class="legend"><span><i style="background:#10b981"></i>Net profit</span><span><i style="background:#dc2626"></i>${esc(lb)}</span></div>`
  }

  // ── views ────────────────────────────────────────────────────────────────
  function viewDashboard() {
    const p = state.period, prior = state.compare ? priorOf(p) : null
    const cur = pl(p), pr = prior ? pl(prior) : null
    const deb = outstanding('receivable', endDate(p)), cred = outstanding('payable', endDate(p))
    const wc = workingCapital(p)
    const netUp = cur.net >= 0
    const kpi = (icon: string, bg: string, fg: string, label: string, value: string, sub: string, click = '') =>
      `<div class="kpi-card${click ? ' clickable' : ''}"${click ? ` data-go="${click}" style="--hover:${fg}"` : ''}><div class="kpi-icon" style="background:${bg};color:${fg}">${icon}</div><div class="kpi-label">${label}</div><div class="kpi-value" style="color:${fg}">${value}</div>${sub}</div>`
    const I = (d: string) => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`
    const expItems = cur.opex.slice().sort((a: any, b: any) => b.amt - a.amt).slice(0, 6)
    const maxE = expItems[0]?.amt || 1
    const colors = ['#4f46e5', '#dc2626', '#d97706', '#059669', '#7c3aed', '#2563eb']
    const top = topItems(p, 5)
    return `
    <div class="kpi-grid">
      ${kpi(I('<polyline points="3 17 9 11 13 15 21 7"/><polyline points="14 7 21 7 21 14"/>'), '#eef2ff', '#4f46e5', 'Revenue (period)', rs(cur.revenue), kpiDelta(cur.revenue, pr?.revenue) || '<div class="kpi-change muted">Sales and direct income</div>')}
      ${kpi(I('<circle cx="12" cy="12" r="8"/><path d="M12 7v10M9.5 9.5h4a1.5 1.5 0 010 3h-3a1.5 1.5 0 000 3h4"/>'), cur.gross >= 0 ? '#d1fae5' : '#fee2e2', cur.gross >= 0 ? '#059669' : '#dc2626', 'Gross profit', rs(cur.gross), `<div class="kpi-change ${cur.grossPct !== null && cur.grossPct >= 30 ? 'up' : 'down'}">${pct(cur.grossPct)} margin</div>${kpiDelta(cur.gross, pr?.gross)}`)}
      ${kpi(I(netUp ? '<polyline points="3 17 9 11 13 15 21 7"/>' : '<polyline points="3 7 9 13 13 9 21 17"/>'), netUp ? '#d1fae5' : '#fee2e2', netUp ? '#059669' : '#dc2626', netUp ? 'Net profit' : 'Net loss', rs(Math.abs(cur.net)), `<div class="kpi-change ${netUp ? 'up' : 'down'}">${pct(cur.netPct)} margin</div>${kpiDelta(cur.net, pr?.net)}`)}
    </div>
    <div class="kpi-grid">
      ${kpi(I('<circle cx="9" cy="8" r="3.5"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M18 8v6M15.5 10.5 18 8l2.5 2.5"/>'), '#fef3c7', '#d97706', 'Total debtors (receivable)', rs(deb.total), `<div class="kpi-change" style="color:#d97706">${deb.parties.length} outstanding customer${deb.parties.length === 1 ? '' : 's'} → View</div>`, 'debtors')}
      ${kpi(I('<circle cx="9" cy="8" r="3.5"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M16 11h6"/>'), '#fee2e2', '#dc2626', 'Total creditors (payable)', rs(cred.total), `<div class="kpi-change" style="color:#dc2626">${cred.parties.length} outstanding supplier${cred.parties.length === 1 ? '' : 's'} → View</div>`, 'creditors')}
      ${kpi(I('<path d="M12 4v16M5 20h14M7 8l-3 6h6zM17 8l-3 6h6zM7 8h10"/>'), '#f3e8ff', '#7c3aed', 'Net working capital', rs(wc.wc), `<div class="kpi-change ${wc.wc >= 0 ? 'up' : 'down'}">Current assets ${rs(wc.ca)} less current liabilities ${rs(wc.cl)}</div>`)}
    </div>
    <div class="charts-grid">
      ${card('Revenue vs Expenses — Monthly Trend', badge('blue', `FY ${B.fy.label}`), `<div class="chart-body">${trendSvg()}</div>`)}
      ${card('P&L Breakdown', badge('green', 'Current period'), `<div class="chart-body center">${doughnutSvg(cur.net, Math.max(0, cur.gross - cur.net), `Net ${netUp ? 'profit' : 'loss'}`, netUp ? '#059669' : '#dc2626', rs(Math.abs(cur.net)), 'Operating expenses')}</div>`)}
    </div>
    <div class="two-col">
      ${card('Expense Breakdown', '', `<div class="chart-body">${expItems.length ? expItems.map((e: any, i: number) => `<div class="hbar"><div class="hbar-head"><span>${esc(e.name)}</span><span class="mono">₹${num(e.amt, 0)}</span></div><div class="hbar-track"><div class="hbar-fill" style="width:${Math.max(2, Math.round((e.amt / maxE) * 100))}%;background:${colors[i]}"></div></div></div>`).join('') : empty('No operating expenses in this period.')}</div>`)}
      ${card(`Top Sales by Item (${p.label})`, '', top.length ? `<table class="report-table"><thead><tr><th>Item</th><th class="amount">Qty</th><th class="amount">Revenue</th><th>Share</th></tr></thead><tbody>${top.map((t) => `<tr><td>${esc(t.item)}</td><td class="amount">${t.qty.toLocaleString('en-IN')}${t.unit ? ' ' + esc(t.unit) : ''}</td><td class="amount">₹${num(t.amt, 0)}</td><td><div class="share"><div class="share-track"><div style="width:${t.share}%"></div></div><span>${t.share.toFixed(0)}%</span></div></td></tr>`).join('')}</tbody></table>` : empty('No item-wise sales in this period.'))}
    </div>`
  }

  function topItems(p: Period, n = 1e9) {
    const map = new Map<string, any>()
    for (const it of B.items as any[]) {
      if (it.t !== 'sales' || !inPeriod(it.d, p)) continue
      const x = map.get(it.item) ?? { item: it.item, unit: it.unit, qty: 0, amt: 0, lines: 0 }
      x.qty += it.qty; x.amt += it.amt; x.lines++
      map.set(it.item, x)
    }
    const arr = [...map.values()].sort((a, b) => b.amt - a.amt)
    const total = arr.reduce((s, x) => s + x.amt, 0)
    arr.forEach((x) => { x.share = total ? (x.amt / total) * 100 : 0 })
    return arr.slice(0, n)
  }

  function viewPL() {
    const p = state.period, prior = state.compare ? priorOf(p) : null
    const c = pl(p), r = prior ? pl(prior) : null
    const extra = r ? 2 : 0, span = 2 + extra
    const find = (list: any[] | undefined, name: string) => list?.find((x) => x.name === name)?.amt ?? 0
    const row = (label: string, v: number, pv?: number) => `<tr class="indent-1"><td>${esc(label)}</td><td class="amount">${amt(v)}</td>${r ? `<td class="amount vs-col">${amt(pv ?? 0)}</td>${change(v, pv ?? 0)}` : ''}</tr>`
    const total = (label: string, v: number, pv?: number, cls = 'total-row') => `<tr class="${cls}"><td>${esc(label)}</td><td class="amount${v < 0 ? ' neg' : ''}">${amt(v)}</td>${r ? `<td class="amount">${amt(pv ?? 0)}</td>${change(v, pv ?? 0)}` : ''}</tr>`
    const section = (t: string) => `<tr class="section-hdr"><td colspan="${span}">${esc(t)}</td></tr>`
    const sub = (t: string) => `<tr class="sub-hdr"><td colspan="${span}">${esc(t)}</td></tr>`
    const lines = (list: any[], prevList?: any[]) => list.length ? list.map((x) => row(x.name, x.amt, prevList ? find(prevList, x.name) : undefined)).join('') : `<tr class="indent-1"><td colspan="${span}" class="muted">None in this period</td></tr>`
    const note = (t: string) => `<tr class="note-row"><td colspan="${span}">${t}</td></tr>`
    return reportArea('Profit & Loss Statement', `Period: ${esc(p.label)}${r ? ` · Compared with ${esc(prior!.label)}` : ''}`,
      `${r ? badge('blue', 'Comparison on') : ''}${badge(c.net >= 0 ? 'green' : 'red', `Net ${c.net >= 0 ? 'profit' : 'loss'}: ₹${num(c.net, 0)}`)}`,
      `<table class="report-table"><thead><tr><th style="width:52%">Particulars</th><th class="amount">${esc(p.label)}</th>${r ? `<th class="amount">${esc(prior!.label)}</th><th class="amount">Change</th>` : ''}</tr></thead><tbody>
      ${section('A. Income')}${sub('Direct income (sales)')}${lines(c.directInc, r?.directInc)}${total('Gross revenue', c.revenue, r?.revenue)}
      ${sub('Other income')}${lines(c.otherInc, r?.otherInc)}${total('Total income', c.totalIncome, r?.totalIncome)}
      ${section('B. Cost of goods sold')}${lines(c.cogs, r?.cogs)}${total('Total cost of goods sold', c.cogsT, r?.cogsT)}
      ${total('Gross profit', c.gross, r?.gross)}${note(`Gross margin: ${pct(c.grossPct)}${r ? ` · Prior: ${pct(r.grossPct)}` : ''}`)}
      ${section('C. Operating expenses')}${lines(c.opex, r?.opex)}${total('Total operating expenses', c.opexT, r?.opexT)}
      ${total('Net profit / (loss)', c.net, r?.net, 'grand-total')}${note(`Net margin: ${pct(c.netPct)}${r ? ` · Prior: ${pct(r.netPct)}` : ''}`)}
      </tbody></table>`)
  }

  function viewBS() {
    const p = state.period
    const byPrimary = (nat: string) => {
      const map = new Map<string, any[]>()
      for (const l of L) {
        if (l.pl || l.nat !== nat) continue
        const bal = closeAt(l, p) * (nat === 'assets' ? 1 : -1)
        if (!bal) continue
        map.set(l.p, [...(map.get(l.p) ?? []), { name: l.n, amt: bal }])
      }
      return [...map.entries()].map(([g, ls]) => ({ g, ls, t: ls.reduce((s: number, x: any) => s + x.amt, 0) }))
    }
    const assets = byPrimary('assets'), liabs = byPrimary('liabilities')
    // P&L ledgers' balances (prior years' results and this year's to date) carried as one line.
    const plBal = -L.filter((l) => l.pl).reduce((s, l) => s + closeAt(l, p), 0)
    const ta = assets.reduce((s, g) => s + g.t, 0), tl = liabs.reduce((s, g) => s + g.t, 0) + plBal
    const diff = ta - tl
    const side = (title: string, groups: any[], total: number, extra = '') => `<table class="report-table"><thead><tr><th>${title}</th><th class="amount">Amount (₹)</th></tr></thead><tbody>
      ${groups.length ? groups.map((g) => `<tr class="section-hdr"><td>${esc(g.g)}</td><td class="amount">${amt(g.t)}</td></tr>${g.ls.map((x: any) => `<tr class="indent-1"><td>${esc(x.name)}</td><td class="amount">${amt(x.amt)}</td></tr>`).join('')}`).join('') : `<tr><td colspan="2" class="muted">No balances</td></tr>`}
      ${extra}<tr class="grand-total"><td>Total ${title.toLowerCase()}</td><td class="amount">${amt(total)}</td></tr></tbody></table>`
    return reportArea('Balance Sheet', `As at ${fmtDate(endDate(p))}`,
      Math.abs(diff) < 100 ? badge('green', '✓ Balanced') : badge('red', `⚠ Difference: ₹${num(diff)}`),
      `<div class="two-col pad">${side('Assets', assets, ta)}${side('Liabilities & equity', liabs, tl, `<tr class="section-hdr"><td>Profit &amp; Loss A/c</td><td class="amount">${amt(plBal)}</td></tr><tr class="indent-1"><td>Surplus to date (incl. prior periods)</td><td class="amount">${amt(plBal)}</td></tr>`)}</div>`)
  }

  function viewSales() {
    const p = state.period, prior = state.compare ? priorOf(p) : null
    const rows = topItems(p)
    const prev = prior ? topItems(prior) : null
    const total = rows.reduce((s, x) => s + x.amt, 0)
    if (!rows.length) return reportArea('Sales by Item', esc(p.label), '', empty('No item-wise sales in this period. Sales vouchers entered without stock items appear under Profit & Loss only.'))
    return reportArea('Sales by Item', `${esc(p.label)} · ${rows.length} item${rows.length === 1 ? '' : 's'}`, badge('green', `Total ₹${num(total, 0)}`),
      `<table class="report-table"><thead><tr><th>#</th><th>Item</th><th class="amount">Qty</th><th class="amount">Avg rate</th><th class="amount">Revenue</th><th>Share</th>${prev ? '<th class="amount">Prior</th><th class="amount">Change</th>' : ''}</tr></thead><tbody>
      ${rows.map((x, i) => { const pv = prev?.find((y) => y.item === x.item)?.amt ?? 0; return `<tr><td class="muted">${i + 1}</td><td><strong>${esc(x.item)}</strong></td><td class="amount">${x.qty.toLocaleString('en-IN')}${x.unit ? ' ' + esc(x.unit) : ''}</td><td class="amount">${x.qty ? num(x.amt / x.qty) : '—'}</td><td class="amount">${num(x.amt)}</td><td><div class="share"><div class="share-track"><div style="width:${x.share}%"></div></div><span>${x.share.toFixed(1)}%</span></div></td>${prev ? `<td class="amount vs-col">${amt(pv)}</td>${change(x.amt, pv)}` : ''}</tr>` }).join('')}
      <tr class="grand-total"><td></td><td>Total</td><td></td><td></td><td class="amount">${num(total)}</td><td></td>${prev ? '<td></td><td></td>' : ''}</tr></tbody></table>`)
  }

  function viewLedgers() {
    const p = state.period
    if (state.ledger !== null) return ledgerStatement(state.ledger, p)
    const q = state.search.toLowerCase()
    const rows = L.map((l, i) => ({ l, i, o: openAt(l, p), mv: move(l, p), c: closeAt(l, p) }))
      .filter((r) => (r.o || r.mv.dr || r.mv.cr) && (!q || r.l.n.toLowerCase().includes(q) || r.l.g.toLowerCase().includes(q)))
    const dc = (v: number) => (v === 0 ? '—' : `${num(v)} ${v > 0 ? 'Dr' : 'Cr'}`)
    return `<div class="toolbar"><input class="search" data-search placeholder="Search ledger or group…" value="${esc(state.search)}"></div>` +
      reportArea('Ledger Accounts', `${esc(p.label)} · ${rows.length} ledger${rows.length === 1 ? '' : 's'} with activity · click a ledger for its statement`, '',
        rows.length ? `<table class="report-table"><thead><tr><th>Ledger</th><th>Group</th><th class="amount">Opening</th><th class="amount">Debit</th><th class="amount">Credit</th><th class="amount">Closing</th></tr></thead><tbody>
        ${rows.map((r) => `<tr class="clickrow" data-ledger="${r.i}"><td><strong>${esc(r.l.n)}</strong></td><td><span class="tag">${esc(r.l.g)}</span></td><td class="amount">${dc(r.o)}</td><td class="amount">${amt(r.mv.dr)}</td><td class="amount">${amt(r.mv.cr)}</td><td class="amount"><strong>${dc(r.c)}</strong></td></tr>`).join('')}</tbody></table>` : empty('No ledger has a balance or movement in this period.'))
  }

  function ledgerStatement(li: number, p: Period) {
    const l = L[li]
    let bal = openAt(l, p)
    const rows: string[] = []
    for (const v of B.vouchers as any[]) {
      if (!inPeriod(v.d, p)) continue
      for (const ln of v.lines) {
        if (ln[0] !== li) continue
        bal += ln[1] - ln[2]
        const other = v.lines.filter((x: any) => x[0] !== li).map((x: any) => L[x[0]]?.n).filter(Boolean)
        rows.push(`<tr><td>${fmtDate(v.d)}</td><td class="mono small">${esc(v.no)}</td><td><span class="tag">${esc(v.tn)}</span></td><td>${esc(other[0] ?? v.party ?? '')}${other.length > 1 ? ` <span class="muted">+${other.length - 1}</span>` : ''}${v.nar ? `<div class="muted small">${esc(v.nar)}</div>` : ''}</td><td class="amount">${amt(ln[1])}</td><td class="amount">${amt(ln[2])}</td><td class="amount">${num(bal)} ${bal >= 0 ? 'Dr' : 'Cr'}</td></tr>`)
      }
    }
    const o = openAt(l, p)
    return `<div class="toolbar"><button class="btn btn-outline btn-sm" data-back>← All ledgers</button></div>` +
      reportArea(`${l.n}`, `${esc(l.g)} · ${esc(p.label)}`, badge('blue', `Closing ${num(closeAt(l, p))} ${closeAt(l, p) >= 0 ? 'Dr' : 'Cr'}`),
        `<table class="report-table"><thead><tr><th>Date</th><th>Voucher</th><th>Type</th><th>Particulars</th><th class="amount">Debit</th><th class="amount">Credit</th><th class="amount">Balance</th></tr></thead><tbody>
        <tr class="sub-hdr"><td colspan="6">Opening balance</td><td class="amount">${num(o)} ${o >= 0 ? 'Dr' : 'Cr'}</td></tr>
        ${rows.join('') || `<tr><td colspan="7" class="muted">No entries in this period.</td></tr>`}
        <tr class="grand-total"><td colspan="6">Closing balance</td><td class="amount">${num(bal)} ${bal >= 0 ? 'Dr' : 'Cr'}</td></tr></tbody></table>`)
  }

  function viewTrial() {
    const p = state.period
    const rows = L.map((l) => ({ l, c: closeAt(l, p) })).filter((r) => r.c !== 0)
    const dr = rows.reduce((s, r) => s + Math.max(0, r.c), 0), cr = rows.reduce((s, r) => s + Math.max(0, -r.c), 0)
    const ok = Math.abs(dr - cr) < 100
    return reportArea('Trial Balance', `As at ${fmtDate(endDate(p))} · ${rows.length} ledger${rows.length === 1 ? '' : 's'}`, ok ? badge('green', '✓ Debits equal credits') : badge('red', `⚠ Difference ₹${num(dr - cr)}`),
      rows.length ? `<table class="report-table"><thead><tr><th>Ledger</th><th>Group</th><th class="amount">Debit (₹)</th><th class="amount">Credit (₹)</th></tr></thead><tbody>
      ${rows.sort((a, b) => a.l.p.localeCompare(b.l.p) || a.l.n.localeCompare(b.l.n)).map((r) => `<tr><td>${esc(r.l.n)}</td><td><span class="tag">${esc(r.l.g)}</span></td><td class="amount">${r.c > 0 ? num(r.c) : ''}</td><td class="amount">${r.c < 0 ? num(r.c) : ''}</td></tr>`).join('')}
      <tr class="grand-total"><td colspan="2">Total</td><td class="amount">${num(dr)}</td><td class="amount">${num(cr)}</td></tr></tbody></table>` : empty('No balances yet.'))
  }

  function viewBank() {
    const p = state.period, asOf = endDate(p)
    if (!(B.bank as any[]).length) return reportArea('Bank Reconciliation', esc(p.label), '', empty('No bank ledger has entries in this financial year.'))
    return (B.bank as any[]).map((b) => {
      const l = L[b.l]
      const book = closeAt(l, p)
      const rows = b.rows.filter((r: any) => r.d <= asOf)
      const uncleared = rows.filter((r: any) => !r.cleared || r.cleared > asOf)
      const depNotCleared = uncleared.reduce((s: number, r: any) => s + r.dr, 0)
      const chqNotPresented = uncleared.reduce((s: number, r: any) => s + r.cr, 0)
      const bankBal = book - depNotCleared + chqNotPresented
      const inP = rows.filter((r: any) => inPeriod(r.d, p))
      return reportArea(l.n, `Reconciliation as at ${fmtDate(asOf)}`, uncleared.length ? badge('amber', `${uncleared.length} uncleared`) : badge('green', '✓ All cleared'),
        `<div class="three-col pad">
          <div class="stat"><div class="stat-l">Balance as per books</div><div class="stat-v">${num(book)} ${book >= 0 ? 'Dr' : 'Cr'}</div></div>
          <div class="stat"><div class="stat-l">Less: deposits not yet cleared · Add: payments not yet presented</div><div class="stat-v">−${num(depNotCleared)} / +${num(chqNotPresented)}</div></div>
          <div class="stat"><div class="stat-l">Expected balance as per bank</div><div class="stat-v" style="color:#4f46e5">${num(bankBal)}</div></div>
        </div>
        <table class="report-table"><thead><tr><th>Date</th><th>Voucher</th><th>Particulars</th><th class="amount">Deposit</th><th class="amount">Withdrawal</th><th>Bank date</th><th>Status</th></tr></thead><tbody>
        ${inP.length ? inP.map((r: any) => `<tr><td>${fmtDate(r.d)}</td><td class="mono small">${esc(r.no)}</td><td>${esc(r.part)}</td><td class="amount pos">${amt(r.dr)}</td><td class="amount neg">${amt(r.cr)}</td><td>${fmtDate(r.cleared)}</td><td>${r.cleared && r.cleared <= asOf ? badge('green', 'Cleared') : badge('amber', 'Uncleared')}</td></tr>`).join('') : '<tr><td colspan="7" class="muted">No bank entries in this period.</td></tr>'}
        </tbody></table>`)
    }).join('')
  }

  function viewSide(side: 'receivable' | 'payable') {
    const p = state.period, asOf = endDate(p)
    const o = outstanding(side, asOf)
    const debt = side === 'receivable'
    const col = debt ? '#d97706' : '#dc2626'
    const who = debt ? 'customer' : 'supplier'
    const summary = card(`${debt ? 'Debtor' : 'Creditor'} Summary`, '', `<div class="chart-body">${[
      ['Total outstanding', `₹${num(o.total, 0)}`, col], [`Total ${who}s`, String(o.parties.length), '#4f46e5'], [`Avg per ${who}`, `₹${num(o.parties.length ? o.total / o.parties.length : 0, 0)}`, '#6b7280'],
    ].map(([a, b, c]) => `<div class="kv"><span>${a}</span><strong style="color:${c}">${b}</strong></div>`).join('')}</div>`)
    const billTotal = Math.max(1, o.buckets.reduce((s, b) => s + b.amount, 0))
    const ageing = card('Ageing Analysis', '', `<div class="chart-body">${o.buckets.map((b) => `<div class="age${b.label.startsWith('>') && b.amount ? ' age-attn' : ''}"><div class="age-head"><strong>${b.label}</strong><span style="color:${b.color}">₹${num(b.amount, 0)}</span></div><div class="hbar-track"><div class="hbar-fill" style="width:${(b.amount / billTotal) * 100}%;background:${b.color}"></div></div><div class="age-count">${b.count} bill${b.count === 1 ? '' : 's'}</div></div>`).join('')}<div class="muted small">Age counted from the due date (or bill date) to ${fmtDate(asOf)}.</div></div>`)
    const table = o.parties.length ? `<table class="report-table"><thead><tr><th>#</th><th>${debt ? 'Customer' : 'Supplier'}</th><th class="amount">Billed</th><th class="amount">${debt ? 'Received' : 'Paid'}</th><th class="amount">Outstanding</th><th>Bills</th><th>Last bill</th><th>Status</th></tr></thead><tbody>
      ${o.parties.map((x, i) => `<tr${(x.oldest ?? 0) > 90 ? ' class="attention"' : ''}><td class="muted">${i + 1}</td><td><strong>${esc(x.name)}</strong></td><td class="amount">${amt(x.billed)}</td><td class="amount pos">${amt(x.settled)}</td><td class="amount" style="color:${col};font-weight:700">${num(x.outstanding)}</td><td>${x.bills.length || '—'}</td><td class="muted small">${fmtDate(x.last)}</td><td>${ageBadge(x.oldest)}</td></tr>`).join('')}
      <tr class="grand-total"><td></td><td>Total</td><td></td><td></td><td class="amount">${num(o.total)}</td><td colspan="3"></td></tr></tbody></table>` : empty(`Nothing outstanding from ${who}s as at ${fmtDate(asOf)}.`)
    const breakup = o.bills.length ? `<div class="breakup ${debt ? '' : 'breakup-red'}"><strong>${debt ? 'Invoice' : 'Bill'}-wise breakup</strong><table class="report-table"><thead><tr><th>${debt ? 'Invoice' : 'Bill'} no</th><th>${debt ? 'Customer' : 'Supplier'}</th><th>Date</th><th>Due</th><th class="amount">Amount</th><th class="amount">Outstanding</th><th>Age</th></tr></thead><tbody>
      ${o.bills.map((b) => `<tr><td class="mono small" style="color:${debt ? '#4f46e5' : '#dc2626'}">${esc(b.ref)}</td><td>${esc(b.party)}</td><td class="small">${fmtDate(b.d)}</td><td class="small">${fmtDate(b.due)}</td><td class="amount">${num(b.amt)}</td><td class="amount" style="color:${col};font-weight:600">${num(b.pending)}</td><td>${badge(b.age > 90 ? 'red' : b.age > 60 ? 'amber' : b.age > 30 ? 'blue' : 'green', b.age > 0 ? `${b.age}d` : 'Not due')}</td></tr>`).join('')}</tbody></table></div>` : ''
    return `<div class="side-grid"><div>${summary}${ageing}</div>${reportArea(debt ? 'Debtors Outstanding Ledger' : 'Creditors Outstanding Ledger', `As at ${fmtDate(asOf)} · ${o.parties.length} ${who}${o.parties.length === 1 ? '' : 's'} · Total ${side}: ₹${num(o.total, 0)}`, badge(debt ? 'amber' : 'red', `Amounts ${debt ? 'receivable' : 'payable'}`), table + breakup)}</div>`
  }

  function viewJournal() {
    const p = state.period
    const q = state.search.toLowerCase()
    const types = [...new Set((B.vouchers as any[]).map((v) => v.tn))].sort()
    const rows = (B.vouchers as any[]).filter((v) => inPeriod(v.d, p) && (!state.vtype || v.tn === state.vtype) &&
      (!q || v.no.toLowerCase().includes(q) || (v.party ?? '').toLowerCase().includes(q) || (v.nar ?? '').toLowerCase().includes(q)))
    const total = rows.reduce((s, v) => s + v.amt, 0)
    return `<div class="toolbar"><select class="select" data-vtype><option value="">All voucher types</option>${types.map((t) => `<option${t === state.vtype ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select><input class="search" data-search placeholder="Search voucher no, party or narration…" value="${esc(state.search)}"></div>` +
      reportArea('Journal Entries', `${esc(p.label)} · ${rows.length} voucher${rows.length === 1 ? '' : 's'}${B.vouchersTruncated ? ' · the file carries the latest vouchers only' : ''}`, badge('blue', `Total ₹${num(total, 0)}`),
        rows.length ? `<table class="report-table ledger-table"><thead><tr><th>Date</th><th>Voucher</th><th>Type</th><th>Ledger</th><th class="amount">Debit</th><th class="amount">Credit</th></tr></thead><tbody>
        ${rows.map((v) => `<tr class="sub-hdr"><td>${fmtDate(v.d)}</td><td class="mono">${esc(v.no)}</td><td>${esc(v.tn)}</td><td colspan="3">${esc(v.party ?? '')}${v.nar ? ` <span class="muted small">— ${esc(v.nar)}</span>` : ''}</td></tr>${v.lines.map((ln: any) => `<tr class="indent-2"><td></td><td></td><td></td><td>${esc(L[ln[0]]?.n ?? '')}</td><td class="amount">${ln[1] ? num(ln[1]) : ''}</td><td class="amount">${ln[2] ? num(ln[2]) : ''}</td></tr>`).join('')}`).join('')}
        </tbody></table>` : empty('No vouchers match in this period.'))
  }

  function viewRegister(t: 'sales' | 'purchase') {
    const p = state.period
    const rows = (B.regs as any[]).filter((r) => r.t === t && inPeriod(r.d, p))
    const sum = (k: string) => rows.reduce((s, r) => s + r[k], 0)
    const title = t === 'sales' ? 'Sales Register' : 'Purchase Register'
    return reportArea(title, `${esc(p.label)} · ${rows.length} voucher${rows.length === 1 ? '' : 's'}`, badge(t === 'sales' ? 'green' : 'amber', `Total ₹${num(sum('total'), 0)}`),
      rows.length ? `<table class="report-table"><thead><tr><th>Date</th><th>${t === 'sales' ? 'Invoice' : 'Bill'} no</th><th>${t === 'sales' ? 'Customer' : 'Supplier'}</th><th>GSTIN</th><th class="amount">Taxable</th><th class="amount">CGST</th><th class="amount">SGST</th><th class="amount">IGST</th><th class="amount">Total</th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td class="small">${fmtDate(r.d)}</td><td class="mono small">${esc(r.no)}</td><td>${esc(r.party ?? '—')}</td><td class="mono small muted">${esc(r.gstin ?? '—')}</td><td class="amount">${amt(r.taxable)}</td><td class="amount">${amt(r.cgst)}</td><td class="amount">${amt(r.sgst)}</td><td class="amount">${amt(r.igst)}</td><td class="amount"><strong>${num(r.total)}</strong></td></tr>`).join('')}
      <tr class="grand-total"><td colspan="4">Total</td><td class="amount">${num(sum('taxable'))}</td><td class="amount">${num(sum('cgst'))}</td><td class="amount">${num(sum('sgst'))}</td><td class="amount">${num(sum('igst'))}</td><td class="amount">${num(sum('total'))}</td></tr></tbody></table>` : empty(`No ${t} vouchers in this period.`))
  }

  // ── shell ────────────────────────────────────────────────────────────────
  const TITLES: Record<string, string> = {
    dashboard: 'Overview Dashboard', pl: 'Profit & Loss', bs: 'Balance Sheet', sales: 'Sales by Item', ledger: 'Ledger Accounts', trial: 'Trial Balance',
    bank: 'Bank Reconciliation', debtors: 'Debtors Ledger', creditors: 'Creditors Ledger', journal: 'Journal Entries', salesreg: 'Sales Register', purchases: 'Purchase Register',
  }
  const $ = (sel: string) => doc.querySelector(sel)

  function render() {
    const content = $('#main-content')
    try {
      const v = state.view
      content.innerHTML = v === 'dashboard' ? viewDashboard() : v === 'pl' ? viewPL() : v === 'bs' ? viewBS() : v === 'sales' ? viewSales()
        : v === 'ledger' ? viewLedgers() : v === 'trial' ? viewTrial() : v === 'bank' ? viewBank() : v === 'debtors' ? viewSide('receivable')
        : v === 'creditors' ? viewSide('payable') : v === 'journal' ? viewJournal() : v === 'salesreg' ? viewRegister('sales') : viewRegister('purchase')
    } catch (e: any) {
      content.innerHTML = `<div class="empty error">This view could not be drawn: ${esc(e && e.message)}</div>`
    }
    $('#page-title').textContent = TITLES[state.view]
    doc.querySelectorAll('.nav-item').forEach((el: any) => el.classList.toggle('active', el.dataset.view === state.view))
    doc.querySelectorAll('.ps-btn').forEach((el: any) => el.classList.toggle('active', el.dataset.mode === state.mode))
    const sel = $('#period-select')
    sel.innerHTML = periodsFor(state.mode).map((p) => `<option value="${esc(p.key)}"${p.key === state.period.key ? ' selected' : ''}>${esc(p.label)}</option>`).join('')
    const prior = priorOf(state.period)
    const cmp = $('#compare-toggle')
    cmp.disabled = !prior
    cmp.checked = state.compare && Boolean(prior)
    $('#compare-wrap').title = prior ? `Compare with ${prior.label}` : 'No earlier period in this file to compare with'
    $('#print-period').textContent = state.period.label
    const search = $('[data-search]')
    if (search && state.focusSearch) { search.focus(); search.setSelectionRange(search.value.length, search.value.length); state.focusSearch = false }
  }

  doc.addEventListener('click', (e: any) => {
    const t = e.target.closest('[data-view],[data-go],[data-mode],[data-ledger],[data-back],[data-action]')
    if (!t) return
    if (t.dataset.view || t.dataset.go) { state.view = t.dataset.view || t.dataset.go; state.ledger = null; state.search = ''; state.vtype = ''; $('.sidebar').classList.remove('open') }
    else if (t.dataset.mode) { state.mode = t.dataset.mode; const list = periodsFor(state.mode); state.period = list.find((p) => p.start <= state.period.end && p.end >= state.period.start) ?? list[0] }
    else if (t.dataset.ledger !== undefined) { state.ledger = Number(t.dataset.ledger) }
    else if (t.dataset.back !== undefined) { state.ledger = null }
    else if (t.dataset.action === 'print' || t.dataset.action === 'pdf') { win.print(); return }
    else if (t.dataset.action === 'export') { exportCsv(); return }
    else if (t.dataset.action === 'share') { share(); return }
    else if (t.dataset.action === 'menu') { $('.sidebar').classList.toggle('open'); return }
    render()
    $('.main').scrollTop = 0
  })
  doc.addEventListener('change', (e: any) => {
    if (e.target.id === 'period-select') { state.period = periodsFor(state.mode).find((p) => p.key === e.target.value) ?? state.period; render() }
    else if (e.target.id === 'compare-toggle') { state.compare = e.target.checked; render() }
    else if (e.target.dataset.vtype !== undefined) { state.vtype = e.target.value; render() }
  })
  doc.addEventListener('input', (e: any) => {
    if (e.target.dataset.search !== undefined) { state.search = e.target.value; state.focusSearch = true; render() }
  })

  function exportCsv() {
    const tables = doc.querySelectorAll('#main-content table')
    if (!tables.length) { toast('Nothing to export on this view.'); return }
    const lines: string[] = [`"${B.company.name}","${TITLES[state.view]}","${state.period.label}"`, '']
    tables.forEach((tb: any) => {
      tb.querySelectorAll('tr').forEach((tr: any) => {
        lines.push([...tr.querySelectorAll('th,td')].map((c: any) => `"${c.innerText.replace(/\s+/g, ' ').trim().replace(/"/g, '""')}"`).join(','))
      })
      lines.push('')
    })
    const blob = new win.Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' })
    const a = doc.createElement('a')
    a.href = win.URL.createObjectURL(blob)
    a.download = `${B.company.name.replace(/[^\w-]+/g, '_')}-${TITLES[state.view].replace(/[^\w]+/g, '_')}-${state.period.key}.csv`
    doc.body.appendChild(a); a.click(); a.remove()
    toast('CSV downloaded — opens in Excel.')
  }

  function share() {
    const c = pl(state.period)
    const d = outstanding('receivable', endDate(state.period))
    const text = `${B.company.name} — ${state.period.label}\nRevenue ₹${num(c.revenue, 0)} · Gross profit ₹${num(c.gross, 0)} (${pct(c.grossPct)}) · Net ${c.net >= 0 ? 'profit' : 'loss'} ₹${num(c.net, 0)}\nReceivables ₹${num(d.total, 0)} from ${d.parties.length} customer${d.parties.length === 1 ? '' : 's'}\n— ${B.firm.preparedBy}`
    if (win.navigator.share) { win.navigator.share({ title: `${B.company.name} — financial summary`, text }).catch(() => undefined); return }
    if (win.navigator.clipboard) win.navigator.clipboard.writeText(text).then(() => toast('Summary copied — paste it into WhatsApp.'), () => toast('Could not copy the summary.'))
    else toast('Sharing is not available in this browser.')
  }

  let toastTimer: any = null
  function toast(msg: string) {
    let el = $('.toast')
    if (!el) { el = doc.createElement('div'); el.className = 'toast'; doc.body.appendChild(el) }
    el.textContent = msg
    el.style.display = 'flex'
    win.clearTimeout(toastTimer)
    toastTimer = win.setTimeout(() => { el.style.display = 'none' }, 2600)
  }

  // "#pl", "#debtors"… opens that report directly.
  const fromHash = String(win.location.hash || '').slice(1)
  if (TITLES[fromHash]) state.view = fromHash
  // Any error still gets a visible message instead of a blank page.
  win.addEventListener('error', (e: any) => { const c = $('#main-content'); if (c && !c.innerHTML) c.innerHTML = `<div class="empty error">Something went wrong: ${esc(e.message)}</div>` })
  render()
}
