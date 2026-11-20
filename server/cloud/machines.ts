/**
 * machines.ts — this computer's calls to the AASC backend's machine directory (plan 18, stage 2), through the
 * server-owned cloud connection (the device token never leaves it):
 *
 *   GET    /v1/machines                 the account's computers and the addresses each can be tried at
 *   PUT    /v1/machines/self            where THIS computer can be tried (written whole)
 *   DELETE /v1/machines/self            leave the directory
 *   POST   /v1/machines/tickets         a 60 s single-use ticket for another computer of the account
 *   POST   /v1/machines/tickets/redeem  redeem a ticket that names this computer
 *
 * An address is a hint, never an authority: a client trusts a computer only after the sealed answer of
 * mobile/computerEnroll.ts opens with the address the client itself dialled.
 *
 * Every input is validated before anything is sent, and every answer is validated and rebuilt from the fields
 * this build knows. Contract v1 is additive, so a key the backend adds later is dropped, never passed on and
 * never a failure; a known field of the wrong shape refuses the whole answer. The backend's own words never
 * cross the boundary.
 */
import { z } from 'zod';
import { isPrivateLanAddress, isPublicAddress, isTailnetAddress } from '../networkInfo.js';
import { CloudError, type CloudClient } from './types.js';

/** The backend never lists more (its MACHINES_LIST_MAX). */
export const MACHINES_LIST_MAX = 50;
/** 32 random bytes, base64url without padding: a ticket and a seal secret. */
export const MACHINE_TICKET_RE = /^[A-Za-z0-9_-]{43}$/;
/** A 65-byte uncompressed P-256 point, base64url without padding. */
export const MACHINE_KEY_RE = /^[A-Za-z0-9_-]{87}$/;
/** Link-local, and never a computer's own. */
const CLOUD_METADATA_ADDRESS = '169.254.169.254';

const Uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const Port = z.number().int().min(1).max(65_535);
/** Canonical dotted-decimal IPv4 of each kind: the rules of networkInfo.ts, which the backend applies too. */
const LanAddress = z.string().refine((a) => isPrivateLanAddress(a) && a !== CLOUD_METADATA_ADDRESS);
const TailnetAddress = z.string().refine(isTailnetAddress);
const PublicAddress = z.string().refine(isPublicAddress);
/** A short lower-case word (macos, lite, …): shown, never acted on, so a value added later still lists. */
const Word = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/);

const PathsSchema = z.object({
  lan: LanAddress.nullable(),
  tailnet: TailnetAddress.nullable(),
  public: PublicAddress.nullable(),
  port: Port,
  updatedAt: z.iso.datetime(),
});

const MachineSchema = z.object({
  deviceId: Uuid,
  name: z.string().max(256),
  platform: Word.nullable(),
  edition: Word.nullable(),
  appVersion: z.string().max(64).nullable(),
  lastUsedAt: z.iso.datetime().nullable(),
  current: z.boolean(),
  connectable: z.boolean(),
  relation: z.literal('self'),
  paths: PathsSchema.nullable(),
});
export type AccountMachine = z.infer<typeof MachineSchema>;
export type AccountMachinePaths = z.infer<typeof PathsSchema>;

const ListSchema = z.object({ machines: z.array(z.unknown()).max(MACHINES_LIST_MAX) });
/** Only to read an entry's relation before the entry itself is checked. */
const RelationSchema = z.object({ relation: z.string().max(64) });

const PublishInputSchema = z
  .object({
    lan: LanAddress.nullable().optional(),
    tailnet: TailnetAddress.nullable().optional(),
    public: PublicAddress.nullable().optional(),
    port: Port,
  })
  .strict()
  .refine((input) => Boolean(input.lan ?? input.tailnet ?? input.public));
export interface MachinePathsInput {
  lan?: string | null;
  tailnet?: string | null;
  public?: string | null;
  port: number;
}

const TicketInputSchema = z.object({ machineId: Uuid, clientKey: z.string().regex(MACHINE_KEY_RE) }).strict();
const TicketSchema = z.object({
  ticket: z.string().regex(MACHINE_TICKET_RE),
  sealSecret: z.string().regex(MACHINE_TICKET_RE),
  expiresAt: z.iso.datetime(),
});
export type MachineTicket = z.infer<typeof TicketSchema>;

/**
 * Who asked for the ticket this computer just redeemed. `relation` must be `self`: any other kind of access
 * (a group member's, later) is not a paired computer's, so an answer naming one is refused as a whole.
 */
const RedeemedSchema = z.object({
  clientDeviceId: Uuid,
  clientName: z.string().max(256),
  clientKind: z.enum(['server', 'phone']).nullable(),
  email: z.string().min(3).max(320).nullable(),
  clientKeyHash: z.string().regex(/^[0-9a-f]{64}$/),
  sealSecret: z.string().regex(MACHINE_TICKET_RE),
  relation: z.literal('self'),
});
export type RedeemedMachineTicket = Omit<z.infer<typeof RedeemedSchema>, 'relation'>;

export type MachineRedeemReason = 'invalid' | 'expired' | 'used' | 'client-revoked' | 'cloud-failed';

export class MachineRedeemError extends Error {
  constructor(readonly reason: MachineRedeemReason) {
    super(`Access ticket refused: ${reason}`);
    this.name = 'MachineRedeemError';
  }
}

const REDEEM_REASON_BY_CODE: Readonly<Record<string, MachineRedeemReason>> = {
  ticket_invalid: 'invalid',
  ticket_expired: 'expired',
  ticket_used: 'used',
  client_revoked: 'client-revoked',
};

const invalidResponse = () => new CloudError('invalid_response', 'Cloud returned an invalid answer about your computers.');

/**
 * What the two refusals that are not about this request mean here: a 403 is a sign-in from before the backend
 * gave computers these scopes (sign in again), and the standard not-found is a backend without the service.
 */
function directoryError(error: unknown): unknown {
  if (!(error instanceof CloudError)) return error;
  if (error.code === 'forbidden' && error.status === 403)
    return new CloudError('needs_sign_in', 'Sign in to AASC Cloud again on this computer to use your account’s computers.', 403);
  if (error.code === 'not_found' && error.status === 404)
    return new CloudError('unsupported', 'This AASC Cloud backend doesn’t list computers yet.', 404);
  return error;
}

/**
 * The account's computers, newest used first. A computer whose `relation` this build does not know is left out
 * (the backend adds kinds with groups). CloudError: `needs_sign_in` (403), `unsupported` (404),
 * `invalid_response`, and `disconnected` / `offline` / `backend_error` otherwise.
 */
export async function listAccountMachines(client: CloudClient, signal?: AbortSignal): Promise<AccountMachine[]> {
  let data: unknown;
  try {
    data = await client.request<unknown>('GET', '/v1/machines', undefined, signal);
  } catch (error) {
    throw directoryError(error);
  }
  const list = ListSchema.safeParse(data);
  if (!list.success) throw invalidResponse();
  const machines: AccountMachine[] = [];
  for (const entry of list.data.machines) {
    const relation = RelationSchema.safeParse(entry);
    if (!relation.success) throw invalidResponse();
    if (relation.data.relation !== 'self') continue;
    const machine = MachineSchema.safeParse(entry);
    if (!machine.success) throw invalidResponse();
    machines.push(machine.data);
  }
  return machines;
}

/**
 * Tell the account where this computer can be tried. Written whole by the backend: an address left out is gone
 * from the directory. CloudError: `invalid_input` (400, nothing sent: an address of the wrong kind, or none),
 * `forbidden` (403), `not_found` (404), `invalid_response`, then the usual connection errors.
 */
export async function publishMachinePaths(
  client: CloudClient,
  input: MachinePathsInput,
  signal?: AbortSignal,
): Promise<{ updatedAt: string }> {
  const parsed = PublishInputSchema.safeParse(input);
  if (!parsed.success) throw new CloudError('invalid_input', 'Invalid addresses or port for this computer.', 400);
  // Rebuilt field by field: the body is these and nothing else.
  const { lan, tailnet, public: publicAddress, port } = parsed.data;
  const body = {
    ...(lan ? { lan } : {}),
    ...(tailnet ? { tailnet } : {}),
    ...(publicAddress ? { public: publicAddress } : {}),
    port,
  };
  const data = await client.request<unknown>('PUT', '/v1/machines/self', body, signal);
  const result = z.object({ updatedAt: z.iso.datetime() }).safeParse(data);
  if (!result.success) throw invalidResponse();
  return { updatedAt: result.data.updatedAt };
}

/** Take this computer's addresses out of the directory. `withdrawn` is false when it had none there. */
export async function withdrawMachinePaths(client: CloudClient, signal?: AbortSignal): Promise<{ withdrawn: boolean }> {
  const data = await client.request<unknown>('DELETE', '/v1/machines/self', undefined, signal);
  const result = z.object({ withdrawn: z.boolean() }).safeParse(data);
  if (!result.success) throw invalidResponse();
  return { withdrawn: result.data.withdrawn };
}

/**
 * Ask for a ticket to connect to another computer of the account, bound to `clientKey`. CloudError:
 * `invalid_input` (400, nothing sent), `machine_not_found` (404), `rate_limited` (429, with `retryAfterMs`),
 * `needs_sign_in` (403), `unsupported` (404), `invalid_response`, then the usual connection errors.
 */
export async function requestMachineTicket(
  client: CloudClient,
  input: { machineId: string; clientKey: string },
  signal?: AbortSignal,
): Promise<MachineTicket> {
  const parsed = TicketInputSchema.safeParse(input);
  if (!parsed.success) throw new CloudError('invalid_input', 'Invalid computer or key.', 400);
  let data: unknown;
  try {
    data = await client.request<unknown>(
      'POST', '/v1/machines/tickets', { machineId: parsed.data.machineId, clientKey: parsed.data.clientKey }, signal,
    );
  } catch (error) {
    throw directoryError(error);
  }
  const result = TicketSchema.safeParse(data);
  if (!result.success) throw invalidResponse();
  return { ticket: result.data.ticket, sealSecret: result.data.sealSecret, expiresAt: result.data.expiresAt };
}

/**
 * Redeem a ticket that names this computer. Throws MachineRedeemError: `invalid` (a malformed ticket, sent
 * nowhere, or 404 ticket_invalid: unknown, or naming another computer and left unconsumed), `expired` (410),
 * `used` (409), `client-revoked` (401 client_revoked: about the CLIENT, never this computer's own token), and
 * `cloud-failed` for anything else (no connection, a timeout, another error, an answer of the wrong shape).
 * Unknown keys are dropped: the ticket is already used once the answer is read.
 */
export async function redeemMachineTicket(
  client: CloudClient,
  ticket: string,
  signal?: AbortSignal,
): Promise<RedeemedMachineTicket> {
  if (!MACHINE_TICKET_RE.test(ticket)) throw new MachineRedeemError('invalid');
  let data: unknown;
  try {
    data = await client.request<unknown>('POST', '/v1/machines/tickets/redeem', { ticket }, signal);
  } catch (error) {
    const known = error instanceof CloudError && Object.hasOwn(REDEEM_REASON_BY_CODE, error.code)
      ? REDEEM_REASON_BY_CODE[error.code]
      : null;
    throw new MachineRedeemError(known ?? 'cloud-failed');
  }
  const parsed = RedeemedSchema.safeParse(data);
  if (!parsed.success) throw new MachineRedeemError('cloud-failed');
  const { relation: _relation, ...redeemed } = parsed.data;
  return redeemed;
}
