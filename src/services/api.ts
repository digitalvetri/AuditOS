/**
 * The one swappable adapter (§2).
 *
 * Calling code says `api.get('/api/auth/me')`. Today MSW intercepts. Tomorrow
 * the same fetch hits a real Express backend. No call site changes.
 *
 * Envelope contract (§9):
 *   Success: 2xx  { data: T }
 *   Error:   4xx  { error: { code, message, details? } }
 */

export interface ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;
}

function makeError(status: number, code: string, message: string, details?: unknown): ApiError {
  const err = new Error(message) as ApiError;
  err.status = status;
  err.code = code;
  err.details = details;
  return err;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(init.headers ?? {}),
    },
  });

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  const json = text ? JSON.parse(text) : {};

  if (!res.ok) {
    const e = json.error ?? { code: 'unknown', message: res.statusText };
    throw makeError(res.status, e.code, e.message, e.details);
  }
  return json.data as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path, { method: 'GET' }),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PATCH', body: body ? JSON.stringify(body) : undefined }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};
