/**
 * Dashboard widget registry (§6.2).
 *
 * The Dashboard NEVER imports from a module. Modules import this registry
 * and call `registerWidget()` at module load time. When Workstation (or any
 * Part 2 module) ships, it registers into the same slots — no Dashboard
 * change needed.
 */

import type { ComponentType } from 'react';
import type { RoleCode } from '@/data/models';
import type { Scope } from '@/platform/rbac/matrix';

export type WidgetSlot = 'hero' | 'primary' | 'secondary' | 'queue' | 'feed';

export interface WidgetRegistration {
  id: string; // e.g. 'hrms.attendance-today'
  slot: WidgetSlot;
  roles: RoleCode[]; // roles allowed to see this widget
  scope: Scope;
  component: ComponentType;
  order?: number; // lower first; default 100
}

const registry = new Map<string, WidgetRegistration>();

export function registerWidget(reg: WidgetRegistration): void {
  registry.set(reg.id, reg);
}

export function widgetsFor(role: RoleCode, slot: WidgetSlot): WidgetRegistration[] {
  return Array.from(registry.values())
    .filter((w) => w.slot === slot && w.roles.includes(role))
    .sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
}

export function allSlots(): WidgetSlot[] {
  return ['hero', 'primary', 'secondary', 'queue', 'feed'];
}
