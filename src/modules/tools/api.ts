import { api, type ApiError } from '@/services/api';
import type {
  DocumentDetail, DocumentFilters, DocumentsList, PagesResponse, PreviewResponse, RegistryStatus,
  SignedLink, ToolDocument, ToolJob,
} from './types';

/**
 * Tools API client. JSON calls go through the one swappable adapter in
 * services/api.ts. Uploads are the exception: they need multipart bodies and
 * per-file progress, which `fetch` cannot report, so they use XMLHttpRequest
 * against the same envelope contract ({ data } / { error }).
 */
function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === '') continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

function makeError(status: number, code: string, message: string): ApiError {
  const err = new Error(message) as ApiError;
  err.status = status;
  err.code = code;
  return err;
}

export function uploadFiles(
  toolId: string,
  files: File[],
  onProgress?: (pct: number) => void,
  signal?: AbortSignal,
): Promise<{ items: ToolDocument[] }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/tools/uploads${qs({ tool_id: toolId })}`);
    xhr.withCredentials = true;
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      let json: { data?: { items: ToolDocument[] }; error?: { code: string; message: string } } = {};
      try { json = xhr.responseText ? JSON.parse(xhr.responseText) : {}; } catch { /* empty */ }
      if (xhr.status >= 200 && xhr.status < 300 && json.data) return resolve(json.data);
      const e = json.error ?? { code: 'unknown', message: xhr.status === 413 ? 'File is too large to upload.' : 'Upload failed. Please try again.' };
      reject(makeError(xhr.status, e.code, e.message));
    };
    xhr.onerror = () => reject(makeError(0, 'network', 'Upload failed. Check your connection and try again.'));
    xhr.onabort = () => reject(makeError(0, 'aborted', 'Upload cancelled.'));
    signal?.addEventListener('abort', () => xhr.abort());
    const form = new FormData();
    for (const f of files) form.append('files', f, f.name);
    xhr.send(form);
  });
}

export const toolsApi = {
  registry: () => api.get<RegistryStatus>('/api/tools'),

  upload: uploadFiles,

  createJob: (toolId: string, inputDocumentIds: string[], options: Record<string, unknown>) =>
    api.post<ToolJob>(`/api/tools/${toolId}/jobs`, { input_document_ids: inputDocumentIds, options }),

  job: (id: string) => api.get<ToolJob>(`/api/tool-jobs/${id}`),

  documents: {
    list: (f: DocumentFilters = {}) => api.get<DocumentsList>(`/api/tool-documents${qs({ ...f })}`),
    get: (id: string) => api.get<DocumentDetail>(`/api/tool-documents/${id}`),
    link: (id: string, inline = false) => api.get<SignedLink>(`/api/tool-documents/${id}/link${qs({ inline: inline ? 1 : '' })}`),
    preview: (id: string) => api.get<PreviewResponse>(`/api/tool-documents/${id}/preview`),
    pages: (id: string) => api.get<PagesResponse>(`/api/tool-documents/${id}/pages`),
    delete: (id: string) => api.delete<void>(`/api/tool-documents/${id}`),
  },
};

/** Two-step signed download: mint a link, then let the browser fetch it. */
export async function downloadDocument(id: string): Promise<void> {
  const link = await toolsApi.documents.link(id, false);
  // A hidden anchor keeps the current tab; the server sets Content-Disposition.
  const a = document.createElement('a');
  a.href = link.url;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
