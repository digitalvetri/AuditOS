import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

/**
 * PDF inspection for the audit-automation upload pre-flight.
 *
 * ONE pdfjs pass produces every fact the pre-flight needs:
 *   - encryption / password correctness (throws PasswordRequiredError /
 *     WrongPasswordError so the route can return specific messages, not
 *     a generic parse failure — AMENDMENT-02 §1-Gap1)
 *   - text-layer presence and byte count (so scanned PDFs are refused
 *     at upload — AMENDMENT-02 §1-Gap3)
 *   - per-page text items with coordinates (the raw material future
 *     bank adapters need for table detection — stored to disk instead
 *     of a decrypted PDF, per AMENDMENT-02 §1-Gap1)
 *   - "Page N of M" footer M value where present, to flag
 *     PAGE_COUNT_MISMATCH (AMENDMENT-02 §1-Gap4)
 *
 * The password is used to decrypt in memory and never leaves this
 * function — its scope ends when inspect() returns.
 */

// ── pdfjs bootstrap (same pattern as tools/PDFService.ts) ────────────────
type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs')
let pdfjsPromise: Promise<PdfJs> | null = null
function pdfjs(): Promise<PdfJs> {
  if (!pdfjsPromise) {
    pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs').then((m) => {
      const require = createRequire(import.meta.url)
      // On Windows, pdfjs's ESM loader rejects a raw C:\ path — it needs
      // a file:// URL. pathToFileURL handles this cross-platform.
      m.GlobalWorkerOptions.workerSrc = pathToFileURL(
        require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'),
      ).href
      return m
    })
  }
  return pdfjsPromise
}

// ── Error types the route layer converts to specific HTTP responses ──────
export class PasswordRequiredError extends Error {
  constructor() { super('password_required'); this.name = 'PasswordRequiredError' }
}
export class WrongPasswordError extends Error {
  constructor() { super('wrong_password'); this.name = 'WrongPasswordError' }
}
export class UnreadablePdfError extends Error {
  constructor(message = 'unreadable') { super(message); this.name = 'UnreadablePdfError' }
}

// ── Result shape stored to disk (as JSON) via extractionPath ─────────────
export interface ExtractedTextItem {
  /** Text content of the item (never trimmed — preserve whitespace). */
  str: string
  /** x coordinate of the left edge in PDF user space. */
  x: number
  /** y coordinate of the baseline in PDF user space (origin bottom-left). */
  y: number
  /** Width in user-space units. */
  width: number
  /** Height (font size) in user-space units. */
  height: number
  /** Font name from pdfjs (useful for bold detection). */
  fontName: string
}

export interface ExtractedPage {
  pageNumber: number
  width: number
  height: number
  items: ExtractedTextItem[]
}

export interface InspectionResult {
  encrypted: boolean
  pages: ExtractedPage[]
  pageCount: number
  /** Total byte length of text across all pages — the text-layer signal. */
  textLayerBytes: number
  /** M from "Page N of M" footer (or "Page N / M"), where detected. */
  declaredPageCount: number | null
}

/**
 * Inspect a PDF. Password is used to decrypt in memory and then discarded —
 * the caller MUST NOT persist or log it.
 *
 * Throws:
 *   PasswordRequiredError — PDF is encrypted and no password was supplied
 *   WrongPasswordError    — supplied password is incorrect
 *   UnreadablePdfError    — the PDF is corrupt or otherwise unreadable
 */
export async function inspectPdf(bytes: Buffer, password?: string): Promise<InspectionResult> {
  const lib = await pdfjs()

  // pdfjs distinguishes NEED_PASSWORD (code 1) from INCORRECT_PASSWORD (code 2)
  // via PasswordException. We surface that as two typed errors so the route can
  // return the right message per AMENDMENT-02 §1-Gap1.
  let doc
  try {
    doc = await lib.getDocument({
      data: new Uint8Array(bytes),
      password: password ?? undefined,
      useSystemFonts: true,
      disableFontFace: true,
      isEvalSupported: false,
    }).promise
  } catch (err) {
    const name = (err as { name?: string }).name
    const code = (err as { code?: number }).code
    if (name === 'PasswordException') {
      // 1 = NEED_PASSWORD, 2 = INCORRECT_PASSWORD (pdfjs constants)
      if (code === 2) throw new WrongPasswordError()
      throw new PasswordRequiredError()
    }
    throw new UnreadablePdfError(name ?? 'unreadable')
  }

  try {
    const pages: ExtractedPage[] = []
    let textLayerBytes = 0
    let declared: number | null = null
    const footerRe = /page\s+\d+\s*(?:of|\/)\s*(\d+)/i

    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p)
      const vp = page.getViewport({ scale: 1 })
      const tc = await page.getTextContent()
      const items: ExtractedTextItem[] = []
      let pageText = ''
      for (const it of tc.items) {
        if (!('str' in it)) continue
        const text = it.str
        if (text) {
          textLayerBytes += Buffer.byteLength(text, 'utf8')
          pageText += text + ' '
        }
        const [a, b, c, d, e, f] = it.transform as [number, number, number, number, number, number]
        const h = Math.hypot(c, d) || Math.hypot(a, b) || it.height || 10
        const w = it.width || text.length * h * 0.5
        items.push({ str: text, x: e, y: f, width: w, height: h, fontName: it.fontName ?? '' })
      }
      pages.push({ pageNumber: p, width: vp.width, height: vp.height, items })

      // Try to find "Page N of M" — usually near the page bottom. Only take
      // the first M value we find; if pages disagree we still report just
      // this one (page-count-footer inspection is a soft check).
      if (declared === null) {
        const m = footerRe.exec(pageText)
        if (m) {
          const val = Number(m[1])
          if (Number.isInteger(val) && val > 0 && val < 10_000) declared = val
        }
      }
    }

    // pdfjs surfaces `_isEncrypted` inconsistently across versions; the safest
    // signal is "we needed a non-empty password to open it".
    const encrypted = Boolean(password && password.length > 0)

    return {
      encrypted,
      pages,
      pageCount: doc.numPages,
      textLayerBytes,
      declaredPageCount: declared,
    }
  } finally {
    await doc.destroy().catch(() => undefined)
  }
}

/**
 * Threshold for the text-layer check. A PDF that yields fewer bytes of text
 * across every page than this is considered scanned/image-only and refused
 * at upload — no OCR fallback (AMENDMENT-02 §1-Gap3).
 *
 * A bank statement of even one page has thousands of text bytes. 500 is
 * generous — anything below is clearly not a real text-layer PDF.
 */
export const MIN_TEXT_LAYER_BYTES = 500
