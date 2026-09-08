import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { ToolError } from '../errors.js'

/**
 * SignatureProvider — the seam a real DSC / ASP integration plugs into.
 *
 * This phase ships ONE implementation, VisibleMarkProvider: it draws a
 * visible signature block (name, designation, date, optional drawn mark)
 * on the chosen page. It is an approval workflow aid, NOT a digital
 * signature under the IT Act — the mark says so, the UI says so, and the
 * stored metadata says so (`kind: 'visible_mark'`).
 *
 * A DSC provider would implement the same `apply()` and return
 * `kind: 'dsc'` with the certificate details in `meta`.
 */
export type Placement = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left' | 'custom'

export interface SignatureRequest {
  page: number                  // 1-based
  placement: Placement
  /** For `custom`: fraction of page width / height from the bottom-left. */
  x?: number
  y?: number
  signerName: string
  designation?: string
  date: string                  // display string, e.g. 08 Sep 2026
  reason?: string
  /** PNG bytes of a drawn signature, if the signer drew one. */
  drawnPng?: Buffer | null
}

export interface SignatureResult {
  bytes: Buffer
  meta: {
    kind: 'visible_mark' | 'dsc'
    page: number
    placement: Placement
    signer_name: string
    designation: string | null
    date: string
    reason: string | null
    legal_note: string
  }
}

export interface SignatureProvider {
  readonly kind: 'visible_mark' | 'dsc'
  apply(pdf: Buffer, req: SignatureRequest): Promise<SignatureResult>
}

const LEGAL_NOTE = 'Visible approval mark applied in Audit OS. This is not a Digital Signature Certificate (DSC) signature.'

export class VisibleMarkProvider implements SignatureProvider {
  readonly kind = 'visible_mark' as const

  async apply(pdf: Buffer, req: SignatureRequest): Promise<SignatureResult> {
    if (!req.signerName.trim()) throw new ToolError('invalid_options', 'Enter the signer name.')
    let doc: PDFDocument
    try {
      doc = await PDFDocument.load(pdf, { ignoreEncryption: true, updateMetadata: false })
    } catch {
      throw new ToolError('unreadable', "We couldn't read this PDF. It may be corrupted or password-protected.")
    }
    if (doc.isEncrypted) throw new ToolError('encrypted', 'This PDF is password-protected. Use Unlock PDF first.')
    const count = doc.getPageCount()
    if (req.page < 1 || req.page > count) throw new ToolError('invalid_options', `Page must be between 1 and ${count}.`)

    const page = doc.getPage(req.page - 1)
    const { width, height } = page.getSize()
    const font = await doc.embedFont(StandardFonts.HelveticaOblique)
    const fontBold = await doc.embedFont(StandardFonts.HelveticaBold)
    const fontSmall = await doc.embedFont(StandardFonts.Helvetica)

    const boxW = Math.min(220, width * 0.4)
    const hasDrawn = Boolean(req.drawnPng)
    const boxH = hasDrawn ? 96 : 64
    const pad = 24
    let x: number, y: number
    switch (req.placement) {
      case 'bottom-left': x = pad; y = pad; break
      case 'top-left': x = pad; y = height - pad - boxH; break
      case 'top-right': x = width - pad - boxW; y = height - pad - boxH; break
      case 'custom':
        x = Math.min(Math.max((req.x ?? 0.7) * width, 0), width - boxW)
        y = Math.min(Math.max((req.y ?? 0.1) * height, 0), height - boxH)
        break
      default: x = width - pad - boxW; y = pad
    }

    page.drawRectangle({ x, y, width: boxW, height: boxH, borderColor: rgb(0.55, 0.55, 0.5), borderWidth: 0.75, color: rgb(1, 1, 1), opacity: 0.92 })
    let cursor = y + boxH - 14
    if (hasDrawn) {
      const png = await doc.embedPng(req.drawnPng as Buffer)
      const scale = Math.min((boxW - 16) / png.width, 34 / png.height)
      page.drawImage(png, { x: x + 8, y: cursor - 34 + 6, width: png.width * scale, height: png.height * scale })
      cursor -= 36
    } else {
      page.drawText(req.signerName, { x: x + 8, y: cursor - 6, size: 13, font, color: rgb(0.1, 0.2, 0.45) })
      cursor -= 18
    }
    const name = hasDrawn ? req.signerName : (req.designation ?? '')
    if (name) { page.drawText(name, { x: x + 8, y: cursor - 4, size: 9, font: fontBold, color: rgb(0.1, 0.1, 0.1) }); cursor -= 12 }
    if (hasDrawn && req.designation) { page.drawText(req.designation, { x: x + 8, y: cursor - 4, size: 8.5, font: fontSmall, color: rgb(0.2, 0.2, 0.2) }); cursor -= 11 }
    page.drawText(`Date: ${req.date}${req.reason ? `  ·  ${req.reason}` : ''}`.slice(0, 60), { x: x + 8, y: cursor - 4, size: 8, font: fontSmall, color: rgb(0.25, 0.25, 0.25) })
    cursor -= 11
    page.drawText('Visible mark · not a DSC signature', { x: x + 8, y: y + 5, size: 6.5, font: fontSmall, color: rgb(0.45, 0.45, 0.45) })

    doc.setModificationDate(new Date())
    return {
      bytes: Buffer.from(await doc.save()),
      meta: {
        kind: 'visible_mark',
        page: req.page,
        placement: req.placement,
        signer_name: req.signerName,
        designation: req.designation ?? null,
        date: req.date,
        reason: req.reason ?? null,
        legal_note: LEGAL_NOTE,
      },
    }
  }
}

/** The provider in use. Swap for a DSC/ASP implementation when one exists. */
export const signatureProvider: SignatureProvider = new VisibleMarkProvider()
