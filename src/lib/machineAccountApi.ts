/**
 * machineAccountApi — what this computer tells and allows its AASC Cloud account (plan 18 stage 2): the two local
 * routes behind the devices panel's "Account" group.
 *
 *   GET /api/resources/cloud/machines/settings   → the three settings, which of them the environment pins, and what
 *                                                   the directory publisher last found
 *   PUT /api/resources/cloud/machines/settings   body: the three settings, whole (the server refuses a part of
 *                                                   them, and `pinned` / `publisher` sent back); answers as GET
 *
 * Only this computer's own dashboard may call them (server/cloud/machinesRouter.ts). The envelope is the cloud
 * routes' own, `{ success, data | error: { code, message } }`, read as `cloudApi.ts` reads it; this module stays
 * apart from that one so the devices panel, which Lite keeps, does not carry the RESOURCES tab's schemas.
 */

const SETTINGS_URL = '/api/resources/cloud/machines/settings';

export type ComputerEnrollMode = 'ask' | 'auto';
export type AccountAddressKind = 'lan' | 'tailnet' | 'public';
export const ACCOUNT_ADDRESS_KINDS: readonly AccountAddressKind[] = ['lan', 'tailnet', 'public'];

/** The part a person sets. */
export interface MachineAccountChoice {
  showOnAccount: boolean;
  addresses: Record<AccountAddressKind, boolean>;
  computerEnroll: ComputerEnrollMode;
}

export interface MachinePublisher {
  /**
   * `pending` · `no-cloud` · `off` · `pairing-off` · `no-password` · `no-address` · `published` · `needs-sign-in` ·
   * `unsupported` · `failed`, or a word a later server adds.
   */
  state: string;
  /** What the account holds right now; set only while `published`. */
  published: { lan: string | null; tailnet: string | null; public: string | null; port: number } | null;
}

export interface MachineAccountSettings extends MachineAccountChoice {
  /** True for a setting this computer's environment decides. */
  pinned: { showOnAccount: boolean; computerEnroll: boolean };
  publisher: MachinePublisher;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const address = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

function readPublisher(v: unknown): MachinePublisher | null {
  if (!isRecord(v) || typeof v.state !== 'string') return null;
  const p = v.published;
  const published = isRecord(p) && typeof p.port === 'number'
    ? { lan: address(p.lan), tailnet: address(p.tailnet), public: address(p.public), port: p.port }
    : null;
  return { state: v.state, published };
}

/** The answer as the page uses it, or null for one that is not this route's. */
function readSettings(v: unknown): MachineAccountSettings | null {
  if (!isRecord(v) || !isRecord(v.addresses) || !isRecord(v.pinned)) return null;
  const publisher = readPublisher(v.publisher);
  if (typeof v.showOnAccount !== 'boolean' || (v.computerEnroll !== 'ask' && v.computerEnroll !== 'auto') || !publisher) return null;
  return {
    showOnAccount: v.showOnAccount,
    addresses: { lan: v.addresses.lan === true, tailnet: v.addresses.tailnet === true, public: v.addresses.public === true },
    computerEnroll: v.computerEnroll,
    pinned: { showOnAccount: v.pinned.showOnAccount === true, computerEnroll: v.pinned.computerEnroll === true },
    publisher,
  };
}

/** The server's own words for a refusal, whichever way it spells the error. */
function refusal(envelope: unknown, fallback: string): string {
  const error = isRecord(envelope) ? envelope.error : undefined;
  if (typeof error === 'string' && error) return error;
  if (isRecord(error) && typeof error.message === 'string' && error.message) return error.message;
  return fallback;
}

async function settingsFrom(response: Response, fallback: string): Promise<MachineAccountSettings> {
  const envelope: unknown = await response.json().catch(() => null);
  if (!response.ok || !isRecord(envelope) || envelope.success !== true) throw new Error(refusal(envelope, fallback));
  const settings = readSettings(envelope.data);
  if (!settings) throw new Error(fallback);
  return settings;
}

/** Said when the request got no answer at all, in place of the browser's "Failed to fetch". */
const SERVER_UNREACHABLE = 'Couldn’t reach this computer’s AASC server. Try again.';

/** `fetch`, with a request that never got an answer said in the page's words. A cancelled one stays as it is. */
async function ask(init: RequestInit): Promise<Response> {
  try {
    return await fetch(SETTINGS_URL, init);
  } catch (err) {
    if (init.signal?.aborted) throw err;
    throw new Error(SERVER_UNREACHABLE);
  }
}

/** The settings, or null when this computer's server has no such route (404): there is nothing to show. */
export async function loadMachineSettings(signal?: AbortSignal): Promise<MachineAccountSettings | null> {
  const response = await ask({ signal });
  if (response.status === 404) return null;
  return settingsFrom(response, 'Couldn’t read this computer’s account settings.');
}

/** Save the choice, whole; answers the settings as they now stand, with what the publisher then found. */
export async function saveMachineSettings(choice: MachineAccountChoice, signal?: AbortSignal): Promise<MachineAccountSettings> {
  const body: MachineAccountChoice = {
    showOnAccount: choice.showOnAccount,
    addresses: { lan: choice.addresses.lan, tailnet: choice.addresses.tailnet, public: choice.addresses.public },
    computerEnroll: choice.computerEnroll,
  };
  const response = await ask({
    method: 'PUT', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return settingsFrom(response, 'Couldn’t save the setting.');
}

const NOT_LISTED: Record<string, string> = {
  'pairing-off': 'Not listed: device pairing is off on this computer.',
  'no-password': 'Not listed: set a dashboard password first.',
  'no-address': 'Not listed: none of the ticked addresses is available right now.',
  'needs-sign-in': 'Not listed: sign out of AASC Cloud and sign in again.',
  unsupported: 'Not listed: AASC Cloud doesn’t support this yet.',
  failed: 'Couldn’t update AASC Cloud. It will try again.',
};

const ADDRESS_NAME: Record<AccountAddressKind, string> = {
  lan: 'home network',
  tailnet: 'Tailscale',
  public: 'public IP, unencrypted',
};

/** "A", "A and B", "A, B and C". */
function listed(parts: readonly string[]): string {
  return parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** The one status line under the settings; null when there is nothing to say (`off`, or a state not known here). */
export function publisherLine(publisher: MachinePublisher): string | null {
  if (publisher.state === 'pending') return 'Checking…';
  if (publisher.state === 'published') {
    const at = publisher.published;
    if (!at) return null;
    const parts = ACCOUNT_ADDRESS_KINDS.flatMap((kind) => (at[kind] ? [`${at[kind]} (${ADDRESS_NAME[kind]})`] : []));
    return parts.length > 0 ? `Listed at ${listed(parts)}, port ${at.port}.` : null;
  }
  return NOT_LISTED[publisher.state] ?? null;
}
