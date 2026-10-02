import { describe, expect, it } from 'vitest'
import { isAllowedOrigin, isLanOrigin } from '../origin.js'

const LIST = ['http://localhost:5173', 'https://app.auditos.in']

describe('isAllowedOrigin', () => {
  it('accepts an explicitly listed origin in production', () => {
    expect(isAllowedOrigin('https://app.auditos.in', LIST, false)).toBe(true)
  })

  it('rejects an unlisted LAN origin in production', () => {
    // The whole point of the production path: no implicit trust.
    expect(isAllowedOrigin('http://10.58.70.139:5173', LIST, false)).toBe(false)
  })

  it('accepts an unlisted LAN origin in development', () => {
    expect(isAllowedOrigin('http://10.58.70.139:5173', LIST, true)).toBe(true)
  })

  it('rejects a public origin even in development', () => {
    expect(isAllowedOrigin('https://evil.example.com', LIST, true)).toBe(false)
  })
})

describe('isLanOrigin', () => {
  it.each([
    'http://localhost:5173',
    'http://127.0.0.1:4000',
    'http://10.58.70.139:5173',
    'http://172.16.53.38:5173',
    'http://172.31.255.255',
    'http://192.168.1.60:5173',
    'http://169.254.10.1',
    'http://kaarthika-laptop.local:5173',
    'http://[::1]:5173',
    'http://[fd12:3456::1]:5173',
  ])('accepts %s', (origin) => {
    expect(isLanOrigin(origin)).toBe(true)
  })

  it.each([
    'https://evil.example.com',
    'http://8.8.8.8',
    // 172.32 is outside 172.16.0.0/12 — the classic off-by-one.
    'http://172.32.0.1:5173',
    'http://172.15.0.1:5173',
    // 192.169 is not 192.168.
    'http://192.169.1.1',
    // Looks private but is a hostname a public DNS server can answer.
    'http://10.0.0.1.evil.com',
    'file:///etc/passwd',
    'not a url',
    '',
  ])('rejects %s', (origin) => {
    expect(isLanOrigin(origin)).toBe(false)
  })

  it('rejects octets out of range', () => {
    expect(isLanOrigin('http://10.999.0.1')).toBe(false)
  })
})
