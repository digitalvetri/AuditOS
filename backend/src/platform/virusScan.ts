import net from 'node:net'
import { readFile } from 'node:fs/promises'
import type { NextFunction, Request, Response } from 'express'
import { ApiError } from '../lib/http.js'

/**
 * OPTIONAL VIRUS SCANNING via clamd (ClamAV daemon), INSTREAM over TCP.
 *
 * Off unless CLAMAV_HOST is set (CLAMAV_PORT defaults to 3310). Every upload
 * route runs `scanUploads` right after its multer step:
 *   - infected                → 422 "This file failed the virus scan"
 *   - scanner unreachable /
 *     timed out / errored     → a warning in the log, upload allowed
 *                               (fail-open), unless CLAMAV_REQUIRED=true,
 *                               then 503.
 *
 * Env is read on every call so a deploy (or a test) can switch it.
 *
 * Protocol: send `zINSTREAM\0`, then chunks each prefixed with a 4-byte
 * big-endian length, then a zero-length chunk. clamd answers
 * `stream: OK\0`, `stream: <Signature> FOUND\0` or `... ERROR\0`.
 */

export type ScanResult =
  | { status: 'clean' }
  | { status: 'infected'; signature: string }
  | { status: 'unavailable'; reason: string }
  | { status: 'disabled' }

const CHUNK = 64 * 1024
export const INFECTED_MESSAGE = 'This file failed the virus scan.'

function config() {
  const host = process.env.CLAMAV_HOST?.trim()
  if (!host) return null
  const port = Number(process.env.CLAMAV_PORT ?? 3310) || 3310
  const timeoutMs = Number(process.env.CLAMAV_TIMEOUT_MS ?? 10_000) || 10_000
  return { host, port, timeoutMs, required: process.env.CLAMAV_REQUIRED === 'true' }
}

export function isVirusScanEnabled(): boolean {
  return config() !== null
}

/** Scan one buffer with clamd. Never throws. */
export function scanBuffer(bytes: Buffer): Promise<ScanResult> {
  const cfg = config()
  if (!cfg) return Promise.resolve({ status: 'disabled' })
  return new Promise<ScanResult>((resolve) => {
    let settled = false
    let reply = ''
    const done = (r: ScanResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve(r)
    }
    const socket = net.createConnection({ host: cfg.host, port: cfg.port })
    const timer = setTimeout(() => done({ status: 'unavailable', reason: `timed out after ${cfg.timeoutMs} ms` }), cfg.timeoutMs)
    socket.on('error', (err) => done({ status: 'unavailable', reason: err.message }))
    socket.on('data', (d) => {
      reply += d.toString('utf8')
      if (reply.includes('\0') || reply.includes('\n')) finish()
    })
    socket.on('end', () => finish())
    socket.on('close', () => finish())
    function finish() {
      const line = reply.replace(/\0/g, '').trim()
      if (!line) return done({ status: 'unavailable', reason: 'no reply from clamd' })
      const found = /^(?:stream:\s*)?(.+)\s+FOUND$/.exec(line)
      if (found) return done({ status: 'infected', signature: found[1].trim() })
      if (/(?:^|\s)OK$/.test(line)) return done({ status: 'clean' })
      return done({ status: 'unavailable', reason: line.slice(0, 200) })
    }
    socket.on('connect', () => {
      socket.write('zINSTREAM\0')
      for (let i = 0; i < bytes.length; i += CHUNK) {
        const part = bytes.subarray(i, i + CHUNK)
        const len = Buffer.alloc(4)
        len.writeUInt32BE(part.length, 0)
        socket.write(len)
        socket.write(part)
      }
      socket.write(Buffer.alloc(4)) // zero-length chunk: end of stream
    })
  })
}

type UploadedFile = { buffer?: Buffer; path?: string; originalname?: string }

function filesOf(req: Request): UploadedFile[] {
  const out: UploadedFile[] = []
  if (req.file) out.push(req.file)
  const f = req.files as unknown
  if (Array.isArray(f)) out.push(...(f as UploadedFile[]))
  else if (f && typeof f === 'object') for (const list of Object.values(f as Record<string, UploadedFile[]>)) out.push(...list)
  return out
}

/** Throw 422 if any file is infected; honour fail-open / CLAMAV_REQUIRED. */
export async function assertFilesClean(files: UploadedFile[]): Promise<void> {
  const cfg = config()
  if (!cfg || !files.length) return
  for (const file of files) {
    const bytes = file.buffer ?? (file.path ? await readFile(file.path) : null)
    if (!bytes) continue
    const r = await scanBuffer(bytes)
    if (r.status === 'infected') {
      console.warn(`[virus-scan] rejected upload "${file.originalname ?? ''}": ${r.signature}`)
      throw ApiError.unprocessable('virus_detected', INFECTED_MESSAGE)
    }
    if (r.status === 'unavailable') {
      if (cfg.required) {
        console.error(`[virus-scan] scanner unavailable (${r.reason}) — upload refused (CLAMAV_REQUIRED=true)`)
        throw new ApiError(503, 'virus_scan_unavailable', 'The virus scanner is unavailable. Try the upload again shortly.')
      }
      console.warn(`[virus-scan] scanner unavailable (${r.reason}) — upload allowed without a scan`)
    }
  }
}

/**
 * Express middleware: put it straight after the multer step of an upload
 * route. A no-op when CLAMAV_HOST is not set.
 */
export function scanUploads(req: Request, _res: Response, next: NextFunction): void {
  assertFilesClean(filesOf(req)).then(() => next(), next)
}
