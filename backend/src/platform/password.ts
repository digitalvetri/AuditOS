/**
 * The one password rule, used by every endpoint that sets a password
 * (change-password, admin create / reset, setup-owners). The frontend mirrors
 * it for instant feedback; this is the control.
 */
export function passwordProblem(pw: string): string | null {
  if (pw.length < 8) return 'Password must be at least 8 characters.'
  if (pw.length > 128) return 'Password must be at most 128 characters.'
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return 'Password must contain letters and numbers.'
  return null
}
