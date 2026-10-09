import { describe, expect, it } from 'vitest';
import { fmtDate, fmtDateTime, fmtDuration, fmtTime, inr, monthLabel } from '../format';

/** Some ICU builds put a (narrow) no-break space after ₹; compare without it. */
const plain = (s: string) => s.replace(/[   ]/g, '');

describe('money', () => {
  it('inr takes paise and prints whole rupees with Indian grouping', () => {
    expect(plain(inr(1_25_000_00))).toBe('₹1,25,000');
    expect(plain(inr(12_34_56_789_00))).toBe('₹12,34,56,789');
    expect(plain(inr(0))).toBe('₹0');
    expect(plain(inr(99_49))).toBe('₹99');
  });
});

describe('dates and times (IST)', () => {
  it('fmtDate is DD MMM YYYY in IST — a UTC evening is the next IST day', () => {
    expect(fmtDate('2026-09-06T00:00:00Z')).toBe('06 Sep 2026');
    expect(fmtDate('2026-09-06T20:00:00Z')).toBe('07 Sep 2026');
    expect(fmtDate(new Date('2026-01-31T10:00:00Z'))).toBe('31 Jan 2026');
  });
  it('fmtTime is hh:mm AM/PM in IST', () => {
    expect(fmtTime('2026-09-06T04:02:00Z')).toBe('09:32 AM');
    expect(fmtTime('2026-09-06T12:30:00Z')).toBe('06:00 PM');
  });
  it('fmtDateTime joins both', () => {
    expect(fmtDateTime('2026-09-06T04:02:00Z')).toBe('06 Sep 2026 · 09:32 AM');
  });
  it('fmtDuration and monthLabel', () => {
    expect(fmtDuration(529)).toBe('08h 49m');
    expect(fmtDuration(0)).toBe('00h 00m');
    expect(monthLabel('2026-08-01')).toBe('August 2026');
    expect(monthLabel('2027-01-31')).toBe('January 2027');
  });
});
