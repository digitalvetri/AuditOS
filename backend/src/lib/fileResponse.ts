import type { Response } from 'express'

/**
 * Headers for serving a file somebody UPLOADED (client documents, tool
 * inputs, TDS and registration files). Such files are served from the app's
 * own origin, so a browser that renders an XML, SVG, HTML or text file as a
 * page would run any script inside it with the viewer's session.
 *
 *   - Only PDFs and raster images may open in the browser ("inline"); any
 *     other type always downloads, whatever the caller asked for.
 *   - Everything except a PDF also gets a sandboxing CSP, so even a file that
 *     is opened cannot run script. (A sandboxed top-level PDF will not render
 *     in Chrome's viewer, and PDF.js does not execute embedded JavaScript.)
 *   - nosniff pins the declared type.
 */
const INLINE_SAFE = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/gif'])

export function setUploadedFileHeaders(
  res: Pick<Response, 'setHeader'>,
  file: { mime: string; filename: string; inline: boolean; size?: number },
): void {
  const mime = file.mime.toLowerCase().split(';')[0].trim()
  const inline = file.inline && INLINE_SAFE.has(mime)
  const ascii = file.filename.replace(/[^\x20-\x7e]|["\\]/g, '_')
  res.setHeader('Content-Type', file.mime)
  if (file.size !== undefined) res.setHeader('Content-Length', String(file.size))
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Cache-Control', 'private, no-store')
  if (mime !== 'application/pdf') res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'")
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`)
}
