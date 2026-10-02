/**
 * Notifications (§8.9 platform primitive).
 *
 *   GET   /api/notifications              caller's own
 *   PATCH /api/notifications/:id/read
 *   POST  /api/notifications/read-all
 *
 * The primitive is Part 1-owned but consumed by every module — attendance
 * check-in/out, leave state changes, correction outcomes, and (Part 2)
 * payslip publish, expense stage changes, chat mentions all emit into it.
 */

import { http } from 'msw';
import { db } from '../db';
import { err, ok, withAuth } from '../middleware';

export const notificationHandlers = [
  http.get(
    '/api/notifications',
    withAuth(async ({ user, request }) => {
      const url = new URL(request.url);
      const limit = Number(url.searchParams.get('limit') ?? '20');
      const rows = db.read().notifications.filter((n) => n.user_id === user.id);
      const sorted = [...rows].sort((a, b) => (a.created_at > b.created_at ? -1 : 1));
      const items = sorted.slice(0, Math.max(1, Math.min(100, limit)));
      const unread = rows.filter((n) => !n.is_read).length;
      return ok({ items, unread, total: rows.length });
    }),
  ),

  http.patch(
    '/api/notifications/:id/read',
    withAuth(async ({ user, params }) => {
      const id = String(params.id);
      const target = db.read().notifications.find((n) => n.id === id);
      if (!target) return err(404, 'not_found', 'Notification not found.');
      if (target.user_id !== user.id) return err(403, 'forbidden', 'Access denied.');
      db.write((d) => {
        const t = d.notifications.find((n) => n.id === id);
        if (t) t.is_read = true;
      });
      return ok({ notification: db.read().notifications.find((n) => n.id === id)! });
    }),
  ),

  http.post(
    '/api/notifications/read-all',
    withAuth(async ({ user }) => {
      db.write((d) => {
        for (const n of d.notifications) {
          if (n.user_id === user.id) n.is_read = true;
        }
      });
      return ok({ ok: true });
    }),
  ),
];
