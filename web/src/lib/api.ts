/**
 * The API client.
 *
 * One place that knows the base URL, sends the session cookie, and turns a
 * non-2xx response into a typed error carrying the server's own message. The
 * server writes messages for people to read, so the UI shows them verbatim
 * rather than substituting something vaguer.
 */
const BASE_URL = '/api/v1';

export type FieldError = { field: string; message: string };

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields: FieldError[];
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.fields =
      details !== null && typeof details === 'object' && 'fields' in details
        ? ((details as { fields: FieldError[] }).fields ?? [])
        : [];
  }

  /** Field errors keyed by field name, for wiring straight into a form. */
  fieldMap(): Record<string, string> {
    return Object.fromEntries(this.fields.map((item) => [item.field, item.message]));
  }
}

async function request<Result>(
  method: string,
  path: string,
  body?: unknown,
): Promise<Result> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    credentials: 'include',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (response.status === 204) {
    return undefined as Result;
  }

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const error = (payload as { error?: { code: string; message: string; details?: unknown } } | null)
      ?.error;
    throw new ApiError(
      response.status,
      error?.code ?? 'internal_error',
      error?.message ?? `Request failed with status ${response.status}.`,
      error?.details ?? null,
    );
  }

  return payload as Result;
}

export const api = {
  get: <Result,>(path: string) => request<Result>('GET', path),
  post: <Result,>(path: string, body?: unknown) => request<Result>('POST', path, body),
  patch: <Result,>(path: string, body?: unknown) => request<Result>('PATCH', path, body),
  remove: <Result,>(path: string) => request<Result>('DELETE', path),
};

/** Builds a query string, dropping empty values so URLs stay readable. */
export function queryString(params: Record<string, string | number | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      search.set(key, String(value));
    }
  }
  const encoded = search.toString();
  return encoded === '' ? '' : `?${encoded}`;
}
