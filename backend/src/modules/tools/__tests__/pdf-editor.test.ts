import { describe, expect, it } from 'vitest'
import { PDFDocument, degrees } from 'pdf-lib'
import { applyPdfEdits, parseEditSpec } from '../services/tools/PdfEditor.js'
import { ToolError } from '../services/errors.js'

/**
 * PDF editor: edits recorded in user space land where they were placed —
 * including on a page with /Rotate and a MediaBox that does not start at 0,0 —
 * pages reorder / rotate / delete / insert, ₹ draws, and bad input is a 400.
 */

// 1x1 transparent PNG.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

async function fixture() {
  const d = await PDFDocument.create()
  d.addPage([595.28, 841.89])                       // page 0: plain A4
  const p1 = d.addPage([600, 800])                  // page 1: offset box, rotated
  p1.setMediaBox(100, 100, 600, 800)          // x, y, width, height → [100 100 700 900]
  p1.setRotation(degrees(90))
  d.addPage([400, 400])                             // page 2: will be deleted
  return Buffer.from(await d.save())
}

async function textItems(bytes: Buffer) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, isEvalSupported: false }).promise
  const pages = []
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const tc = await page.getTextContent()
    pages.push({
      rotate: page.rotate,
      view: page.view,
      items: tc.items.map((it) => ({ str: (it as { str: string }).str, x: (it as { transform: number[] }).transform[4], y: (it as { transform: number[] }).transform[5] })).filter((t) => t.str.trim()),
    })
  }
  return pages
}

describe('PDF editor', () => {
  it('applies every kind of edit and rebuilds the page order', async () => {
    const spec = parseEditSpec({
      pages: [
        { source: 1 },                 // rotated, offset page first
        { source: 0, rotate: 90 },     // then the A4 page, turned
        { source: null },              // a blank page; page 2 is dropped
      ],
      objects: [
        { type: 'whiteout', page: 1, x: 70, y: 690, w: 200, h: 20 },
        { type: 'text', page: 1, x: 72, y: 700, lines: ['Fee ₹ 1,500 received', 'Second line'], size: 12, font: 'sans', bold: true },
        { type: 'text', page: 0, x: 150, y: 750, lines: ['On the rotated page'], size: 10, font: 'serif', italic: true, rotation: 90 },
        { type: 'highlight', page: 1, x: 70, y: 600, w: 120, h: 14 },
        { type: 'rect', page: 1, x: 60, y: 500, w: 100, h: 50 },
        { type: 'ink', page: 1, points: [[100, 400], [120, 420], [150, 410]] },
        { type: 'image', page: 2, x: 50, y: 50, w: 100, h: 40, data: PNG },
        { type: 'text', page: 2, x: 72, y: 760, lines: ['Annexure'], size: 18 },
        // Arial-metric font with no ₹ glyph: ₹ falls back to Carlito mid-line.
        { type: 'text', page: 2, x: 72, y: 700, lines: ['Total ₹ 2,40,000 only'], size: 12, font: 'arial' },
      ],
    })
    const r = await applyPdfEdits(await fixture(), spec)
    expect(r.meta).toMatchObject({ pages: 3, blank_pages: 1, objects: { text: 4, whiteout: 1, highlight: 1, rect: 1, ink: 1, image: 1 } })

    const pages = await textItems(r.bytes)
    expect(pages).toHaveLength(3)
    // Order and rotation: the offset page keeps its /Rotate 90 and box; A4 turned 90.
    expect(pages[0].rotate).toBe(90)
    expect(pages[0].view).toEqual([100, 100, 700, 900])
    expect(pages[1].rotate).toBe(90)
    expect(pages[1].view).toEqual([0, 0, 595.28, 841.89])

    // Text lands at the user-space point it was placed at (±2pt).
    const fee = pages[1].items.find((t) => t.str.includes('1,500'))!
    expect(fee.str).toBe('Fee ₹ 1,500 received')
    expect(Math.abs(fee.x - 72)).toBeLessThan(2)
    expect(Math.abs(fee.y - 700)).toBeLessThan(2)
    const second = pages[1].items.find((t) => t.str === 'Second line')!
    expect(Math.abs(second.y - (700 - 12 * 1.2))).toBeLessThan(2)

    const rotated = pages[0].items.find((t) => t.str === 'On the rotated page')!
    expect(Math.abs(rotated.x - 150)).toBeLessThan(2)
    expect(Math.abs(rotated.y - 750)).toBeLessThan(2)

    // Three runs on one baseline, left to right: Liberation Sans, Carlito (₹), Liberation Sans.
    expect(pages[2].items.map((t) => t.str.trim())).toEqual(['Annexure', 'Total', '₹', '2,40,000 only'])
    const [, tot, rupee, rest] = pages[2].items
    expect(tot.x < rupee.x && rupee.x < rest.x).toBe(true)
    expect(Math.abs(rupee.y - 700) + Math.abs(rest.y - 700)).toBeLessThan(2)
    const total = pages[2].items.find((t) => t.str.startsWith('Total'))!
    expect(Math.abs(total.x - 72)).toBeLessThan(2)
    expect(Math.abs(total.y - 700)).toBeLessThan(2)
  })

  it('refuses bad input with a clear message', async () => {
    const bytes = await fixture()
    const bad = async (raw: unknown) => {
      try { await applyPdfEdits(bytes, parseEditSpec(raw)); return null } catch (e) { return e }
    }
    const outOfRange = await bad({ pages: [{ source: 9 }] })
    expect(outOfRange).toBeInstanceOf(ToolError)
    expect((outOfRange as ToolError).code).toBe('invalid_options')

    expect(await bad({ pages: [{ source: 0 }], objects: [{ type: 'rect', page: 0, x: Number.NaN, y: 0, w: 1, h: 1 }] })).toBeInstanceOf(ToolError)
    expect(await bad({ pages: [{ source: 0 }], objects: [{ type: 'rect', page: 3, x: 0, y: 0, w: 1, h: 1 }] })).toBeInstanceOf(ToolError)
    expect(await bad({ pages: [] })).toBeInstanceOf(ToolError)
    expect(await bad({ pages: [{ source: 0 }], objects: Array.from({ length: 2001 }, () => ({ type: 'rect', page: 0, x: 0, y: 0, w: 1, h: 1 })) })).toBeInstanceOf(ToolError)
    expect(await bad({ pages: [{ source: 0 }], objects: [{ type: 'image', page: 0, x: 0, y: 0, w: 1, h: 1, data: 'data:image/gif;base64,AAAA' }] })).toBeInstanceOf(ToolError)

    const cjk = await bad({ pages: [{ source: 0 }], objects: [{ type: 'text', page: 0, x: 10, y: 10, lines: ['会计'], size: 12 }] })
    expect(cjk).toBeInstanceOf(ToolError)
    expect((cjk as ToolError).message).toMatch(/cannot draw/)
  })

  it('a password-protected PDF is turned away towards Unlock PDF', async () => {
    const enc = Buffer.from('%PDF-1.7\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R/Encrypt<</Filter/Standard>>>>\n%%EOF')
    await expect(applyPdfEdits(enc, parseEditSpec({ pages: [{ source: 0 }] }))).rejects.toBeInstanceOf(ToolError)
  })
})
