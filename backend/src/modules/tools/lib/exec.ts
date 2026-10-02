import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

/**
 * External-process helpers for the converters that lean on system tools:
 * LibreOffice (Office ⇄ PDF), Ghostscript (compress / decrypt) and poppler
 * (page rasters for thumbnails and OCR). Everything runs in a per-call temp
 * directory that is removed afterwards, with a hard timeout.
 */
export class ToolProcessError extends Error {
  constructor(message: string, public readonly stderr: string, public readonly code: number | null) {
    super(message)
  }
}

export interface RunResult { stdout: string; stderr: string }

export function run(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, {
      cwd: opts.cwd,
      timeout: opts.timeoutMs ?? 120_000,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, ...(opts.env ?? {}) },
    }, (err, stdout, stderr) => {
      if (err) {
        const code = (err as NodeJS.ErrnoException & { code?: number | string }).code
        reject(new ToolProcessError(`${cmd} failed`, String(stderr ?? ''), typeof code === 'number' ? code : null))
        return
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

export async function withTempDir<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `auditos-${prefix}-`))
  try {
    return await fn(dir)
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

export function haveBinary(name: string): Promise<boolean> {
  return run('which', [name]).then(() => true, () => false)
}

// ── LibreOffice ──────────────────────────────────────────────────────────
//
// soffice will not start a second instance against the same user profile, so
// every call gets its own throwaway profile directory. A small mutex keeps
// concurrent conversions from starving the box — one at a time is plenty for
// a firm-sized workload and keeps memory predictable.
let loQueue: Promise<unknown> = Promise.resolve()

export function convertWithLibreOffice(inputPath: string, outExt: 'pdf' | 'docx' | 'xlsx', outDir: string, filter?: string): Promise<string> {
  const job = loQueue.then(async () => {
    const profile = path.join(os.tmpdir(), `auditos-lo-profile-${crypto.randomBytes(6).toString('hex')}`)
    try {
      const target = filter ? `${outExt}:${filter}` : outExt
      await run('soffice', [
        `-env:UserInstallation=file://${profile}`,
        '--headless', '--norestore', '--nologo', '--nolockcheck',
        '--convert-to', target, '--outdir', outDir, inputPath,
      ], { timeoutMs: 180_000, env: { HOME: profile } })
      const produced = path.join(outDir, `${path.basename(inputPath, path.extname(inputPath))}.${outExt}`)
      await fs.access(produced)
      return produced
    } finally {
      await fs.rm(profile, { recursive: true, force: true }).catch(() => undefined)
    }
  })
  loQueue = job.catch(() => undefined)
  return job
}
