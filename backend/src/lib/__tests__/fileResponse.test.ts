import { describe, expect, it } from 'vitest'
import { setUploadedFileHeaders } from '../fileResponse.js'

function fakeRes() {
  const headers: Record<string, string> = {}
  return { headers, setHeader: (k: string, v: string) => { headers[k.toLowerCase()] = v } }
}

describe('setUploadedFileHeaders', () => {
  it('lets PDFs and raster images open in the browser when asked', () => {
    for (const mime of ['application/pdf', 'image/png', 'image/jpeg', 'image/webp']) {
      const r = fakeRes()
      setUploadedFileHeaders(r as never, { mime, filename: 'a', inline: true })
      expect(r.headers['content-disposition']).toMatch(/^inline;/)
    }
  })
  it('always downloads anything that could carry script (xml, svg, html, json, text)', () => {
    for (const mime of ['application/xml', 'text/xml', 'image/svg+xml', 'text/html', 'application/json', 'text/plain', 'application/octet-stream']) {
      const r = fakeRes()
      setUploadedFileHeaders(r as never, { mime, filename: 'a', inline: true })
      expect(r.headers['content-disposition']).toMatch(/^attachment;/)
    }
  })
  it('sandboxes everything but PDFs, and pins the type', () => {
    const x = fakeRes(); setUploadedFileHeaders(x as never, { mime: 'image/png', filename: 'a.png', inline: true })
    expect(x.headers['content-security-policy']).toMatch(/sandbox/)
    expect(x.headers['x-content-type-options']).toBe('nosniff')
    const p = fakeRes(); setUploadedFileHeaders(p as never, { mime: 'application/pdf', filename: 'a.pdf', inline: true })
    // A sandboxed top-level PDF will not render in Chrome's viewer.
    expect(p.headers['content-security-policy']).toBeUndefined()
  })
  it('keeps a quote or newline in the name out of the header', () => {
    const r = fakeRes()
    setUploadedFileHeaders(r as never, { mime: 'application/pdf', filename: 'a"b\r\nc.pdf', inline: false })
    expect(r.headers['content-disposition']).not.toMatch(/[\r\n]/)
    expect(r.headers['content-disposition']).toMatch(/filename="a_b__c\.pdf"/)
  })
})
