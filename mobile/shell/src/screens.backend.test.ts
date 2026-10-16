// @vitest-environment jsdom
// AASC-52: the phone's backend device for push comes from each Mac after it allows the phone, over the
// phone's signed-in session. Never from the QR. Quiet when a Mac has no cloud, asked again at the next
// sign-in until it works, and kept per Mac.
import { afterEach, describe, expect, it } from 'vitest';
import { loadMacs, readBackendCredential } from './savedMacs';
import { click, createHarness, KASON_MBP, seedMac, STUDIO, TAILNET, until, type Harness, type HarnessOptions } from './testing/shellHarness';

afterEach(() => {
  document.body.replaceChildren();
});

const STUDIO_ORIGIN = 'http://100.88.1.7:3333';
const asks = (t: Harness) => t.mac.calls.filter((c) => c.url.endsWith('/api/mobile/backend-code')).length;
const redeems = (t: Harness) => t.mac.calls.filter((c) => c.url === 'https://api.aasc.work/v1/devices/pair').length;

/** A phone already paired with Kason-MBP (and Studio when asked) opens it from the list. */
async function openSaved(opts: HarnessOptions = {}, macs = [KASON_MBP, STUDIO]): Promise<Harness> {
  const t = createHarness({ ...opts, mac: { reachable: [TAILNET, STUDIO_ORIGIN], ...opts.mac } });
  for (const m of macs) await seedMac(t, m);
  await t.app.start();
  return t;
}

async function open(t: Harness, name: RegExp): Promise<void> {
  const before = t.navigations.length;
  click(t.root, name);
  await until(t.root, () => t.navigations.length > before);
}

/** The same phone launching again later: same Preferences, vault and Mac. */
async function relaunch(t: Harness, opts: HarnessOptions = {}): Promise<Harness> {
  t.app.dispose();
  document.body.replaceChildren();
  const next = createHarness({ ...opts, fakeMac: t.mac, store: Object.fromEntries(t.store), vault: Object.fromEntries(t.vault) });
  await next.app.start();
  return next;
}

describe('the backend device for push (AASC-52)', () => {
  it('a Mac with no cloud: opens as usual, nothing reaches the backend, nothing is said', async () => {
    const t = await openSaved({ mac: { cloud: false } });
    await open(t, /^Kason-MBP/);
    expect(asks(t)).toBe(1);
    expect(redeems(t)).toBe(0);
    expect(await readBackendCredential(t.deps.vault, KASON_MBP.id)).toBeNull();
    expect(t.navigations).toEqual([`${TAILNET}/`]);
  });

  it('asks again at the next sign-in, and links once the Mac has its cloud', async () => {
    const first = await openSaved({ mac: { cloud: false } });
    await open(first, /^Kason-MBP/);
    first.mac.setCloud(true);
    const t = await relaunch(first);
    await open(t, /^Kason-MBP/);
    expect(await readBackendCredential(t.deps.vault, KASON_MBP.id)).toMatchObject({ host: 'api.aasc.work' });
    expect((await loadMacs(t.deps.store)).find((m) => m.id === KASON_MBP.id)?.backendDeviceId).toBe('mac-dev-1');
  });

  it('a failed redeem leaves no half-stored credential and is retried at the next sign-in', async () => {
    const first = await openSaved();
    first.mac.setBackendDown(true);
    await open(first, /^Kason-MBP/);
    expect(await readBackendCredential(first.deps.vault, KASON_MBP.id)).toBeNull();
    first.mac.setBackendDown(false);
    const t = await relaunch(first);
    await open(t, /^Kason-MBP/);
    expect(await readBackendCredential(t.deps.vault, KASON_MBP.id)).not.toBeNull();
  });

  it('a cloud that doesn’t answer never holds up opening the Mac: linking has a time budget', async () => {
    const t = await openSaved({ timing: { pollMs: 5, pollMaxMs: 60_000, linkMs: 40 } });
    t.mac.setBackendHang(true);
    const started = Date.now();
    await open(t, /^Kason-MBP/);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(t.navigations).toEqual([`${TAILNET}/`]);
    expect(await readBackendCredential(t.deps.vault, KASON_MBP.id)).toBeNull();
  });

  it('a phone that already holds its backend device for a Mac doesn’t ask again', async () => {
    const first = await openSaved();
    await open(first, /^Kason-MBP/);
    const t = await relaunch(first);
    await open(t, /^Kason-MBP/);
    expect(asks(t)).toBe(1); // the fake Mac's log spans both launches: only the first asked
  });

  it('keeps one backend device per Mac: each Mac issues its own', async () => {
    const first = await openSaved();
    await open(first, /^Kason-MBP/);
    const t = await relaunch(first);
    await open(t, /^Studio/);
    const a = await readBackendCredential(t.deps.vault, KASON_MBP.id);
    const b = await readBackendCredential(t.deps.vault, STUDIO.id);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a?.deviceId).not.toBe(b?.deviceId);
    expect(t.mac.backendCodes()).toHaveLength(2);
  });

  it('a backend device revoked on the Mac’s side is dropped, and the next sign-in gets a fresh one', async () => {
    const first = await openSaved({ push: { configured: true, permission: 'granted' } });
    await open(first, /^Kason-MBP/);
    const old = await readBackendCredential(first.deps.vault, KASON_MBP.id);
    first.mac.revokeBackendDevice(old!.deviceId); // e.g. "Remove them" on the Mac, or the owner CLI
    const t = await relaunch(first, { push: { configured: true, permission: 'granted' } });
    await until(t.root, () => t.extras.token !== null);
    t.extras.token!('fcm-token-1');
    await until(t.root, () => !t.vault.has(`backend.${KASON_MBP.id}`));
    await open(t, /^Kason-MBP/);
    const fresh = await readBackendCredential(t.deps.vault, KASON_MBP.id);
    expect(fresh).not.toBeNull();
    expect(fresh?.deviceId).not.toBe(old?.deviceId);
  });
});
