import { describe, it, expect } from 'vitest'
import { sniffMime } from '../files.js'

/**
 * Regression: an ITR-U acknowledgment downloaded from the income-tax portal
 * was being rejected by Merge PDF as "not a PDF" because it had a UTF-8 BOM
 * before the `%PDF-` header. Every real PDF reader accepts the file; the
 * sniffer's byte-0 check did not. PDF spec Appendix H allows the header
 * anywhere in the first 1024 bytes.
 */
describe('sniffMime — PDF header tolerance', () => {
  const pdfBody = Buffer.from('%PDF-1.4\n%\xff\xff\xff\xff\n1 0 obj<</Type/Catalog>>endobj\n')
  const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf])

  it('accepts a PDF whose header is at byte 0', async () => {
    expect(await sniffMime(pdfBody, 'pdf')).toBe('application/pdf')
  })

  it('accepts a PDF prefixed with a UTF-8 BOM (the ITR-portal case)', async () => {
    const withBom = Buffer.concat([UTF8_BOM, pdfBody])
    expect(await sniffMime(withBom, 'pdf')).toBe('application/pdf')
  })

  it('accepts a PDF prefixed with leading whitespace', async () => {
    const withSpaces = Buffer.concat([Buffer.from('   \n\r\t'), pdfBody])
    expect(await sniffMime(withSpaces, 'pdf')).toBe('application/pdf')
  })

  it('accepts a PDF with the header deep inside the first 1 KB', async () => {
    const padding = Buffer.alloc(900, 0x20)  // 900 spaces
    expect(await sniffMime(Buffer.concat([padding, pdfBody]), 'pdf')).toBe('application/pdf')
  })

  it('does NOT accept a file whose first 1 KB is pure padding', async () => {
    // %PDF- starts at byte 1025 — past the spec's 1024-byte search window.
    const padding = Buffer.alloc(1025, 0x20)
    expect(await sniffMime(Buffer.concat([padding, pdfBody]), 'pdf')).not.toBe('application/pdf')
  })

  it('does NOT accept a text file that lacks the %PDF- substring', async () => {
    const text = Buffer.from('hello world\nnot a pdf at all\n')
    expect(await sniffMime(text, 'txt')).toBe('text/plain')
  })
})
