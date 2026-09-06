/**
 * Client-side `can()` — for menu rendering only.
 * Never a security control (§4.3). The API is the security control.
 */
import { hasPermission, type PermissionCode, type Scope } from './matrix';
import type { RoleCode } from '@/data/models';

export function can(
  role: RoleCode | undefined,
  permission: PermissionCode,
  scope: Scope = 'self',
): boolean {
  if (!role) return false;
  return hasPermission(role, permission, scope);
}
