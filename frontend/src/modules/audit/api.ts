import { api, type ApiError } from '@/services/api';
import { downloadFile } from '@/modules/workstation/invoices/download';
import type {
  AuditFile, AuditListResponse, AuditObservation, AuditRisk, AuditTeamMember, AuditUdin,
  ChecklistResponse, ChecklistTemplate, MissingUdin, ReviewNote, WorkingPaper, WorkingPaperFile,
} from './types';

/**
 * Audit files API — `/api/audits` (docs/audit-files/README.md).
 *
 * Every write takes its body whole; the pages pass it through the file's
 * `useAuditWrite()` (AuditContext) first, so once the file is locked the
 * addendum flag and reason ride along on every POST / PUT / PATCH.
 */

function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === '' || v === false) continue;
    sp.set(k, v === true ? '1' : String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

type Body = Record<string, unknown>;

/** Sub-lists come back as bare arrays; an `{ items }` envelope is accepted too. */
const listOf = <T,>(x: T[] | { items?: T[] } | null | undefined): T[] =>
  Array.isArray(x) ? x : x?.items ?? [];
const getList = async <T,>(path: string): Promise<T[]> => listOf(await api.get<T[] | { items: T[] }>(path));

const base = '/api/audits';

export interface AuditListFilters {
  client_id?: string;
  financial_year?: string;
  audit_type?: string;
  status?: string;
  mine?: boolean;
  q?: string;
}

export interface UdinFilters {
  from?: string;
  to?: string;
  client_id?: string;
  partner_id?: string;
  include_revoked?: boolean;
}

export const auditApi = {
  list: (f: AuditListFilters = {}) => api.get<AuditListResponse>(`${base}${qs({ ...f })}`),
  get: (id: string) => api.get<AuditFile>(`${base}/${id}`),
  create: (body: Body) => api.post<AuditFile>(base, body),
  update: (id: string, body: Body) => api.patch<AuditFile>(`${base}/${id}`, body),
  approveAcceptance: (id: string, body: Body) => api.post<AuditFile>(`${base}/${id}/acceptance/approve`, body),
  materiality: (id: string, body: Body) => api.put<AuditFile>(`${base}/${id}/materiality`, body),
  sign: (id: string, body: Body) => api.post<AuditFile>(`${base}/${id}/sign`, body),
  lock: (id: string, body: Body) => api.post<AuditFile>(`${base}/${id}/lock`, body),

  // ── Team ────────────────────────────────────────────────────────────────
  team: (id: string) => getList<AuditTeamMember>(`${base}/${id}/team`),
  addMember: (id: string, body: Body) => api.post<AuditTeamMember>(`${base}/${id}/team`, body),
  removeMember: (id: string, memberId: string) => api.delete<void>(`${base}/${id}/team/${memberId}`),
  declareIndependence: (id: string, body: Body) =>
    api.post<AuditTeamMember>(`${base}/${id}/team/declare-independence`, body),

  // ── Working papers ──────────────────────────────────────────────────────
  workingPapers: (id: string) => getList<WorkingPaper>(`${base}/${id}/working-papers`),
  addWorkingPaper: (id: string, body: Body) => api.post<WorkingPaper>(`${base}/${id}/working-papers`, body),
  updateWorkingPaper: (id: string, wpId: string, body: Body) =>
    api.patch<WorkingPaper>(`${base}/${id}/working-papers/${wpId}`, body),
  prepare: (id: string, wpId: string, body: Body) =>
    api.post<WorkingPaper>(`${base}/${id}/working-papers/${wpId}/prepare`, body),
  review: (id: string, wpId: string, body: Body) =>
    api.post<WorkingPaper>(`${base}/${id}/working-papers/${wpId}/review`, body),
  reopen: (id: string, wpId: string, body: Body) =>
    api.post<WorkingPaper>(`${base}/${id}/working-papers/${wpId}/reopen`, body),
  uploadFile: (id: string, wpId: string, file: File, extra: Body) => {
    const form = new FormData();
    form.append('file', file);
    for (const [k, v] of Object.entries(extra)) {
      if (v !== undefined && v !== null) form.append(k, String(v));
    }
    return api.postForm<WorkingPaperFile>(`${base}/${id}/working-papers/${wpId}/files`, form);
  },
  fileUrl: (id: string, wpId: string, fileId: string) => `${base}/${id}/working-papers/${wpId}/files/${fileId}`,
  deleteFile: (id: string, wpId: string, fileId: string) =>
    api.delete<void>(`${base}/${id}/working-papers/${wpId}/files/${fileId}`),

  // ── Review notes ────────────────────────────────────────────────────────
  notes: (id: string, status?: string) => getList<ReviewNote>(`${base}/${id}/review-notes${qs({ status })}`),
  addNote: (id: string, body: Body) => api.post<ReviewNote>(`${base}/${id}/review-notes`, body),
  respondNote: (id: string, noteId: string, body: Body) =>
    api.post<ReviewNote>(`${base}/${id}/review-notes/${noteId}/respond`, body),
  clearNote: (id: string, noteId: string, body: Body) =>
    api.post<ReviewNote>(`${base}/${id}/review-notes/${noteId}/clear`, body),

  // ── Risks ───────────────────────────────────────────────────────────────
  risks: (id: string) => getList<AuditRisk>(`${base}/${id}/risks`),
  addRisk: (id: string, body: Body) => api.post<AuditRisk>(`${base}/${id}/risks`, body),
  updateRisk: (id: string, riskId: string, body: Body) => api.patch<AuditRisk>(`${base}/${id}/risks/${riskId}`, body),
  deleteRisk: (id: string, riskId: string) => api.delete<void>(`${base}/${id}/risks/${riskId}`),

  // ── Observations ────────────────────────────────────────────────────────
  observations: (id: string) => getList<AuditObservation>(`${base}/${id}/observations`),
  addObservation: (id: string, body: Body) => api.post<AuditObservation>(`${base}/${id}/observations`, body),
  updateObservation: (id: string, obsId: string, body: Body) =>
    api.patch<AuditObservation>(`${base}/${id}/observations/${obsId}`, body),

  // ── Checklists ──────────────────────────────────────────────────────────
  templates: () => getList<ChecklistTemplate>(`${base}/checklist-templates`),
  checklist: (id: string, code: string) => api.get<ChecklistResponse>(`${base}/${id}/checklists/${encodeURIComponent(code)}`),
  answer: (id: string, code: string, clause: string, body: Body) =>
    api.put(`${base}/${id}/checklists/${encodeURIComponent(code)}/${encodeURIComponent(clause)}`, body),
  reviewItem: (id: string, code: string, clause: string, body: Body) =>
    api.post(`${base}/${id}/checklists/${encodeURIComponent(code)}/${encodeURIComponent(clause)}/review`, body),

  exportUrl: (id: string) => `${base}/${id}/export`,

  // ── UDIN register ───────────────────────────────────────────────────────
  udins: (f: UdinFilters = {}) => getList<AuditUdin>(`${base}/udins${qs({ ...f })}`),
  addUdin: (body: Body) => api.post<AuditUdin>(`${base}/udins`, body),
  revokeUdin: (udinId: string, body: Body) => api.post<AuditUdin>(`${base}/udins/${udinId}/revoke`, body),
  missingUdins: () => getList<MissingUdin>(`${base}/udins/missing`),
};

/**
 * Fetch a binary route (a working-paper file, the export zip) and hand it to
 * the browser. Not `api.get`: that expects the JSON envelope and would retry
 * a zip as a bad response. An error still comes back as the JSON envelope,
 * so a 423 or 403 surfaces as its own message.
 */
export async function downloadBinary(path: string, fallbackName: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(path, { credentials: 'include' });
  } catch {
    throw Object.assign(new Error('Could not reach the server.'), { status: 0, code: 'network_error' }) as ApiError;
  }
  if (!res.ok) {
    let message = `Download failed (HTTP ${res.status}).`;
    let code = 'unknown';
    try {
      const j = await res.json() as { error?: { code: string; message: string } };
      if (j.error) { message = j.error.message; code = j.error.code; }
    } catch { /* not JSON */ }
    throw Object.assign(new Error(message), { status: res.status, code }) as ApiError;
  }
  const blob = await res.blob();
  const cd = res.headers.get('Content-Disposition') ?? '';
  const star = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(cd);
  const plain = /filename="?([^";]+)"?/i.exec(cd);
  const name = star ? decodeURIComponent(star[1].trim().replace(/"/g, '')) : plain ? plain[1].trim() : fallbackName;
  const url = URL.createObjectURL(blob);
  downloadFile(url, name);
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

// ── UDIN format ─────────────────────────────────────────────────────────────

// Pure (no API client) so it can be unit-tested; re-exported for existing imports.
export { udinError } from './udin';
