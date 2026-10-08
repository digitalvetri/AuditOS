/**
 * How a user is named to other people. The Super Admin (DigitalVetri) is a
 * system account: it is never shown by email or name, only as "System
 * administrator". Every endpoint that labels a user selects USER_LABEL_SELECT
 * and calls userLabel(), so this rule lives in one place.
 */
export const USER_LABEL_SELECT = {
  id: true,
  email: true,
  role: { select: { code: true } },
  employee: { select: { fullName: true } },
} as const

export function userLabel(u: { email: string; role: { code: string }; employee: { fullName: string } | null }): string {
  if (u.role.code === 'md') return 'System administrator'
  return u.employee?.fullName ?? u.email
}
