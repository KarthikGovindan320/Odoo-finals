/**
 * The API client.
 *
 * One place that knows the base URL, sends the session cookie, and turns a
 * non-2xx response into a typed error carrying the server's own message. The
 * server writes messages for people to read, so the UI shows them verbatim
 * rather than substituting something vaguer.
 */
const BASE_URL = '/api/v1';

/**
 * How long any single request may hang before we give up.
 *
 * fetch() has no default timeout, so a stalled connection left a button saying
 * "Saving..." for as long as the tab stayed open.
 */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Notified when the server says the session is gone.
 *
 * Without this, a 401 was handled like any other error: each panel rendered
 * "Sign in to continue." as red text inside the still-logged-in shell, with no
 * login form and no way back except a manual refresh. AuthProvider subscribes
 * and clears the user, which drops the app to the login screen.
 */
type SessionExpiredListener = () => void;
const sessionExpiredListeners = new Set<SessionExpiredListener>();

export function onSessionExpired(listener: SessionExpiredListener): () => void {
  sessionExpiredListeners.add(listener);
  return () => sessionExpiredListeners.delete(listener);
}

/** Set once the user is known to be signed in, so a 401 on the initial
 *  "who am I" probe is not mistaken for an expiry. */
let sessionEstablished = false;

export function markSessionEstablished(established: boolean): void {
  sessionEstablished = established;
}

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
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      method,
      credentials: 'include',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: abort.signal,
    });
  } catch (error) {
    if (abort.signal.aborted) {
      throw new ApiError(0, 'timeout', 'The server took too long to respond. Try again.', null);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  if (response.status === 204) {
    return undefined as Result;
  }

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const error = (payload as { error?: { code: string; message: string; details?: unknown } } | null)
      ?.error;

    // An expiry is a session-wide fact, not this panel's problem to render.
    if (response.status === 401 && sessionEstablished) {
      sessionEstablished = false;
      for (const listener of sessionExpiredListeners) {
        listener();
      }
    }

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

/**
 * Opens a PDF the API generates, in a new tab.
 *
 * Goes through fetch rather than a plain <a href> for two reasons: the response
 * may be an error, which as a link lands the user on a tab of raw JSON; and a
 * relative href assumes the API shares the page's origin, which is only true
 * while the dev proxy is in front of it.
 */
export async function openPdf(path: string): Promise<void> {
  const response = await fetch(`${BASE_URL}${path}`, { credentials: 'include' });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as
      | { error?: { message?: string } }
      | null;
    throw new Error(payload?.error?.message ?? `Could not open the document (${response.status}).`);
  }

  const blobUrl = URL.createObjectURL(await response.blob());
  const opened = window.open(blobUrl, '_blank', 'noopener');

  if (opened === null) {
    throw new Error('Your browser blocked the popup. Allow popups for this site and try again.');
  }

  // Freed once the new tab has taken its own reference.
  setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
}

/**
 * Downloads a file the API generates.
 *
 * Through fetch rather than a plain <a href> for the same two reasons openPdf
 * is: the response may be an error, which as a link lands the user on a tab of
 * raw JSON, and a relative href assumes the API shares the page's origin, which
 * is only true while the dev proxy is in front of it.
 *
 * The filename comes from Content-Disposition when the server sent one, so the
 * name of the file is decided by whatever built it rather than guessed here.
 */
export async function downloadFile(path: string, fallbackName: string): Promise<void> {
  const response = await fetch(`${BASE_URL}${path}`, { credentials: 'include' });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as
      | { error?: { message?: string } }
      | null;
    throw new Error(payload?.error?.message ?? `Could not prepare the download (${response.status}).`);
  }

  const disposition = response.headers.get('content-disposition') ?? '';
  const named = /filename="([^"]+)"/.exec(disposition);

  const blobUrl = URL.createObjectURL(await response.blob());
  const link = document.createElement('a');
  link.href = blobUrl;
  link.download = named?.[1] ?? fallbackName;
  document.body.append(link);
  link.click();
  link.remove();

  // Long enough for the browser to have started writing the file.
  setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
}
