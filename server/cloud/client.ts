import { ResourceErrorDetailsSchema } from '../../src/types/cloudResources.js';
import type { CloudBinaryConsumer } from './types.js';
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
function allowedPath(path: string): boolean {
  const [pathname] = path.split('?');
  return (
    !path.includes('#') &&
    !/[\\\u0000-\u0020]/u.test(path) &&
    /^\/v1\/(?:health|devices|account|skill-notes|resources|projects)(?:\/[A-Za-z0-9_-]+)*$/.test(
      pathname,
    ) &&
    !pathname.split('/').some((p) => p === '.' || p === '..')
  );
}
export interface CloudTransport {
  send<T>(
    origin: string,
    method: string,
    path: string,
    body?: unknown,
    token?: string,
    signal?: AbortSignal,
    consume?: CloudBinaryConsumer,
  ): Promise<T>;
  abort(): void;
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
      consume?: CloudBinaryConsumer,
    ): Promise<T> {
      if (!allowedPath(path) || !['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(method))
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
            ...(body !== undefined
              ? {
                  'Content-Type': Buffer.isBuffer(body)
                    ? 'application/octet-stream'
                    : 'application/json',
                }
              : {}),
          },
          ...(body !== undefined
            ? { body: Buffer.isBuffer(body) ? (body as unknown as BodyInit) : JSON.stringify(body) }
            : {}),
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
          // Only known notes codes cross the boundary; never forward backend text/details.
          if ([400, 404, 409, 410, 413, 429].includes(response.status)) {
            const reader = response.body?.getReader();
            const chunks: Buffer[] = [];
            let bytes = 0;
            try {
              if (reader)
                while (true) {
                  const part = await reader.read();
                  if (part.done) break;
                  bytes += part.value.byteLength;
                  if (bytes > 8192) break;
                  chunks.push(Buffer.from(part.value));
                }
            } finally {
              await reader?.cancel().catch(() => {});
            }
            if (bytes <= 8192) {
              let value: unknown;
              try {
                value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              } catch {
                /* fixed generic error below */
              }
              const code =
                (value as { success?: unknown; error?: { code?: unknown } })?.success === false
                  ? (value as { error?: { code?: unknown } }).error?.code
                  : undefined;
              const messages: Record<string, string> = {
                ...NOTES_HTTP_MESSAGES,
                ...NOTE_MESSAGES,
                ...RESOURCE_MESSAGES,
              };
              if (
                typeof code === 'string' &&
                Object.hasOwn(messages, code) &&
                (DOMAIN_HTTP_STATUSES[code] === response.status ||
                  (code === 'hash_mismatch' && response.status === 400))
              ) {
                const parsed = ResourceErrorDetailsSchema.safeParse(
                  (value as { error?: { details?: unknown } })?.error?.details,
                );
                const details =
                  parsed.success &&
                  ((code === 'version_conflict' && 'headVersion' in parsed.data) ||
                    (code === 'version_in_use' && 'references' in parsed.data))
                    ? parsed.data
                    : undefined;
                const retry = response.headers.get('retry-after');
                const retryAfterMs =
                  code === 'rate_limited' &&
                  retry &&
                  /^\d{1,3}$/.test(retry) &&
                  Number(retry) <= 120
                    ? Math.max(1, Number(retry)) * 1000
                    : undefined;
                throw new CloudError(code, messages[code], response.status, details, retryAfterMs);
              }
            }
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
        if (consume) {
          if (!response.body) throw new CloudError('invalid_response', 'Missing cloud file body.');
          await consume(response.body);
          return undefined as T;
        }
        // Foundation JSON is capped independently of local parser and remote headers.
        const reader = response.body?.getReader();
        if (!reader)
          throw new CloudError('invalid_response', 'Cloud returned an invalid response.');
        const chunks: Buffer[] = [];
        let size = 0;
        try {
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            size += part.value.byteLength;
            if (size > (/^\/v1\/(resources|projects)/.test(path) ? 8 : 1) * 1024 * 1024)
              throw new CloudError('invalid_response', 'Cloud response exceeds the JSON limit.');
            chunks.push(Buffer.from(part.value));
          }
        } finally {
          await reader.cancel().catch(() => {});
        }
        const result = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
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
  async function run<T>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
    consume?: CloudBinaryConsumer,
  ): Promise<T> {
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
        consume,
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
  }
  return {
    request: run,
    stream: (path, consume, signal) => run<void>('GET', path, undefined, signal, consume),
  };
}
const RESOURCE_MESSAGES: Record<string, string> = {
  upload_incomplete: 'Upload is incomplete. Retry or review publication.',
  upload_busy: 'A file upload is in progress.',
  upload_committed: 'The upload was already committed.',
  file_too_large: 'File exceeds its declared size.',
  version_conflict: 'Cloud version changed. Review the latest version.',
  version_in_use: 'This exact version is still referenced.',
  dependency_missing: 'An exact dependency is unavailable.',
  dependency_cycle: 'Dependency cycle is not supported.',
  dependency_version_conflict: 'Dependencies select incompatible exact versions.',
  project_unavailable: 'Save or associate active project metadata first.',
  resource_unavailable: 'A referenced resource version is unavailable.',
  mutation_conflict: 'This mutation identity was already used for different content.',
  not_found: 'Cloud resource was not found.',
  quota_exceeded: 'Cloud storage quota exceeded.',
  upload_expired: 'Upload expired. Review publication again.',
  hash_mismatch: 'Resource file hash did not match.',
  size_mismatch: 'Resource file size did not match.',
  rate_limited: 'Cloud rate limit reached. Retry after the indicated delay.',
};
const RESOURCE_STATUSES: Record<string, number> = Object.fromEntries(
  Object.keys(RESOURCE_MESSAGES).map((code) => [
    code,
    code === 'not_found'
      ? 404
      : code === 'rate_limited'
        ? 429
        : code === 'upload_expired'
          ? 410
          : ['quota_exceeded', 'file_too_large'].includes(code)
            ? 413
            : code === 'size_mismatch'
              ? 400
              : 409,
  ]),
);

// Only validated remote domain responses establish reachability. Local validation,
// cancellation, authentication failure and arbitrary errors do not.
const DOMAIN_HTTP_STATUSES: Record<string, number> = {
  invalid_cursor: 400,
  invalid_request: 400,
  batch_too_large: 413,
  ...Object.fromEntries(Object.keys(NOTE_MESSAGES).map((code) => [code, 409])),
  ...RESOURCE_STATUSES,
};
export function isReachableCloudError(error: CloudError): boolean {
  return (error.code === 'forbidden' && error.status === 403) ||
    (Object.hasOwn(DOMAIN_HTTP_STATUSES, error.code) &&
      (DOMAIN_HTTP_STATUSES[error.code] === error.status ||
        (error.code === 'hash_mismatch' && error.status === 400)));
}
