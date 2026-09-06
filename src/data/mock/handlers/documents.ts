/**
 * Documents handlers per §8.8 + §9.
 *
 *   GET    /api/documents                  scoped list (self/dept/org); Finance → 403
 *   POST   /api/documents                  upload metadata (mock file_key)
 *   DELETE /api/documents/:id              HR/MD (or owner deleting own pending doc)
 *   GET    /api/documents/:id/download?t   signed-URL simulation
 *
 * "Signed URLs" (§8.8 + §11): the endpoint returns a short-lived token via a
 * separate GET, and the download URL includes it. Requests without a valid
 * token get 403. In production this is HMAC + expiry; here it's a random
 * string cached in memory for 5 minutes.
 *
 * File bytes: no real file storage in mock mode. `download` returns a small
 * text payload derived from the document metadata so the demo shows a real
 * blob-download event.
 */

import { http, HttpResponse } from 'msw';
import { db } from '../db';
import { audit, err, ok, withAuth } from '../middleware';
import type { DocumentType, EmployeeDocument, RoleCode } from '@/data/models';
import { hasPermission, type Scope } from '@/platform/rbac/matrix';
import { addDays, istToday, daysBetween } from '@/lib/dates';

// ── Signed-URL token store (in-memory, 5-minute TTL) ──────────────────────
const tokens = new Map<string, { docId: string; userId: string; expiresAt: number }>();
function issueToken(docId: string, userId: string): string {
  const tok = `${crypto.randomUUID()}`;
  tokens.set(tok, { docId, userId, expiresAt: Date.now() + 5 * 60_000 });
  return tok;
}
function verifyToken(tok: string): { docId: string; userId: string } | null {
  const rec = tokens.get(tok);
  if (!rec) return null;
  if (rec.expiresAt < Date.now()) {
    tokens.delete(tok);
    return null;
  }
  return { docId: rec.docId, userId: rec.userId };
}

// ── Helpers ───────────────────────────────────────────────────────────────
function roleOf(userId: string): RoleCode | null {
  const u = db.read().users.find((x) => x.id === userId);
  if (!u) return null;
  return db.read().roles.find((x) => x.id === u.role_id)?.code ?? null;
}
function documentScope(role: RoleCode): Scope | 'blocked' {
  if (hasPermission(role, 'document.manage', 'organisation')) return 'organisation';
  if (hasPermission(role, 'document.read', 'organisation')) return 'organisation';
  if (hasPermission(role, 'document.read', 'department')) return 'department';
  if (hasPermission(role, 'document.read', 'self')) return 'self';
  return 'blocked';
}

/**
 * Reconcile status from expiry_date + current stored status.
 * Pending Verification is sticky — HR/MD flips it away explicitly.
 */
function reconcileStatus(doc: EmployeeDocument): EmployeeDocument['status'] {
  if (doc.status === 'pending_verification') return 'pending_verification';
  if (!doc.expiry_date) return 'valid';
  const today = istToday();
  const days = daysBetween(today, doc.expiry_date);
  if (days < 0) return 'expired';
  if (days <= 30) return 'expiring_soon';
  return 'valid';
}

function withDerived(doc: EmployeeDocument) {
  return { ...doc, status: reconcileStatus(doc) };
}

// ── Handlers ──────────────────────────────────────────────────────────────

export const documentHandlers = [
  // GET /api/documents
  http.get(
    '/api/documents',
    withAuth(async ({ user, employee, request }) => {
      const url = new URL(request.url);
      const type = url.searchParams.get('type') as DocumentType | null;
      const status = url.searchParams.get('status');
      const employeeId = url.searchParams.get('employeeId');
      const expiringWithinDays = url.searchParams.get('expiringWithinDays');

      const role = roleOf(user.id)!;
      const scope = documentScope(role);
      if (scope === 'blocked') return err(403, 'forbidden', 'Access denied.');

      let rows = db.read().documents.filter((d) => !d.deleted_at);
      // Scope narrowing.
      if (scope === 'self') {
        if (!employee) return ok({ items: [], count: 0, scope });
        rows = rows.filter((d) => d.employee_id === employee.id);
      } else if (scope === 'department') {
        if (!employee) return ok({ items: [], count: 0, scope });
        const deptEmpIds = db
          .read()
          .employees.filter((e) => e.department_id === employee.department_id)
          .map((e) => e.id);
        rows = rows.filter((d) => deptEmpIds.includes(d.employee_id));
      }

      if (employeeId) {
        // Cross-scope check.
        const target = db.read().employees.find((e) => e.id === employeeId);
        if (!target) return err(403, 'forbidden', 'Access denied.');
        if (scope === 'self' && employee?.id !== employeeId)
          return err(403, 'forbidden', 'Access denied.');
        if (scope === 'department' && employee?.department_id !== target.department_id)
          return err(403, 'forbidden', 'Access denied.');
        rows = rows.filter((d) => d.employee_id === employeeId);
      }
      if (type) rows = rows.filter((d) => d.type === type);

      // Reconcile status derivations before filtering.
      const withStatus = rows.map(withDerived);
      const finalRows = withStatus
        .filter((d) => (status ? d.status === status : true))
        .filter((d) => {
          if (!expiringWithinDays) return true;
          if (!d.expiry_date) return false;
          const n = Number(expiringWithinDays);
          const days = daysBetween(istToday(), d.expiry_date);
          return days >= 0 && days <= n;
        });

      // Enrich with employee display fields.
      const enriched = finalRows
        .sort((a, b) => (a.uploaded_at > b.uploaded_at ? -1 : 1))
        .map((d) => {
          const emp = db.read().employees.find((e) => e.id === d.employee_id);
          const uploader = db.read().users.find((u) => u.id === d.uploaded_by);
          const uploaderEmp = uploader?.employee_id
            ? db.read().employees.find((e) => e.id === uploader.employee_id)
            : null;
          return {
            ...d,
            employee: emp ? { id: emp.id, full_name: emp.full_name, employee_code: emp.employee_code } : null,
            uploader_label: uploaderEmp?.full_name ?? uploader?.email ?? 'system',
          };
        });

      return ok({ items: enriched, count: enriched.length, scope });
    }),
  ),

  // POST /api/documents
  http.post(
    '/api/documents',
    withAuth(async ({ user, employee, request }) => {
      const role = roleOf(user.id)!;
      const canManage = hasPermission(role, 'document.manage', 'organisation');
      const body = (await request.json().catch(() => ({}))) as Partial<EmployeeDocument> & {
        employee_id?: string;
        file_body_preview?: string;
      };
      const targetId = body.employee_id;
      if (!body.name?.trim() || !body.type || !targetId) {
        return err(400, 'validation', 'name, type and employee_id are required.');
      }
      if (!canManage && employee?.id !== targetId) {
        return err(403, 'forbidden', 'You can only upload to your own record.');
      }
      const target = db.read().employees.find((e) => e.id === targetId);
      if (!target || target.deleted_at) {
        return err(422, 'invalid_target', 'Target employee not found or inactive.');
      }

      const nowISO = new Date().toISOString();
      const doc: EmployeeDocument = {
        id: `doc-${crypto.randomUUID()}`,
        employee_id: targetId,
        name: body.name.trim(),
        type: body.type,
        file_key: `mock/${body.name.replace(/\s+/g, '-').toLowerCase()}.pdf`,
        uploaded_by: user.id,
        uploaded_at: nowISO,
        expiry_date: body.expiry_date ?? null,
        // Employees uploading their own bank details → pending_verification.
        // HR uploads default to valid unless caller sets pending_verification.
        status:
          !canManage && body.type === 'bank'
            ? 'pending_verification'
            : (body.status ?? 'valid'),
        created_at: nowISO,
        updated_at: nowISO,
        created_by: user.id,
        updated_by: user.id,
        deleted_at: null,
      };
      db.write((d) => d.documents.push(doc));
      audit({
        actor_user_id: user.id,
        action: 'document.uploaded',
        entity_type: 'EmployeeDocument',
        entity_id: doc.id,
        after_json: { name: doc.name, type: doc.type, employee_id: targetId },
        request,
      });
      return ok({ document: withDerived(doc) });
    }),
  ),

  // DELETE /api/documents/:id  — HR/MD only
  http.delete(
    '/api/documents/:id',
    withAuth(async ({ user, params, request }) => {
      const role = roleOf(user.id)!;
      if (!hasPermission(role, 'document.manage', 'organisation')) {
        return err(403, 'forbidden', 'Only HR or MD can delete documents.');
      }
      const id = String(params.id);
      const doc = db.read().documents.find((d) => d.id === id);
      if (!doc) return err(404, 'not_found', 'Document not found.');
      const nowISO = new Date().toISOString();
      db.write((d) => {
        const t = d.documents.find((x) => x.id === id);
        if (t) t.deleted_at = nowISO;
      });
      audit({
        actor_user_id: user.id,
        action: 'document.deleted',
        entity_type: 'EmployeeDocument',
        entity_id: id,
        before_json: doc,
        request,
      });
      return new HttpResponse(null, { status: 204 });
    }),
  ),

  // GET /api/documents/:id/download-url  — issue signed URL
  http.get(
    '/api/documents/:id/download-url',
    withAuth(async ({ user, employee, params }) => {
      const id = String(params.id);
      const doc = db.read().documents.find((d) => d.id === id && !d.deleted_at);
      if (!doc) return err(404, 'not_found', 'Document not found.');
      const role = roleOf(user.id)!;
      const scope = documentScope(role);
      if (scope === 'blocked') return err(403, 'forbidden', 'Access denied.');
      const target = db.read().employees.find((e) => e.id === doc.employee_id);
      const allowed =
        scope === 'organisation' ||
        (scope === 'department' && employee?.department_id === target?.department_id) ||
        (scope === 'self' && employee?.id === doc.employee_id);
      if (!allowed) return err(403, 'forbidden', 'Access denied.');

      const tok = issueToken(id, user.id);
      // Short-lived: 5 minutes; convey the URL back to the client.
      return ok({
        url: `/api/documents/${id}/download?t=${encodeURIComponent(tok)}`,
        expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
      });
    }),
  ),

  // GET /api/documents/:id/download?t=…  — actual bytes
  http.get('/api/documents/:id/download', async ({ request, params }) => {
    const id = String((params as { id: string }).id);
    const url = new URL(request.url);
    const tok = url.searchParams.get('t');
    if (!tok) {
      return HttpResponse.json({ error: { code: 'missing_token', message: 'Token required.' } }, { status: 403 });
    }
    const rec = verifyToken(tok);
    if (!rec || rec.docId !== id) {
      return HttpResponse.json({ error: { code: 'invalid_token', message: 'Invalid or expired token.' } }, { status: 403 });
    }
    const doc = db.read().documents.find((d) => d.id === id && !d.deleted_at);
    if (!doc) return HttpResponse.json({ error: { code: 'not_found', message: 'Document not found.' } }, { status: 404 });

    // Mock file bytes — a small text payload derived from the metadata.
    const body = `Audit OS — Mock document payload\n\nid: ${doc.id}\nname: ${doc.name}\ntype: ${doc.type}\nemployee: ${doc.employee_id}\nfile_key: ${doc.file_key}\nissued_to_user: ${rec.userId}\n`;
    return new HttpResponse(body, {
      status: 200,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${doc.name.replace(/[^A-Za-z0-9._-]/g, '_')}.txt"`,
      },
    });
  }),
];

/** Exported for the dashboard aggregate — expiring within N days. */
export function expiringDocsForCaller(userId: string, employeeId: string | null | undefined, withinDays: number): {
  id: string; name: string; employee_id: string; expiry_date: string; days_left: number;
}[] {
  const role = roleOf(userId);
  if (!role) return [];
  const scope = documentScope(role);
  if (scope === 'blocked') return [];
  const today = istToday();
  const from = today;
  const to = addDays(today, withinDays);

  let rows = db.read().documents.filter((d) => !d.deleted_at && d.expiry_date);
  if (scope === 'self') {
    if (!employeeId) return [];
    rows = rows.filter((d) => d.employee_id === employeeId);
  } else if (scope === 'department') {
    if (!employeeId) return [];
    const emp = db.read().employees.find((e) => e.id === employeeId);
    if (!emp) return [];
    const deptEmpIds = db
      .read()
      .employees.filter((e) => e.department_id === emp.department_id)
      .map((e) => e.id);
    rows = rows.filter((d) => deptEmpIds.includes(d.employee_id));
  }
  return rows
    .filter((d) => d.expiry_date! >= from && d.expiry_date! <= to)
    .map((d) => ({
      id: d.id,
      name: d.name,
      employee_id: d.employee_id,
      expiry_date: d.expiry_date!,
      days_left: daysBetween(today, d.expiry_date!),
    }))
    .sort((a, b) => a.days_left - b.days_left);
}
