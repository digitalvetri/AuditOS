/** Mirrors backend/src/platform/password.ts — the server is the control. */
export function passwordProblem(pw: string): string | null {
  if (pw.length < 8) return 'Password must be at least 8 characters.';
  if (pw.length > 128) return 'Password must be at most 128 characters.';
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return 'Password must contain letters and numbers.';
  return null;
}

// No look-alikes (0/O, 1/l/I): an Admin may read this out to a colleague.
const LETTERS = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';
const DIGITS = '23456789';

/** 12 characters: 8 letters + 4 digits, shuffled, from crypto randomness. */
export function generatePassword(): string {
  const rand = (n: number) => crypto.getRandomValues(new Uint32Array(1))[0] % n;
  const chars = [
    ...Array.from({ length: 8 }, () => LETTERS[rand(LETTERS.length)]),
    ...Array.from({ length: 4 }, () => DIGITS[rand(DIGITS.length)]),
  ];
  for (let i = chars.length - 1; i > 0; i--) {
    const j = rand(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}
