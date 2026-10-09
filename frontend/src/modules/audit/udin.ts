/** UDIN format check — pure, shared by the UDIN register and the audit file. */

/**
 * ICAI UDIN: 18 characters — 2-digit year, 6-digit membership number, then
 * 10 uppercase letters or digits. Returns an error message, or null when
 * the UDIN is well formed and carries `membershipNo`.
 */
export function udinError(udin: string, membershipNo: string): string | null {
  const u = udin.trim();
  if (!u) return 'Enter the UDIN.';
  if (u.length !== 18) return `A UDIN is 18 characters; this is ${u.length}.`;
  if (!/^\d{2}/.test(u)) return 'The first two characters are the year (digits).';
  if (!/^\d{8}/.test(u)) return 'Characters 3–8 are the 6-digit membership number.';
  if (!/^\d{8}[A-Z0-9]{10}$/.test(u)) return 'The last 10 characters must be uppercase letters or digits.';
  const m = membershipNo.trim();
  if (m) {
    if (!/^\d{1,6}$/.test(m)) return 'Membership number is up to 6 digits.';
    if (u.slice(2, 8) !== m.padStart(6, '0')) return `The membership number inside the UDIN (${u.slice(2, 8)}) does not match ${m.padStart(6, '0')}.`;
  }
  return null;
}
