import { describe, expect, it } from 'vitest'
import { b2clThresholdPaise } from '../gst.js'

describe('bookkeeping GSTR-1: B2CL threshold', () => {
  it('is more than ₹1 lakh from 1 Aug 2024 (Notification 12/2024-CT), ₹2.5 lakh before', () => {
    expect(b2clThresholdPaise('2024-07-31')).toBe(2_50_000_00)
    expect(b2clThresholdPaise('2024-08-01')).toBe(1_00_000_00)
    expect(b2clThresholdPaise('2026-11-16')).toBe(1_00_000_00)
  })
})
