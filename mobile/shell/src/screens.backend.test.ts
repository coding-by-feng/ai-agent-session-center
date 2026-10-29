// @vitest-environment jsdom
// AASC-52: the phone's backend device for push comes from each Mac after it allows the phone, over the
// phone's signed-in session. Never from the QR. Quiet when a Mac has no cloud, asked again at the next
// sign-in until it works, and kept per Mac.
import { afterEach, describe, expect, it } from 'vitest';
import { linkBackend } from './backendLink';
import { openSession } from './pairingClient';
import {
  loadMacs, readBackendCredential, readMacCredentials, saveMacs, withoutMac, writeBackendCredential,
} from './savedMacs';
import { signInAndOpen, unpairMac } from './shellFlows';
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

/** The same phone launching again later: same Preferences, vault and Mac. It opens the Mac used last by itself. */
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
    await until(t.root, () => t.navigations.length > 0); // the launch opens the Mac used last: the next sign-in
    expect(await readBackendCredential(t.deps.vault, KASON_MBP.id)).toMatchObject({ host: 'api.aasc.work' });
    expect((await loadMacs(t.deps.store)).find((m) => m.id === KASON_MBP.id)?.backendDeviceId).toBe('mac-dev-1');
  });

  it('a failed redeem leaves no half-stored credential and is retried at the next sign-in', async () => {
    const first = await openSaved();
    first.mac.setBackendDown(true);
    await open(first, /^Kason-MBP/);
    expect(await readBackendCredential(first.deps.vault, KASON_MBP.id)).toBeNull();
    expect(asks(first)).toBe(2); // asked once more at once (below), then no more until the next sign-in
    first.mac.setBackendDown(false);
    const t = await relaunch(first);
    await until(t.root, () => t.navigations.length > 0); // the launch opens the Mac used last: the next sign-in
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
    await until(t.root, () => t.navigations.length > 0); // the launch opens the Mac used last: the next sign-in
    expect(asks(t)).toBe(1); // the fake Mac's log spans both launches: only the first asked
  });

  it('keeps one backend device per Mac: each Mac issues its own', async () => {
    const first = await openSaved();
    await open(first, /^Kason-MBP/);
    const t = await relaunch(first, { search: '?tap=1' }); // back on Your Macs (More → Switch AASC)
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
    // Back on Your Macs (More → Switch AASC), so the sign-in below comes after push dropped the device.
    const t = await relaunch(first, { push: { configured: true, permission: 'granted' }, search: '?tap=1' });
    await until(t.root, () => t.extras.token !== null);
    t.extras.token!('fcm-token-1');
    await until(t.root, () => !t.vault.has(`backend.${KASON_MBP.id}`));
    await open(t, /^Kason-MBP/);
    const fresh = await readBackendCredential(t.deps.vault, KASON_MBP.id);
    expect(fresh).not.toBeNull();
    expect(fresh?.deviceId).not.toBe(old?.deviceId);
  });
});

// The LAN path is plain HTTP: a sniffer may redeem the phone's backend code first. The phone asks its Mac once
// more at once, and the Mac's look at the backend before the next code revokes the device the sniffer made.
describe('a backend code someone else redeemed first (AASC-52 review)', () => {
  it('asks the Mac once more at once, and links with the next code', async () => {
    const t = await openSaved();
    t.mac.stealNextBackendCode();
    await open(t, /^Kason-MBP/);
    expect(asks(t)).toBe(2);
    expect(redeems(t)).toBe(2);
    expect(await readBackendCredential(t.deps.vault, KASON_MBP.id)).toMatchObject({ host: 'api.aasc.work' });
  });

  it('asks once more only: the Mac caps the asks, and the next sign-in tries again', async () => {
    const t = await openSaved();
    t.mac.stealNextBackendCode();
    t.mac.setBackendDown(true);
    await open(t, /^Kason-MBP/);
    expect(asks(t)).toBe(2);
    expect(await readBackendCredential(t.deps.vault, KASON_MBP.id)).toBeNull();
  });
});

// Opening a Mac waits for the backend link only so long (linkMs). The link must not then go on writing the vault
// outside the serialized work: a later sign-in or an unpair may have run since.
describe('a backend link that outlives its sign-in (AASC-52 review)', () => {
  async function seeded(): Promise<Harness> {
    const t = createHarness({ mac: { reachable: [TAILNET] } });
    await seedMac(t, KASON_MBP);
    return t;
  }

  /** Let the held redemption answer, then wait until the shell has done whatever it does with it. */
  async function answerHeld(t: Harness, release: () => void): Promise<void> {
    const before = t.mac.issued.length;
    release();
    await until(t.root, () => t.mac.issued.length > before); // the backend made the device and its token
    await new Promise((r) => setTimeout(r, 30));
  }

  it('a second sign-in’s newer credential is never overwritten by the first one’s late answer', async () => {
    const t = await seeded();
    const release = t.mac.holdNextBackendRequest();
    const first = await signInAndOpen(t.deps, [KASON_MBP], KASON_MBP, '/', undefined, { linkMs: 40 });
    expect(first).toMatchObject({ kind: 'navigate', backendLinked: false });
    if (first.kind !== 'navigate') return;
    const second = await signInAndOpen(t.deps, first.macs, first.mac, '/', undefined, { linkMs: 2_000 });
    expect(second).toMatchObject({ kind: 'navigate', backendLinked: true });
    const newer = await readBackendCredential(t.deps.vault, KASON_MBP.id);
    expect(newer).not.toBeNull();
    await answerHeld(t, release);
    expect(await readBackendCredential(t.deps.vault, KASON_MBP.id)).toEqual(newer);
  });

  it('a link that comes back after the Mac was removed from this phone writes nothing', async () => {
    const t = await seeded();
    const release = t.mac.holdNextBackendRequest();
    const first = await signInAndOpen(t.deps, [KASON_MBP], KASON_MBP, '/', undefined, { linkMs: 40 });
    if (first.kind !== 'navigate') throw new Error(`expected navigate, got ${first.kind}`);
    expect(await unpairMac(t.deps, first.macs, first.mac, { force: true })).toMatchObject({ done: true, macs: [] });
    await answerHeld(t, release);
    expect(t.vault.has(`backend.${KASON_MBP.id}`)).toBe(false);
    expect(t.vault.has(`mac.${KASON_MBP.id}`)).toBe(false);
  });

  async function signedIn(t: Harness): Promise<string> {
    const creds = await readMacCredentials(t.deps.vault, KASON_MBP.id);
    const session = await openSession(t.deps.http, TAILNET, creds!);
    if (session.status !== 'ok') throw new Error(`sign-in failed: ${session.status}`);
    return session.token;
  }

  it('re-checks before writing: a credential written meanwhile wins', async () => {
    const t = await seeded();
    const token = await signedIn(t);
    const release = t.mac.holdNextBackendRequest();
    const link = linkBackend(t.deps, KASON_MBP, TAILNET, token);
    await until(t.root, () => redeems(t) === 1);
    const newer = t.mac.seedBackendDevice();
    await writeBackendCredential(t.deps.vault, KASON_MBP.id, newer);
    release();
    expect(await link).toEqual({ kind: 'failed' });
    expect(await readBackendCredential(t.deps.vault, KASON_MBP.id)).toEqual(newer);
  });

  it('re-checks before writing: a Mac removed meanwhile gets nothing', async () => {
    const t = await seeded();
    const token = await signedIn(t);
    const release = t.mac.holdNextBackendRequest();
    const link = linkBackend(t.deps, KASON_MBP, TAILNET, token);
    await until(t.root, () => redeems(t) === 1);
    await saveMacs(t.deps.store, withoutMac(await loadMacs(t.deps.store), KASON_MBP.id));
    release();
    expect(await link).toEqual({ kind: 'failed' });
    expect(t.vault.has(`backend.${KASON_MBP.id}`)).toBe(false);
  });

  it('a link cut off by its budget drops what comes back', async () => {
    const t = await seeded();
    const token = await signedIn(t);
    const release = t.mac.holdNextBackendRequest();
    const cut = new AbortController();
    const link = linkBackend(t.deps, KASON_MBP, TAILNET, token, cut.signal);
    await until(t.root, () => redeems(t) === 1);
    cut.abort();
    release();
    expect(await link).toEqual({ kind: 'failed' });
    expect(t.vault.has(`backend.${KASON_MBP.id}`)).toBe(false);
    expect(asks(t)).toBe(1);
  });
});

// AASC-60: a backend token made without mac-paths:read is replaced at the next sign-in (savedMacs relink flag). The Mac
// revokes this phone's old backend device when it issues the next code, so the phone lets go of the old token first.
describe('replacing the backend device (AASC-60 relink)', () => {
  async function withToken(opts: HarnessOptions = {}): Promise<{ t: Harness; old: { host: string; deviceId: string; token: string }; session: string }> {
    const t = createHarness({ mac: { reachable: [TAILNET], ...opts.mac } });
    await seedMac(t, KASON_MBP);
    const old = t.mac.seedBackendDevice();
    await writeBackendCredential(t.deps.vault, KASON_MBP.id, old);
    const creds = await readMacCredentials(t.deps.vault, KASON_MBP.id);
    const session = await openSession(t.deps.http, TAILNET, creds!);
    if (session.status !== 'ok') throw new Error(`sign-in failed: ${session.status}`);
    return { t, old, session: session.token };
  }

  it('a held token is kept, and nothing is asked, when no relink is wanted', async () => {
    const { t, old, session } = await withToken();
    expect(await linkBackend(t.deps, KASON_MBP, TAILNET, session)).toEqual({ kind: 'already' });
    expect(await linkBackend(t.deps, KASON_MBP, TAILNET, session, undefined, { relink: false })).toEqual({ kind: 'already' });
    expect(await readBackendCredential(t.deps.vault, KASON_MBP.id)).toEqual(old);
    expect(asks(t)).toBe(0);
  });

  it('a relink lets go of the held token, asks the Mac for a new code and keeps the new device', async () => {
    const { t, old, session } = await withToken();
    const outcome = await linkBackend(t.deps, KASON_MBP, TAILNET, session, undefined, { relink: true });
    expect(outcome).toMatchObject({ kind: 'linked' });
    const fresh = await readBackendCredential(t.deps.vault, KASON_MBP.id);
    expect(fresh).not.toBeNull();
    expect(fresh?.deviceId).not.toBe(old.deviceId);
    expect(fresh?.token).not.toBe(old.token);
    expect(asks(t)).toBe(1);
    expect(redeems(t)).toBe(1);
  });

  it('a relink for a Mac holding no token is just a link', async () => {
    const t = createHarness({ mac: { reachable: [TAILNET] } });
    await seedMac(t, KASON_MBP);
    const creds = await readMacCredentials(t.deps.vault, KASON_MBP.id);
    const session = await openSession(t.deps.http, TAILNET, creds!);
    if (session.status !== 'ok') throw new Error(`sign-in failed: ${session.status}`);
    expect(await linkBackend(t.deps, KASON_MBP, TAILNET, session.token, undefined, { relink: true })).toMatchObject({ kind: 'linked' });
    expect(await readBackendCredential(t.deps.vault, KASON_MBP.id)).not.toBeNull();
  });

  it('a Mac that has lost its cloud leaves no token, and the next sign-in asks again', async () => {
    const { t, session } = await withToken({ mac: { cloud: false } });
    expect(await linkBackend(t.deps, KASON_MBP, TAILNET, session, undefined, { relink: true })).toEqual({ kind: 'no-cloud' });
    expect(await readBackendCredential(t.deps.vault, KASON_MBP.id)).toBeNull();
    t.mac.setCloud(true);
    expect(await linkBackend(t.deps, KASON_MBP, TAILNET, session)).toMatchObject({ kind: 'linked' });
  });

  it('a vault that won’t let go of the old token stops the relink before the Mac is asked', async () => {
    const { t, old, session } = await withToken();
    const stuck = { ...t.deps, vault: { ...t.deps.vault, delete: async () => { throw new Error('keystore unavailable'); } } };
    expect(await linkBackend(stuck, KASON_MBP, TAILNET, session, undefined, { relink: true })).toEqual({ kind: 'failed' });
    expect(asks(t)).toBe(0); // asking would have the Mac revoke the old device with no way to keep the new one
    expect(redeems(t)).toBe(0);
    expect(await readBackendCredential(t.deps.vault, KASON_MBP.id)).toEqual(old);
  });

  it('a vault that says it let go but didn’t is not a reason to ask the Mac either', async () => {
    const { t, old, session } = await withToken();
    const keeping = { ...t.deps, vault: { ...t.deps.vault, delete: async () => undefined } };
    expect(await linkBackend(keeping, KASON_MBP, TAILNET, session, undefined, { relink: true })).toEqual({ kind: 'already' });
    expect(asks(t)).toBe(0);
    expect(await readBackendCredential(t.deps.vault, KASON_MBP.id)).toEqual(old);
  });

  it('a relink that is already cut off lets go of nothing and asks nobody', async () => {
    const { t, old, session } = await withToken();
    const cut = new AbortController();
    cut.abort();
    expect(await linkBackend(t.deps, KASON_MBP, TAILNET, session, cut.signal, { relink: true })).toEqual({ kind: 'failed' });
    expect(await readBackendCredential(t.deps.vault, KASON_MBP.id)).toEqual(old);
    expect(asks(t)).toBe(0);
  });

  it('a relink cut off by its budget drops what comes back, like any link', async () => {
    const { t, session } = await withToken();
    const release = t.mac.holdNextBackendRequest();
    const cut = new AbortController();
    const link = linkBackend(t.deps, KASON_MBP, TAILNET, session, cut.signal, { relink: true });
    await until(t.root, () => redeems(t) === 1);
    cut.abort();
    release();
    expect(await link).toEqual({ kind: 'failed' });
    expect(t.vault.has(`backend.${KASON_MBP.id}`)).toBe(false); // the old one was let go; nothing new was kept
  });
});
