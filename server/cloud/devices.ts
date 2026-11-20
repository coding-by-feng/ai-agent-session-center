/**
 * Typed calls this Mac makes to the AASC backend on behalf of its phones,
 * through the server-owned cloud connection (the device token never leaves it):
 *
 *   POST /v1/push/notify             — ask the backend to push to paired phones (AASC-16)
 *   POST /v1/devices/pairing-codes   — mint a phone-scoped backend pairing code (AASC-15)
 *   GET  /v1/devices                 — the account's devices, a page at a time, or all of them (plan 18)
 *   DELETE /v1/devices/:id           — revoke one of them
 *
 * Inputs mirror the backend's contract v1 schemas (aasc-backend
 * src/contracts/v1.ts) and are validated before anything is sent, so a bad
 * value never reaches the network. Responses are validated too; fields the
 * backend adds later are dropped, never fatal. Nothing here is wired into
 * pairing or push yet: callers own when (and whether) to send.
 */
import { z } from 'zod';
import { CloudError, type CloudClient } from './types.js';

const canonicalUuid = z.uuid().refine((id) => id === id.toLowerCase(), 'Canonical UUID required');
// Control characters, line/paragraph separators and bidi overrides could forge or hide notification text.
const UNPRINTABLE = /[\p{Cc}\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;
const printable = (max: number) =>
  z
    .string()
    .max(max * 2)
    .refine((s) => !UNPRINTABLE.test(s) && s.trim().length > 0 && [...s].length <= max);

export const PushNotifyInputSchema = z
  .object({
    /** Idempotency key: a retry with the same id and body is answered once. */
    mutationId: canonicalUuid,
    kind: z.enum(['approval', 'input', 'finished', 'interrupted', 'test']),
    sessionRef: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    title: printable(80),
    toolName: printable(40).optional(),
    collapseKey: z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/),
    ttlSeconds: z.number().int().min(0).max(3600),
  })
  .strict();
export type PushNotifyInput = z.infer<typeof PushNotifyInputSchema>;

export const PushNotifyResultSchema = z.object({
  sent: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  disabled: z.number().int().nonnegative(),
});
export type PushNotifyResult = z.infer<typeof PushNotifyResultSchema>;

/**
 * Scope names are plain `area:action` strings, not a closed list: the backend
 * adds scopes within contract v1, and it — not this Mac — decides which a phone
 * may hold (it refuses anything outside its phone set with 403, and a backend
 * from before a scope name rejects the whole body with 400).
 */
const ScopeNameSchema = z.string().regex(/^[a-z][a-z-]{0,31}:[a-z][a-z-]{0,31}$/);
export const PhonePairingCodeInputSchema = z
  .object({
    scopes: z
      .array(ScopeNameSchema)
      .min(1)
      .max(32)
      .refine((s) => new Set(s).size === s.length, 'Duplicate scopes'),
    ttlSeconds: z.number().int().min(60).max(600).optional(),
  })
  .strict();
export type PhonePairingCodeInput = z.infer<typeof PhonePairingCodeInputSchema>;

export const PhonePairingCodeSchema = z.object({
  code: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
  codeRef: z.uuid(),
  expiresAt: z.iso.datetime(),
});
export type PhonePairingCode = z.infer<typeof PhonePairingCodeSchema>;

function validInput<T>(schema: z.ZodType<T>, input: unknown, what: string): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new CloudError('invalid_input', `Invalid ${what}.`, 400);
  return parsed.data;
}

function validResponse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new CloudError('invalid_response', `Cloud returned an invalid ${what} response.`);
  return parsed.data;
}

/**
 * Ask the backend to notify this account's phones. Fails with CloudError:
 * `disconnected` (no connection), `push_unconfigured` (503), `push_collapsed`
 * or `rate_limited` (429, `retryAfterMs` when given), `forbidden` (no
 * `push:send` scope), `offline`/`backend_error` otherwise.
 */
export async function notifyPush(
  client: CloudClient,
  input: PushNotifyInput,
  signal?: AbortSignal,
): Promise<PushNotifyResult> {
  const body = validInput(PushNotifyInputSchema, input, 'push notification');
  const data = await client.request<unknown>('POST', '/v1/push/notify', body, signal);
  return validResponse(PushNotifyResultSchema, data, 'push');
}

/**
 * Mint a one-use backend pairing code for a phone, capped by the backend to its
 * phone scopes. Fails with CloudError: `pairing_codes_outstanding` (409),
 * `rate_limited` (429), `forbidden` (no `devices:pair` scope, or a scope a
 * phone may not hold), `invalid_request` (400: a backend from before a scope
 * name, such as `mac-paths:read`, rejects the body), `disconnected`/`offline`/
 * `backend_error` otherwise.
 */
export async function createPhonePairingCode(
  client: CloudClient,
  input: PhonePairingCodeInput,
  signal?: AbortSignal,
): Promise<PhonePairingCode> {
  const body = validInput(PhonePairingCodeInputSchema, input, 'pairing code request');
  const data = await client.request<unknown>(
    'POST',
    '/v1/devices/pairing-codes',
    { kind: 'phone', ...body },
    signal,
  );
  return validResponse(PhonePairingCodeSchema, data, 'pairing code');
}

/** A value this build can't read is as good as absent: never a reason to fail a row someone else relies on. */
const tolerant = <T extends z.ZodType>(schema: T) => schema.optional().catch(undefined);

const BackendDeviceSchema = z.object({
  id: z.string().min(1).max(128),
  kind: z.string().nullable().optional(),
  createdByCode: z.string().nullable().optional(),
  revokedAt: z.string().nullable().optional(),
  // Plan 18 (Manage devices), additive. The backend has always sent name, createdAt and lastUsedAt; platform,
  // edition and appVersion are null until a device describes itself and absent from an older backend.
  name: tolerant(z.string().min(1).max(256)),
  platform: tolerant(z.string().min(1).max(64).nullable()),
  edition: tolerant(z.string().min(1).max(64).nullable()),
  appVersion: tolerant(z.string().min(1).max(64).nullable()),
  createdAt: tolerant(z.iso.datetime()),
  lastUsedAt: tolerant(z.iso.datetime().nullable()),
});
const DevicePageSchema = z.object({
  devices: z.array(BackendDeviceSchema),
  nextCursor: z.string().nullable(),
});
export type BackendDevice = z.infer<typeof BackendDeviceSchema>;

/** One page of this account's backend devices (needs `devices:manage`). */
export async function listBackendDevices(
  client: CloudClient,
  cursor?: string | null,
  signal?: AbortSignal,
): Promise<{ devices: BackendDevice[]; nextCursor: string | null }> {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
  const data = await client.request<unknown>('GET', `/v1/devices${query}`, undefined, signal);
  return validResponse(DevicePageSchema, data, 'device list');
}

/** Revoke one backend device (needs `devices:manage`). Revoking twice is fine. */
export async function revokeBackendDevice(client: CloudClient, deviceId: string, signal?: AbortSignal): Promise<void> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(deviceId)) throw new CloudError('invalid_input', 'Invalid device id.', 400);
  await client.request<unknown>('DELETE', `/v1/devices/${deviceId}`, undefined, signal);
}

/**
 * Find the backend device a phone created with the backend code `codeRef`
 * (the pairing QR's backend half), or null. Pages through the list; the owner
 * has few devices.
 */
export async function findDeviceByPairingCode(
  client: CloudClient,
  codeRef: string,
  signal?: AbortSignal,
): Promise<BackendDevice | null> {
  let cursor: string | null = null;
  for (let page = 0; page < 50; page++) {
    const { devices, nextCursor } = await listBackendDevices(client, cursor, signal);
    const hit = devices.find((d) => d.createdByCode === codeRef);
    if (hit) return hit;
    if (!nextCursor) return null;
    cursor = nextCursor;
  }
  return null;
}

/** A listing stops after this many pages (the backend gives up to 100 devices a page). */
export const MAX_DEVICE_PAGES = 50;

/** A device of the account as "Manage devices" shows it. Times are ms since the epoch. */
export interface AccountDevice {
  id: string;
  name: string;
  /** `server` or `phone` today; null when the backend can't say. */
  kind: string | null;
  platform: string | null;
  edition: string | null;
  appVersion: string | null;
  createdAt: number;
  lastUsedAt: number | null;
  /** This computer's own device. */
  current: boolean;
}

/** A backend device id: a lower-case UUID. What may be listed, and what may be put into a revoke's path. */
export const ACCOUNT_DEVICE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * A row for the manage list. It must say which device it is (id), what to call it (name) and when it was made;
 * everything else is read when it can be and null when it can't, so a device is never hidden for a detail.
 */
const AccountDeviceRowSchema = BackendDeviceSchema.extend({
  id: z.string().regex(ACCOUNT_DEVICE_ID_RE),
  kind: tolerant(z.string().min(1).max(64).nullable()),
  createdByCode: tolerant(z.unknown()),
  revokedAt: tolerant(z.string().nullable()),
});
const AccountDevicePageSchema = z.object({ devices: z.array(z.unknown()), nextCursor: z.string().max(128).nullable() });

/** This computer first, then the most recently used, then by name. */
function byUse(a: AccountDevice, b: AccountDevice): number {
  if (a.current !== b.current) return a.current ? -1 : 1;
  const used = (b.lastUsedAt ?? -Infinity) - (a.lastUsedAt ?? -Infinity);
  if (used !== 0 && !Number.isNaN(used)) return used;
  return a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * Every live device of this account (needs `devices:manage`): all pages, revoked ones left out, each rebuilt
 * from the fields above and nothing else (never its scopes or the code that made it). A row that can't be read
 * is skipped, never a failure of the list. The whole list or none: a read that did not reach the last page
 * (the page cap, a cursor the backend repeats) fails rather than pass a part of it off as the account's
 * devices. Fails with CloudError: `forbidden` (403), `invalid_response` (an answer that is no device page, or a
 * list that did not end), `disconnected` / `offline` / `backend_error` otherwise.
 */
export async function listAccountDevices(
  client: CloudClient,
  currentDeviceId: string | null,
  signal?: AbortSignal,
): Promise<AccountDevice[]> {
  const read = await readDevicePages(client, signal);
  if (!read.complete) throw new CloudError('invalid_response', 'Cloud returned a device list that did not end.');
  // A row's id is lower-case by ACCOUNT_DEVICE_ID_RE; the id this computer stored need not be.
  const current = currentDeviceId?.toLowerCase() ?? null;
  const devices = new Map<string, AccountDevice>();
  for (const raw of read.rows) {
    const row = AccountDeviceRowSchema.safeParse(raw);
    if (!row.success) continue;
    const { id, name, createdAt, revokedAt, kind, platform, edition, appVersion, lastUsedAt } = row.data;
    if (revokedAt || !name || !createdAt) continue;
    devices.set(id, {
      id,
      name,
      kind: kind ?? null,
      platform: platform ?? null,
      edition: edition ?? null,
      appVersion: appVersion ?? null,
      createdAt: Date.parse(createdAt),
      lastUsedAt: lastUsedAt ? Date.parse(lastUsedAt) : null,
      current: id === current,
    });
  }
  return [...devices.values()].sort(byUse);
}

/**
 * The account's device rows as the backend sent them, page by page, at most MAX_DEVICE_PAGES. `complete` is
 * false when the read did not reach the last page: that cap was reached with more to read, or the backend
 * handed back a cursor it had already given (a list that goes round, which no more asking would end). A
 * request that fails, or an answer that is no device page, rejects. Callers must treat `complete: false` as no
 * answer at all.
 */
async function readDevicePages(client: CloudClient, signal?: AbortSignal): Promise<{ rows: unknown[]; complete: boolean }> {
  const rows: unknown[] = [];
  const cursors = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < MAX_DEVICE_PAGES; page++) {
    const query: string = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
    const data = await client.request<unknown>('GET', `/v1/devices${query}`, undefined, signal);
    const parsed = validResponse(AccountDevicePageSchema, data, 'device list');
    rows.push(...parsed.devices);
    if (!parsed.nextCursor) return { rows, complete: true };
    if (cursors.has(parsed.nextCursor)) return { rows, complete: false };
    cursors.add(parsed.nextCursor);
    cursor = parsed.nextCursor;
  }
  return { rows, complete: false };
}

/** The backend's own word that a device was signed out. */
const DeviceRevokedSchema = z.object({ revoked: z.literal(true) });

/**
 * Sign one device out of this account (needs `devices:manage`), and have the backend say it did: only its own
 * `{ revoked: true }` counts. Any other answer, a 2xx too, fails with CloudError `invalid_response`, and the
 * caller must conclude nothing from it. Fails as the request does otherwise (`device_not_found` 404,
 * `forbidden` 403, …).
 */
export async function revokeAccountDevice(client: CloudClient, deviceId: string, signal?: AbortSignal): Promise<void> {
  if (!ACCOUNT_DEVICE_ID_RE.test(deviceId)) throw new CloudError('invalid_input', 'Invalid device id.', 400);
  const data = await client.request<unknown>('DELETE', `/v1/devices/${deviceId}`, undefined, signal);
  validResponse(DeviceRevokedSchema, data, 'device revocation');
}

/** What one read of the account's device list proves: nothing unless it was complete. */
export type RevokedDevicesRead =
  | { complete: true; revoked: ReadonlySet<string> }
  /** The page cap was reached with more to read: nothing may be concluded from it. */
  | { complete: false };

/** A row as evidence that a device was signed out: which device, and a revocation time or an explicit none. */
const RevocationRowSchema = z.object({
  id: z.string().regex(ACCOUNT_DEVICE_ID_RE),
  revokedAt: z.iso.datetime().nullable(),
});
const RowIdSchema = z.object({ id: z.string().regex(ACCOUNT_DEVICE_ID_RE) });

/**
 * The backend device ids that a COMPLETE read of this account's device list shows revoked (plan 18,
 * mobile/accountDeviceReconcile.ts). Positive evidence only, and only when every row about a device agrees:
 *   - a device the list does not mention is not in the answer (absence proves nothing);
 *   - a device with a row that can't be read (a `revokedAt` that is no time, or missing), or with two rows that
 *     disagree, is not in the answer;
 *   - a row that names no device is evidence about none.
 * Rejects (CloudError) when any request fails or any page is no device page; `complete: false` when the page
 * cap was reached. The caller must do nothing in both cases.
 */
export async function readRevokedAccountDevices(client: CloudClient, signal?: AbortSignal): Promise<RevokedDevicesRead> {
  const read = await readDevicePages(client, signal);
  if (!read.complete) return { complete: false };
  const revoked = new Set<string>();
  const doubted = new Set<string>();
  for (const raw of read.rows) {
    const row = RevocationRowSchema.safeParse(raw);
    if (row.success && row.data.revokedAt !== null) {
      revoked.add(row.data.id);
      continue;
    }
    // Live, or unreadable: either way this device is not proven revoked, whatever another row says.
    const named = row.success ? row : RowIdSchema.safeParse(raw);
    if (named.success) doubted.add(named.data.id);
  }
  for (const id of doubted) revoked.delete(id);
  return { complete: true, revoked };
}
