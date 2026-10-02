/**
 * GET /api/dashboard/widgets — returns registered widgets visible to caller.
 *
 * Registration happens on the client (see platform/dashboard/registry). The
 * API returns the set of widget IDs the caller is entitled to see, and the
 * client renders those. This keeps the Dashboard from importing modules.
 */

import { http } from 'msw';
import { db } from '../db';
import { ok, withAuth } from '../middleware';

export const dashboardHandlers = [
  http.get(
    '/api/dashboard/widgets',
    withAuth(async ({ user }) => {
      const role = db.read().roles.find((r) => r.id === user.role_id)!;
      // In this scaffold we return the role code; the client-side registry
      // filters registered widgets against it. When Part 2 modules register
      // their own widgets, no server change is needed.
      return ok({ role: role.code });
    }),
  ),
];
