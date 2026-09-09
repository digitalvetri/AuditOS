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
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(init.headers ?? {}),
      },
    });
  } catch {
    // fetch only rejects for transport failures — the backend is down, the
    // proxy has nothing to talk to, or CORS blocked the response. There is
    // no HTTP status here, so status 0 marks "never reached the server" and
    // pages can tell it apart from a real 4xx.
    throw makeError(0, 'network_error',
      `Could not reach the API (${path}). Is the backend running? In mock mode this path may have no MSW handler.`);
  }

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  let json: { data?: unknown; error?: { code: string; message: string; details?: unknown } };
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    // Not JSON — usually Vite's proxy error page or an HTML 502 from a
    // backend that is not up. Report the status we actually got rather
    // than a bare "Unexpected token <".
    throw makeError(res.status, 'bad_response',
      `The API returned a non-JSON response (HTTP ${res.status}) for ${path}.`);
  }

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
