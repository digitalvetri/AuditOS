import sharp from 'sharp'
import { PDFDocument, PageSizes } from 'pdf-lib'
import { ToolError } from '../errors.js'

/**
 * ImageService — photos and scans into one PDF.
 *
 * sharp normalises every input (EXIF rotation applied, WEBP → PNG, CMYK →
 * RGB) so pdf-lib only ever embeds JPEG or PNG; page size, orientation and
 * margin are applied per page and the image is fitted proportionally.
 */
export type PageSize = 'A4' | 'Letter' | 'Fit'
export type Orientation = 'portrait' | 'landscape' | 'auto'

export interface ImageToPdfOptions {
  pageSize?: PageSize
  orientation?: Orientation
  marginMm?: number
}

const MM = 72 / 25.4

export const ImageService = {
  async info(bytes: Buffer): Promise<{ width: number; height: number; format: string }> {
    try {
      const m = await sharp(bytes).metadata()
      if (!m.width || !m.height) throw new Error('no dimensions')
      return { width: m.width, height: m.height, format: m.format ?? 'unknown' }
    } catch {
      throw new ToolError('unreadable', "We couldn't read this image. It may be corrupted.")
    }
  },

  /** Any supported image → PNG (lossless) or JPEG, upright, RGB. */
  async normalise(bytes: Buffer): Promise<{ bytes: Buffer; kind: 'png' | 'jpeg'; width: number; height: number }> {
    let meta
    try {
      meta = await sharp(bytes).metadata()
    } catch {
      throw new ToolError('unreadable', "We couldn't read this image. It may be corrupted.")
    }
    const isJpeg = meta.format === 'jpeg'
    const pipeline = sharp(bytes).rotate().toColorspace('srgb')
    const out = isJpeg
      ? await pipeline.jpeg({ quality: 90, mozjpeg: true }).toBuffer({ resolveWithObject: true })
      : await pipeline.png().toBuffer({ resolveWithObject: true })
    return { bytes: out.data, kind: isJpeg ? 'jpeg' : 'png', width: out.info.width, height: out.info.height }
  },

  async imagesToPdf(images: Buffer[], opts: ImageToPdfOptions = {}, onProgress?: (pct: number) => void): Promise<{ bytes: Buffer; pageCount: number }> {
    if (images.length === 0) throw new ToolError('empty', 'Add at least one image.')
    const pageSize = opts.pageSize ?? 'A4'
    const orientation = opts.orientation ?? 'auto'
    const margin = Math.max(0, Math.min(opts.marginMm ?? 10, 50)) * MM
    const pdf = await PDFDocument.create()
    pdf.setCreator('Audit OS')

    for (let i = 0; i < images.length; i++) {
      const img = await ImageService.normalise(images[i])
      const embedded = img.kind === 'jpeg' ? await pdf.embedJpg(img.bytes) : await pdf.embedPng(img.bytes)
      const landscapeImage = img.width > img.height
      let w: number, h: number
      if (pageSize === 'Fit') {
        // 72 dpi mapping caps a phone photo at a sane page; scale down to A4 width max.
        const scale = Math.min(1, (PageSizes.A4[1] - 2 * margin) / Math.max(img.width, img.height))
        w = img.width * scale + 2 * margin
        h = img.height * scale + 2 * margin
      } else {
        const base = pageSize === 'Letter' ? PageSizes.Letter : PageSizes.A4
        const landscape = orientation === 'landscape' || (orientation === 'auto' && landscapeImage)
        ;[w, h] = landscape ? [base[1], base[0]] : [base[0], base[1]]
      }
      const page = pdf.addPage([w, h])
      const boxW = w - 2 * margin
      const boxH = h - 2 * margin
      const scale = Math.min(boxW / img.width, boxH / img.height)
      const dw = img.width * scale
      const dh = img.height * scale
      page.drawImage(embedded, { x: (w - dw) / 2, y: (h - dh) / 2, width: dw, height: dh })
      onProgress?.(((i + 1) / images.length) * 95)
    }
    return { bytes: Buffer.from(await pdf.save()), pageCount: images.length }
  },
}
