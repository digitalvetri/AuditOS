import PDFDocument from 'pdfkit'
import type { Response } from 'express'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Row } from './service.js'
import { pitchOf, type FontKey, type HeadLine, type WordSkin } from './skins.js'

/**
 * ENGAGEMENT LETTER PDF — the firm's Word templates.
 *
 * The browser draws these letters in points on a fixed grid (see
 * EngagementDocument.tsx, "Word templates"); this is the same grid on paper.
 * Every rule is mirrored: line boxes `pitch` tall with the text centred in
 * them as CSS centres it, rows `pitch + gap` apart lifted by half a gap,
 * margins that collapse the way block margins do, and the same pagination —
 * a unit fits when its own box does, page breaks close their page. Lines are
 * broken here, word by word, at the same opportunities the browser uses
 * (spaces, a hyphen between letters, a slash before a letter), with Tinos —
 * Times New Roman's metric twin — so each line ends on the same word.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
// src/modules/engagement → backend/assets; dist/src/modules/engagement → /app/assets.
const FONTS = [
  resolve(__dirname, '..', '..', '..', 'assets', 'fonts'),
  resolve(__dirname, '..', '..', '..', '..', 'assets', 'fonts'),
].find((p) => existsSync(resolve(p, 'Tinos-Regular.ttf'))) ?? resolve(__dirname, '..', '..', '..', 'assets', 'fonts')

/** Word applies neither; the browser page turns both off to match. */
const NO_FEATURES = { kern: false, liga: false, clig: false } as unknown as []

// Tinos / Times New Roman vertical metrics (em): what CSS centres a line on.
const ASC = 0.891
const DESC = 0.216

interface Block {
  id?: string
  key: string
  enabled?: boolean
  title?: string
  body?: string
  lines?: Line[]
  heightPx?: number
  table?: { cols: number[]; head: string[]; rows: { html: string; valign?: 'top' | 'middle'; padTop?: number }[][]; heights: number[]; pad?: number[] }
  afterPt?: number
  gapPt?: number
  rule?: boolean
  ruleGapPt?: number
  dateFormat?: 'd MMMM, yyyy' | 'do MMMM yyyy' | 'ddo MMMM yyyy'
  place?: string
  bold?: boolean
  showCompany?: boolean
}

interface Line {
  kind?: 'p' | 'bullet' | 'number'
  align?: 'left' | 'center' | 'right' | 'justify'
  indent?: number
  html?: string
  size?: number
  after?: number
  marker?: string
  pad?: number
}

interface Recipient {
  name?: string; designation?: string; companyName?: string; address?: string
  city?: string; state?: string; pincode?: string
}

/** A styled stretch of text. */
interface Run { text: string; b: boolean; i: boolean; u: boolean; sup: boolean; size?: number; color?: string }

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
const decode = (t: string) => t
  .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
  .replace(/&([a-z]+);/gi, (m, n: string) => ENTITIES[n.toLowerCase()] ?? m)

const COMPANY_KEYS = new Set(['company_name', 'company_name_caps'])

/**
 * Stored inline HTML (b, i, u, sup, br) into runs, with {{placeholders}}
 * filled. The client company keeps the template's own size and ink, as the
 * page shows it. Unknown tags are skipped, never printed.
 */
function parseInline(html: string, vars: Record<string, string>, company?: WordSkin['company']): Run[] {
  const runs: Run[] = []
  let b = 0, i = 0, u = 0, sup = 0
  const re = /<\s*(\/)?\s*([a-zA-Z]+)[^>]*>|([^<]+)/g
  let m: RegExpExecArray | null
  const push = (text: string, extra: Partial<Run> = {}) => {
    if (text) runs.push({ text, b: b > 0, i: i > 0, u: u > 0, sup: sup > 0, ...extra })
  }
  while ((m = re.exec(html))) {
    if (m[3] !== undefined) {
      const t = decode(m[3])
      let last = 0
      for (const ph of t.matchAll(/\{\{\s*(\w+)\s*\}\}/g)) {
        push(t.slice(last, ph.index))
        const k = ph[1]
        const v = vars[k] ? vars[k] : ph[0]
        push(v, COMPANY_KEYS.has(k) && company ? { size: company.size, color: company.color } : {})
        last = (ph.index ?? 0) + ph[0].length
      }
      push(t.slice(last))
      continue
    }
    const tag = m[2].toLowerCase()
    if (tag === 'br') { runs.push({ text: '\n', b: false, i: false, u: false, sup: false }); continue }
    const d = m[1] ? -1 : 1
    if (tag === 'b' || tag === 'strong') b = Math.max(0, b + d)
    else if (tag === 'i' || tag === 'em') i = Math.max(0, i + d)
    else if (tag === 'u') u = Math.max(0, u + d)
    else if (tag === 'sup') sup = Math.max(0, sup + d)
  }
  return runs
}

const ordinal = (n: number) => {
  const t = n % 100
  if (t >= 11 && t <= 13) return 'th'
  return ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'
}
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/** The letter date in the template's own format — as fmtDate in document.ts. */
function fmtDate(iso: string | null | undefined, f: Block['dateFormat']): string {
  if (!iso) return ''
  const d = new Date(`${iso}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return iso
  const day = d.getUTCDate()
  const month = MONTHS[d.getUTCMonth()]
  const dd = String(day).padStart(2, '0')
  const y = d.getUTCFullYear()
  if (f === 'do MMMM yyyy') return `${day}${ordinal(day)} ${month} ${y}`
  if (f === 'ddo MMMM yyyy') return `${dd}${ordinal(day)} ${month} ${y}`
  if (f === 'd MMMM, yyyy') return `${dd} ${month}, ${y}`
  return `${dd} ${month} ${y}`
}

const capsName = (name: string) => name.trim().replace(/[,\s]+$/, '').toUpperCase()
const fillPlain = (t: string, vars: Record<string, string>) =>
  t.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k: string) => (vars[k] ? vars[k] : m))

/** Collapse two adjoining vertical margins, as CSS does. */
const collapse = (a: number, b: number) => (a >= 0 && b >= 0 ? Math.max(a, b) : a <= 0 && b <= 0 ? Math.min(a, b) : a + b)

// ── One unit of the page: measured, then drawn ────────────────────────────

interface Unit {
  /** Top margin (may be negative), box height, bottom margin — in points. */
  mt: number
  h: number
  mb: number
  pageBreak?: boolean
  draw: (top: number) => void
}

export function streamWordPdf(res: Response, l: Row, skin: WordSkin) {
  const doc = new PDFDocument({ size: 'A4', margin: 0, bufferPages: true, autoFirstPage: true })
  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('Content-Disposition', `attachment; filename="${l.letterCode}.pdf"`)
  doc.pipe(res)

  doc.registerFont('T', resolve(FONTS, 'Tinos-Regular.ttf'))
  doc.registerFont('TB', resolve(FONTS, 'Tinos-Bold.ttf'))
  doc.registerFont('TI', resolve(FONTS, 'Tinos-Italic.ttf'))
  doc.registerFont('TBI', resolve(FONTS, 'Tinos-BoldItalic.ttf'))
  doc.registerFont('C', resolve(FONTS, 'Carlito-Regular.ttf'))
  doc.registerFont('CB', resolve(FONTS, 'Carlito-Bold.ttf'))
  const fontOf = (r: { b: boolean; i: boolean }) => (r.b && r.i ? 'TBI' : r.b ? 'TB' : r.i ? 'TI' : 'T')

  const layout = (l.layoutConfig ?? {}) as { company?: Record<string, string> }
  const company: Record<string, string> = {
    name: 'JNS Accounting Solutions', addressLine1: '2A, Velavan Nagar, IInd Street, SRP Mills', addressLine2: 'Saravanampatti',
    city: 'Coimbatore', state: 'Tamil Nadu', pin: '641 035', email: 'jnsacctax@gmail.com', phone: '97900 39150',
    ...(layout.company ?? {}),
  }
  const rcp = (l.recipientSnapshot ?? {}) as Recipient
  const companyName = rcp.companyName || l.client?.companyName || l.lead?.name || ''
  const vars: Record<string, string> = {
    client_name: rcp.name ?? '',
    contact_person: rcp.name ?? '',
    designation: rcp.designation ?? '',
    company_name: companyName,
    company_name_caps: capsName(companyName),
    financial_year: l.financialYear ?? '',
    effective_from: fmtDate(l.effectiveFrom, undefined),
    effective_until: fmtDate(l.effectiveUntil, undefined),
    firm_name: company.name ?? '',
  }

  const W = doc.page.width
  const colW = W - skin.margin * 2
  const ROW = skin.pitch + skin.gap

  /** Baseline of text of `size` in a line box `box` tall whose top is `top`. */
  const baseline = (top: number, box: number, size: number) => top + (box - (ASC + DESC) * size) / 2 + ASC * size

  const put = (t: string, x: number, base: number, font: string, size: number, color = '#000000', opts: Record<string, unknown> = {}) => {
    doc.font(font).fontSize(size).fillColor(color)
    const asc = (doc as unknown as { _font: { ascender: number } })._font.ascender / 1000
    doc.text(t, x, base - asc * size, { lineBreak: false, features: NO_FEATURES, ...opts })
  }
  const width = (t: string, font: string, size: number, spacing = 0) => {
    doc.font(font).fontSize(size)
    return doc.widthOfString(t, { features: NO_FEATURES, characterSpacing: spacing })
  }

  // ── Line breaking ─────────────────────────────────────────────────────

  interface Piece { text: string; run: Run; w: number; space: boolean }
  const runSize = (r: Run, base: number) => (r.sup ? (r.size ?? base) * 0.636 : (r.size ?? base))

  /** Break runs into pieces at the browser's break opportunities. */
  const piecesOf = (runs: Run[], base: number): (Piece | 'br')[] => {
    const out: (Piece | 'br')[] = []
    for (const r of runs) {
      if (r.text === '\n') { out.push('br'); continue }
      // Spaces are their own pieces; a word breaks after "-" between letters and after "/" before a letter.
      for (const tok of r.text.split(/( +)/)) {
        if (!tok) continue
        if (/^ +$/.test(tok)) {
          out.push({ text: tok, run: r, w: width(tok, fontOf(r), runSize(r, base)), space: true })
          continue
        }
        for (const part of tok.split(/(?<=[A-Za-z]-)(?=[A-Za-z])|(?<=\/)(?=[A-Za-z])/)) {
          if (part) out.push({ text: part, run: r, w: width(part, fontOf(r), runSize(r, base)), space: false })
        }
      }
    }
    return out
  }

  /** Greedy lines, spaces hanging at the end of a line as `pre-wrap` hangs them. */
  const wrap = (runs: Run[], base: number, avail: number, firstIndent = 0): Piece[][] => {
    const lines: Piece[][] = []
    let cur: Piece[] = []
    let used = firstIndent
    const flush = () => { lines.push(cur); cur = []; used = 0 }
    for (const p of piecesOf(runs, base)) {
      if (p === 'br') { flush(); continue }
      // Every piece boundary is a break opportunity (that is how pieces are
      // cut), so a piece that does not fit starts the next line; the spaces
      // it leaves behind hang. A word wider than the line simply overflows,
      // as it would on screen.
      if (!p.space && cur.length && used + p.w > avail + 0.01) flush()
      cur.push(p)
      used += p.w
    }
    if (cur.length || !lines.length) lines.push(cur)
    return lines
  }

  /** Draw wrapped lines; `top` is the first line box's top. */
  const drawLines = (lines: Piece[][], x: number, top: number, avail: number, pitch: number, base: number,
    align: Line['align'] = 'left', firstIndent = 0) => {
    lines.forEach((ln, idx) => {
      let end = ln.length
      while (end > 0 && ln[end - 1].space) end--
      const shown = ln.slice(0, end)
      const indent = idx === 0 ? firstIndent : 0
      const textW = shown.reduce((a, p) => a + p.w, 0)
      const room = avail - indent - textW
      const last = idx === lines.length - 1
      const spaces = shown.filter((p) => p.space).length
      const stretch = align === 'justify' && !last && spaces > 0 ? room / spaces : 0
      let cx = x + indent + (align === 'center' ? room / 2 : align === 'right' ? room : 0)
      const b = baseline(top + idx * pitch, pitch, base)
      for (const p of shown) {
        const size = runSize(p.run, base)
        if (!p.space) {
          put(p.text, cx, p.run.sup ? b - 0.42 * size : b, fontOf(p.run), size, p.run.color ?? '#000000')
          if (p.run.u) doc.rect(cx, b + 1.3, p.w, 0.8).fill('#000000')
        } else if (p.run.u && !last) {
          doc.rect(cx, b + 1.3, p.w + stretch, 0.8).fill('#000000')
        }
        cx += p.w + (p.space ? stretch : 0)
      }
    })
  }

  // ── Units ─────────────────────────────────────────────────────────────

  const units: Unit[] = []

  /** A paragraph or list line — the browser's WordLineView. */
  const lineUnit = (ln: Line, n: number, head?: string): Unit => {
    const size = ln.size ?? skin.size
    const pitch = pitchOf(skin, ln.size)
    const list = ln.kind === 'bullet' || ln.kind === 'number'
    const lead = !list && ln.marker ? ln.marker : ''
    const padL = (ln.pad ?? 0) + Math.min(4, Math.max(0, Number(ln.indent) || 0)) * skin.listIndent + (list ? skin.listIndent : 0)
    const x = skin.margin + padL + (list ? skin.markerWidth : 0)
    const avail = colW - padL - (list ? skin.markerWidth : 0)
    const runs = parseInline(ln.html ?? '', vars, skin.company)
    const lines = wrap(runs, size, avail, lead ? 9.4 : 0)
    const headH = head ? skin.pitch + skin.gap : 0
    return {
      mt: 0,
      h: headH + lines.length * pitch,
      mb: ln.after ?? skin.blank,
      draw: (top) => {
        if (head) {
          const b = baseline(top, skin.pitch, skin.size)
          put(head, skin.margin, b, 'TB', skin.size)
          doc.rect(skin.margin, b + 1.3, width(head.replace(/\s+$/, ''), 'TB', skin.size), 1.0).fill('#000000')
        }
        const t = top + headH
        if (list) {
          const marker = ln.marker ?? (ln.kind === 'bullet' ? '•' : `${n}.`)
          put(marker, skin.margin + padL, baseline(t, pitch, size), 'T', size)
        }
        if (lead) put(lead, skin.margin + (ln.pad ?? 0), baseline(t, pitch, size) + 1.3, 'T', size * 1.328)
        drawLines(lines, x, t, avail, pitch, size, ln.align ?? 'left', lead ? 9.4 : 0)
      },
    }
  }

  /** Rows on the `pitch + gap` grid — the browser's WordRows. */
  interface RowSpec { text: string; extra?: number; font?: string; size?: number; color?: string; align?: 'left' | 'right' | 'center' }
  const rowsUnit = (rows: RowSpec[], after: number | undefined, align: 'left' | 'right' | 'center' = 'left', ruleGap?: number): Unit => {
    // A multi-line row (the address) is one row per line.
    const flat: RowSpec[] = rows.flatMap((r) => r.text.split('\n').map((t, i, a) => ({ ...r, text: t, extra: i === a.length - 1 ? r.extra : 0 })))
    const extras = flat.slice(0, -1).reduce((a, r) => a + (r.extra ?? 0), 0)
    const rule = ruleGap !== undefined
    const h = flat.length * ROW + extras + (rule ? ruleGap - skin.gap / 2 + 1.5 : 0)
    return {
      mt: -skin.gap / 2,
      h,
      mb: rule ? (after ?? skin.blank) : (after ?? skin.blank) - skin.gap / 2,
      draw: (top) => {
        let y = top
        for (const r of flat) {
          const size = r.size ?? skin.size
          const font = r.font ?? 'T'
          const w = width(r.text, font, size)
          const a = r.align ?? align
          const x = a === 'right' ? skin.margin + colW - w : a === 'center' ? skin.margin + (colW - w) / 2 : skin.margin
          put(r.text, x, baseline(y, ROW, size), font, size, r.color ?? '#000000')
          y += ROW + (r.extra ?? 0)
        }
        if (rule) {
          const ry = top + flat.length * ROW + extras + ruleGap - skin.gap / 2
          doc.rect(skin.margin - 1.4, ry, colW + 3, 1.5).fill('#000000')
        }
      },
    }
  }

  /** A single row at `pitch` (subject, salutation, a fee). */
  const singleUnit = (runs: Run[], after: number | undefined, align: Line['align'] = 'left'): Unit => {
    const lines = wrap(runs, skin.size, colW)
    return {
      mt: 0,
      h: lines.length * skin.pitch,
      mb: after ?? skin.blank,
      draw: (top) => drawLines(lines, skin.margin, top, colW, skin.pitch, skin.size, align),
    }
  }
  const plain = (text: string, extra: Partial<Run> = {}): Run => ({ text, b: false, i: false, u: false, sup: false, ...extra })

  const companyStyle = skin.company ? { size: skin.company.size, color: skin.company.color } : {}
  const blocks = (Array.isArray(l.blockConfig) ? (l.blockConfig as unknown as Block[]) : []).filter((b) => b && b.enabled !== false)
  const hasLetterhead = blocks.some((b) => b.key === 'letterhead')
  const isEmpty = (ln: Line) => !(ln.html ?? '').replace(/<br\s*\/?>/gi, '').replace(/&nbsp;| /g, '').replace(/<[^>]+>/g, '').trim()

  for (const b of blocks) {
    switch (b.key) {
      case 'letterhead':
        break
      case 'date': {
        const rows: RowSpec[] = [{ text: fmtDate(l.letterDate, b.dateFormat), font: b.bold ? 'TB' : 'T' }]
        if (b.place) rows.push({ text: b.place, font: b.bold ? 'TB' : 'T' })
        units.push(rowsUnit(rows, b.afterPt, 'right'))
        break
      }
      case 'recipient': {
        const tail = [rcp.city, rcp.state].filter(Boolean).join(', ') + (rcp.pincode ? ` – ${rcp.pincode}` : '')
        const rows: RowSpec[] = [{ text: fillPlain(b.body || 'To', vars) }]
        if (rcp.name) rows.push({ text: rcp.name })
        if (rcp.designation) rows.push({ text: rcp.designation })
        if (companyName) rows.push({ text: companyName, ...companyStyle })
        if (rcp.address) rows.push({ text: rcp.address })
        if (tail) rows.push({ text: tail })
        units.push(rowsUnit(rows, b.afterPt))
        break
      }
      case 'subject':
        units.push(singleUnit([plain(`${fillPlain(b.body || 'Sub:', vars)} ${fillPlain(l.subject, vars)}`)], b.afterPt, 'center'))
        break
      case 'salutation':
        units.push(singleUnit([plain(fillPlain(b.body || 'Dear Sir,', vars))], b.afterPt))
        break
      case 'paragraph':
      case 'closing':
      case 'section': {
        const lines = (b.lines ?? []).filter((x) => !isEmpty(x))
        let n = 0
        lines.forEach((ln, i) => {
          n = ln.kind === 'number' ? n + 1 : 0
          units.push(lineUnit(ln, n, b.key === 'section' && i === 0 && b.title?.trim() ? fillPlain(b.title, vars) : undefined))
        })
        break
      }
      case 'fees': {
        const note = (b.lines ?? []).filter((x) => !isEmpty(x))
        l.feeItems.forEach((f, i) => {
          const last = i === l.feeItems.length - 1
          const after = !last || note.length ? skin.gap : (b.afterPt ?? skin.blank)
          const amount = (f.amountPaise / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })
          const text = `${f.service} – Rs. ${amount}${f.frequency ? ` ${f.frequency}` : ''}${f.billingBasis ? ` [${f.billingBasis}]` : ''}`
          const u = singleUnit([plain(text)], after)
          if (i === 0 && b.title?.trim()) {
            const title = fillPlain(b.title, vars)
            const inner = u.draw
            u.h += skin.pitch + skin.gap
            u.draw = (top) => {
              const bl = baseline(top, skin.pitch, skin.size)
              put(title, skin.margin, bl, 'TB', skin.size)
              doc.rect(skin.margin, bl + 1.3, width(title.replace(/\s+$/, ''), 'TB', skin.size), 1.0).fill('#000000')
              inner(top + skin.pitch + skin.gap)
            }
          }
          units.push(u)
        })
        let n = 0
        note.forEach((ln) => { n = ln.kind === 'number' ? n + 1 : 0; units.push(lineUnit(ln, n)) })
        break
      }
      case 'signature': {
        const rows: RowSpec[] = [
          { text: fillPlain(b.body || 'Yours truly,', vars), extra: (b.gapPt ?? skin.pitch * 2 + skin.gap * 3) - skin.gap },
          { text: l.signatoryName ?? '' },
          { text: l.signatoryDesignation ?? '' },
          { text: company.name ?? '' },
        ]
        units.push(rowsUnit(rows, b.afterPt, 'left', b.rule ? (b.ruleGapPt ?? 1.2) : undefined))
        break
      }
      case 'confirmation': {
        const who = l.clientSignatoryName || rcp.name
        const role = l.clientSignatoryDesignation || rcp.designation
        const rows: RowSpec[] = [
          { text: fillPlain(b.body || 'The above terms and conditions are agreed and confirmed by;', vars), extra: 2 * ROW },
          { text: b.title || '______________________' },
        ]
        if (who) rows.push({ text: who })
        if (role) rows.push({ text: role })
        if (b.showCompany !== false && companyName) rows.push({ text: companyName, ...companyStyle })
        units.push(rowsUnit(rows, b.afterPt ?? 0))
        break
      }
      case 'spacer': {
        const h = (typeof b.heightPx === 'number' && Number.isFinite(b.heightPx) ? b.heightPx : 24) * 0.75
        units.push({ mt: 0, h, mb: 0, draw: () => {} })
        break
      }
      case 'pagebreak':
        units.push({ mt: 0, h: 0, mb: 0, pageBreak: true, draw: () => {} })
        break
      case 'table': {
        const t = b.table
        if (!t) break
        const withHead = t.head.length > 0
        const heights = t.heights
        const total = heights.reduce((a, x) => a + x, 0)
        units.push({
          mt: 0, h: total, mb: b.afterPt ?? skin.blank,
          draw: (top) => {
            let y = top
            const cell = (html: string, c: number, rowTop: number, rowH: number, center: boolean, valign: 'top' | 'middle', padTop: number) => {
              const pad = t.pad?.[c] ?? 4.7
              const x0 = skin.margin + t.cols.slice(0, c).reduce((a, w) => a + w, 0)
              const avail = t.cols[c] - pad - (center ? pad : 0)
              const lines = wrap(parseInline(html, vars, skin.company), skin.size, avail)
              const h = lines.length * skin.pitch
              const ct = valign === 'top' ? rowTop + padTop : rowTop + (rowH - h) / 2
              drawLines(lines, x0 + pad, ct, avail, skin.pitch, skin.size, center ? 'center' : 'left')
            }
            if (withHead) {
              t.head.forEach((h, c) => cell(h, c, y, heights[0] ?? 0, true, 'middle', 0))
              y += heights[0] ?? 0
            }
            t.rows.forEach((row, r) => {
              const rh = heights[r + (withHead ? 1 : 0)] ?? 0
              row.forEach((x, c) => cell(x.html, c, y, rh, false, x.valign ?? 'middle', x.padTop ?? 0))
              y += rh
            })
          },
        })
        break
      }
      default:
        break
    }
  }

  // ── Pagination: the browser's rule, unit for unit ─────────────────────

  const pages: Unit[][] = []
  let cur: Unit[] = []
  let used = 0
  let room = skin.bottom - skin.top[0]
  const close = () => { pages.push(cur); cur = []; used = 0; room = skin.bottom - skin.top[1] }
  units.forEach((u, i) => {
    const next = units[i + 1]
    const step = u.h + collapse(u.mb, next ? next.mt : 0)
    if (!u.pageBreak && cur.length && used + u.h > room + 0.5) close()
    cur.push(u)
    used += step
    if (u.pageBreak) close()
  })
  if (cur.length || !pages.length) pages.push(cur)

  pages.forEach((page, p) => {
    if (p > 0) doc.addPage({ size: 'A4', margin: 0 })
    let y = skin.top[p === 0 ? 0 : 1] + (page[0] ? Math.min(0, page[0].mt) : 0)
    page.forEach((u, k) => {
      u.draw(y)
      const next = page[k + 1]
      if (next) y += u.h + collapse(u.mb, next.mt)
    })
  })

  // ── Letterhead and footer on every sheet ──────────────────────────────

  const headFont = (f: FontKey, bold: boolean) =>
    (f === 'segoe' || f === 'arial' ? (bold ? 'Helvetica-Bold' : 'Helvetica') : bold ? 'TB' : 'T')
  const head = (h: HeadLine, text: string) => {
    const font = headFont(h.font, h.bold)
    const w = width(text, font, h.size)
    put(text, (W - w) / 2, h.baseline, font, h.size, h.color)
  }
  const range = doc.bufferedPageRange()
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i)
    if (hasLetterhead && (i === 0 || skin.letterhead.repeat)) {
      const { name, addr } = skin.letterhead
      head(name, (company.name ?? '').toUpperCase())
      head(addr[0], `${company.addressLine1 ?? ''},`.toUpperCase())
      head(addr[1], `${company.addressLine2 ?? ''}, ${company.city ?? ''}, ${company.state ?? ''} – ${company.pin ?? ''}`.toUpperCase())
      head(addr[2], `${company.phone ?? ''}, ${company.email ?? ''}`)
    }
    doc.rect(skin.margin - 1.4, 778.4, colW + 3, 0.5).fill('#d9d9d9')
    const fb = skin.footer.baseline
    let fx = skin.margin
    const num = String(i + 1)
    const numFont = skin.footer.spaced ? 'CB' : 'C'
    put(num, fx, fb, numFont, 11)
    fx += width(num, numFont, 11)
    put(' | ', fx, fb, 'CB', 11)
    fx += width(' | ', 'CB', 11)
    const spacing = skin.footer.spaced ? 2.9 : 0
    put('Page', fx, fb, 'C', 11, '#7f7f7f', { characterSpacing: spacing })
  }

  doc.end()
}
