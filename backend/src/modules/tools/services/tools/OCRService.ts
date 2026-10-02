import path from 'node:path'
import fs from 'node:fs/promises'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import sharp from 'sharp'
import { ToolError } from '../errors.js'
import { PDFService } from './PDFService.js'

/**
 * OCRService — scanned PDF or image → text (+ a searchable PDF).
 *
 * The engine sits behind `OCREngine` so tesseract.js (bundled, WASM, English
 * data cached on first run) can be swapped for a native tesseract or a cloud
 * OCR API without touching the tool. Output:
 *
 *   text      per-page, separated by "── Page N ──" headers
 *   pdf       the ORIGINAL page image with an invisible text layer laid over
 *             it at the recognised word positions, so Ctrl+F and copy work.
 */
export interface OCRWord { text: string; confidence: number; x0: number; y0: number; x1: number; y1: number }
export interface OCRPage { page: number; text: string; confidence: number; words: OCRWord[]; width: number; height: number }

export interface OCREngine {
  readonly name: string
  recognise(png: Buffer, lang: string): Promise<{ text: string; confidence: number; words: OCRWord[] }>
}

export interface OCROptions {
  lang?: 'eng'
  outputs?: ('pdf' | 'txt')[]
  /** Pages to process, 1-based; default all (capped). */
  maxPages?: number
}

export interface OCRResult {
  pages: OCRPage[]
  text: string
  averageConfidence: number
  pdf: Buffer | null
  txt: Buffer
}

// ── tesseract.js engine ──────────────────────────────────────────────────
class TesseractEngine implements OCREngine {
  readonly name = 'tesseract.js'
  private worker: Promise<import('tesseract.js').Worker> | null = null
  private lang = ''

  private async get(lang: string) {
    if (this.worker && this.lang === lang) return this.worker
    if (this.worker) { const w = await this.worker; await w.terminate().catch(() => undefined) }
    this.lang = lang
    this.worker = (async () => {
      const { createWorker } = await import('tesseract.js')
      const cachePath = process.env.TOOLS_OCR_CACHE ?? path.resolve(process.cwd(), 'uploads', 'ocr-cache')
      await fs.mkdir(cachePath, { recursive: true })
      try {
        return await createWorker(lang, 1, { cachePath, gzip: true })
      } catch (err) {
        this.worker = null
        throw new ToolError('engine_unavailable', 'The OCR engine could not start. Check the server has network access to download language data, then try again.')
      }
    })()
    return this.worker
  }

  async recognise(png: Buffer, lang: string) {
    const worker = await this.get(lang)
    const { data } = await worker.recognize(png, {}, { text: true, blocks: true })
    const words: OCRWord[] = []
    for (const block of data.blocks ?? []) {
      for (const para of block.paragraphs) {
        for (const line of para.lines) {
          for (const w of line.words) {
            if (!w.text.trim()) continue
            words.push({ text: w.text, confidence: w.confidence, x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1 })
          }
        }
      }
    }
    return { text: data.text ?? '', confidence: data.confidence ?? 0, words }
  }
}

export const ocrEngine: OCREngine = new TesseractEngine()

export const OCRService = {
  async run(input: { bytes: Buffer; mime: string }, opts: OCROptions = {}, onProgress?: (pct: number) => void): Promise<OCRResult> {
    const lang = opts.lang ?? 'eng'
    const outputs = opts.outputs?.length ? opts.outputs : ['pdf', 'txt']
    const maxPages = Math.min(opts.maxPages ?? 50, 100)

    // 1. Page rasters.
    let rasters: Buffer[]
    let original: PDFDocument | null = null
    if (input.mime === 'application/pdf') {
      original = await PDFService.load(input.bytes)
      if (original.isEncrypted) throw new ToolError('encrypted', 'This PDF is password-protected. Use Unlock PDF first.')
      rasters = await PDFService.rasterize(input.bytes, 200, maxPages)
    } else {
      const png = await sharp(input.bytes).rotate().png().toBuffer().catch(() => { throw new ToolError('unreadable', "We couldn't read this image. It may be corrupted.") })
      rasters = [png]
    }
    if (rasters.length === 0) throw new ToolError('empty', 'Nothing to scan — the file has no pages.')
    onProgress?.(8)

    // 2. Recognise.
    const pages: OCRPage[] = []
    for (let i = 0; i < rasters.length; i++) {
      const meta = await sharp(rasters[i]).metadata()
      const r = await ocrEngine.recognise(rasters[i], lang)
      pages.push({ page: i + 1, text: r.text.trim(), confidence: r.confidence, words: r.words, width: meta.width ?? 0, height: meta.height ?? 0 })
      onProgress?.(8 + ((i + 1) / rasters.length) * 80)
    }
    const text = pages.map((p) => `── Page ${p.page} ──\n${p.text}`).join('\n\n')
    const withText = pages.filter((p) => p.text.length > 0)
    const averageConfidence = withText.length ? withText.reduce((n, p) => n + p.confidence, 0) / withText.length : 0

    // 3. Searchable PDF.
    let pdf: Buffer | null = null
    if (outputs.includes('pdf')) {
      const out = await PDFDocument.create()
      out.setCreator('Audit OS OCR')
      const font = await out.embedFont(StandardFonts.Helvetica)
      for (let i = 0; i < pages.length; i++) {
        const p = pages[i]
        let page
        if (original) {
          const [copied] = await out.copyPages(original, [i])
          page = out.addPage(copied)
        } else {
          const img = await out.embedPng(rasters[i])
          page = out.addPage([img.width * 72 / 200, img.height * 72 / 200])
          page.drawImage(img, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() })
        }
        const { width: pw, height: ph } = page.getSize()
        const sx = pw / (p.width || 1)
        const sy = ph / (p.height || 1)
        for (const w of p.words) {
          const boxW = Math.max((w.x1 - w.x0) * sx, 1)
          const boxH = Math.max((w.y1 - w.y0) * sy, 2)
          const size = Math.max(boxH * 0.85, 2)
          const textW = font.widthOfTextAtSize(w.text, size) || 1
          // Invisible (fully transparent) text scaled to the word's box, so
          // search hits and copy-paste land where the pixels are.
          page.drawText(w.text, {
            x: w.x0 * sx, y: ph - w.y1 * sy + boxH * 0.2, size, font,
            color: rgb(0, 0, 0), opacity: 0,
            // Horizontal scale via a matrix would be ideal; pdf-lib lacks it,
            // so pick a size that keeps the run inside the box.
            ...(textW > boxW ? { size: Math.max(size * (boxW / textW), 1.5) } : {}),
          })
        }
      }
      pdf = Buffer.from(await out.save())
    }
    onProgress?.(96)
    return { pages, text, averageConfidence, pdf, txt: Buffer.from(text, 'utf8') }
  },
}
