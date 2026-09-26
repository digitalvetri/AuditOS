/**
 * Resolve a "logo" string from a document's layout config into raw image
 * bytes that pdfkit's `doc.image()` can draw.
 *
 * The frontend stores a logo URL, not a file. Two shapes reach the server:
 *
 *   • `data:image/(png|jpeg|jpg|webp);base64,<b64>` — a user-uploaded image
 *     inlined into the layout config. Decoded and returned as bytes.
 *
 *   • `/some-file.png` — a public asset the web bundle serves. The server
 *     cannot reach the web container's filesystem, so the same file is
 *     baked into the API image at `server/assets/logos/<name>` (see the
 *     runtime stage of server/Dockerfile). Only `.png|.jpg|.jpeg|.webp`
 *     is served, and the resolved path is confined under the assets root
 *     so a stray `../etc/passwd` cannot escape it.
 *
 * Anything else — empty string, http:// URL, unknown extension, missing
 * file — returns null. PDF generation must survive a missing or malformed
 * logo silently; a broken URL is a reason to render without a logo, never
 * a reason to fail the whole download.
 */
import { readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
// dist/src/modules/pdf/logo.js  →  dist/src/../..  →  the image's /app root.
// The assets folder sits at /app/assets/logos when the Dockerfile has done
// its COPY, and beside dist/ in dev.
const ASSETS_ROOT = resolve(__dirname, '..', '..', '..', '..', 'assets', 'logos')

const DATA_URL_RE = /^data:image\/(png|jpe?g|webp);base64,(.+)$/
const ALLOWED_EXT = new Set(['png', 'jpg', 'jpeg', 'webp'])

export function resolveLogoBuffer(logo: string | null | undefined): Buffer | null {
  const src = typeof logo === 'string' ? logo.trim() : ''
  if (!src) return null

  // Data URL — cheapest path, no filesystem read.
  const m = DATA_URL_RE.exec(src)
  if (m) {
    try { return Buffer.from(m[2], 'base64') } catch { return null }
  }

  // Public path — resolve within the assets root only.
  if (src.startsWith('/')) {
    const name = basename(src)
    const ext = name.split('.').pop()?.toLowerCase() ?? ''
    if (!ALLOWED_EXT.has(ext)) return null
    const full = resolve(ASSETS_ROOT, name)
    if (!full.startsWith(ASSETS_ROOT)) return null
    try {
      return readFileSync(full)
    } catch {
      // Missing file (asset not baked, dev environment without assets/, etc.)
      // is a silent no-op; the PDF simply renders without a logo.
      return null
    }
  }

  return null
}
