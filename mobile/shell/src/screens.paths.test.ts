// @vitest-environment jsdom
// AASC-60 Remote access: after the phone signs in to its Mac on any working path, it asks the Mac for its Tailscale
// address (POST /api/mobile/paths) and saves it only when the Mac proves it with this phone's key. A phone paired
// before Tailscale was set up then reaches the Mac from anywhere, with no pairing again.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HttpRequest, HttpRequester } from './http';
import type { HttpResponse } from './pairingClient';
import { loadMacs, type SavedMac } from './savedMacs';
import { adoptTailnet, LINK_BUDGET_MS, PATHS_BUDGET_MS, signInAndOpen, type OpenOutcome } from './shellFlows';
import { createHarness, KASON_MBP, LAN, seedMac, STUDIO, until, type Harness, type HarnessOptions } from './testing/shellHarness';

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

const NEW_ADDRESS = '100.101.102.103';
const NEW_ORIGIN = `http://${NEW_ADDRESS}:3333`;
/** The Tailscale address STUDIO has saved (and MOVED_ON, whose Mac has since moved to another). */
const OLD_ORIGIN = 'http://100.88.1.7:3333';
/** Paired before Tailscale was set up: the home network is the only way in. */
const HOME_ONLY: SavedMac = { ...KASON_MBP, tailnet: null, lanAllowed: true, lastPath: 'lan' };
/** Knows an older Tailscale address, and the home network answers. */
const MOVED_ON: SavedMac = { ...HOME_ONLY, tailnet: '100.88.1.7' };

const pathsCalls = (t: Harness) => t.mac.calls.filter((c) => c.url.endsWith('/api/mobile/paths'));
const savedTailnet = async (t: Harness) => (await loadMacs(t.deps.store))[0].tailnet;

function navigated(out: OpenOutcome): Extract<OpenOutcome, { kind: 'navigate' }> {
  if (out.kind !== 'navigate') throw new Error(`expected navigate, got ${out.kind}`);
  return out;
}

/** The phone launches with one saved Mac and opens it by itself. */
async function launch(mac: SavedMac, opts: HarnessOptions): Promise<Harness> {
  const t = createHarness(opts);
  await seedMac(t, mac);
  void t.app.start();
  await until(t.root, () => t.navigations.length > 0);
  return t;
}

/**
 * signInAndOpen on a seeded phone, with the Mac's /paths answered by `answer` (it may call `real` for the fake Mac's
 * own answer). `asked` counts the questions the phone put, whatever came back.
 */
function signInWith(t: Harness, mac: SavedMac, answer: (real: () => Promise<HttpResponse>) => Promise<HttpResponse>) {
  let asked = 0;
  const requester: HttpRequester = {
    request(req: HttpRequest) {
      if (!req.url.endsWith('/api/mobile/paths')) return t.mac.requester.request(req);
      asked += 1;
      return answer(() => t.mac.requester.request(req));
    },
  };
  return { run: signInAndOpen({ ...t.deps, requester }, [mac], mac, '/'), asked: () => asked };
}

/** The real timer, taken before any fake ones are installed. */
const realSetTimeout = globalThis.setTimeout.bind(globalThis);

/**
 * With fake timers on: let real time pass (the sign-in's WebCrypto steps need it) without moving the fake clock,
 * until `ready`. Bounded by turns, not by the clock: Date is faked too.
 */
async function settle(ready: () => boolean): Promise<void> {
  for (let i = 0; i < 3_000 && !ready(); i += 1) await new Promise<void>((resolve) => realSetTimeout(resolve, 1));
}

describe('learning the Mac’s Tailscale address at sign-in', () => {
  it('a phone paired without Tailscale saves the Mac’s address after signing in', async () => {
    const t = await launch(HOME_ONLY, { mac: { reachable: [LAN], tailnetAnswer: NEW_ADDRESS } });
    expect(t.navigations).toEqual([`${LAN}/`]); // signed in on the home network, as before
    expect(await savedTailnet(t)).toBe(NEW_ADDRESS);
    expect(pathsCalls(t)).toHaveLength(1);
  });

  it('a paths answer whose proof doesn’t match saves nothing', async () => {
    const t = await launch(HOME_ONLY, { mac: { reachable: [LAN], tailnetAnswer: NEW_ADDRESS, forgePaths: true } });
    expect(pathsCalls(t)).toHaveLength(1);
    expect(await savedTailnet(t)).toBeNull();
    expect(t.allowed.flat()).not.toContain(NEW_ORIGIN);
    expect(t.navigations).toEqual([`${LAN}/`]); // the sign-in itself is unaffected
  });

  it('a Mac without Tailscale leaves a saved address alone', async () => {
    const t = await launch(STUDIO, { mac: { reachable: [OLD_ORIGIN], tailnetAnswer: null } });
    expect(pathsCalls(t)).toHaveLength(1);
    expect(await savedTailnet(t)).toBe('100.88.1.7');
  });

  it('an answer for another port is ignored', async () => {
    const t = await launch(HOME_ONLY, { mac: { reachable: [LAN], tailnetAnswer: NEW_ADDRESS, pathsPort: 3334 } });
    expect(pathsCalls(t)).toHaveLength(1);
    expect(await savedTailnet(t)).toBeNull();
  });

  it('the new address is added to the WebView’s allowed origins', async () => {
    const t = await launch(HOME_ONLY, { mac: { reachable: [LAN], tailnetAnswer: NEW_ADDRESS } });
    expect(t.allowed.at(-1)).toEqual(expect.arrayContaining([LAN, NEW_ORIGIN]));
  });

  it('learns it over the home address the rescan just found the Mac on', async () => {
    const moved = 'http://192.168.1.57:3333';
    const t = await launch(HOME_ONLY, { mac: { reachable: [moved], tailnetAnswer: NEW_ADDRESS } });
    expect(t.navigations).toEqual([`${moved}/`]);
    expect(pathsCalls(t).map((c) => new URL(c.url).origin)).toEqual([moved]);
    expect((await loadMacs(t.deps.store))[0]).toMatchObject({ lan: '192.168.1.57', tailnet: NEW_ADDRESS });
    expect(t.cleared).toEqual([LAN]); // the old home address's session goes; no old Tailscale address to drop
  });

  it('and later reaches the Mac over Tailscale alone, with no pairing again', async () => {
    const first = await launch(HOME_ONLY, { mac: { reachable: [LAN], tailnetAnswer: NEW_ADDRESS } });
    first.mac.setReachable([NEW_ORIGIN]); // away from home: only Tailscale answers
    first.app.dispose();
    document.body.replaceChildren();
    const t = createHarness({ fakeMac: first.mac, store: Object.fromEntries(first.store), vault: Object.fromEntries(first.vault) });
    void t.app.start();
    await until(t.root, () => t.navigations.length > 0);
    expect(t.navigations).toEqual([`${NEW_ORIGIN}/`]);
    expect(t.cookies.map((c) => c.origin)).toEqual([NEW_ORIGIN]);
    expect((await loadMacs(t.deps.store))[0]).toMatchObject({ tailnet: NEW_ADDRESS, lastPath: 'tailnet' });
  });

  it('asks with the session it just opened and a nonce, and nothing else', async () => {
    const t = await launch(HOME_ONLY, { mac: { reachable: [LAN], tailnetAnswer: NEW_ADDRESS } });
    const [ask] = pathsCalls(t);
    expect(ask.method).toBe('POST');
    expect(ask.headers.Authorization).toMatch(/^Bearer sess-/);
    expect(ask.headers['Content-Type']).toBe('application/json');
    expect(Object.keys(ask.body as object)).toEqual(['nonce']);
    expect((ask.body as { nonce: string }).nonce).toMatch(/^[0-9a-f]{64}$/);
    expect(t.mac.strikes()).toBe(0);
  });

  it('asks once per sign-in, with a new nonce each time', async () => {
    const t = createHarness({ mac: { reachable: [LAN], tailnetAnswer: NEW_ADDRESS } });
    await seedMac(t, HOME_ONLY);
    const first = navigated(await signInAndOpen(t.deps, [HOME_ONLY], HOME_ONLY, '/'));
    expect(pathsCalls(t)).toHaveLength(1);
    expect(first.mac.tailnet).toBe(NEW_ADDRESS);
    navigated(await signInAndOpen(t.deps, first.macs, first.mac, '/'));
    const nonces = pathsCalls(t).map((c) => (c.body as { nonce: string }).nonce);
    expect(nonces).toHaveLength(2);
    expect(new Set(nonces).size).toBe(2);
    expect(t.mac.strikes()).toBe(0);
  });

  it.each(['pending', 'revoked'] as const)('asks nothing of a Mac that holds this phone %s', async (status) => {
    const t = createHarness({ mac: { reachable: [LAN], tailnetAnswer: NEW_ADDRESS } });
    await seedMac(t, HOME_ONLY, status);
    const out = await signInAndOpen(t.deps, [HOME_ONLY], HOME_ONLY, '/');
    expect(out.kind).toBe(status);
    expect(pathsCalls(t)).toEqual([]);
  });

  it('takes a changed address, and drops the old Tailscale address’s session', async () => {
    const t = await launch(MOVED_ON, { mac: { reachable: [LAN], tailnetAnswer: NEW_ADDRESS } });
    expect(await savedTailnet(t)).toBe(NEW_ADDRESS);
    expect(t.cleared).toEqual([OLD_ORIGIN]);
    expect(t.allowed.at(-1)).toEqual(expect.arrayContaining([LAN, NEW_ORIGIN]));
    expect(t.allowed.at(-1)).not.toContain(OLD_ORIGIN);
  });

  it('drops no session when the Mac names the address already saved', async () => {
    const t = await launch(STUDIO, { mac: { reachable: [OLD_ORIGIN], tailnetAnswer: '100.88.1.7' } });
    expect(await savedTailnet(t)).toBe('100.88.1.7');
    expect(t.cleared).toEqual([]);
  });

  it('drops no session when the Mac names none', async () => {
    const t = await launch(MOVED_ON, { mac: { reachable: [LAN], tailnetAnswer: null } });
    expect(await savedTailnet(t)).toBe('100.88.1.7');
    expect(t.cleared).toEqual([]);
  });

  // The page about to open is on the address it signed in on: a different one named now must not take it away.
  it('keeps the Tailscale address it signed in on, even if the Mac names another', async () => {
    const t = await launch(STUDIO, { mac: { reachable: [OLD_ORIGIN], tailnetAnswer: '100.88.1.9' } });
    expect(await savedTailnet(t)).toBe('100.88.1.7');
    expect(t.allowed.at(-1)).toContain(OLD_ORIGIN);
    expect(t.cleared).toEqual([]);
  });
});

// A failed question never costs the sign-in anything, and is not asked again: each one without a valid session
// costs a login strike on the Mac.
describe('a /paths that goes wrong', () => {
  it.each([
    ['a refusal', () => Promise.resolve({ status: 401, data: { error: 'Sign in first', code: 'NOT_SIGNED_IN' } })],
    ['a server error', () => Promise.resolve({ status: 500, data: {} })],
    ['a rate limit', () => Promise.resolve({ status: 429, data: { error: 'Too many attempts' } })],
    ['a dropped connection', () => Promise.reject(new Error('network unreachable'))],
    ['an answer that is not the Mac’s JSON', () => Promise.resolve({ status: 200, data: '<html>' })],
  ])('%s leaves the saved Mac as it was, is asked once, and the page still opens', async (_why, answer) => {
    const t = createHarness({ mac: { reachable: [LAN], tailnetAnswer: NEW_ADDRESS } });
    await seedMac(t, HOME_ONLY);
    const { run, asked } = signInWith(t, HOME_ONLY, answer);
    const out = navigated(await run);
    expect(out.url).toBe(`${LAN}/`);
    expect(out.mac.tailnet).toBeNull();
    expect(asked()).toBe(1);
    expect(await savedTailnet(t)).toBeNull();
  });

  it('holds the page for 3 s at most: never longer than the backend link already may', () => {
    expect(PATHS_BUDGET_MS).toBe(3_000);
    expect(PATHS_BUDGET_MS).toBeLessThanOrEqual(LINK_BUDGET_MS);
  });

  it('a /paths answer slower than PATHS_BUDGET_MS doesn’t hold the page', async () => {
    const t = createHarness({ mac: { reachable: [LAN], tailnetAnswer: NEW_ADDRESS } });
    await seedMac(t, HOME_ONLY);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.useFakeTimers();
    const { run, asked } = signInWith(t, HOME_ONLY, async (real) => {
      const answer = await real(); // the Mac answers (the fake logs it), but the answer is held on the way
      await held;
      return answer;
    });
    let done = false;
    void run.then(() => {
      done = true;
    });
    await settle(() => asked() === 1); // the question is out, so the budget is running
    await vi.advanceTimersByTimeAsync(PATHS_BUDGET_MS - 1);
    expect(done).toBe(false); // it waits for the answer while there is time
    await vi.advanceTimersByTimeAsync(1);
    await settle(() => done);
    expect(done).toBe(true); // and then goes on without it
    const out = navigated(await run);
    expect(out.url).toBe(`${LAN}/`);
    expect(out.mac.tailnet).toBeNull();

    release(); // the answer (a good one) arrives after the page has opened: dropped
    vi.useRealTimers();
    await new Promise((resolve) => setTimeout(resolve, 50)); // real time for the late proof check to run
    expect(await savedTailnet(t)).toBeNull();
    expect(asked()).toBe(1);
  });

  it('asks at the same time as the backend link: opening waits for the slower of the two, not for both', async () => {
    const t = createHarness({ mac: { reachable: [LAN], tailnetAnswer: NEW_ADDRESS } });
    await seedMac(t, HOME_ONLY);
    t.mac.setBackendHang(true); // the link runs out its whole LINK_BUDGET_MS
    vi.useFakeTimers();
    const { run, asked } = signInWith(t, HOME_ONLY, () => new Promise<HttpResponse>(() => undefined)); // /paths never answers
    let done = false;
    void run.then(() => {
      done = true;
    });
    await settle(() => asked() === 1);
    await vi.advanceTimersByTimeAsync(LINK_BUDGET_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await settle(() => done);
    expect(done).toBe(true); // after 5 s, not 5 s plus 3 s
    expect(navigated(await run).mac.tailnet).toBeNull();
  });
});

describe('adoptTailnet', () => {
  const saved = { ...KASON_MBP, tailnet: '100.88.1.7' };
  const bare = { ...KASON_MBP, tailnet: null };
  it.each([
    ['nothing proven', bare, null, null],
    ['no Tailscale address on that Mac (a saved one is never erased)', saved, { tailnet: null, port: 3333 }, null],
    ['another port', bare, { tailnet: NEW_ADDRESS, port: 3334 }, null],
    ['the address already saved', saved, { tailnet: '100.88.1.7', port: 3333 }, null],
    ['an address Tailscale never hands out', bare, { tailnet: '192.168.1.9', port: 3333 }, null],
    ['an address for a Mac that had none', bare, { tailnet: NEW_ADDRESS, port: 3333 }, NEW_ADDRESS],
    ['a changed address', saved, { tailnet: NEW_ADDRESS, port: 3333 }, NEW_ADDRESS],
  ])('%s', (_why, mac, paths, expected) => {
    expect(adoptTailnet(mac, paths)).toBe(expected);
  });
});
