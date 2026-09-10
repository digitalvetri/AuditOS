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
