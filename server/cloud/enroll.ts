/**
 * enroll.ts — this Mac redeems a phone's enroll ticket at the AASC backend (plan 17).
 *
 *   POST /v1/enroll/tickets/redeem  { ticket }  →  { phoneDeviceId, phoneName, email, phoneKeyHash, sealSecret }
 *
 * A phone signed into the account asked the backend for a 60 s single-use ticket naming this Mac and the
 * phone's ephemeral public key. The backend redeems it only for the Mac it names (this connection's token)
 * and answers with the SHA-256 of that key, which the caller compares with the key the phone sent it.
 * Every refusal becomes one typed reason; the backend's own words never cross the boundary.
 */
import { z } from 'zod';
import { CloudError, type CloudClient } from './types.js';

export type EnrollRedeemReason = 'invalid' | 'expired' | 'used' | 'phone-revoked' | 'cloud-failed';

export class EnrollRedeemError extends Error {
  constructor(readonly reason: EnrollRedeemReason) {
    super(`Enroll ticket refused: ${reason}`);
    this.name = 'EnrollRedeemError';
  }
}

/** 32 random bytes, base64url without padding. */
export const ENROLL_TICKET_RE = /^[A-Za-z0-9_-]{43}$/;

/**
 * The backend's answer (plan 17 wire contract). Unknown keys are dropped, not refused: the ticket is already used
 * by the time this is read, so a backend that adds a field must not cost the phone its ticket (contract v1 is
 * additive). `sealSecret` (review C1) keys the seal together with the ECDH secret; it never crosses the LAN.
 */
const RedeemedTicketSchema = z.object({
  phoneDeviceId: z.uuid(),
  phoneName: z.string().max(256),
  email: z.string().min(3).max(320).nullable(),
  phoneKeyHash: z.string().regex(/^[0-9a-f]{64}$/),
  sealSecret: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
export type RedeemedEnrollTicket = z.infer<typeof RedeemedTicketSchema>;

const REASON_BY_CODE: Readonly<Record<string, EnrollRedeemReason>> = {
  ticket_invalid: 'invalid',
  ticket_expired: 'expired',
  ticket_used: 'used',
  phone_revoked: 'phone-revoked',
};

/**
 * Redeem `ticket` for the phone it names. Throws EnrollRedeemError: `invalid` (a malformed ticket, sent
 * nowhere, or 404 ticket_invalid), `expired` (410), `used` (409), `phone-revoked` (401 phone_revoked), and
 * `cloud-failed` for anything else (no connection, timeout, another error, an answer of the wrong shape).
 */
export async function redeemEnrollTicket(
  client: CloudClient,
  ticket: string,
  signal?: AbortSignal,
): Promise<RedeemedEnrollTicket> {
  if (!ENROLL_TICKET_RE.test(ticket)) throw new EnrollRedeemError('invalid');
  let data: unknown;
  try {
    data = await client.request<unknown>('POST', '/v1/enroll/tickets/redeem', { ticket }, signal);
  } catch (error) {
    const known = error instanceof CloudError && Object.hasOwn(REASON_BY_CODE, error.code) ? REASON_BY_CODE[error.code] : null;
    throw new EnrollRedeemError(known ?? 'cloud-failed');
  }
  const parsed = RedeemedTicketSchema.safeParse(data);
  if (!parsed.success) throw new EnrollRedeemError('cloud-failed');
  return parsed.data;
}
