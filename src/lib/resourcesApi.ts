/**
 * resourcesApi — the RESOURCES tab's only path to the server.
 *
 * Plain same-origin `fetch` (the auth cookie rides along, and the global
 * identity-header patch in presenceClient applies), unwrapping the
 * `{ success, data | error }` envelope every `/api/resources` route answers.
 *
 * Nothing here reaches `/api/files/*`, whose write routes the PROJECT tab uses.
 * The POSTs are `/scan` (re-reads disk) and the tab's only writes: uninstall,
 * which MOVES a resource into the AASC trash, and restore, which moves it back.
 *
 * A 404 has its own error type. The router answers every non-loopback request
 * with 404 — deliberately not 403, so a remote device can't tell the feature
 * exists — and the view has to say "only on this machine" rather than offer a
 * Retry that can never succeed.
 */
import type {
  CompareTarget,
  ResourceCatalog,
  ResourceCompare,
  ResourceDetail,
  ResourceFileContent,
  RestoreResult,
  ScanProgress,
  ScanState,
  UninstallResult,
} from '@/types/resources';
import { MAX_EXTRA_ROOTS, parseStoredExtraRoots } from './resourceFilters';

const BASE = '/api/resources';

export class ResourcesUnavailableError extends Error {
  constructor(message = 'Resources are available only on the machine that runs AASC.') {
    super(message);
    this.name = 'ResourcesUnavailableError';
  }
}

/** True for a request cancelled through its AbortSignal — never shown to the user. */
export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

/** Display text for anything a request can throw. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'string' && err) return err;
  return 'Something went wrong.';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function request<T>(url: string, init: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    if (isAbortError(err)) throw err;
    throw new Error('Could not reach the AASC server.');
  }

  if (res.status === 404) throw new ResourcesUnavailableError();

  const body = parseJson(await res.text());
  if (isRecord(body) && body.success === true && 'data' in body) return body.data as T;

  // `{ success: false, error }` from the router, or a bare `{ error }` from the
  // auth gate in front of it — either way the server's own words are the best
  // message we have.
  if (isRecord(body) && typeof body.error === 'string' && body.error) throw new Error(body.error);
  if (!res.ok) throw new Error(`Request failed (HTTP ${res.status}).`);
  throw new Error(`Unexpected response from the server (HTTP ${res.status}).`);
}

function itemUrl(id: string, suffix = ''): string {
  return `${BASE}/item/${encodeURIComponent(id)}${suffix}`;
}

export function fetchCatalog(signal?: AbortSignal): Promise<ResourceCatalog> {
  return request<ResourceCatalog>(BASE, { method: 'GET', signal });
}

export interface ScanStartResult {
  state: ScanState;
  progress?: ScanProgress;
}

/** Start a scan, or join the one already running (the server never runs two). */
export function startScan(extraRoots: readonly string[], signal?: AbortSignal): Promise<ScanStartResult> {
  return request<ScanStartResult>(`${BASE}/scan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ extraRoots }),
    signal,
  });
}

export function fetchResourceDetail(id: string, signal?: AbortSignal): Promise<ResourceDetail> {
  return request<ResourceDetail>(itemUrl(id), { method: 'GET', signal });
}

export function fetchResourceFile(id: string, path: string, signal?: AbortSignal): Promise<ResourceFileContent> {
  const query = new URLSearchParams({ path });
  return request<ResourceFileContent>(itemUrl(id, `/file?${query.toString()}`), { method: 'GET', signal });
}

export function fetchResourceCompare(
  id: string,
  against: CompareTarget,
  signal?: AbortSignal,
): Promise<ResourceCompare> {
  const query = new URLSearchParams({ against });
  return request<ResourceCompare>(itemUrl(id, `/compare?${query.toString()}`), { method: 'GET', signal });
}

/**
 * Moves the resource into the AASC trash. `confirmName` must be its exact name —
 * the server checks it too. Its 404 means "gone since the scan" here, not a
 * remote device (the tab never renders this control remotely).
 */
export function uninstallResource(id: string, confirmName: string): Promise<UninstallResult> {
  return request<UninstallResult>(itemUrl(id, '/uninstall'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirmName }),
  });
}

/** Moves a trash entry back to where it was uninstalled from (never over something new). */
export function restoreResource(trashId: string): Promise<RestoreResult> {
  return request<RestoreResult>(`${BASE}/trash/${encodeURIComponent(trashId)}/restore`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
}

// ---------------------------------------------------------------------------
// Extra scan roots — folders added by hand in Sources, sent with each scan.
// localStorage can throw (private mode, disabled storage, quota), so every
// access is guarded and a failure degrades to "no extra roots".
// ---------------------------------------------------------------------------

export const EXTRA_ROOTS_STORAGE_KEY = 'aasc.resources.extraRoots';

export function readExtraRoots(): string[] {
  try {
    return parseStoredExtraRoots(localStorage.getItem(EXTRA_ROOTS_STORAGE_KEY));
  } catch {
    return [];
  }
}

/** Returns false when the list could not be saved (it still applies until reload). */
export function writeExtraRoots(roots: readonly string[]): boolean {
  try {
    localStorage.setItem(EXTRA_ROOTS_STORAGE_KEY, JSON.stringify(roots.slice(0, MAX_EXTRA_ROOTS)));
    return true;
  } catch {
    return false;
  }
}
