import { describe, expect, it } from 'vitest'
import { maskPan, maskPersonalData } from '../mask.js'

describe('maskPersonalData — what leaves for the outside AI service', () => {
  it('PAN keeps the first five letters and the last letter', () => {
    expect(maskPan('AAACK1234F')).toBe('AAACK****F')
    expect(maskPersonalData('PAN: ABCDE1234F.')).toBe('PAN: ABCDE****F.')
  })

  it('GSTIN keeps the state code and the last three characters; its PAN does not leak', () => {
    const out = maskPersonalData('GSTIN 27AAACK1234F1Z5 of the taxpayer')
    expect(out).toBe('GSTIN 27**********1Z5 of the taxpayer')
    expect(out).not.toContain('AAACK')
    expect(out).not.toContain('1234')
  })

  it('Aadhaar (12 digits, grouped or not) keeps only the last four', () => {
    expect(maskPersonalData('Aadhaar 2345 6789 0123')).toBe('Aadhaar XXXX XXXX 0123')
    expect(maskPersonalData('Aadhaar 234567890123.')).toBe('Aadhaar XXXX XXXX 0123.')
    expect(maskPersonalData('UID 2345-6789-0123')).toBe('UID XXXX XXXX 0123')
  })

  it('mobile numbers, with or without +91 / 0', () => {
    expect(maskPersonalData('Call 9876543210')).toBe('Call [phone]')
    expect(maskPersonalData('Call +91 98765 43210 now')).toBe('Call [phone] now')
    expect(maskPersonalData('Ph: 09876543210')).toBe('Ph: [phone]')
  })

  it('email addresses', () => {
    expect(maskPersonalData('Write to ravi.k+gst@example.co.in today')).toBe('Write to [email] today')
  })

  it('leaves reference numbers, amounts, dates and sections alone', () => {
    const text = [
      'Reference No. ZD290323001234X dated 12/03/2026',
      'Demand of Rs. 12,34,56,789 and 9,87,65,43,210.50 under section 73(1)',
      'Period 2023-24, ARN AA2903230012345, DIN 2026031234567',
      'Amount 98765.43210',
    ].join('\n')
    expect(maskPersonalData(text)).toBe(text)
  })

  it('masks everything in one notice and is idempotent', () => {
    const text = 'M/s Ravi Traders (GSTIN 29ABCDE1234F1Z5, PAN ABCDE1234F), proprietor Aadhaar 4567 8901 2345, mobile 9123456789, ravi@traders.in'
    const once = maskPersonalData(text)
    expect(once).toBe('M/s Ravi Traders (GSTIN 29**********1Z5, PAN ABCDE****F), proprietor Aadhaar XXXX XXXX 2345, mobile [phone], [email]')
    expect(maskPersonalData(once)).toBe(once)
  })
})
