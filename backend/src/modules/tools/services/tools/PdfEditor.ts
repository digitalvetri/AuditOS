import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { PDFDocument, degrees, rgb, type PDFFont, type PDFImage, type PDFPage } from 'pdf-lib'
// @ts-expect-error fontkit 1.x ships no type declarations; pdf-lib only needs its `create`.
import fontkit from 'fontkit'
import { ToolError } from '../errors.js'

/**
 * PDF EDITOR — applies the edits made in the browser editor to the original.
 *
 * The browser renders the pages (pdf.js) and records every edit in PDF USER
 * SPACE — the page's own coordinates, before its /Rotate, from the page's
 * viewport (convertToPdfPoint) — so the server draws exactly where the user
 * placed it whatever the page's rotation or MediaBox origin.
 *
 *   pages    the final document, in order: each an original page (by its
 *            0-based index) or a blank page, plus extra rotation
 *   objects  drawn on a final page (by its position in `pages`):
 *     text       lines of text, baseline-left origin, rotated with the page
 *                it was typed on; Carlito (sans) / Tinos (serif), embedded,
 *                so ₹ and accented Latin draw
 *     whiteout   an opaque box (to cover text before retyping it)
 *     highlight  a translucent box
 *     rect       an outlined box
 *     ink        a freehand stroke, as straight segments
 *     image      PNG / JPEG (signatures, stamps, logos)
 *
 * White-out COVERS, it does not remove: the covered text is still in the file
 * and can be searched or copied. The editor says so.
 *
 * Everything from the browser is validated here; nothing is trusted.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FONT_DIR = [path.resolve(HERE, '../../../../../assets/fonts'), path.resolve(HERE, '../../../../../../assets/fonts')]
  .find((p) => existsSync(path.join(p, 'Carlito-Regular.ttf'))) ?? path.resolve(HERE, '../../../../../assets/fonts')

const FONT_FILES = {
  'sans:0:0': 'Carlito-Regular.ttf', 'sans:1:0': 'Carlito-Bold.ttf',
  // Carlito has no italic cut: sans italic is the upright face slanted.
  'sans:0:1': 'Carlito-Regular.ttf', 'sans:1:1': 'Carlito-Bold.ttf',
  'serif:0:0': 'Tinos-Regular.ttf', 'serif:1:0': 'Tinos-Bold.ttf',
  'serif:0:1': 'Tinos-Italic.ttf', 'serif:1:1': 'Tinos-BoldItalic.ttf',
  // Arial / Helvetica metrics — the most common PDF text. No ₹ glyph: those
  // characters fall back to Carlito, exactly as the browser does on screen.
  'arial:0:0': 'LiberationSans-Regular.ttf', 'arial:1:0': 'LiberationSans-Bold.ttf',
  'arial:0:1': 'LiberationSans-Italic.ttf', 'arial:1:1': 'LiberationSans-BoldItalic.ttf',
} as const
type FontKey = keyof typeof FONT_FILES
const fontCache = new Map<string, Promise<Buffer>>()
const fontBytes = (file: string) => {
  if (!fontCache.has(file)) fontCache.set(file, fs.readFile(path.join(FONT_DIR, file)))
  return fontCache.get(file)!
}

export const MAX_OBJECTS = 2000
export const MAX_PAGES = 1000
const num = z.number().finite()
const coord = num.min(-100_000).max(100_000)
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Colours are #rrggbb.')

const pageSpec = z.object({
  /** 0-based index of the original page; null = a blank page. */
  source: z.number().int().min(0).nullable(),
  /** Extra clockwise rotation on top of the page's own. */
  rotate: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).default(0),
  /** Blank pages only: size in points (defaults to A4). */
  width: num.min(36).max(14_400).optional(),
  height: num.min(36).max(14_400).optional(),
})

const base = { page: z.number().int().min(0) }
const box = { ...base, x: coord, y: coord, w: num.min(0.5).max(100_000), h: num.min(0.5).max(100_000) }

const objectSpec = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('text'), ...base,
    /** Baseline-left of the first line, user space. */
    x: coord, y: coord,
    lines: z.array(z.string().max(2000)).min(1).max(200),
    size: num.min(2).max(400),
    font: z.enum(['arial', 'sans', 'serif']).default('arial'),
    bold: z.boolean().default(false),
    italic: z.boolean().default(false),
    color: color.default('#000000'),
    /** Counter-clockwise degrees, so text typed on a rotated page reads upright. */
    rotation: num.min(-360).max(360).default(0),
    lineHeight: num.min(0.5).max(5).default(1.2),
  }),
  z.object({ type: z.literal('whiteout'), ...box, color: color.default('#ffffff') }),
  z.object({ type: z.literal('highlight'), ...box, color: color.default('#fde047'), opacity: num.min(0.05).max(1).default(0.4) }),
  z.object({ type: z.literal('rect'), ...box, color: color.default('#dc2626'), borderWidth: num.min(0.25).max(40).default(1.5) }),
  z.object({
    type: z.literal('ink'), ...base,
    points: z.array(z.tuple([coord, coord])).min(2).max(5000),
    color: color.default('#1d4ed8'), width: num.min(0.25).max(60).default(2),
  }),
  z.object({
    type: z.literal('image'), ...base,
    /** The image's bottom-left corner (before rotation), user space. */
    x: coord, y: coord, w: num.min(1).max(100_000), h: num.min(1).max(100_000),
    rotation: num.min(-360).max(360).default(0),
    /** data:image/png;base64,… or data:image/jpeg;base64,… */
    data: z.string().max(8_000_000).regex(/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/, 'Images must be PNG or JPEG.'),
    opacity: num.min(0.05).max(1).default(1),
  }),
])

export const editSpec = z.object({
  pages: z.array(pageSpec).min(1, 'The document needs at least one page.').max(MAX_PAGES),
  objects: z.array(objectSpec).max(MAX_OBJECTS, `At most ${MAX_OBJECTS} edits in one save.`).default([]),
})
export type EditSpec = z.infer<typeof editSpec>
type Obj = EditSpec['objects'][number]

/** Parse the browser's edit list, as a 400 with the first problem when it is wrong. */
export function parseEditSpec(raw: unknown): EditSpec {
  const r = editSpec.safeParse(raw)
  if (!r.success) {
    const i = r.error.issues[0]
    throw new ToolError('invalid_options', `The edits could not be read (${i.path.join('.') || 'edits'}: ${i.message}). Reload the editor and try again.`)
  }
  return r.data
}

function hex(c: string) {
  const n = parseInt(c.slice(1), 16)
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255)
}

/**
 * Split a line into runs the primary font can draw and runs it cannot, which
 * use the fallback (Carlito) — the browser's own per-glyph fallback, so the
 * saved PDF matches the editor. A character neither can draw is refused.
 */
function runsOf(line: string, primary: PDFFont, fallback: PDFFont): { text: string; font: PDFFont }[] {
  const has = new Set(primary.getCharacterSet())
  const hasFb = new Set(fallback.getCharacterSet())
  const runs: { text: string; font: PDFFont }[] = []
  const missing = new Set<string>()
  for (const ch of line) {
    const cp = ch.codePointAt(0)!
    const font = /\s/.test(ch) || has.has(cp) ? primary : hasFb.has(cp) ? fallback : null
    if (!font) { missing.add(ch); continue }
    const last = runs[runs.length - 1]
    if (last && last.font === font) last.text += ch
    else runs.push({ text: ch, font })
  }
  if (missing.size) {
    throw new ToolError('invalid_options',
      `Some text has characters the editor's fonts cannot draw (${[...missing].slice(0, 6).join(' ')}). English letters, numbers, ₹ and common punctuation work.`)
  }
  return runs
}

export interface EditResult { bytes: Buffer; meta: { pages: number; objects: Record<string, number>; blank_pages: number } }

export async function applyPdfEdits(input: Buffer, spec: EditSpec): Promise<EditResult> {
  let src: PDFDocument
  try {
    src = await PDFDocument.load(input, { updateMetadata: false })
  } catch (err) {
    const msg = (err as Error).message ?? ''
    if (/encrypt/i.test(msg)) throw new ToolError('encrypted', 'This PDF is password-protected. Remove the password with Unlock PDF first, then edit it.')
    throw new ToolError('unreadable', 'This PDF could not be read. It may be damaged.')
  }
  if (src.isEncrypted) throw new ToolError('encrypted', 'This PDF is password-protected. Remove the password with Unlock PDF first, then edit it.')
  const srcCount = src.getPageCount()

  for (const [i, p] of spec.pages.entries()) {
    if (p.source !== null && p.source >= srcCount) throw new ToolError('invalid_options', `Page ${i + 1} refers to a page the PDF does not have. Reload the editor.`)
  }
  for (const o of spec.objects) {
    if (o.page >= spec.pages.length) throw new ToolError('invalid_options', 'An edit is on a page that is no longer in the document. Reload the editor.')
  }

  // Build the final document: original pages copied in the new order (a page
  // may appear once), blank pages added, rotation = own + extra.
  const out = await PDFDocument.create()
  out.registerFontkit(fontkit)
  const sources = spec.pages.map((p) => p.source).filter((s): s is number => s !== null)
  const copied = sources.length ? await out.copyPages(src, sources) : []
  let ci = 0
  const finalPages: PDFPage[] = []
  for (const p of spec.pages) {
    let page: PDFPage
    if (p.source === null) {
      page = out.addPage([p.width ?? 595.28, p.height ?? 841.89])
      if (p.rotate) page.setRotation(degrees(p.rotate))
    } else {
      page = out.addPage(copied[ci++])
      if (p.rotate) page.setRotation(degrees((page.getRotation().angle + p.rotate) % 360))
    }
    finalPages.push(page)
  }

  // Fonts and images once each, however many objects use them.
  const fonts = new Map<FontKey, PDFFont>()
  const embed = async (key: FontKey) => {
    if (!fonts.has(key)) fonts.set(key, await out.embedFont(await fontBytes(FONT_FILES[key]), { subset: true }))
    return fonts.get(key)!
  }
  const font = (o: Extract<Obj, { type: 'text' }>) => embed(`${o.font}:${o.bold ? 1 : 0}:${o.italic ? 1 : 0}` as FontKey)
  const fallbackFont = (o: Extract<Obj, { type: 'text' }>) => embed(`sans:${o.bold ? 1 : 0}:${o.italic ? 1 : 0}` as FontKey)
  const images = new Map<string, PDFImage>()
  const image = async (data: string) => {
    if (!images.has(data)) {
      const bytes = Buffer.from(data.slice(data.indexOf(',') + 1), 'base64')
      try {
        images.set(data, data.startsWith('data:image/png') ? await out.embedPng(bytes) : await out.embedJpg(bytes))
      } catch {
        throw new ToolError('invalid_options', 'One of the images could not be read. Add it again as a PNG or JPEG.')
      }
    }
    return images.get(data)!
  }

  const counts: Record<string, number> = {}
  for (const o of spec.objects) {
    counts[o.type] = (counts[o.type] ?? 0) + 1
    const page = finalPages[o.page]
    switch (o.type) {
      case 'whiteout':
        page.drawRectangle({ x: o.x, y: o.y, width: o.w, height: o.h, color: hex(o.color), borderWidth: 0 })
        break
      case 'highlight':
        page.drawRectangle({ x: o.x, y: o.y, width: o.w, height: o.h, color: hex(o.color), opacity: o.opacity, borderWidth: 0 })
        break
      case 'rect':
        page.drawRectangle({ x: o.x, y: o.y, width: o.w, height: o.h, borderColor: hex(o.color), borderWidth: o.borderWidth })
        break
      case 'ink': {
        const c = hex(o.color)
        for (let i = 1; i < o.points.length; i++) {
          const [x1, y1] = o.points[i - 1]
          const [x2, y2] = o.points[i]
          page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: o.width, color: c, lineCap: 1 })
        }
        break
      }
      case 'image': {
        const img = await image(o.data)
        page.drawImage(img, { x: o.x, y: o.y, width: o.w, height: o.h, rotate: degrees(o.rotation), opacity: o.opacity })
        break
      }
      case 'text': {
        const f = await font(o)
        const fb = await fallbackFont(o)
        const runs = o.lines.map((line) => runsOf(line, f, fb))
        // Each line steps down from the first along the text's own axis, and
        // each run along it, so rotated text keeps together.
        const rad = (o.rotation * Math.PI) / 180
        const step = o.size * o.lineHeight
        for (const [i, line] of runs.entries()) {
          let along = 0
          for (const run of line) {
            if (run.text.trim()) {
              page.drawText(run.text, {
                x: o.x + Math.sin(rad) * step * i + Math.cos(rad) * along,
                y: o.y - Math.cos(rad) * step * i + Math.sin(rad) * along,
                size: o.size, font: run.font, color: hex(o.color),
                rotate: degrees(o.rotation),
                // Carlito has no italic cut: slant the upright face.
                ...(o.italic && run.font === fb ? { xSkew: degrees(12) } : {}),
              })
            }
            along += run.font.widthOfTextAtSize(run.text, o.size)
          }
        }
        break
      }
    }
  }

  const bytes = Buffer.from(await out.save({ useObjectStreams: true }))
  return { bytes, meta: { pages: finalPages.length, objects: counts, blank_pages: spec.pages.filter((p) => p.source === null).length } }
}
