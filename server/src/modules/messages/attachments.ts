import path from 'node:path'
import crypto from 'node:crypto'
import { LocalStorageAdapter } from '../tools/storage/LocalStorageAdapter.js'
import type { StorageAdapter } from '../tools/storage/StorageAdapter.js'

/**
 * CHAT IMAGE ATTACHMENTS — storage and type validation.
 *
 * Chat images get their own storage root, separate from Tools documents: the
 * two have different retention and different readers, and a shared root would
 * make either one impossible to move to an object store on its own. Swap the
 * adapter here and nothing in the routes or the service changes.
 *
 * CHAT_STORAGE_ROOT overrides the local root; default is server/uploads/chat.
 */
const root = process.env.CHAT_STORAGE_ROOT
  ? path.resolve(process.env.CHAT_STORAGE_ROOT)
  : path.resolve(process.cwd(), 'uploads', 'chat')

export const chatStorage: StorageAdapter = new LocalStorageAdapter(root)

/** Per-image ceiling. Chat images are screenshots and photos, not archives. */
export const MAX_IMAGE_MB = 10
/** Per-message ceiling, so one send cannot become a bulk upload. */
export const MAX_IMAGES_PER_MESSAGE = 6

/**
 * The only image types accepted, mapped to the extension used on disk.
 *
 * SVG is deliberately absent: it is a script-carrying document, and serving
 * one from our own origin would hand an attacker stored XSS against every
 * member of the chat.
 */
const IMAGE_TYPES = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
} as const

export type ImageMime = keyof typeof IMAGE_TYPES

export const ACCEPTED_IMAGE_MIMES = Object.keys(IMAGE_TYPES) as ImageMime[]

export const extensionFor = (mime: ImageMime): string => IMAGE_TYPES[mime]

/**
 * Identify an image from its leading bytes.
 *
 * The browser's declared Content-Type is not trusted — it is attacker-supplied
 * on any non-browser client — so the magic bytes decide, and the sniffed type
 * is what gets stored and what the download route later sends back.
 */
export function sniffImage(bytes: Buffer): ImageMime | null {
  if (bytes.length < 12) return null
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (
    bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
    bytes.subarray(8, 12).toString('latin1') === 'WEBP'
  ) return 'image/webp'
  const gif = bytes.subarray(0, 6).toString('latin1')
  if (gif === 'GIF87a' || gif === 'GIF89a') return 'image/gif'
  return null
}

/**
 * A storage key for one image. Server-generated end to end: the chat id is a
 * uuid we issued, the basename is random, and the extension comes from the
 * sniffed type — so no part of it is attacker-controlled.
 */
export function storageKeyFor(chatId: string, mime: ImageMime): string {
  return `${chatId}/${crypto.randomUUID()}.${extensionFor(mime)}`
}

// ── Voice messages ─────────────────────────────────────────────────────────

/** A voice note is short speech; this caps a runaway recording, not a real one. */
export const MAX_VOICE_MB = 16
export const MAX_VOICE_SECONDS = 15 * 60

/** Audio a browser recorder produces (Chrome/Edge: WebM Opus; Firefox: Ogg Opus; Safari: MP4/AAC). */
const AUDIO_TYPES = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
} as const
export type AudioMime = keyof typeof AUDIO_TYPES

/** Identify recorded audio from its leading bytes — the declared type is not trusted. */
export function sniffAudio(bytes: Buffer): AudioMime | null {
  if (bytes.length < 12) return null
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return 'audio/webm'
  if (bytes.subarray(0, 4).toString('latin1') === 'OggS') return 'audio/ogg'
  if (bytes.subarray(4, 8).toString('latin1') === 'ftyp') return 'audio/mp4'
  if (bytes.subarray(0, 3).toString('latin1') === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) return 'audio/mpeg'
  if (bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WAVE') return 'audio/wav'
  return null
}

export function audioStorageKeyFor(chatId: string, mime: AudioMime): string {
  return `${chatId}/${crypto.randomUUID()}.${AUDIO_TYPES[mime]}`
}

// ── Documents ──────────────────────────────────────────────────────────────

export const MAX_DOCUMENT_MB = 25
export const MAX_DOCUMENTS_PER_MESSAGE = 5

/** Office / PDF / text documents accepted, by extension, with the MIME they are served as. */
const DOCUMENT_TYPES: Record<string, { mime: string; magic: 'pdf' | 'zip' | 'ole' | 'text' }> = {
  pdf: { mime: 'application/pdf', magic: 'pdf' },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', magic: 'zip' },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', magic: 'zip' },
  pptx: { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', magic: 'zip' },
  zip: { mime: 'application/zip', magic: 'zip' },
  doc: { mime: 'application/msword', magic: 'ole' },
  xls: { mime: 'application/vnd.ms-excel', magic: 'ole' },
  ppt: { mime: 'application/vnd.ms-powerpoint', magic: 'ole' },
  csv: { mime: 'text/csv', magic: 'text' },
  txt: { mime: 'text/plain', magic: 'text' },
}
export const ACCEPTED_DOCUMENT_EXTENSIONS = Object.keys(DOCUMENT_TYPES)

/**
 * Accept a document only when its bytes match what its extension claims:
 * a PDF starts %PDF, Office files are ZIP (OOXML) or OLE (legacy), text has
 * no NUL bytes. Returns the extension and served MIME, or null.
 */
export function sniffDocument(bytes: Buffer, filename: string): { ext: string; mime: string } | null {
  const ext = (filename.split('.').pop() ?? '').toLowerCase()
  const spec = DOCUMENT_TYPES[ext]
  if (!spec || bytes.length < 4) return null
  const ok =
    spec.magic === 'pdf' ? bytes.subarray(0, 4).toString('latin1') === '%PDF'
    : spec.magic === 'zip' ? bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04
    : spec.magic === 'ole' ? bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))
    : !bytes.subarray(0, Math.min(bytes.length, 8192)).includes(0)
  return ok ? { ext, mime: spec.mime } : null
}

export function documentStorageKeyFor(chatId: string, ext: string): string {
  return `${chatId}/${crypto.randomUUID()}.${ext}`
}
