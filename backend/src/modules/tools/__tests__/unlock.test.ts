import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PDFService } from '../services/tools/PDFService.js'

/**
 * Two-page PDFs, user password ABCDE1234F, owner password owner123. These
 * are the encryptions Ghostscript 10.x refuses with the right password;
 * Unlock goes through qpdf for them, so the test needs qpdf on PATH.
 */
const fixture = (f: string) => fs.readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', f))
const qpdf = (() => { try { execFileSync('qpdf', ['--version']); return true } catch { return false } })()

describe.skipIf(!qpdf)('Unlock PDF', () => {
  it.each(['locked-aes128.pdf', 'locked-aes256-r5.pdf'])('opens %s with the user or owner password', async (f) => {
    for (const pw of ['ABCDE1234F', 'owner123']) {
      const out = await PDFService.unlock(await fixture(f), pw)
      const doc = await PDFService.load(out)
      expect(doc.isEncrypted).toBe(false)
      expect(doc.getPageCount()).toBe(2)
    }
  })

  it('says so when the password is wrong', async () => {
    await expect(PDFService.unlock(await fixture('locked-aes128.pdf'), 'nope')).rejects.toThrow(/^Incorrect password\.$/)
  })
})
