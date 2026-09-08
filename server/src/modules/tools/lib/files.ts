import JSZip from 'jszip'
import { MIME } from '../registry.js'

/**
 * File identity helpers. The extension and the browser-supplied MIME are
 * hints; the bytes decide (§11 — validate MIME AND magic bytes server-side).
 */

/** Sniff the real type from the leading bytes. `null` = not a type we know. */
export async function sniffMime(bytes: Buffer, hintExt: string): Promise<string | null> {
  if (bytes.length < 4) return null
  if (bytes.subarray(0, 4).toString('latin1') === '%PDF') return MIME.pdf
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return MIME.png
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return MIME.jpeg
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return MIME.webp
  // OLE compound document — legacy .xls (also .doc, which we do not accept).
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) {
    return hintExt === 'xls' ? MIME.xls : null
  }
  // OOXML — a zip whose entries tell xlsx from docx apart.
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    try {
      const zip = await JSZip.loadAsync(bytes)
      const names = Object.keys(zip.files)
      if (names.some((n) => n.startsWith('xl/'))) return MIME.xlsx
      if (names.some((n) => n.startsWith('word/'))) return MIME.docx
      return MIME.zip
    } catch {
      return null
    }
  }
  if (isProbablyText(bytes)) {
    if (hintExt === 'tsv') return MIME.tsv
    if (hintExt === 'json') return MIME.json
    if (hintExt === 'xml') return MIME.xml
    if (hintExt === 'csv') return MIME.csv
    return MIME.txt
  }
  return null
}

/** Text if the first 8 KB has no NUL bytes and is mostly printable. */
export function isProbablyText(bytes: Buffer): boolean {
  const head = bytes.subarray(0, Math.min(bytes.length, 8192))
  let control = 0
  for (const b of head) {
    if (b === 0) return false
    if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) control++
  }
  return control / Math.max(head.length, 1) < 0.02
}

export function extensionOf(filename: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(filename)
  return m ? m[1].toLowerCase() : ''
}

/**
 * A safe display filename: keep letters, digits, dot, dash, underscore and
 * spaces; collapse the rest; cap the length; never allow a path separator.
 */
export function sanitizeFilename(name: string, fallback = 'file'): string {
  const base = name.split(/[\\/]/).pop() ?? ''
  const cleaned = base
    .replace(/[^A-Za-z0-9._\- ]+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^\.+/, '')
    .trim()
  const capped = cleaned.length > 120 ? cleaned.slice(-120) : cleaned
  return capped || fallback
}

export function stripExtension(name: string): string {
  return name.replace(/\.[A-Za-z0-9]+$/, '')
}

/** 'invoice.pdf' → 'invoice.xlsx' */
export function withExtension(name: string, ext: string): string {
  return `${stripExtension(name)}.${ext}`
}

/** For a Content-Disposition header — quotes and CR/LF stripped. */
export function headerFilename(name: string): string {
  return name.replace(/["\r\n]/g, '_')
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}
