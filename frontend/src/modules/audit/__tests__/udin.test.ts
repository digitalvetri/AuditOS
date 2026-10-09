import { describe, expect, it } from 'vitest';
import { udinError } from '../udin';

describe('UDIN validator', () => {
  const ok = '26212345ABCDEF1234';

  it('accepts a well-formed UDIN that carries the membership number', () => {
    expect(udinError(ok, '212345')).toBeNull();
    expect(udinError(ok, '')).toBeNull();
    expect(udinError(` ${ok} `, '212345')).toBeNull();
    // Short membership numbers are zero-padded to six digits.
    expect(udinError('26012345ABCDEF1234', '12345')).toBeNull();
  });

  it('rejects empty, wrong length and wrong shape', () => {
    expect(udinError('', '')).toBe('Enter the UDIN.');
    expect(udinError('26212345ABCDEF123', '')).toMatch(/18 characters; this is 17/);
    expect(udinError('X6212345ABCDEF1234', '')).toMatch(/year/);
    expect(udinError('2621234XABCDEF1234', '')).toMatch(/membership number/);
    expect(udinError('26212345abcdef1234', '')).toMatch(/uppercase/);
  });

  it('cross-checks the membership number', () => {
    expect(udinError(ok, '212346')).toMatch(/does not match 212346/);
    expect(udinError(ok, '1234567')).toMatch(/up to 6 digits/);
    expect(udinError(ok, 'ABC')).toMatch(/up to 6 digits/);
  });
});
