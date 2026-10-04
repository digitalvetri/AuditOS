/**
 * GST notice — text extraction.
 *
 * Two paths:
 *   - PDF with a usable text layer  → pdfjs text (fast, no OCR)
 *   - Scanned PDF or image upload   → OCRService (pdftoppm + tesseract.js),
 *     the same engine the Tools "OCR scan" tool uses
 *
 * Threshold is the same number the audit-automation pipeline uses: fewer than
 * MIN_TEXT_LAYER_BYTES across the whole PDF means "no real text layer" and we
 * fall through to OCR rather than hand the LLM a blank page.
 */
import { inspectPdf, MIN_TEXT_LAYER_BYTES } from '../audit-automation/lib/pdfInspect.js'
import { OCRService } from '../tools/services/tools/OCRService.js'

export interface ExtractResult {
  text: string
  /** 'pdf-parse' = pdfjs text layer, 'tesseract' = OCR, 'empty' = nothing read. */
  source: 'pdf-parse' | 'tesseract' | 'empty'
  pageCount: number
  /** Average OCR confidence (0-100) when source = 'tesseract'. */
  confidence?: number
}

const PDF_MIME = 'application/pdf'
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp'])

export function isSupportedNoticeMime(mime: string): boolean {
  return mime === PDF_MIME || IMAGE_MIMES.has(mime)
}

export async function extractNoticeText(bytes: Buffer, mime: string): Promise<ExtractResult> {
  if (mime === PDF_MIME) {
    try {
      const info = await inspectPdf(bytes)
      if (info.textLayerBytes >= MIN_TEXT_LAYER_BYTES) {
        const text = info.pages
          .map((p) => p.items.map((i) => i.str).join(' '))
          .join('\n\n')
          .replace(/[ \t]+\n/g, '\n')
          .replace(/\n{3,}/g, '\n\n')
          .trim()
        return { text, source: 'pdf-parse', pageCount: info.pageCount }
      }
      // Thin text layer → fall through to OCR.
    } catch {
      // Unreadable PDF or encrypted — try OCR anyway (poppler can usually
      // rasterise it even when pdfjs refused the parse).
    }
  } else if (!IMAGE_MIMES.has(mime)) {
    return { text: '', source: 'empty', pageCount: 0 }
  }

  const ocr = await OCRService.run({ bytes, mime }, { lang: 'eng', outputs: ['txt'], maxPages: 20 })
  return {
    text: ocr.text.trim(),
    source: 'tesseract',
    pageCount: ocr.pages.length,
    confidence: Math.round(ocr.averageConfidence),
  }
}
