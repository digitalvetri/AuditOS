/**
 * Auth handlers (§9).
 *   POST /api/auth/login   { email, password } -> { user, role, employee }
 *   POST /api/auth/logout
 *   GET  /api/auth/me      current session
 *
 * Session model (mock): the "access token" is the user id, set as a cookie.
 * Real backend: swap for JWT verify — handlers otherwise unchanged.
 */

import { http, HttpResponse } from 'msw';
import { db } from '../db';
import {
  audit,
  clearAccessCookie,
  err,
  ok,
  setAccessCookie,
  withAuth,
} from '../middleware';

interface LoginBody {
  email?: string;
  password?: string;
}

export const authHandlers = [
  http.post('/api/auth/login', async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as LoginBody;
    const email = body.email?.trim().toLowerCase();
    const password = body.password ?? '';
    if (!email || !password) {
      return err(400, 'validation', 'Email and password are required.');
    }

    const user = db
      .read()
      .users.find((u) => u.email.toLowerCase() === email && u.is_active);
    if (!user || user.password_hash !== `plain:${password}`) {
      audit({
        actor_user_id: null,
        action: 'auth.login_failed',
        entity_type: 'User',
        entity_id: email,
        request,
      });
      return err(401, 'invalid_credentials', 'Invalid email or password.');
    }

    db.write((d) => {
      const u = d.users.find((x) => x.id === user.id);
      if (u) u.last_login_at = new Date().toISOString();
    });

    const role = db.read().roles.find((r) => r.id === user.role_id)!;
    const employee = user.employee_id
      ? db.read().employees.find((e) => e.id === user.employee_id) ?? null
      : null;

    return ok(
      {
        user: { id: user.id, email: user.email },
        role: { id: role.id, code: role.code, name: role.name },
        employee: employee
          ? {
              id: employee.id,
              full_name: employee.full_name,
              department_id: employee.department_id,
              designation_id: employee.designation_id,
              photo_url: employee.photo_url,
              employee_code: employee.employee_code,
            }
          : null,
      },
      { headers: { 'Set-Cookie': setAccessCookie(user.id) } },
    );
  }),

  http.post(
    '/api/auth/logout',
    withAuth(async () => {
      // Use HttpResponse so MSW forwards the Set-Cookie to document.cookie.
      // A plain `new Response()` bypasses MSW's cookie interception path.
      return new HttpResponse(null, {
        status: 204,
        headers: { 'Set-Cookie': clearAccessCookie() },
      });
    }),
  ),

  http.get(
    '/api/auth/me',
    withAuth(async ({ user, employee }) => {
      const role = db.read().roles.find((r) => r.id === user.role_id)!;
      return ok({
        user: { id: user.id, email: user.email },
        role: { id: role.id, code: role.code, name: role.name },
        employee: employee
          ? {
              id: employee.id,
              full_name: employee.full_name,
              department_id: employee.department_id,
              designation_id: employee.designation_id,
              photo_url: employee.photo_url,
              employee_code: employee.employee_code,
            }
          : null,
      });
    }),
  ),
];
