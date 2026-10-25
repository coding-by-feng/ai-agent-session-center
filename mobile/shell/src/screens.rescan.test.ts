// @vitest-environment jsdom
// The Mac's home-network address changed: the phone finds it again on its own, without pairing again.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BACKEND_RELINK_KEY, clearBackendRelink, loadMacs, markBackendRelink, needsBackendRelink, readBackendCredential, readMacCredentials,
  RELINK_COOLDOWN_MS, writeBackendCredential, type SavedMac,
} from './savedMacs';
import { SWEEP_PROBE_MS, type BrowseResult } from './lanRescan';
import { forgetMac, signInAndOpen, unpairMac, type OpenOutcome } from './shellFlows';
import { click, createHarness, heading, KASON_MBP, seedMac, STUDIO, TAILNET, until, type Harness, type HarnessOptions } from './testing/shellHarness';

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

const MOVED = 'http://192.168.1.57:3333';
const STRANGER = 'http://192.168.1.30:3333';
/** Saved at pairing: home network allowed, 192.168.1.20; its Tailscale address doesn't answer here. */
const HOME_MAC = { ...KASON_MBP, lanAllowed: true, lastPath: 'lan' as const };

/** Launch with one saved Mac: the app opens it at once (not awaited: a held browse holds the launch). */
async function open(opts: HarnessOptions, mac: SavedMac = HOME_MAC) {
  const t = createHarness(opts);
  await seedMac(t, mac);
  void t.app.start();
  return t;
}

const identifyCalls = (t: ReturnType<typeof createHarness>) => t.mac.calls.filter((c) => c.url.endsWith('/api/mobile/identify'));
/** What the Opening screen says it is doing. */
const statusText = (t: Harness) => t.root.querySelector('[role="status"]')?.textContent ?? '';

describe('LAN rescan', () => {
  it('finds the Mac at its new address and opens it, no pairing', async () => {
    const t = await open({ mac: { reachable: [MOVED] } });
    await until(t.root, () => t.navigations.length > 0);
    expect(t.navigations).toEqual([`${MOVED}/`]);
    expect(t.cookies.map((c) => c.origin)).toEqual([MOVED]);
    expect(t.allowed.at(-1)).toContain(MOVED);
    const saved = (await loadMacs(t.deps.store)).find((m) => m.id === HOME_MAC.id);
    expect(saved).toMatchObject({ lan: '192.168.1.57', lastPath: 'lan', tailnet: HOME_MAC.tailnet });
  });

  // The Opening screen already says "Looking for <name>…" before any path is tried, so the browse (the first thing the
  // search does) is the proof that the search has begun and has put its own words up in place of "Trying …".
  it('shows "Looking for <name>…" while searching', async () => {
    let browsing = false;
    let release!: (found: BrowseResult) => void;
    const t = await open({
      mac: { reachable: [MOVED] },
      discovery: () => {
        browsing = true;
        return new Promise<BrowseResult>((resolve) => { release = resolve; });
      },
    });
    await until(t.root, () => browsing);
    expect(statusText(t)).toBe('Looking for Kason-MBP…');
    release({ services: [] });
    await until(t.root, () => t.navigations.length > 0);
    expect(t.navigations).toEqual([`${MOVED}/`]);
  });

  it('passes over another AASC on the network that can\'t prove this phone\'s key', async () => {
    const t = await open({ mac: { reachable: [MOVED], strangers: [STRANGER] } });
    await until(t.root, () => t.navigations.length > 0);
    expect(t.navigations).toEqual([`${MOVED}/`]);
    expect(identifyCalls(t).map((c) => new URL(c.url).origin)).toContain(STRANGER);
    expect(t.cookies.map((c) => c.origin)).not.toContain(STRANGER);
  });

  it('never opens a relay that passes the question on to the real Mac', async () => {
    const RELAY = 'http://192.168.1.3:3333';
    const t = await open({ mac: { reachable: [MOVED], relays: [RELAY] }, discovery: async () => ({ services: [{ host: '192.168.1.3', port: 3333 }] }) });
    await until(t.root, () => t.navigations.length > 0);
    expect(t.navigations).toEqual([`${MOVED}/`]);
    expect(identifyCalls(t).map((c) => new URL(c.url).origin)).toContain(RELAY);
    expect(t.cookies.map((c) => c.origin)).toEqual([MOVED]);
  });

  it('never sends its device id while it looks', async () => {
    const t = await open({ mac: { reachable: [MOVED], strangers: [STRANGER] } });
    await until(t.root, () => t.navigations.length > 0);
    const deviceId = [...t.mac.devices.keys()][0];
    expect(JSON.stringify(identifyCalls(t).map((c) => c.body))).not.toContain(deviceId);
  });

  it('finds the Mac through Bonjour on another network', async () => {
    const t = await open({
      mac: { reachable: ['http://10.0.0.7:3333'] },
      discovery: async () => ({ services: [{ host: '10.0.0.7', port: 3333 }] }),
    });
    await until(t.root, () => t.navigations.length > 0);
    expect(t.navigations).toEqual(['http://10.0.0.7:3333/']);
    expect((await loadMacs(t.deps.store))[0].lan).toBe('10.0.0.7');
  });

  it('opens nothing and changes nothing when no one proves the key', async () => {
    const t = await open({ mac: { reachable: [], strangers: [STRANGER] } });
    await until(t.root, () => heading(t.root) === 'Can’t reach Kason-MBP');
    expect(t.navigations).toEqual([]);
    expect((await loadMacs(t.deps.store))[0].lan).toBe('192.168.1.20');
  });

  // Oct 21 2026 review: the old address answering as someone else's AASC used to wipe the pairing.
  it('keeps its pairing when another AASC took the Mac\'s old address, and finds the Mac', async () => {
    const OLD = 'http://192.168.1.20:3333';
    const t = await open({ mac: { reachable: [MOVED], strangers: [OLD] } });
    await until(t.root, () => t.navigations.length > 0);
    expect(t.navigations).toEqual([`${MOVED}/`]);
    expect((await loadMacs(t.deps.store))[0].lan).toBe('192.168.1.57');
    expect(await readMacCredentials(t.deps.vault, HOME_MAC.id)).not.toBeNull();
  });

  it('keeps its pairing when another AASC took the old address and the Mac is nowhere', async () => {
    const t = await open({ mac: { reachable: [], strangers: ['http://192.168.1.20:3333'] } });
    await until(t.root, () => heading(t.root) === 'Can’t reach Kason-MBP');
    expect((await loadMacs(t.deps.store))[0].lan).toBe('192.168.1.20');
    expect(await readMacCredentials(t.deps.vault, HOME_MAC.id)).not.toBeNull();
  });

  it('sweeps only the network the phone is on', async () => {
    const t = await open({ mac: { reachable: [MOVED] }, discovery: async () => ({ services: [], local: ['10.0.0.9'] }) });
    await until(t.root, () => heading(t.root) === 'Can’t reach Kason-MBP');
    expect(t.mac.calls.filter((c) => c.url.startsWith('http://192.168.1.') && !c.url.startsWith('http://192.168.1.20:'))).toEqual([]);
  });

  it('sweeps when the phone is on the saved address\'s network', async () => {
    const t = await open({ mac: { reachable: [MOVED] }, discovery: async () => ({ services: [], local: ['192.168.1.33'] }) });
    await until(t.root, () => t.navigations.length > 0);
    expect(t.navigations).toEqual([`${MOVED}/`]);
  });

  it('probes the home network with the short sweep timeout', async () => {
    const t = await open({ mac: { reachable: [MOVED] } });
    await until(t.root, () => t.navigations.length > 0);
    const probes = t.mac.calls.filter((c) => c.url.startsWith('http://192.168.1.') && c.url.endsWith('/api/auth/status') && !c.url.startsWith('http://192.168.1.20:'));
    expect(probes.length).toBeGreaterThan(10);
    expect(new Set(probes.map((c) => c.timeoutMs))).toEqual(new Set([SWEEP_PROBE_MS]));
  });

  it('never searches for a Mac the home network isn\'t allowed for', async () => {
    const t = await open({ mac: { reachable: [MOVED] } }, { ...KASON_MBP, lanAllowed: false });
    await until(t.root, () => heading(t.root) === 'Can’t reach Kason-MBP');
    expect(identifyCalls(t)).toEqual([]);
    expect(t.mac.calls.some((c) => c.url.startsWith('http://192.168.1.'))).toBe(false);
  });

  it('never searches for a Mac still waiting for approval', async () => {
    const t = createHarness({ mac: { reachable: [MOVED] } });
    await seedMac(t, { ...HOME_MAC, status: 'pending' }, 'pending');
    await t.app.start(); // a launch stays on Your Macs while a pairing waits
    click(t.root, /^Kason-MBP/);
    await until(t.root, () => heading(t.root) === 'Approve on your Mac');
    await new Promise((r) => setTimeout(r, 50));
    expect(identifyCalls(t)).toEqual([]);
  });

  it('drops the search when the user cancels', async () => {
    let browsing = false;
    let release!: (found: BrowseResult) => void;
    const t = await open({
      mac: { reachable: [MOVED] },
      discovery: () => {
        browsing = true;
        return new Promise<BrowseResult>((resolve) => { release = resolve; });
      },
    });
    await until(t.root, () => browsing);
    click(t.root, 'Cancel');
    release({ services: [] });
    await new Promise((r) => setTimeout(r, 50));
    expect(t.navigations).toEqual([]);
    expect((await loadMacs(t.deps.store))[0].lan).toBe('192.168.1.20');
  });
});

// AASC-60 Remote access: no saved path answers and the LAN rescan finds nothing (or isn't allowed): the phone asks
// AASC Cloud where its Mac is on Tailscale. A listed address is opened only once the Mac there proves this phone's key.
describe('AASC Cloud lookup', () => {
  const BACKEND_LIST = 'https://api.aasc.work/v1/mac-paths';
  const CLOUD = 'http://100.101.102.103:3333';
  const MINI = 'http://100.88.1.7:3333';
  /** Paired at home with the home network allowed, before Tailscale was set up: no Tailscale address saved. */
  const AWAY_MAC: SavedMac = { ...KASON_MBP, tailnet: null, lanAllowed: true, lastPath: 'lan' };
  /** The account lists a Mac mini first, then this Mac (under the id it sent with its backend code). */
  const LISTED = [{ deviceId: 'mac-mini', tailnet: '100.88.1.7', port: 3333 }, { deviceId: 'mac-dev-1', tailnet: '100.101.102.103', port: 3333 }];
  /** On mobile data, or a café's Wi-Fi: not on the saved home network. */
  const OFF_HOME = async (): Promise<BrowseResult> => ({ services: [], local: ['10.0.0.9'] });

  const cloudAsks = (t: Harness) => t.mac.calls.filter((c) => c.url === BACKEND_LIST);
  const sweeps = (t: Harness) => t.mac.calls.filter((c) => c.url.startsWith('http://192.168.1.') && !c.url.startsWith('http://192.168.1.20:'));
  const asks = (t: Harness) => t.mac.calls.filter((c) => c.url.endsWith('/api/mobile/backend-code')).length;

  /** A phone with one saved Mac and a backend token of its own, not started yet (a test may need to hold a request first). */
  async function phone(opts: HarnessOptions, mac: SavedMac = AWAY_MAC): Promise<Harness> {
    const t = createHarness(opts);
    await seedMac(t, mac);
    await writeBackendCredential(t.deps.vault, mac.id, t.mac.seedBackendDevice());
    return t;
  }

  const launch = (t: Harness) => {
    void t.app.start();
    return t;
  };

  function navigated(out: OpenOutcome): Extract<OpenOutcome, { kind: 'navigate' }> {
    if (out.kind !== 'navigate') throw new Error(`expected navigate, got ${out.kind}`);
    return out;
  }

  it('away from home with no saved Tailscale address, the cloud finds the Mac and the row saves it', async () => {
    const t = launch(await phone({ mac: { reachable: [CLOUD], strangers: [MINI], cloudMacs: LISTED }, discovery: OFF_HOME }));
    await until(t.root, () => t.navigations.length > 0);
    expect(t.navigations).toEqual([`${CLOUD}/`]);
    expect(t.cookies.map((c) => c.origin)).toEqual([CLOUD]);
    expect(t.allowed.at(-1)).toContain(CLOUD);
    expect((await loadMacs(t.deps.store))[0]).toMatchObject({
      id: AWAY_MAC.id, lan: '192.168.1.20', tailnet: '100.101.102.103', lastPath: 'tailnet', lanAllowed: true, status: 'active',
    });
    expect(cloudAsks(t)).toHaveLength(1);
    expect(sweeps(t)).toEqual([]); // the café's network was not swept
    expect(await readMacCredentials(t.deps.vault, AWAY_MAC.id)).not.toBeNull();
  });

  it('a Tailscale-only row (home network not allowed) still asks the cloud', async () => {
    const MOVED_TAILNET = 'http://100.88.1.9:3333';
    let browsed = false;
    const t = launch(await phone({
      mac: { reachable: [MOVED_TAILNET], cloudMacs: [{ deviceId: 'mac-dev-1', tailnet: '100.88.1.9', port: 3333 }] },
      discovery: async () => {
        browsed = true;
        return { services: [] };
      },
    }, STUDIO));
    await until(t.root, () => t.navigations.length > 0);
    expect(t.navigations).toEqual([`${MOVED_TAILNET}/`]);
    expect(browsed).toBe(false); // the home network was never allowed, so it was not looked at
    expect((await loadMacs(t.deps.store))[0]).toMatchObject({ tailnet: '100.88.1.9', lan: null, lastPath: 'tailnet' });
    expect(t.cleared).toEqual([MINI]); // the session at the old Tailscale address goes
    expect(t.allowed.at(-1)).toContain(MOVED_TAILNET);
    expect(t.allowed.at(-1)).not.toContain(MINI);
  });

  it('shows "Looking for <name>…" while it asks the cloud', async () => {
    const t = await phone({ mac: { reachable: ['http://100.88.1.9:3333'], cloudMacs: [{ deviceId: 'mac-dev-1', tailnet: '100.88.1.9', port: 3333 }] } }, STUDIO);
    const release = t.mac.holdNextBackendRequest();
    launch(t);
    await until(t.root, () => cloudAsks(t).length === 1);
    expect(statusText(t)).toBe('Looking for Studio…'); // not the "Trying Tailscale …" of the saved path it just gave up on
    release();
    await until(t.root, () => t.navigations.length > 0);
  });

  describe('asks only when it has to', () => {
    it('not when a saved path answers', async () => {
      const t = launch(await phone({ mac: { reachable: [TAILNET], cloudMacs: LISTED } }, KASON_MBP));
      await until(t.root, () => t.navigations.length > 0);
      expect(t.navigations).toEqual([`${TAILNET}/`]);
      expect(cloudAsks(t)).toEqual([]);
    });

    it('not when the LAN rescan finds the Mac', async () => {
      const t = launch(await phone({ mac: { reachable: [MOVED], cloudMacs: LISTED } }, { ...HOME_MAC, tailnet: null }));
      await until(t.root, () => t.navigations.length > 0);
      expect(t.navigations).toEqual([`${MOVED}/`]);
      expect(cloudAsks(t)).toEqual([]);
    });

    it('not for a Mac it holds no backend token for', async () => {
      const t = createHarness({ mac: { reachable: [], cloudMacs: LISTED } });
      await seedMac(t, STUDIO);
      launch(t);
      await until(t.root, () => heading(t.root) === 'Can’t reach Studio');
      expect(t.mac.calls.filter((c) => c.url.startsWith('https://'))).toEqual([]);
    });

    it('not for a Mac still waiting for approval', async () => {
      const t = createHarness({ mac: { reachable: [CLOUD], cloudMacs: LISTED }, discovery: OFF_HOME });
      await seedMac(t, { ...AWAY_MAC, status: 'pending' }, 'pending');
      await writeBackendCredential(t.deps.vault, AWAY_MAC.id, t.mac.seedBackendDevice());
      await t.app.start();
      click(t.root, /^Kason-MBP/);
      await until(t.root, () => heading(t.root) === 'Approve on your Mac');
      await new Promise((r) => setTimeout(r, 50));
      expect(cloudAsks(t)).toEqual([]);
      expect(identifyCalls(t)).toEqual([]);
    });
  });

  describe('announcing the search', () => {
    /** How many times signInAndOpen says it is looking, for a phone that can't reach its Mac. */
    async function announced(mac: SavedMac, token: boolean): Promise<number> {
      const t = createHarness({ mac: { reachable: [], cloudMacs: [] }, discovery: OFF_HOME });
      await seedMac(t, mac);
      if (token) await writeBackendCredential(t.deps.vault, mac.id, t.mac.seedBackendDevice());
      let said = 0;
      await signInAndOpen(t.deps, [mac], mac, '/', undefined, { onSearch: () => { said += 1; } });
      return said;
    }

    it('once when it can look on the home network', async () => {
      expect(await announced(AWAY_MAC, false)).toBe(1);
    });

    it('once when it can only ask the cloud', async () => {
      expect(await announced(STUDIO, true)).toBe(1);
    });

    it('once when it can do both', async () => {
      expect(await announced(AWAY_MAC, true)).toBe(1);
    });

    it('not at all when there is nowhere to look', async () => {
      expect(await announced(STUDIO, false)).toBe(0);
    });
  });

  // The saved paths stop at the first that answers. When that is a stranger at the saved home address (a café that
  // reuses its /24), the saved Tailscale address was never tried, so the cloud may name it.
  describe('a stranger holds the saved home address', () => {
    const STRANGER = 'http://192.168.1.20:3333';
    /** The phone is on the saved home network's /24, so the sweep runs too. */
    const CAFE = async (): Promise<BrowseResult> => ({ services: [], local: ['192.168.1.33'] });
    const origins = (calls: Array<{ url: string }>) => calls.map((c) => new URL(c.url).origin);

    it('finds the Mac on its saved Tailscale address through the cloud', async () => {
      const t = launch(await phone({
        mac: { reachable: [TAILNET], strangers: [STRANGER], cloudMacs: [LISTED[1]] },
        discovery: CAFE,
      }, HOME_MAC));
      await until(t.root, () => t.navigations.length > 0);
      expect(t.navigations).toEqual([`${TAILNET}/`]);
      expect(t.cookies.map((c) => c.origin)).toEqual([TAILNET]);
      expect((await loadMacs(t.deps.store))[0]).toMatchObject({
        id: HOME_MAC.id, lan: '192.168.1.20', tailnet: '100.101.102.103', lastPath: 'tailnet', status: 'active',
      });
      expect(await readMacCredentials(t.deps.vault, HOME_MAC.id)).not.toBeNull();
      expect(cloudAsks(t)).toHaveLength(1);
      expect(origins(identifyCalls(t))).toContain(TAILNET); // opened only after the Mac there proved this phone's key
    });

    it('keeps the pairing and opens nothing when the Mac is not there either', async () => {
      const t = launch(await phone({
        mac: { reachable: [], strangers: [STRANGER, TAILNET], cloudMacs: [LISTED[1]] },
        discovery: CAFE,
      }, HOME_MAC));
      await until(t.root, () => heading(t.root) === 'Can’t reach Kason-MBP');
      expect(origins(identifyCalls(t))).toContain(TAILNET); // asked, and a box there could not prove the key
      expect(t.navigations).toEqual([]);
      expect(t.cookies).toEqual([]);
      expect((await loadMacs(t.deps.store))[0]).toMatchObject({ lan: '192.168.1.20', tailnet: '100.101.102.103' });
      expect(await readMacCredentials(t.deps.vault, HOME_MAC.id)).not.toBeNull();
    });

    it('does not ask again about a saved Tailscale address the saved paths had just tried', async () => {
      const t = launch(await phone({
        mac: { reachable: [], cloudMacs: [{ deviceId: 'mac-dev-1', tailnet: '100.88.1.7', port: 3333 }] },
      }, STUDIO));
      await until(t.root, () => heading(t.root) === 'Can’t reach Studio');
      expect(cloudAsks(t)).toHaveLength(1);
      expect(t.mac.calls.filter((c) => c.url === `${MINI}/api/auth/status`)).toHaveLength(1); // the saved path's own probe, once
      expect(identifyCalls(t)).toEqual([]);
    });
  });

  describe('when the cloud can’t help', () => {
    it('opens nothing and changes nothing when no listed Mac proves the key', async () => {
      const t = launch(await phone({ mac: { reachable: [], strangers: [MINI], cloudMacs: [LISTED[0]] }, discovery: OFF_HOME }));
      await until(t.root, () => heading(t.root) === 'Can’t reach Kason-MBP');
      expect(identifyCalls(t).map((c) => new URL(c.url).origin)).toEqual([MINI]); // asked, and it could not prove the key
      expect(t.navigations).toEqual([]);
      expect(t.cookies).toEqual([]);
      expect((await loadMacs(t.deps.store))[0]).toMatchObject({ tailnet: null, lan: '192.168.1.20' });
      expect(await readMacCredentials(t.deps.vault, AWAY_MAC.id)).not.toBeNull();
      expect(t.mac.strikes()).toBe(0);
    });

    it('a Mac the cloud lists but nothing answers for is still not reachable', async () => {
      const t = launch(await phone({ mac: { reachable: [], cloudMacs: LISTED }, discovery: OFF_HOME }));
      await until(t.root, () => heading(t.root) === 'Can’t reach Kason-MBP');
      expect(identifyCalls(t)).toEqual([]);
      expect(t.navigations).toEqual([]);
    });

    it('a backend without the mac-paths module is just no help', async () => {
      const t = launch(await phone({ mac: { reachable: [], strangers: [] }, discovery: OFF_HOME }));
      await until(t.root, () => heading(t.root) === 'Can’t reach Kason-MBP');
      expect(cloudAsks(t)).toHaveLength(1);
      expect(await needsBackendRelink(t.deps.store, AWAY_MAC.id)).toBe(false);
      expect(await readBackendCredential(t.deps.vault, AWAY_MAC.id)).not.toBeNull();
    });

    it('drops the cloud lookup when the user cancels', async () => {
      const t = await phone({ mac: { reachable: [CLOUD], cloudMacs: LISTED }, discovery: OFF_HOME });
      const release = t.mac.holdNextBackendRequest();
      launch(t);
      await until(t.root, () => cloudAsks(t).length === 1);
      click(t.root, 'Cancel');
      release();
      await new Promise((r) => setTimeout(r, 80));
      expect(t.navigations).toEqual([]);
      expect(t.cookies).toEqual([]);
      expect((await loadMacs(t.deps.store))[0].tailnet).toBeNull();
      expect(identifyCalls(t)).toEqual([]); // the late list led nowhere
    });
  });

  describe('the backend token it asks with', () => {
    it('a 401 costs the phone that token, and the next sign-in links a new device', async () => {
      const t = createHarness({ mac: { reachable: [], cloudMacs: [] } });
      await seedMac(t, KASON_MBP);
      const old = t.mac.seedBackendDevice();
      await writeBackendCredential(t.deps.vault, KASON_MBP.id, old);
      t.mac.revokeBackendDevice(old.deviceId);
      expect((await signInAndOpen(t.deps, [KASON_MBP], KASON_MBP, '/')).kind).toBe('offline');
      expect(await readBackendCredential(t.deps.vault, KASON_MBP.id)).toBeNull();
      t.mac.setReachable([TAILNET]);
      const again = navigated(await signInAndOpen(t.deps, [KASON_MBP], KASON_MBP, '/'));
      expect(again.backendLinked).toBe(true);
      expect((await readBackendCredential(t.deps.vault, KASON_MBP.id))?.deviceId).not.toBe(old.deviceId);
    });

    it('a row marked for relink gets a new backend code at its next sign-in', async () => {
      // Its token was made push-only (the backend refused mac-paths:read then), and a 403 from the cloud marked the row.
      const t = createHarness({ mac: { reachable: [TAILNET], cloudMacs: [], cloudReadForbidden: true } });
      await seedMac(t, KASON_MBP);
      const old = t.mac.seedBackendDevice();
      await writeBackendCredential(t.deps.vault, KASON_MBP.id, old);
      await markBackendRelink(t.deps.store, KASON_MBP.id);
      t.mac.setCloudReadForbidden(false); // the backend has been upgraded since
      launch(t);
      await until(t.root, () => t.navigations.length > 0);
      const fresh = await readBackendCredential(t.deps.vault, KASON_MBP.id);
      expect(fresh).not.toBeNull();
      expect(fresh?.deviceId).not.toBe(old.deviceId);
      expect(asks(t)).toBe(1);
      expect(await needsBackendRelink(t.deps.store, KASON_MBP.id)).toBe(false);
      const as = (token: string) => t.mac.requester.request({ method: 'GET', url: BACKEND_LIST, headers: { Authorization: `Bearer ${token}` } });
      expect((await as(fresh!.token)).status).toBe(200); // the new device can read the list
      expect((await as(old.token)).status).toBe(403); // the old one could not
    });

    it('a marked Mac that can’t be reached keeps its token: the relink waits for a sign-in', async () => {
      const t = createHarness({ mac: { reachable: [], cloudMacs: [] } });
      await seedMac(t, KASON_MBP);
      const old = t.mac.seedBackendDevice();
      await writeBackendCredential(t.deps.vault, KASON_MBP.id, old);
      await markBackendRelink(t.deps.store, KASON_MBP.id);
      launch(t);
      await until(t.root, () => heading(t.root) === 'Can’t reach Kason-MBP');
      expect(await readBackendCredential(t.deps.vault, KASON_MBP.id)).toEqual(old);
      expect(await needsBackendRelink(t.deps.store, KASON_MBP.id)).toBe(true);
      expect(asks(t)).toBe(0);
    });

    it('a relink that didn’t link keeps the Mac marked, and starts no cooldown', async () => {
      const t = createHarness({ mac: { reachable: [TAILNET], cloudMacs: [] } });
      await seedMac(t, KASON_MBP);
      await writeBackendCredential(t.deps.vault, KASON_MBP.id, t.mac.seedBackendDevice());
      await markBackendRelink(t.deps.store, KASON_MBP.id);
      t.mac.setBackendDown(true);
      const failed = navigated(await signInAndOpen(t.deps, [KASON_MBP], KASON_MBP, '/'));
      expect(failed.backendLinked).toBe(false);
      expect(await needsBackendRelink(t.deps.store, KASON_MBP.id)).toBe(true); // still owed
      t.mac.setBackendDown(false);
      const again = navigated(await signInAndOpen(t.deps, failed.macs, failed.mac, '/'));
      expect(again.backendLinked).toBe(true);
      expect(await needsBackendRelink(t.deps.store, KASON_MBP.id)).toBe(false);
    });

    describe('removing a Mac from this phone', () => {
      const stored = (t: Harness) => JSON.parse(t.store.get(BACKEND_RELINK_KEY) ?? '[]') as Array<{ id: string }>;

      /** Two Macs, both with a relink on record: KASON_MBP marked, STUDIO relinked (a cooldown running). */
      async function twoWithRelinks(): Promise<{ t: Harness; macs: SavedMac[] }> {
        const t = createHarness({ mac: { reachable: [TAILNET] } });
        await seedMac(t, KASON_MBP);
        await seedMac(t, STUDIO);
        await markBackendRelink(t.deps.store, KASON_MBP.id);
        await markBackendRelink(t.deps.store, STUDIO.id);
        await clearBackendRelink(t.deps.store, STUDIO.id);
        return { t, macs: await loadMacs(t.deps.store) };
      }

      it('drops its mark and its cooldown, and only its own', async () => {
        const { t, macs } = await twoWithRelinks();
        const rest = await forgetMac(t.deps, macs, KASON_MBP);
        expect(stored(t).map((e) => e.id)).toEqual([STUDIO.id]);
        expect(await needsBackendRelink(t.deps.store, KASON_MBP.id)).toBe(false);
        await forgetMac(t.deps, rest, STUDIO);
        expect(stored(t)).toEqual([]);
      });

      it('does so when the user unpairs it, too', async () => {
        const { t, macs } = await twoWithRelinks();
        const out = await unpairMac(t.deps, macs, macs[0], { force: true });
        expect(out).toMatchObject({ done: true });
        expect(stored(t).map((e) => e.id)).toEqual([STUDIO.id]);
      });

      it('never lets a preferences write that fails keep the Mac on the phone', async () => {
        const { t, macs } = await twoWithRelinks();
        const failing = {
          ...t.deps,
          store: {
            get: t.deps.store.get,
            set: async (k: string, v: string) => {
              if (k === BACKEND_RELINK_KEY) throw new Error('preferences are full');
              await t.deps.store.set(k, v);
            },
          },
        };
        const rest = await forgetMac(failing, macs, KASON_MBP);
        expect(rest.map((m) => m.id)).toEqual([STUDIO.id]);
        expect((await loadMacs(t.deps.store)).map((m) => m.id)).toEqual([STUDIO.id]);
        expect(await readMacCredentials(t.deps.vault, KASON_MBP.id)).toBeNull();
      });
    });

    // R19: a Mac whose backend keeps issuing push-only codes is not relinked at every sign-in.
    it('a 403 right after a relink does not mark it again', async () => {
      const t = createHarness({ mac: { reachable: [TAILNET], cloudMacs: [], cloudReadForbidden: true } });
      await seedMac(t, KASON_MBP);
      const signIn = (prev: { macs: readonly SavedMac[]; mac: SavedMac }) => signInAndOpen(t.deps, prev.macs, prev.mac, '/');
      const tokenId = async () => (await readBackendCredential(t.deps.vault, KASON_MBP.id))?.deviceId;

      const first = navigated(await signInAndOpen(t.deps, [KASON_MBP], KASON_MBP, '/'));
      expect(first.backendLinked).toBe(true); // linked, push-only
      const firstToken = await tokenId();
      t.mac.setReachable([]);
      expect((await signIn(first)).kind).toBe('offline'); // the cloud: 403
      expect(await needsBackendRelink(t.deps.store, KASON_MBP.id)).toBe(true);

      t.mac.setReachable([TAILNET]);
      const second = navigated(await signIn(first)); // the relink
      expect(second.backendLinked).toBe(true);
      expect(await tokenId()).not.toBe(firstToken);
      expect(asks(t)).toBe(2);
      expect(await needsBackendRelink(t.deps.store, KASON_MBP.id)).toBe(false);

      t.mac.setReachable([]);
      expect((await signIn(second)).kind).toBe('offline'); // and the new token is refused too
      expect(await needsBackendRelink(t.deps.store, KASON_MBP.id)).toBe(false); // but it is not marked again
      t.mac.setReachable([TAILNET]);
      const third = navigated(await signIn(second));
      expect(third.backendLinked).toBe(false);
      expect(asks(t)).toBe(2); // no third code

      // A week on, the next 403 marks it again.
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + RELINK_COOLDOWN_MS + 1_000);
      t.mac.setReachable([]);
      expect((await signIn(third)).kind).toBe('offline');
      expect(await needsBackendRelink(t.deps.store, KASON_MBP.id)).toBe(true);
    });
  });
});
