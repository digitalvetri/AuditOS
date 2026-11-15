/**
 * WORKSTATION DOC — .docx renderer (POST-DELIVERY-CHANGES §D1).
 *
 * Walks the SAME ordered `blockConfig` and `fieldValues` the editor and the
 * PDF renderer consume, with the SAME block vocabulary and the SAME
 * {{placeholder}} substitution rule — so a document opened in Word matches
 * the paper, which matches what the auditor composed. Nothing here knows
 * what a consent letter is: the kind lives entirely in the data.
 *
 * Why docx alongside the PDF: the firm's clients open PDFs to read and
 * .docx to EDIT. A board resolution a client marks up and sends back has
 * to arrive as Word.
 *
 * The docx grammar is a subset of the PDF's — we render what Word can
 * represent naturally (paragraphs, headings, tables for signature grids),
 * skip layout decoration that only matters on paper (page numbers footer,
 * fine kerning), and defer rich-text styling to the few inline tags the
 * editor actually produces (b/i/u/br).
 */
import type { Response } from 'express'
import {
  AlignmentType, BorderStyle, Document, HeadingLevel, LevelFormat, PageBreak,
  Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType,
} from 'docx'
import type { Row } from './service.js'

// ── Block shapes (match pdf.ts; the editor writes the same JSON for both) ──

interface Line { id?: string; kind?: 'p' | 'bullet' | 'number'; align?: 'left' | 'center' | 'right' | 'justify'; indent?: number; html?: string }
interface KVRow { id?: string; label?: string; value?: string }
interface Person { id?: string; name?: string; role?: string; din?: string; note?: string; sign?: string; rule?: boolean }
interface Block {
  id?: string; key: string; enabled?: boolean; title?: string
  align?: 'left' | 'center' | 'right' | 'justify'; variant?: string
  lines?: Line[]; rows?: KVRow[]; people?: Person[]; columns?: number; heightPx?: number
}

interface Run { text: string; b: boolean; i: boolean; u: boolean }

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
const decode = (t: string) => t
  .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
  .replace(/&([a-z]+);/gi, (m, n: string) => ENTITIES[n.toLowerCase()] ?? m)

/** {{placeholder}} → fieldValues[placeholder], same rule the PDF uses. */
function fill(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k: string) => (k in vars && vars[k] ? vars[k] : m))
}

/** Stored inline HTML (b, i, u, br) into styled runs — tolerant by design. */
function parseInline(html: string, vars: Record<string, string>): Run[] {
  const runs: Run[] = []
  let b = 0, i = 0, u = 0
  const re = /<\s*(\/)?\s*([a-zA-Z]+)[^>]*>|([^<]+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    if (m[3] !== undefined) {
      const t = fill(decode(m[3]), vars)
      if (t) runs.push({ text: t, b: b > 0, i: i > 0, u: u > 0 })
      continue
    }
    const tag = m[2].toLowerCase()
    if (tag === 'br') { runs.push({ text: '\n', b: b > 0, i: i > 0, u: u > 0 }); continue }
    const d = m[1] ? -1 : 1
    if (tag === 'b' || tag === 'strong') b = Math.max(0, b + d)
    else if (tag === 'i' || tag === 'em') i = Math.max(0, i + d)
    else if (tag === 'u') u = Math.max(0, u + d)
  }
  return runs
}

function fmtLong(iso?: string | null): string {
  if (!iso) return ''
  const d = new Date(`${iso}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'UTC' })
}

const AL = (a?: 'left' | 'center' | 'right' | 'justify') => (
  a === 'center' ? AlignmentType.CENTER
    : a === 'right' ? AlignmentType.RIGHT
    : a === 'justify' ? AlignmentType.JUSTIFIED
    : AlignmentType.LEFT
)

/** Runs → TextRuns, splitting on '\n' (inline <br>) into separate break runs. */
function toTextRuns(runs: Run[]): TextRun[] {
  const out: TextRun[] = []
  for (const r of runs) {
    const parts = r.text.split('\n')
    parts.forEach((part, i) => {
      if (i > 0) out.push(new TextRun({ break: 1 }))
      if (part) out.push(new TextRun({ text: part, bold: r.b, italics: r.i, underline: r.u ? {} : undefined }))
    })
  }
  return out
}

function paragraphOfLine(line: Line, vars: Record<string, string>): Paragraph {
  const runs = toTextRuns(parseInline(line.html ?? '', vars))
  // docx ParagraphOptions are readonly — construct the shape upfront.
  // Bullets / numbered use docx's own numbering model; the reference-style
  // list via the built-in level is enough for a deed.
  const bullet = line.kind === 'bullet' ? { level: 0 } : undefined
  const numbering = line.kind === 'number' ? { reference: 'doc-numbered', level: 0 } : undefined
  // The editor's indent is coarse (0 / 1 / 2) — map to left indent in twips.
  const indent = line.indent && line.indent > 0
    ? { left: Math.min(line.indent, 4) * 360 }
    : undefined
  return new Paragraph({
    children: runs,
    alignment: AL(line.align),
    ...(bullet ? { bullet } : {}),
    ...(numbering ? { numbering } : {}),
    ...(indent ? { indent } : {}),
  })
}

function tableOfPeople(people: Person[], columns: number): Table {
  // Render as a simple multi-column table: one row per `columns` entries.
  // Each cell is a stacked (name, role, DIN, note, rule-for-signature) block.
  const cols = Math.max(1, Math.min(4, columns || 2))
  const rows: TableRow[] = []
  for (let i = 0; i < people.length; i += cols) {
    const cells: TableCell[] = []
    for (let j = 0; j < cols; j++) {
      const p = people[i + j]
      if (!p) { cells.push(new TableCell({ children: [new Paragraph('')] })); continue }
      const lines: Paragraph[] = []
      if (p.rule !== false) {
        lines.push(new Paragraph({ children: [new TextRun('____________________')], alignment: AlignmentType.LEFT }))
      }
      if (p.name) lines.push(new Paragraph({ children: [new TextRun({ text: p.name, bold: true })] }))
      if (p.role) lines.push(new Paragraph({ children: [new TextRun({ text: p.role, italics: true })] }))
      if (p.din) lines.push(new Paragraph({ children: [new TextRun(`DIN: ${p.din}`)] }))
      if (p.note) lines.push(new Paragraph({ children: [new TextRun(p.note)] }))
      cells.push(new TableCell({
        children: lines.length ? lines : [new Paragraph('')],
        // No visible borders — same effect as the PDF's signature grid.
        borders: {
          top: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
          bottom: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
          left: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
          right: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
        },
      }))
    }
    rows.push(new TableRow({ children: cells }))
  }
  return new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } })
}

/** Build the list of docx children (Paragraph | Table) from blockConfig. */
export function buildDocxChildren(d: Row): Array<Paragraph | Table> {
  const fv = (d.fieldValues ?? {}) as Record<string, unknown>
  const vars: Record<string, string> = { doc_date: fmtLong(d.docDate) }
  for (const [k, v] of Object.entries(fv)) {
    vars[k] = typeof v === 'string' ? v : v == null ? '' : String(v)
  }
  const children: Array<Paragraph | Table> = []
  const blocks: Block[] = Array.isArray(d.blockConfig) ? (d.blockConfig as unknown as Block[]) : []

  type HL = (typeof HeadingLevel)[keyof typeof HeadingLevel]
  const heading = (text: string, align?: Block['align'], level: HL = HeadingLevel.HEADING_1) =>
    new Paragraph({ children: [new TextRun({ text, bold: true })], alignment: AL(align), heading: level, spacing: { before: 200, after: 120 } })

  for (const b of blocks) {
    if (b.enabled === false) continue
    switch (b.key) {
      case 'heading': {
        if (b.title) children.push(heading(fill(b.title, vars), b.align, HeadingLevel.HEADING_1))
        break
      }
      case 'section': {
        if (b.title) children.push(heading(fill(b.title, vars), b.align, HeadingLevel.HEADING_2))
        break
      }
      case 'subject': {
        if (b.title) children.push(new Paragraph({
          children: [new TextRun({ text: fill(b.title, vars), bold: true })],
          alignment: AL(b.align), spacing: { before: 120, after: 80 },
        }))
        break
      }
      case 'date': {
        children.push(new Paragraph({ children: [new TextRun(`Date: ${fmtLong(d.docDate)}`)], alignment: AL(b.align) }))
        break
      }
      case 'address': {
        for (const line of (b.lines ?? [])) children.push(paragraphOfLine(line, vars))
        children.push(new Paragraph(''))
        break
      }
      case 'paragraph': {
        for (const line of (b.lines ?? [])) children.push(paragraphOfLine(line, vars))
        break
      }
      case 'keyvalue': {
        // Two-column table so labels line up cleanly.
        const rows = (b.rows ?? []).filter((r) => (r.label || r.value))
        if (rows.length === 0) break
        const trs = rows.map((r) => new TableRow({
          children: [
            new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: fill(r.label ?? '', vars), bold: true })] })], width: { size: 35, type: WidthType.PERCENTAGE } }),
            new TableCell({ children: [new Paragraph({ children: [new TextRun(fill(r.value ?? '', vars))] })], width: { size: 65, type: WidthType.PERCENTAGE } }),
          ],
        }))
        children.push(new Table({ rows: trs, width: { size: 100, type: WidthType.PERCENTAGE } }))
        children.push(new Paragraph(''))
        break
      }
      case 'signature':
      case 'witness': {
        if (b.title) children.push(heading(fill(b.title, vars), b.align, HeadingLevel.HEADING_3))
        const people = (b.people ?? []).map((p) => ({
          ...p,
          name: p.name ? fill(p.name, vars) : p.name,
          role: p.role ? fill(p.role, vars) : p.role,
          din: p.din ? fill(p.din, vars) : p.din,
          note: p.note ? fill(p.note, vars) : p.note,
        }))
        if (people.length) children.push(tableOfPeople(people, b.columns ?? 2))
        children.push(new Paragraph(''))
        break
      }
      case 'placedate': {
        children.push(new Paragraph({ children: [new TextRun(`Date: ${fmtLong(d.docDate)}`)], alignment: AL(b.align) }))
        children.push(new Paragraph({ children: [new TextRun(`Place: ${fill((b.title ?? '').trim() || '{{place}}', vars)}`)], alignment: AL(b.align) }))
        children.push(new Paragraph(''))
        break
      }
      case 'spacer': {
        // Word doesn't have a px spacer; one empty paragraph per 24px of PDF
        // height is a close-enough approximation.
        const h = typeof b.heightPx === 'number' ? b.heightPx : 24
        const n = Math.max(1, Math.round(h / 24))
        for (let i = 0; i < n; i++) children.push(new Paragraph(''))
        break
      }
      case 'pagebreak': {
        children.push(new Paragraph({ children: [new PageBreak()] }))
        break
      }
      default:
        break
    }
  }
  return children
}

/** The route-facing export: build the document, pack, write the response. */
export async function streamDocDocx(res: Response, d: Row): Promise<void> {
  const children = buildDocxChildren(d)
  const doc = new Document({
    numbering: {
      config: [{
        reference: 'doc-numbered',
        levels: [{
          level: 0,
          format: LevelFormat.DECIMAL,
          text: '%1.',
          alignment: AlignmentType.START,
          style: { paragraph: { indent: { left: 720, hanging: 360 } } },
        }],
      }],
    },
    sections: [{ properties: {}, children }],
  })
  const buffer = await Packer.toBuffer(doc)
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
  res.setHeader('Content-Disposition', `attachment; filename="${d.docCode}.docx"`)
  res.end(buffer)
}
