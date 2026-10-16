// @vitest-environment jsdom
// AASC-17 / plan 08 §2: tokens live in the vault and the native cookie only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MACS_KEY } from './savedMacs';
import { click, createHarness, KASON_MBP, pairUntilApproval, seedMac, STUDIO, TAILNET, until } from './testing/shellHarness';

/** A Web Storage that records writes (Node 26 shadows jsdom's localStorage with an empty one). */
function recordingStorage() {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    key: (i: number) => [...values.keys()][i] ?? null,
    getItem: (k: string) => values.get(k) ?? null,
    setItem: vi.fn((k: string, v: string) => { values.set(k, String(v)); }),
    removeItem: (k: string) => { values.delete(k); },
    clear: () => values.clear(),
    dump: () => JSON.stringify([...values]),
  };
}

let local = recordingStorage();
let session = recordingStorage();

beforeEach(() => {
  local = recordingStorage();
  session = recordingStorage();
  vi.stubGlobal('localStorage', local);
  vi.stubGlobal('sessionStorage', session);
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('where the tokens go', () => {
  it('never puts a token in web storage, Preferences, a URL, the page or a cookie script can read', async () => {
    const t = createHarness();
    await pairUntilApproval(t);
    t.mac.approve();
    await until(t.root, () => t.navigations.length > 0);

    // Every secret the Mac and the backend handed out: device and session tokens, the backend code, the backend token.
    expect(t.mac.issued.length).toBeGreaterThanOrEqual(4);
    const visible = [
      ...t.store.values(),
      ...t.navigations,
      ...t.allowed.flat(),
      t.root.textContent ?? '',
      document.cookie,
      local.dump(),
      session.dump(),
    ].join('\n');
    for (const secret of t.mac.issued) expect(visible).not.toContain(secret);
    expect(local.setItem).not.toHaveBeenCalled();
    expect(session.setItem).not.toHaveBeenCalled();

    // The device and backend tokens reached the vault, the session token only the native cookie. The backend
    // code the Mac issued after approval (AASC-52) went to the backend and nowhere else: not even the vault.
    const [device, sessionToken, backendCode, backend] = t.mac.issued;
    const vaulted = [...t.vault.values()].join('\n');
    expect(vaulted).toContain(device);
    expect(vaulted).toContain(backend);
    expect(vaulted).not.toContain(backendCode);
    expect(t.mac.backendCodes()).toEqual([backendCode]);
    expect(t.cookies.map((c) => c.token)).toEqual([sessionToken]);
  });

  it('never sends the device token over the wire after pairing (only a one-time proof)', async () => {
    const t = createHarness();
    await pairUntilApproval(t);
    t.mac.approve();
    await until(t.root, () => t.navigations.length > 0);
    const deviceToken = t.mac.issued[0];
    const sent = t.mac.calls.map((c) => JSON.stringify({ url: c.url, body: c.body, headers: c.headers })).join('\n');
    expect(sent).not.toContain(deviceToken);
  });

  it('drops a tampered saved entry instead of navigating to it', async () => {
    const t = createHarness({ mac: { reachable: [TAILNET, 'http://100.88.1.7:3333'] } });
    await seedMac(t, KASON_MBP);
    await seedMac(t, STUDIO);
    // Another page with the bridge rewrote Preferences: a public "home network" and a bad id.
    const list = JSON.parse(t.store.get(MACS_KEY) ?? '[]');
    t.store.set(MACS_KEY, JSON.stringify([
      ...list,
      { ...KASON_MBP, id: '6f1c2a10-0000-4000-8000-000000000009', name: 'Evil', lan: '8.8.8.8', tailnet: null, lanAllowed: true },
      { ...KASON_MBP, id: '../../etc', name: 'Odd' },
    ]));
    await t.app.start();
    const names = Array.from(t.root.querySelectorAll('.mac-name')).map((n) => n.textContent);
    expect(names).toEqual(['Kason-MBP', 'Studio']);
    click(t.root, /^Kason-MBP/);
    await until(t.root, () => t.navigations.length > 0);
    expect(t.allowed.at(-1)).toEqual([TAILNET, 'http://100.88.1.7:3333']);
  });
});
