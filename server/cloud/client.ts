import { NOTES_HTTP_MESSAGES, NOTE_MESSAGES } from '../../src/types/skillNotesSync.js';
import { CloudError, type ActiveCloudConnection, type CloudClient } from './types.js';
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
export function normalizeBackendOrigin(input: string): string {
  try {
    const url = new URL(input);
    if (
      /[?#@\\\u0000-\u0020]/u.test(input) ||
      input.trim() !== input ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.pathname !== '/' && url.pathname !== '') ||
      !['https:', 'http:'].includes(url.protocol) ||
      (url.protocol === 'http:' && !LOOPBACK.has(url.hostname))
    )
      throw new Error();
    return url.origin;
  } catch {
    throw new CloudError(
      'invalid_backend',
      'Backend URL must be an HTTPS origin (HTTP is allowed only on loopback).',
      400,
    );
  }
}
/**
 * The only backend namespaces this Mac may send its device token to: health,
 * device management (pairing, phone pairing codes, revocation), skill notes and
 * push. Cloud resources and projects are not part of this connector.
 */
const ALLOWED_PATH = /^\/v1\/(?:health|devices|skill-notes|push)(?:\/[A-Za-z0-9_-]+)*$/;
export function allowedCloudPath(path: string): boolean {
  const [pathname] = path.split('?');
  return (
    !path.includes('#') &&
    !/[\\\u0000-\u0020]/u.test(path) &&
    ALLOWED_PATH.test(pathname) &&
    !pathname.split('/').some((p) => p === '.' || p === '..')
  );
}
/** Errors the backend's device and push services answer with; nothing else crosses the boundary. */
export const DEVICE_MESSAGES: Record<string, string> = {
  not_found: 'Cloud item was not found.',
  pairing_codes_outstanding:
    'Too many unused phone pairing codes. Use one or wait for it to expire.',
  push_collapsed: 'A notification for this event was just sent.',
  push_unconfigured: 'Push notifications are not configured on the backend.',
};
const DEVICE_STATUSES: Record<string, number> = {
  not_found: 404,
  pairing_codes_outstanding: 409,
  push_collapsed: 429,
  push_unconfigured: 503,
};
// Only validated remote domain responses establish reachability. Local validation,
// cancellation, authentication failure and arbitrary errors do not.
const DOMAIN_HTTP_STATUSES: Record<string, number> = {
  invalid_cursor: 400,
  invalid_request: 400,
  batch_too_large: 413,
  rate_limited: 429,
  ...Object.fromEntries(Object.keys(NOTE_MESSAGES).map((code) => [code, 409])),
  ...DEVICE_STATUSES,
};
const DOMAIN_MESSAGES: Record<string, string> = {
  ...NOTES_HTTP_MESSAGES,
  ...NOTE_MESSAGES,
  ...DEVICE_MESSAGES,
};
/** Statuses whose small JSON body may carry one of the known codes above. */
const READ_STATUSES = new Set([400, 404, 409, 410, 413, 429, 503]);
const JSON_LIMIT = 1024 * 1024;
const ERROR_LIMIT = 8192;
export interface CloudTransport {
  send<T>(
    origin: string,
    method: string,
    path: string,
    body?: unknown,
    token?: string,
    signal?: AbortSignal,
  ): Promise<T>;
  abort(): void;
}
async function readCapped(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<Buffer | null> {
  const reader = body?.getReader();
  if (!reader) return null;
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > limit) return null;
      chunks.push(Buffer.from(part.value));
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks);
}
/** A known domain error, or null. Backend messages and details never cross the boundary. */
async function domainError(response: Response): Promise<CloudError | null> {
  const bytes = await readCapped(response.body, ERROR_LIMIT);
  if (!bytes) return null;
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    return null;
  }
  const envelope = value as { success?: unknown; error?: { code?: unknown } };
  const code = envelope?.success === false ? envelope.error?.code : undefined;
  if (
    typeof code !== 'string' ||
    !Object.hasOwn(DOMAIN_MESSAGES, code) ||
    DOMAIN_HTTP_STATUSES[code] !== response.status
  )
    return null;
  const retry = response.headers.get('retry-after');
  const retryAfterMs =
    response.status === 429 && retry && /^\d{1,4}$/.test(retry) && Number(retry) <= 3600
      ? Math.max(1, Number(retry)) * 1000
      : undefined;
  return new CloudError(code, DOMAIN_MESSAGES[code], response.status, retryAfterMs);
}
export function createCloudTransport(options: {
  timeoutMs?: number;
  fetch?: typeof fetch;
}): CloudTransport {
  const controllers = new Set<AbortController>();
  return {
    abort() {
      for (const c of controllers) c.abort();
    },
    async send<T>(
      origin: string,
      method: string,
      path: string,
      body?: unknown,
      token?: string,
      signal?: AbortSignal,
    ): Promise<T> {
      if (
        !allowedCloudPath(path) ||
        !['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(method)
      )
        throw new CloudError('invalid_path', 'Cloud route is not allowed.', 400);
      const controller = new AbortController();
      controllers.add(controller);
      const cancel = () => controller.abort();
      if (signal?.aborted) controller.abort();
      signal?.addEventListener('abort', cancel, { once: true });
      const timer = setTimeout(cancel, options.timeoutMs ?? 15_000);
      timer.unref?.();
      try {
        const response = await (options.fetch ?? fetch)(new URL(path, origin), {
          method,
          redirect: 'manual',
          signal: controller.signal,
          headers: {
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
        if (controller.signal.aborted) {
          await response.body?.cancel();
          throw new CloudError('cancelled', 'Cloud request cancelled or timed out.');
        }
        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel();
          throw new CloudError(
            'redirect_refused',
            'Cloud redirect refused. Use the final backend origin.',
          );
        }
        if (!response.ok) {
          if (READ_STATUSES.has(response.status)) {
            const known = await domainError(response);
            if (known) throw known;
          } else await response.body?.cancel();
          if (response.status === 401)
            throw new CloudError(
              'revoked',
              'Cloud authentication is no longer valid. Reconnect this device.',
              401,
            );
          if (response.status === 403)
            throw new CloudError(
              'forbidden',
              'This device does not have permission for this cloud action.',
              403,
            );
          if (
            (response.status === 409 || response.status === 410) &&
            path.startsWith('/v1/devices/pair')
          )
            throw new CloudError(
              'pairing_invalid',
              'Pairing code is consumed or expired. Create a new code.',
              400,
            );
          throw new CloudError(
            'backend_error',
            'Cloud request failed. Check the backend and try again.',
          );
        }
        // JSON is capped independently of the local parser and remote headers.
        const bytes = await readCapped(response.body, JSON_LIMIT);
        if (!bytes)
          throw new CloudError('invalid_response', 'Cloud returned an invalid response.');
        const result = JSON.parse(bytes.toString('utf8')) as {
          success?: unknown;
          data?: T;
        };
        if (result.success !== true || !('data' in result))
          throw new CloudError('invalid_response', 'Cloud returned an invalid response.');
        if (controller.signal.aborted)
          throw new CloudError('cancelled', 'Cloud request cancelled or timed out.');
        return result.data as T;
      } catch (error) {
        if (error instanceof CloudError) throw error;
        throw new CloudError(
          controller.signal.aborted ? 'cancelled' : 'offline',
          controller.signal.aborted
            ? 'Cloud request cancelled or timed out.'
            : 'Cloud is offline. Check the connection and try again.',
        );
      } finally {
        clearTimeout(timer);
        controllers.delete(controller);
        signal?.removeEventListener('abort', cancel);
      }
    },
  };
}
export function createCloudClient(deps: {
  active(): ActiveCloudConnection | null;
  revision(): number;
  transport: CloudTransport;
  outcome(active: ActiveCloudConnection, error: CloudError | null): void;
}): CloudClient {
  return {
    async request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal) {
      const revision = deps.revision(),
        active = deps.active();
      if (!active) throw new CloudError('disconnected', 'Cloud is disconnected.', 409);
      try {
        const data = await deps.transport.send<T>(
          active.connection.backendOrigin,
          method,
          path,
          body,
          active.token,
          signal,
        );
        if (deps.revision() !== revision || deps.active() !== active)
          throw new CloudError('connection_changed', 'Cloud connection changed. Review again.', 409);
        deps.outcome(active, null);
        return data;
      } catch (error) {
        const safe =
          error instanceof CloudError ? error : new CloudError('offline', 'Cloud request failed.');
        if (deps.revision() === revision) deps.outcome(active, safe);
        throw safe;
      }
    },
  };
}
export function isReachableCloudError(error: CloudError): boolean {
  return (
    (error.code === 'forbidden' && error.status === 403) ||
    (Object.hasOwn(DOMAIN_HTTP_STATUSES, error.code) &&
      DOMAIN_HTTP_STATUSES[error.code] === error.status)
  );
}
