/**
 * Typed calls this Mac makes to the AASC backend on behalf of its phones,
 * through the server-owned cloud connection (the device token never leaves it):
 *
 *   POST /v1/push/notify             — ask the backend to push to paired phones (AASC-16)
 *   POST /v1/devices/pairing-codes   — mint a phone-scoped backend pairing code (AASC-15)
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
 * may hold (it refuses anything outside its phone set with 403).
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
 * phone may not hold), `disconnected`/`offline`/`backend_error` otherwise.
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
