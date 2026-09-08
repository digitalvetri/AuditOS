import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { PDFDocument } from 'pdf-lib'
import { run, withTempDir, ToolProcessError } from '../../lib/exec.js'
import { ToolError } from '../errors.js'

/**
 * PDFService — everything that reads or rewrites PDF bytes.
 *
 *   pdf-lib     merge / split / page count / drawing (pure JS, fast)
 *   pdfjs-dist  text extraction with coordinates (tables, Word export, OCR gate)
 *   ghostscript compress and decrypt (re-encodes the file)
 *   poppler     page rasters for thumbnails and OCR (pdftoppm)
 *
 * No React, no Express, no Prisma in here — Buffers in, Buffers out.
 */

// ── pdfjs bootstrap ──────────────────────────────────────────────────────
type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs')
let pdfjsPromise: Promise<PdfJs> | null = null
function pdfjs(): Promise<PdfJs> {
  if (!pdfjsPromise) {
    pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs').then((m) => {
      const require = createRequire(import.meta.url)
      m.GlobalWorkerOptions.workerSrc = require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')
      return m
    })
  }
  return pdfjsPromise
}

// ── Text model ───────────────────────────────────────────────────────────
export interface TextSpan {
  x0: number
  x1: number
  y: number      // baseline, PDF user space (origin bottom-left)
  h: number      // font size
  text: string
  bold: boolean
}
export interface TextLine {
  y: number
  h: number
  cells: TextSpan[]   // spans separated by a gap wide enough to be a column
}
export interface PageText {
  page: number
  width: number
  height: number
  lines: TextLine[]
  charCount: number
}

const CELL_GAP_EM = 1.1   // horizontal gap (in ems) that separates two cells
const WORD_GAP_EM = 0.12  // smaller gaps are just kerning; join without a space
const BULLET = /^[•●○◦▪■□◆◇►▸‣⁃\-–—*·]$/

export const PDFService = {
  async load(bytes: Buffer): Promise<PDFDocument> {
    try {
      const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false })
      // A truncated or garbage file can "load" and then explode on first use.
      if (doc.getPageCount() < 1) throw new Error('no pages')
      return doc
    } catch {
      throw new ToolError('unreadable', "We couldn't read this PDF. It may be corrupted or password-protected.")
    }
  },

  async pageCount(bytes: Buffer): Promise<number> {
    return (await PDFService.load(bytes)).getPageCount()
  },

  async isEncrypted(bytes: Buffer): Promise<boolean> {
    return (await PDFService.load(bytes)).isEncrypted
  },

  /** Text with layout for every page. Throws `unreadable` when pdfjs cannot open the file. */
  async extractText(bytes: Buffer, onPage?: (done: number, total: number) => void): Promise<PageText[]> {
    const lib = await pdfjs()
    let doc
    try {
      doc = await lib.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true, disableFontFace: true, isEvalSupported: false }).promise
    } catch (err) {
      const name = (err as { name?: string }).name
      if (name === 'PasswordException') throw new ToolError('encrypted', 'This PDF is password-protected. Use Unlock PDF first.')
      throw new ToolError('unreadable', "We couldn't read this PDF. It may be corrupted or password-protected.")
    }
    const pages: PageText[] = []
    try {
      for (let p = 1; p <= doc.numPages; p++) {
        const page = await doc.getPage(p)
        const vp = page.getViewport({ scale: 1 })
        const tc = await page.getTextContent()
        const spans: TextSpan[] = []
        for (const it of tc.items) {
          if (!('str' in it)) continue
          const text = it.str
          if (!text || !text.trim()) continue
          const [a, b, c, d, e, f] = it.transform
          const h = Math.hypot(c, d) || Math.hypot(a, b) || it.height || 10
          const w = it.width || text.length * h * 0.5
          const style = tc.styles[it.fontName]
          const bold = /bold|black|heavy|semibold/i.test(it.fontName) || /bold/i.test(style?.fontFamily ?? '')
          spans.push({ x0: e, x1: e + w, y: f, h, text, bold })
        }
        pages.push({ page: p, width: vp.width, height: vp.height, lines: groupLines(spans), charCount: spans.reduce((n, s) => n + s.text.length, 0) })
        onPage?.(p, doc.numPages)
      }
    } finally {
      await doc.destroy().catch(() => undefined)
    }
    return pages
  },

  /** A page has a usable text layer if it carries more than a handful of characters. */
  hasTextLayer(pages: PageText[]): boolean {
    const total = pages.reduce((n, p) => n + p.charCount, 0)
    return total >= Math.max(20, pages.length * 5)
  },

  /** Tables per page. Pages without a table are reported so nothing is dropped silently. */
  detectTables(page: PageText): string[][][] {
    return findTables(page.lines)
  },

  async merge(files: Buffer[], onProgress?: (pct: number) => void): Promise<{ bytes: Buffer; pageCount: number }> {
    const out = await PDFDocument.create()
    let done = 0
    for (const bytes of files) {
      const src = await PDFService.load(bytes)
      if (src.isEncrypted) throw new ToolError('encrypted', 'One of the files is password-protected. Unlock it first, then merge.')
      const pages = await out.copyPages(src, src.getPageIndices())
      pages.forEach((p) => out.addPage(p))
      done++
      onProgress?.((done / files.length) * 100)
    }
    return { bytes: Buffer.from(await out.save()), pageCount: out.getPageCount() }
  },

  /** '1-3, 7, 10-12' → [[1,2,3],[7],[10,11,12]] (1-based, validated). */
  parseRanges(spec: string, pageCount: number): number[][] {
    const groups: number[][] = []
    for (const raw of spec.split(',')) {
      const part = raw.trim()
      if (!part) continue
      const m = /^(\d+)\s*(?:-\s*(\d+))?$/.exec(part)
      if (!m) throw new ToolError('invalid_range', `"${part}" isn't a valid page range. Use forms like 1-3, 7, 10-12.`)
      const a = Number(m[1])
      const b = m[2] ? Number(m[2]) : a
      if (a < 1 || b < a || b > pageCount) throw new ToolError('invalid_range', `Range "${part}" is outside pages 1–${pageCount}.`)
      const pages: number[] = []
      for (let i = a; i <= b; i++) pages.push(i)
      groups.push(pages)
    }
    if (groups.length === 0) throw new ToolError('invalid_range', 'Enter at least one page or range.')
    return groups
  },

  async split(bytes: Buffer, groups: number[][], onProgress?: (pct: number) => void): Promise<Buffer[]> {
    const src = await PDFService.load(bytes)
    if (src.isEncrypted) throw new ToolError('encrypted', 'This PDF is password-protected. Use Unlock PDF first.')
    const outputs: Buffer[] = []
    for (let i = 0; i < groups.length; i++) {
      const out = await PDFDocument.create()
      const pages = await out.copyPages(src, groups[i].map((p) => p - 1))
      pages.forEach((p) => out.addPage(p))
      outputs.push(Buffer.from(await out.save()))
      onProgress?.(((i + 1) / groups.length) * 100)
    }
    return outputs
  },

  async compress(bytes: Buffer, level: 'low' | 'recommended' | 'high'): Promise<Buffer> {
    const preset = level === 'low' ? '/printer' : level === 'high' ? '/screen' : '/ebook'
    return withTempDir('compress', async (dir) => {
      const input = path.join(dir, 'in.pdf')
      const output = path.join(dir, 'out.pdf')
      await fs.writeFile(input, bytes)
      try {
        await run('gs', [
          '-sDEVICE=pdfwrite', '-dCompatibilityLevel=1.5', `-dPDFSETTINGS=${preset}`,
          '-dNOPAUSE', '-dQUIET', '-dBATCH', '-dSAFER',
          '-dDetectDuplicateImages=true', '-dCompressFonts=true', '-dSubsetFonts=true',
          `-sOutputFile=${output}`, input,
        ], { timeoutMs: 240_000 })
      } catch (err) {
        throw translateGs(err)
      }
      return fs.readFile(output)
    })
  },

  /** Decrypt with a password the user already knows. Never guesses. */
  async unlock(bytes: Buffer, password: string): Promise<Buffer> {
    const source = await PDFService.load(bytes)
    if (!source.isEncrypted) {
      throw new ToolError('not_encrypted', "This PDF isn't password-protected — there is nothing to unlock.")
    }
    const expectedPages = source.getPageCount()
    return withTempDir('unlock', async (dir) => {
      const input = path.join(dir, 'in.pdf')
      const output = path.join(dir, 'out.pdf')
      await fs.writeFile(input, bytes)
      let log = ''
      try {
        // Ghostscript reports a bad password on stdout and still exits 0, so
        // the transcript is checked explicitly and the result is verified.
        const r = await run('gs', [
          `-sPDFPassword=${password}`,
          '-sDEVICE=pdfwrite', '-dNOPAUSE', '-dBATCH', '-dSAFER', '-dPDFSTOPONERROR',
          `-sOutputFile=${output}`, input,
        ], { timeoutMs: 240_000 })
        log = `${r.stdout}\n${r.stderr}`.toLowerCase()
      } catch (err) {
        log = err instanceof ToolProcessError ? err.stderr.toLowerCase() : ''
        if (log.includes('password') || log.includes('decrypt')) throw new ToolError('wrong_password', 'Incorrect password.')
        throw translateGs(err)
      }
      if (log.includes('password did not work') || log.includes('cannot decrypt') || log.includes("couldn't initialise")) {
        throw new ToolError('wrong_password', 'Incorrect password.')
      }
      const out = await fs.readFile(output).catch(() => null)
      if (!out) throw new ToolError('wrong_password', 'Incorrect password.')
      const result = await PDFService.load(out).catch(() => null)
      if (!result || result.isEncrypted || result.getPageCount() !== expectedPages) throw new ToolError('wrong_password', 'Incorrect password.')
      return out
    })
  },

  /** PNG thumbnails, `scaleTo` px on the longer edge. Pages are 1-based. */
  async thumbnails(bytes: Buffer, scaleTo = 220, maxPages = 300): Promise<Buffer[]> {
    return withTempDir('thumbs', async (dir) => {
      const input = path.join(dir, 'in.pdf')
      await fs.writeFile(input, bytes)
      try {
        await run('pdftoppm', ['-png', '-scale-to', String(scaleTo), '-l', String(maxPages), input, path.join(dir, 'p')], { timeoutMs: 180_000 })
      } catch (err) {
        throw translatePoppler(err)
      }
      return readNumbered(dir, 'p')
    })
  },

  /** Full-resolution page rasters for OCR. */
  async rasterize(bytes: Buffer, dpi = 200, maxPages = 100): Promise<Buffer[]> {
    return withTempDir('raster', async (dir) => {
      const input = path.join(dir, 'in.pdf')
      await fs.writeFile(input, bytes)
      try {
        await run('pdftoppm', ['-png', '-r', String(dpi), '-l', String(maxPages), input, path.join(dir, 'p')], { timeoutMs: 300_000 })
      } catch (err) {
        throw translatePoppler(err)
      }
      return readNumbered(dir, 'p')
    })
  },
}

// ── Helpers ──────────────────────────────────────────────────────────────
async function readNumbered(dir: string, prefix: string): Promise<Buffer[]> {
  const names = (await fs.readdir(dir))
    .filter((n) => n.startsWith(`${prefix}-`) && n.endsWith('.png'))
    .sort((a, b) => Number(a.match(/-(\d+)\.png$/)?.[1]) - Number(b.match(/-(\d+)\.png$/)?.[1]))
  return Promise.all(names.map((n) => fs.readFile(path.join(dir, n))))
}

function translateGs(err: unknown): ToolError {
  const text = err instanceof ToolProcessError ? err.stderr.toLowerCase() : ''
  if (text.includes('password')) return new ToolError('encrypted', 'This PDF is password-protected. Use Unlock PDF first.')
  return new ToolError('unreadable', "We couldn't read this PDF. It may be corrupted or password-protected.")
}
function translatePoppler(err: unknown): ToolError {
  const text = err instanceof ToolProcessError ? err.stderr.toLowerCase() : ''
  if (text.includes('encrypted') || text.includes('password')) return new ToolError('encrypted', 'This PDF is password-protected. Use Unlock PDF first.')
  return new ToolError('unreadable', "We couldn't read this PDF. It may be corrupted or password-protected.")
}

/** Spans → lines (by baseline) → cells (by horizontal gap). */
export function groupLines(spans: TextSpan[]): TextLine[] {
  const sorted = [...spans].sort((a, b) => b.y - a.y || a.x0 - b.x0)
  const lines: { y: number; h: number; spans: TextSpan[] }[] = []
  for (const s of sorted) {
    const last = lines[lines.length - 1]
    if (last && Math.abs(last.y - s.y) <= Math.max(last.h, s.h) * 0.45) {
      last.spans.push(s)
      last.h = Math.max(last.h, s.h)
    } else {
      lines.push({ y: s.y, h: s.h, spans: [s] })
    }
  }
  return lines.map((ln) => {
    const items = ln.spans.sort((a, b) => a.x0 - b.x0)
    const cells: TextSpan[] = []
    for (const s of items) {
      const prev = cells[cells.length - 1]
      if (!prev) { cells.push({ ...s }); continue }
      const gap = s.x0 - prev.x1
      const em = Math.max(prev.h, s.h, 4)
      if (gap > em * CELL_GAP_EM) {
        cells.push({ ...s })
      } else {
        const joiner = gap > em * WORD_GAP_EM && !prev.text.endsWith(' ') && !s.text.startsWith(' ') ? ' ' : ''
        prev.text = `${prev.text}${joiner}${s.text}`.replace(/\s{2,}/g, ' ')
        prev.x1 = Math.max(prev.x1, s.x1)
        prev.h = Math.max(prev.h, s.h)
        prev.bold = prev.bold && s.bold
      }
    }
    const trimmed = cells.map((c) => ({ ...c, text: c.text.trim() }))
    // A lone bullet glyph is a list marker, not a table column: fold it into
    // the text that follows so the line reads "• item" as one cell.
    if (trimmed.length >= 2 && BULLET.test(trimmed[0].text)) {
      const [marker, first, ...rest] = trimmed
      return { y: ln.y, h: ln.h, cells: [{ ...first, x0: marker.x0, text: `• ${first.text}` }, ...rest] }
    }
    return { y: ln.y, h: ln.h, cells: trimmed }
  })
}

/**
 * Table detection on one page's lines.
 *
 * A table is a run of consecutive lines with ≥2 cells, close together
 * vertically. Column spans come from the rows with the most cells (so a
 * merged header cannot swallow the columns beneath it); every other cell
 * lands in the column it overlaps most, which keeps right-aligned numbers
 * under their heading. A 1-cell line inside a run is a continuation of the
 * previous row (multi-line cell) and is appended, never dropped.
 */
export interface TableBlock { start: number; end: number; rows: string[][] }

export function findTables(lines: TextLine[]): string[][][] {
  return findTableBlocks(lines).map((b) => b.rows)
}

/** Like findTables, but also says which line indexes each table consumed. */
export function findTableBlocks(lines: TextLine[]): TableBlock[] {
  const tables: TableBlock[] = []
  let block: number[] = []
  const flush = () => {
    // Trim leading / trailing single-cell lines; they are prose, not rows.
    while (block.length && lines[block[0]].cells.length < 2) block.shift()
    while (block.length && lines[block[block.length - 1]].cells.length < 2) block.pop()
    const multi = block.filter((i) => lines[i].cells.length >= 2)
    if (multi.length >= 2) tables.push({ start: block[0], end: block[block.length - 1], rows: buildTable(block.map((i) => lines[i])) })
    block = []
  }
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i]
    const prev = block.length ? lines[block[block.length - 1]] : undefined
    if (prev) {
      const gap = prev.y - ln.y
      if (gap > Math.max(prev.h, ln.h) * 2.6) flush()
    }
    if (ln.cells.length >= 2) {
      block.push(i)
    } else if (block.length) {
      // Single-cell line: keep it in the block only if a multi-cell line follows soon.
      const next = lines[i + 1]
      const nextIsRow = next && next.cells.length >= 2 && ln.y - next.y <= Math.max(ln.h, next.h) * 2.6
      if (nextIsRow) block.push(i)
      else flush()
    }
  }
  flush()
  return tables
}

function buildTable(block: TextLine[]): string[][] {
  const maxCells = Math.max(...block.map((l) => l.cells.length))
  const anchors = block.filter((l) => l.cells.length === maxCells)
  // Column spans from the anchor rows.
  const spans: { x0: number; x1: number }[] = []
  for (let c = 0; c < maxCells; c++) {
    const xs0 = anchors.map((l) => l.cells[c].x0)
    const xs1 = anchors.map((l) => l.cells[c].x1)
    spans.push({ x0: Math.min(...xs0), x1: Math.max(...xs1) })
  }
  // Resolve overlaps between neighbouring spans at the midpoint.
  for (let c = 1; c < spans.length; c++) {
    if (spans[c].x0 < spans[c - 1].x1) {
      const mid = (spans[c].x0 + spans[c - 1].x1) / 2
      spans[c - 1].x1 = mid
      spans[c].x0 = mid
    }
  }
  const columnOf = (cell: TextSpan): number => {
    let best = 0
    let bestOverlap = -Infinity
    for (let c = 0; c < spans.length; c++) {
      const overlap = Math.min(cell.x1, spans[c].x1) - Math.max(cell.x0, spans[c].x0)
      const score = overlap > 0 ? overlap : -Math.min(Math.abs(cell.x0 - spans[c].x1), Math.abs(spans[c].x0 - cell.x1))
      if (score > bestOverlap) { bestOverlap = score; best = c }
    }
    return best
  }
  const rows: string[][] = []
  for (const ln of block) {
    const row: string[] = new Array(maxCells).fill('')
    for (const cell of ln.cells) {
      const c = columnOf(cell)
      row[c] = row[c] ? `${row[c]} ${cell.text}` : cell.text
    }
    const filled = row.filter(Boolean).length
    const prev = rows[rows.length - 1]
    if (ln.cells.length === 1 && prev && filled === 1) {
      // Continuation of a multi-line cell.
      const c = row.findIndex(Boolean)
      prev[c] = prev[c] ? `${prev[c]}\n${row[c]}` : row[c]
      continue
    }
    rows.push(row)
  }
  return rows
}
