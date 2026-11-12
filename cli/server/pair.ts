/**
 * `aasc-server pair [--lan] [--tailscale] [--public] [--invert]` (terminal-editions plan §8.3): make a
 * pairing link, draw it as a text QR, wait for a phone or computer to redeem it, then ask y/N.
 *
 * Allow always needs a person: there is no --yes, and pair refuses to run without a terminal (an
 * `echo y |` would otherwise approve whoever redeems the code first). A pairing code can be redeemed
 * as any kind of device (open item M1 in remote-computers.md), so the prompt names the platform and
 * the confirm code the device shows. N, Ctrl-C or ten minutes deny it.
 */
import { EXIT, errorOf, safeText, type AdminClient } from './http.js';

export const PAIR_POLL_MS = 2_000;
/** As long as the server keeps a device waiting for Allow (deviceAuth.ts PENDING_TTL_MS). */
export const ANSWER_TIMEOUT_MS = 10 * 60_000;

export type AddressKind = 'lan' | 'tailnet' | 'public';

export interface PairDeps {
  client: AdminClient;
  /** The addresses the link carries; undefined lets the server choose (home network and Tailscale). */
  include: AddressKind[] | undefined;
  invert: boolean;
  /** stdin and stdout are a terminal: a person is there to answer. */
  interactive: boolean;
  out: (line: string) => void;
  /** Ask a question; the answer, or null on Ctrl-C, end of input or timeout. */
  ask: (question: string, timeoutMs: number) => Promise<string | null>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** Aborted on Ctrl-C while waiting for a device. */
  cancelled: AbortSignal;
  qr: (text: string, options: { invert: boolean }) => string;
}

interface DeviceRow {
  id: string;
  label: string;
  platform: string;
  status: string;
  confirmCode: string | null;
}

function platformName(platform: string): string {
  if (platform === 'desktop') return 'Computer';
  if (platform === 'ios') return 'Phone · iOS';
  if (platform === 'android') return 'Phone · Android';
  return safeText(platform);
}

/** 482913 → "482 913", as the device shows it. */
function spacedCode(code: string | null): string {
  const safe = safeText(code ?? '');
  return safe.length === 6 ? `${safe.slice(0, 3)} ${safe.slice(3)}` : safe;
}

async function listDevices(client: AdminClient): Promise<DeviceRow[] | string> {
  const res = await client.request('GET', '/api/mobile/devices');
  if (res.status !== 200) return errorOf(res, 'Could not list devices');
  return (res.body?.data?.devices ?? []) as DeviceRow[];
}

/** Put the QR's rows beside the instructions: phones scan, computers paste. */
function framed(qr: string): string[] {
  const side = [
    '',
    'Phone: scan this with the AASC app.',
    'Computer: paste the link below into',
    'Remote computers ▸ + Add a computer.',
  ];
  return qr.split('\n').map((row, i) => `  ${row}${side[i] ? `      ${side[i]}` : ''}`);
}

export async function runPair(deps: PairDeps): Promise<number> {
  const { client, out } = deps;
  if (!deps.interactive) {
    out('aasc-server pair needs a terminal: Allow always needs a person to answer y/N.');
    return EXIT.FAILED;
  }

  // Devices already waiting before this link existed are someone else's business.
  const before = await listDevices(client);
  if (typeof before === 'string') {
    out(before);
    return EXIT.FAILED;
  }
  const known = new Set(before.map((d) => d.id));

  const made = await client.request('POST', '/api/mobile/pairing', deps.include ? { include: deps.include } : {});
  if (made.status !== 200) {
    out(errorOf(made, 'Could not make a pairing link'));
    return EXIT.FAILED;
  }
  const link = String(made.body?.data?.link ?? '');
  const codeRef = String(made.body?.data?.codeRef ?? '');
  const expiresAt = Number(made.body?.data?.expiresAt ?? 0);
  const minutes = Math.max(1, Math.round((expiresAt - deps.now()) / 60_000));

  out('');
  out(`  Pair a phone or computer — this link works for ${minutes} minutes`);
  out('');
  for (const line of framed(deps.qr(link, { invert: deps.invert }))) out(line);
  out('');
  out(`  ${link}`);
  out('');
  out('  Waiting for a device… (Ctrl-C to cancel)');

  let device: DeviceRow | undefined;
  while (!device) {
    if (deps.cancelled.aborted) {
      out(await withdraw(client, codeRef)
        ? 'Cancelled. The link no longer works.'
        : 'Cancelled. The link stops working when it expires.');
      return EXIT.FAILED;
    }
    if (deps.now() >= expiresAt) {
      // The server's clock decides expiry; withdrawing makes sure the code is gone now.
      await withdraw(client, codeRef);
      out('The link expired and no device asked to pair. Run `aasc-server pair` again.');
      return EXIT.FAILED;
    }
    await deps.sleep(PAIR_POLL_MS);
    if (deps.cancelled.aborted) continue;
    const list = await listDevices(client);
    if (typeof list === 'string') {
      out(list);
      return EXIT.FAILED;
    }
    device = list.find((d) => d.status === 'pending' && !known.has(d.id));
  }

  const id = encodeURIComponent(device.id);
  const label = safeText(device.label);
  // The label is the device's own claim, so it is quoted on a line of its own; the kind and the
  // confirm code (what the owner should check) sit on the next line, where a label can't reach.
  const answer = await deps.ask(
    `\n  "${label}" wants to pair.\n  ${platformName(device.platform)} · check it shows ${spacedCode(device.confirmCode)}. Allow? [y/N] `,
    ANSWER_TIMEOUT_MS,
  );
  if (answer !== null && /^\s*y(es)?\s*$/i.test(answer)) {
    const approved = await client.request('POST', `/api/mobile/devices/${id}/approve`);
    if (approved.status !== 200) {
      out(errorOf(approved, `Could not allow ${label}`));
      return EXIT.FAILED;
    }
    out(`✓ Paired ${label}. It sees shared sessions only.`);
    return EXIT.OK;
  }

  const denied = await client.request('DELETE', `/api/mobile/devices/${id}`);
  out(denied.status === 200 ? `Denied. ${label} was not paired.` : errorOf(denied, `Could not deny ${label}`));
  return EXIT.FAILED;
}

/**
 * Withdraw the unused pairing code (DELETE /api/mobile/pairing/:codeRef), so a cancelled `pair`
 * doesn't leave a working link behind for its remaining minutes. True when the server confirmed.
 */
async function withdraw(client: AdminClient, codeRef: string): Promise<boolean> {
  if (!codeRef) return false;
  try {
    const res = await client.request('DELETE', `/api/mobile/pairing/${encodeURIComponent(codeRef)}`);
    return res.status === 200;
  } catch {
    return false;
  }
}
