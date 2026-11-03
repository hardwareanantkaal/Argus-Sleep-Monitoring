// API client. Cookies carry the login (httpOnly, the JS never sees a token).
// On 401 TOKEN_EXPIRED it calls /auth/refresh once and retries (API.md "Auth cookies").
// Areas not yet built on the backend are answered by the in-browser mock (see config.ts).

import { areaOf, isLive } from './config';
import { mockRequest } from './mock/handler';

export class ApiError extends Error {
  status: number;
  code: string;
  field?: string;
  retryAfterS?: number;
  constructor(status: number, code: string, message: string, field?: string, retryAfterS?: number) {
    super(message);
    this.status = status;
    this.code = code;
    this.field = field;
    this.retryAfterS = retryAfterS;
  }
}

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

// Called when refresh fails: the session is over, the app shows the login screen.
let onLoggedOut: (() => void) | null = null;
export function setLoggedOutHandler(fn: () => void) {
  onLoggedOut = fn;
}

let refreshing: Promise<boolean> | null = null;
export function refreshSession(): Promise<boolean> {
  // One refresh at a time: several requests can expire together.
  if (!refreshing) {
    refreshing = (async () => {
      try {
        if (!isLive('auth')) return mockRequest('POST', '/auth/refresh').then(() => true, () => false);
        const r = await fetch('/api/v1/auth/refresh', { method: 'POST', credentials: 'include' });
        return r.ok;
      } catch {
        return false;
      } finally {
        setTimeout(() => { refreshing = null; }, 0);
      }
    })();
  }
  return refreshing;
}

async function toError(r: Response): Promise<ApiError> {
  let body: { error?: { code?: string; message?: string; field?: string; retryAfterS?: number } } = {};
  try { body = await r.json(); } catch { /* not JSON */ }
  const e = body.error || {};
  return new ApiError(r.status, e.code || `HTTP_${r.status}`, e.message || r.statusText || 'Request failed', e.field, e.retryAfterS);
}

async function liveRequest<T>(method: Method, path: string, body?: unknown): Promise<T> {
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
  const r = await fetch(`/api/v1${path}`, {
    method,
    credentials: 'include',
    headers: body !== undefined && !isForm ? { 'Content-Type': 'application/json' } : undefined,
    body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
  });
  if (!r.ok) throw await toError(r);
  if (r.status === 204) return undefined as T;
  return (await r.json()) as T;
}

export async function api<T = unknown>(method: Method, path: string, body?: unknown): Promise<T> {
  const live = isLive(areaOf(path));
  const run = () => (live ? liveRequest<T>(method, path, body) : mockRequest<T>(method, path, body));
  try {
    return await run();
  } catch (e) {
    const isAuthCall = path.startsWith('/auth/');
    if (e instanceof ApiError && e.status === 401 && e.code === 'TOKEN_EXPIRED' && !isAuthCall) {
      if (await refreshSession()) return run();
      onLoggedOut?.();
    } else if (e instanceof ApiError && (e.code === 'REFRESH_INVALID' || e.code === 'USER_DISABLED' || (e.status === 401 && !isAuthCall && e.code === 'NOT_LOGGED_IN'))) {
      onLoggedOut?.();
    }
    throw e;
  }
}

export const get = <T,>(p: string) => api<T>('GET', p);
export const post = <T,>(p: string, b?: unknown) => api<T>('POST', p, b ?? {});
export const patch = <T,>(p: string, b: unknown) => api<T>('PATCH', p, b);
export const put = <T,>(p: string, b: unknown) => api<T>('PUT', p, b);
export const del = <T,>(p: string, b?: unknown) => api<T>('DELETE', p, b);

/** Friendly text for an error, for showing under a form. */
export function errText(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 429) return `Too many tries. Wait ${e.retryAfterS ? Math.ceil(e.retryAfterS / 60) + ' min' : 'a few minutes'} and try again.`;
    return e.message;
  }
  if (e instanceof TypeError) return 'Can’t reach the server. Check your connection and try again.';
  return e instanceof Error ? e.message : String(e);
}

export const qs = (o: Record<string, string | number | undefined | null>) => {
  const p = Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '' && v !== 'all');
  return p.length ? '?' + p.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&') : '';
};
