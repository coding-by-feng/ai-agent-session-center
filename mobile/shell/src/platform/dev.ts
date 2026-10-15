// dev.ts — the shell in a desktop browser, development builds only (AASC-17).
//
// main.ts loads this only when the build mode is "development"; a release build
// drops it. Everything is in memory (a reload forgets every pairing), the Mac is
// a fake (dev/fakeMac.ts), and leaving for a Mac's page does nothing.
//
// Query switches for trying screens by hand or from a render check:
//   ?scenario=offline   no path answers
//   ?scenario=lan       only the home network answers
//   ?scenario=wait      the Mac never answers the approval
//   ?scenario=deny      the Mac denies this phone at the first check
//   ?seed=1             start with two paired Macs (Studio and Kason-MBP)
import { createFakeMac } from '../dev/fakeMac.js';
import type { DeviceVault, ShellDeps } from '../native.js';
import type { KeyValueStore } from '../pushRegistration.js';
import { LAST_MAC_KEY, saveMacs, writeMacCredentials, type SavedMac } from '../savedMacs.js';

const TAILNET = 'http://100.101.102.103:3333';
const LAN = 'http://192.168.1.20:3333';
const STUDIO_TAILNET = 'http://100.88.1.7:3333';

function memoryMap(): { get(k: string): Promise<string | null>; set(k: string, v: string): Promise<void>; delete(k: string): Promise<void> } {
  const values = new Map<string, string>();
  return {
    get: async (k) => values.get(k) ?? null,
    set: async (k, v) => {
      values.set(k, v);
    },
    delete: async (k) => {
      values.delete(k);
    },
  };
}

export async function devDeps(search: string): Promise<ShellDeps> {
  const q = new URLSearchParams(search);
  const scenario = q.get('scenario');
  const reachable = scenario === 'offline' ? [] : scenario === 'lan' ? [LAN] : [TAILNET, LAN, STUDIO_TAILNET];
  const mac = createFakeMac({
    reachable,
    approveAfter: scenario === 'wait' || scenario === 'deny' ? null : 2,
    denyAfter: scenario === 'deny' ? 0 : null,
    confirmCode: '482913',
  });
  const vault: DeviceVault = memoryMap();
  const store: KeyValueStore = memoryMap();

  if (q.get('seed') === '1') {
    const seeded: SavedMac[] = [
      { id: 'dev-studio-0001', name: 'Studio', port: 3333, lan: null, tailnet: '100.88.1.7', lanAllowed: false, backendDeviceId: null, status: 'active', confirmCode: null, phoneName: 'Android phone', lastPath: 'tailnet' },
      { id: 'dev-kason-mbp-01', name: 'Kason-MBP', port: 3333, lan: '192.168.1.20', tailnet: '100.101.102.103', lanAllowed: true, backendDeviceId: null, status: 'active', confirmCode: null, phoneName: 'Android phone', lastPath: 'lan' },
    ];
    for (const m of seeded) await writeMacCredentials(vault, m.id, mac.seedDevice('active'));
    await saveMacs(store, seeded);
    await store.set(LAST_MAC_KEY, 'dev-kason-mbp-01');
  }

  return {
    os: 'web',
    vault,
    store,
    http: mac.http,
    requester: mac.requester,
    cookies: { set: async () => undefined, clear: async () => undefined },
    scanner: { available: false, scan: async () => null },
    navigator: {
      allowOrigins: async () => undefined,
      go: () => undefined,
      search: () => search,
      launchUrl: async () => q.get('link'),
      onLinkOpened: () => () => undefined,
    },
    newId: () => crypto.randomUUID(),
  };
}
