import { describe, expect, it } from 'vitest';
import {
  gstinCheckChar, gstinError, gstinMatchesPan, isCin, isGstin, isLlpin, isPan, isTan, normId, panOfGstin,
} from '../ids';

/** A well-formed GSTIN built with the real check character (never hard-coded). */
const gstin = (first14: string) => first14 + gstinCheckChar(first14);

describe('PAN / TAN / CIN / LLPIN', () => {
  it('PAN is 5 letters, 4 digits, 1 letter', () => {
    expect(isPan('AAACK1234F')).toBe(true);
    expect(isPan('AAACK1234')).toBe(false);
    expect(isPan('AAAC11234F')).toBe(false);
    expect(isPan('aaack1234f')).toBe(false); // callers normalise first
    expect(isPan(normId('  aaack1234f '))).toBe(true);
  });
  it('TAN is 4 letters, 5 digits, 1 letter', () => {
    expect(isTan('CHEK09876B')).toBe(true);
    expect(isTan('CHE09876BB')).toBe(false);
  });
  it('CIN and LLPIN shapes', () => {
    expect(isCin('U74999TN2020PTC123456')).toBe(true);
    expect(isCin('X74999TN2020PTC123456')).toBe(false);
    expect(isCin('U74999TN2020PTC12345')).toBe(false);
    expect(isLlpin('AAB-1234')).toBe(true);
    expect(isLlpin('AAB1234')).toBe(false);
  });
});

describe('GSTIN checksum', () => {
  const good = gstin('27AAACK1234F1Z');

  it('accepts the right check character', () => {
    expect(good).toHaveLength(15);
    expect(isGstin(good)).toBe(true);
    expect(gstinError(good)).toBeNull();
  });

  it('a single mistyped character fails the checksum', () => {
    const wrongCheck = good.slice(0, 14) + (good[14] === '0' ? '1' : '0');
    expect(isGstin(wrongCheck)).toBe(false);
    expect(gstinError(wrongCheck)).toMatch(/check character/);
    // Typo in the PAN part, check char unchanged.
    const typo = good.slice(0, 5) + (good[5] === 'C' ? 'D' : 'C') + good.slice(6);
    expect(isGstin(typo)).toBe(false);
  });

  it('known-good public GSTIN checksums', () => {
    // Check characters computed by GSTN's mod-36 algorithm.
    expect(gstinCheckChar('27AAPFU0939F1Z')).toBe('V');
    expect(gstinCheckChar('29AAGCB7383J1Z')).toBe('4');
  });

  it('shape errors and the PAN cross-check', () => {
    expect(gstinError('27AAACK1234F1Z')).toMatch(/15-character/);
    expect(panOfGstin(good)).toBe('AAACK1234F');
    expect(gstinMatchesPan(good, 'AAACK1234F')).toBe(true);
    expect(gstinMatchesPan(good, 'BBBCK1234F')).toBe(false);
    expect(gstinMatchesPan('', 'AAACK1234F')).toBe(true);
    expect(gstinError(good, 'BBBCK1234F')).toMatch(/does not match the PAN/);
    expect(gstinError(good, 'AAACK1234F')).toBeNull();
  });
});
