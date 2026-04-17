import { API_URL } from './constants';

/**
 * Thrown by apiFetch when the server responds with a non-2xx status. Carries
 * the parsed JSON body so callers can branch on the server-issued `code`
 * (e.g. ASSESSMENT_STALE) without parsing the error message.
 */
export class ApiError extends Error {
  status: number;
  code?: string;
  body: Record<string, unknown>;
  constructor(status: number, body: Record<string, unknown>) {
    const message =
      typeof body.error === 'string' ? body.error : `API error: ${status}`;
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = typeof body.code === 'string' ? body.code : undefined;
    this.body = body;
  }
}

/** Typed API fetch wrapper */
export async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    headers: { 'Content-Type': 'application/json', ...options?.headers },
    ...options,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(res.status, body);
  }

  return res.json();
}

/** GET request */
export function apiGet<T>(path: string): Promise<T> {
  return apiFetch<T>(path);
}

/** POST request */
export function apiPost<T>(path: string, body: unknown): Promise<T> {
  return apiFetch<T>(path, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}
