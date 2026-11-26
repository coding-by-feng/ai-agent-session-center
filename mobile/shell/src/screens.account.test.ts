// @vitest-environment jsdom
// Plan 17: Sign in with Google on the pair screen, and the account's Macs in Your computers.
import { afterEach, describe, expect, it } from 'vitest';
import { ACCOUNT_PREFS_KEY, ACCOUNT_VAULT_KEY, currentAccount, matchCode } from './accountSignIn';
import { LOCK_SETTINGS_KEY } from './lockGate';
import type { ShellTiming } from './app';
import type { AuthSessionResult } from './native';
import { loadMacs, MACS_KEY } from './savedMacs';
import { buttonNamed, click, createHarness, heading, KASON_MBP, LAN, seedMac, TAILNET, until, type Harness, type HarnessOptions } from './testing/shellHarness';

afterEach(() => {
  document.body.replaceChildren();
});

const text = (t: { root: HTMLElement }) => t.root.textContent ?? '';

/** Sign in with Google, past the match-code step (review M2). */
async function signIn(t: ReturnType<typeof createHarness>) {
  click(t.root, 'Sign in with Google');
  await until(t.root, () => heading(t.root) === 'Check this code');
  click(t.root, 'Continue');
}

async function signInFromPair(t: ReturnType<typeof createHarness>) {
  await t.app.start();
  await signIn(t);
  await until(t.root, () => heading(t.root) === 'Your computers' && text(t).includes('Kason-MBP'));
}

describe('Sign in with Google', () => {
  it('shows only where the app has the sign-in sheet, first on the pair screen', async () => {
    const without = createHarness({ scan: async () => null });
    await without.app.start();
    expect(buttonNamed(without.root, 'Sign in with Google')).toBeNull();
    expect(buttonNamed(without.root, 'Scan the QR code')?.className).toContain('btn-primary');
    document.body.replaceChildren();

    const t = createHarness({ authSession: true, scan: async () => null });
    await t.app.start();
    const google = buttonNamed(t.root, 'Sign in with Google')!;
    expect(google.className).toContain('btn-primary');
    expect(buttonNamed(t.root, 'Scan the QR code')?.className).toContain('btn-secondary');
    const all = Array.from(t.root.querySelectorAll('button'));
    expect(all.indexOf(google)).toBeLessThan(all.indexOf(buttonNamed(t.root, 'Scan the QR code')!));
  });

  it('is the only primary action on the pair screen, even without a scanner', async () => {
    const t = createHarness({ authSession: true });
    await t.app.start();
    expect(Array.from(t.root.querySelectorAll('.btn-primary')).map((b) => b.textContent?.trim())).toEqual(['Sign in with Google']);
  });

  it('signs in, then lists the account’s Mac with its email and Connect', async () => {
    const t = createHarness({ authSession: true });
    await signInFromPair(t);
    expect(text(t)).toContain('owner@example.com');
    expect(buttonNamed(t.root, 'Connect to Kason-MBP')).not.toBeNull();
    // Nothing secret in what the screen holds.
    const shown = JSON.stringify(t.app.current()) + text(t);
    for (const s of t.mac.issued) expect(shown).not.toContain(s);
  });

  it('Connect enrolls this phone and opens the Mac the normal way', async () => {
    const t = createHarness({ authSession: true });
    await signInFromPair(t);
    click(t.root, 'Connect to Kason-MBP');
    await until(t.root, () => t.navigations.length > 0);
    expect(t.navigations).toEqual([`${TAILNET}/`]);
    expect(t.cookies.map((c) => c.origin)).toEqual([TAILNET]);
    const [saved] = await loadMacs(t.deps.store);
    expect(saved).toMatchObject({ name: 'Kason-MBP', status: 'active', backendDeviceId: '7d3e9a2c-1b4f-4c6d-8e2f-3a5b6c7d8e9f', tailnet: '100.101.102.103' });
    expect(t.mac.enrolled()).toHaveLength(1);
  });

  it('a cancelled sign-in stays on the pair screen and says nothing was saved', async () => {
    const t = createHarness({ authSession: async () => ({ cancelled: true }) });
    await t.app.start();
    await signIn(t);
    await until(t.root, () => text(t).includes('Sign-in cancelled'));
    expect(heading(t.root)).toBe('Pair with a Mac');
    expect(text(t)).toContain('Nothing was saved');
    expect(t.store.has(ACCOUNT_PREFS_KEY)).toBe(false);
  });

  it('a sign-in whose state doesn’t match is refused with a short alert', async () => {
    const t = createHarness({ authSession: async (_u, redirect) => ({ url: redirect!.replace(/state=[^&]+/, 'state=x') }) });
    await t.app.start();
    await signIn(t);
    await until(t.root, () => t.root.querySelector('[role="alert"]') !== null);
    expect(t.root.querySelector('[role="alert"]')?.textContent).toContain('didn’t match');
    expect(t.vault.has(ACCOUNT_VAULT_KEY)).toBe(false);
  });
});

describe('Check this code (review M2)', () => {
  it('shows the code for the challenge before the sheet opens; Continue opens it with that same challenge', async () => {
    const t = createHarness({ authSession: true });
    await t.app.start();
    click(t.root, 'Sign in with Google');
    await until(t.root, () => heading(t.root) === 'Check this code');
    expect(t.extras.authStarts).toHaveLength(0);
    const shown = t.root.querySelector('.code')?.textContent ?? '';
    expect(shown).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/);
    expect(text(t)).toContain('You’ll see the same code on the next page. Continue only if they match.');
    expect(buttonNamed(t.root, 'Continue')?.className).toContain('btn-primary');
    expect(buttonNamed(t.root, 'Cancel')?.className).not.toContain('btn-primary');
    const screenState = t.app.current() as { name: string; code?: string };
    expect(screenState).toMatchObject({ name: 'account-match', code: shown });
    expect(JSON.stringify(screenState)).not.toMatch(/verifier|[A-Za-z0-9_-]{43}/); // no verifier, challenge or state in the screen
    click(t.root, 'Continue');
    await until(t.root, () => heading(t.root) === 'Your computers');
    expect(t.extras.authStarts).toHaveLength(1);
    expect(await matchCode(new URL(t.extras.authStarts[0].url).searchParams.get('c')!)).toBe(shown);
  });

  it('Cancel opens nothing and goes back to the pair screen', async () => {
    const t = createHarness({ authSession: true });
    await t.app.start();
    click(t.root, 'Sign in with Google');
    await until(t.root, () => heading(t.root) === 'Check this code');
    click(t.root, 'Cancel');
    expect(heading(t.root)).toBe('Pair with a Mac');
    expect(t.extras.authStarts).toHaveLength(0);
    expect(t.mac.calls).toHaveLength(0);
  });

  it('each new sign-in gets a new challenge and code; a cancelled one is never reused', async () => {
    const t = createHarness({ authSession: true });
    await t.app.start();
    const codes: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      click(t.root, 'Sign in with Google');
      await until(t.root, () => heading(t.root) === 'Check this code');
      codes.push(t.root.querySelector('.code')?.textContent ?? '');
      click(t.root, 'Cancel');
    }
    expect(new Set(codes).size).toBeGreaterThan(1);
  });
});

describe('Your computers with an account', () => {
  it('opens on the account’s Macs at launch when signed in with none saved', async () => {
    const first = createHarness({ authSession: true });
    await signInFromPair(first);
    document.body.replaceChildren();
    const t = createHarness({
      authSession: true, fakeMac: first.mac,
      store: Object.fromEntries(first.store), vault: Object.fromEntries(first.vault),
    });
    await t.app.start();
    await until(t.root, () => buttonNamed(t.root, 'Connect to Kason-MBP') !== null);
    expect(heading(t.root)).toBe('Your computers');
  });

  it('leaves out an account Mac already saved here', async () => {
    const t = createHarness({ authSession: true, search: '?tap=1' });
    await seedMac(t, { ...KASON_MBP, backendDeviceId: '7d3e9a2c-1b4f-4c6d-8e2f-3a5b6c7d8e9f' });
    await t.app.start();
    click(t.root, 'Pair another computer');
    await signIn(t);
    await until(t.root, () => heading(t.root) === 'Your computers' && text(t).includes('owner@example.com'));
    await until(t.root, () => text(t).includes('Every computer on your account is on this phone'));
    expect(buttonNamed(t.root, 'Connect to Kason-MBP')).toBeNull();
    expect(t.root.querySelectorAll('.mac')).toHaveLength(1);
  });

  // The Mac drops an account phone that opens no /session within 2 minutes (an app suspended that long, say).
  it('an account row the Mac dropped before its first session goes, and the Mac is back with Connect', async () => {
    const t = createHarness({ authSession: true });
    await signInFromPair(t);
    const post = t.mac.http.post.bind(t.mac.http);
    t.mac.http.post = async (url: string, body: unknown) => {
      const res = await post(url, body);
      if (url.endsWith('/api/mobile/enroll') && res.status === 201) for (const id of t.mac.enrolled()) t.mac.devices.delete(id);
      return res;
    };
    click(t.root, 'Connect to Kason-MBP');
    await until(t.root, () => text(t).includes('didn’t finish connecting'));
    expect(text(t)).toContain('Kason-MBP didn’t finish connecting. Tap Connect to try again.');
    expect(heading(t.root)).toBe('Your computers');
    expect(buttonNamed(t.root, 'Connect to Kason-MBP')).not.toBeNull();
    expect(await loadMacs(t.deps.store)).toEqual([]);
    expect([...t.vault.keys()].filter((k) => k !== ACCOUNT_VAULT_KEY)).toEqual([]);
    expect(t.navigations).toEqual([]);
  });

  it('an account row that has had its first session is an ordinary row after that', async () => {
    const t = createHarness({ authSession: true });
    await signInFromPair(t);
    click(t.root, 'Connect to Kason-MBP');
    await until(t.root, () => t.navigations.length > 0);
    const [saved] = await loadMacs(t.deps.store);
    expect(saved).not.toHaveProperty('unconfirmed');
    expect(JSON.parse(t.store.get(MACS_KEY) ?? '[]')[0]).not.toHaveProperty('unconfirmed');
  });

  it('a code-paired row the Mac removed keeps today’s words, even when signed in to the account', async () => {
    const t = createHarness({ authSession: true, search: '?tap=1' });
    await seedMac(t, { ...KASON_MBP, backendDeviceId: '7d3e9a2c-1b4f-4c6d-8e2f-3a5b6c7d8e9f' }, 'revoked');
    await t.app.start();
    click(t.root, 'Pair another computer');
    await signIn(t);
    await until(t.root, () => heading(t.root) === 'Your computers' && text(t).includes('owner@example.com'));
    click(t.root, /^Kason-MBP/);
    await until(t.root, () => text(t).includes('removed this phone'));
    expect(text(t)).toContain('Kason-MBP removed this phone. Pair again to use it.');
    expect(text(t)).not.toContain('didn’t finish connecting');
  });

  it('Sign out from the account menu forgets the account; saved Macs stay', async () => {
    const t = createHarness({ authSession: true });
    await signInFromPair(t);
    const menu = buttonNamed(t.root, 'AASC Cloud account')!;
    expect(menu.getAttribute('aria-expanded')).toBe('false');
    click(t.root, 'AASC Cloud account');
    expect(buttonNamed(t.root, 'AASC Cloud account')?.getAttribute('aria-expanded')).toBe('true');
    click(t.root, 'Sign out of AASC Cloud');
    await until(t.root, () => heading(t.root) === 'Pair with a Mac');
    expect(text(t)).toContain('Signed out of AASC Cloud');
    expect(t.vault.has(ACCOUNT_VAULT_KEY)).toBe(false);
    expect(buttonNamed(t.root, 'Sign in with Google')).not.toBeNull();
  });

  it('a 401 for the list signs the phone out', async () => {
    const t = createHarness({ authSession: true });
    await signInFromPair(t);
    t.mac.account.revokeDevice(t.mac.account.devices()[0]);
    click(t.root, 'Pair with a QR code');
    expect(buttonNamed(t.root, 'Sign in with Google')).toBeNull(); // signed in: no second sign-in offered
    click(t.root, 'Your computers');
    await until(t.root, () => heading(t.root) === 'Pair with a Mac');
    expect(t.vault.has(ACCOUNT_VAULT_KEY)).toBe(false);
  });

  it('a Mac nothing reaches shows Offline with Try again, and saves nothing', async () => {
    const t = createHarness({ authSession: true, mac: { reachable: [] } });
    await signInFromPair(t);
    click(t.root, 'Connect to Kason-MBP');
    await until(t.root, () => text(t).includes('Offline'), 8_000);
    expect(buttonNamed(t.root, 'Try connecting to Kason-MBP again')).not.toBeNull();
    expect(text(t)).toContain('Nothing was saved');
    expect(t.store.get(MACS_KEY) ?? '[]').toBe('[]');
  }, 10_000);

  it('a Mac with account sign-ins off says where to turn them on', async () => {
    const t = createHarness({ authSession: true });
    await signInFromPair(t);
    t.mac.setAccountEnroll(false);
    click(t.root, 'Connect to Kason-MBP');
    await until(t.root, () => t.root.querySelector('[role="alert"]') !== null);
    expect(t.root.querySelector('[role="alert"]')?.textContent).toContain('devices panel');
    expect(heading(t.root)).toBe('Your computers');
  });

  it('Android: the sign-in App Link reaching appUrlOpen mid sign-in is ignored, and the sign-in still lands', async () => {
    let t!: ReturnType<typeof createHarness>;
    t = createHarness({
      authSession: async (_url, redirect) => {
        t.openLink(redirect!); // the same App Link also arrives at @capacitor/app appUrlOpen
        return { url: redirect! };
      },
    });
    await t.app.start();
    await signIn(t);
    await until(t.root, () => heading(t.root) === 'Your computers' && text(t).includes('owner@example.com'));
    expect(text(t)).not.toContain('pairing link');
  });

  it('a cold start whose launch URL is the sign-in App Link opens normally, without a link error', async () => {
    const t = createHarness({ authSession: true, launchUrl: 'https://aasc.work/auth/google?code=AAAAAAAAAAAAAAAAAAAAAA&state=x' });
    await t.app.start();
    expect(heading(t.root)).toBe('Pair with a Mac');
    expect(text(t)).not.toContain('pairing link. It starts');
    expect(t.root.querySelector('[aria-invalid="true"]')).toBeNull();
    expect(t.mac.calls).toHaveLength(0);
  });
});

// Android: the sheet is another activity, so the app pauses and resumes around it, and the lock can come up on the
// way back. The answer then lands behind the lock, or on the waiting screen the lock gives back.
describe('the lock coming up while the sign-in sheet is open', () => {
  const lockAtOnce = { [LOCK_SETTINGS_KEY]: JSON.stringify({ enabled: true, relockAfterMinutes: 0 }) };
  const pairAsked = (t: Harness) => t.mac.calls.some((c) => c.url.endsWith('/v1/devices/pair'));
  const waiting = (t: Harness) => text(t).includes('Waiting for the sign-in page');

  /** From the pair screen with the lock on: the sheet comes back, as `end` says, once the lock is up. */
  async function signInBehindLock(end: (redirect: string, t: Harness) => AuthSessionResult): Promise<Harness> {
    const t: Harness = createHarness({
      biometric: { available: true, pass: true }, store: lockAtOnce,
      authSession: async (_url, redirect) => {
        t.extras.pause!();
        await new Promise((r) => setTimeout(r, 5));
        t.extras.resume!();
        await until(t.root, () => heading(t.root) === 'AASC is locked');
        return end(redirect!, t);
      },
    });
    await t.app.start();
    click(t.root, 'Unlock');
    await until(t.root, () => heading(t.root) === 'Pair with a Mac');
    await signIn(t);
    return t;
  }

  it('a sign-in that finished behind the lock: the unlock lands on Your computers, signed in', async () => {
    const t = await signInBehindLock((redirect) => ({ url: redirect }));
    await until(t.root, () => t.vault.has(ACCOUNT_VAULT_KEY)); // stored while locked
    expect(heading(t.root)).toBe('AASC is locked');
    click(t.root, 'Unlock');
    await until(t.root, () => heading(t.root) === 'Your computers' && text(t).includes('Signed in as owner@example.com'));
    await until(t.root, () => buttonNamed(t.root, 'Connect to Kason-MBP') !== null);
    expect(waiting(t)).toBe(false);
  });

  it('a sign-in that finishes after the unlock, back on the waiting screen, lands on Your computers too', async () => {
    let release: () => void = () => undefined;
    const t = await signInBehindLock((redirect, h) => {
      release = h.mac.holdNextBackendRequest();
      return { url: redirect };
    });
    await until(t.root, () => pairAsked(t)); // the code is being redeemed, and held
    click(t.root, 'Unlock');
    await until(t.root, () => heading(t.root) === 'Check this code');
    expect(waiting(t)).toBe(true);
    release();
    await until(t.root, () => heading(t.root) === 'Your computers' && text(t).includes('Signed in as owner@example.com'));
  });

  it('a sheet closed behind the lock: the unlock lands back on the pair screen, saying nothing was saved', async () => {
    const t = await signInBehindLock(() => ({ cancelled: true }));
    await new Promise((r) => setTimeout(r, 20)); // the answer lands behind the lock
    expect(heading(t.root)).toBe('AASC is locked');
    click(t.root, 'Unlock');
    await until(t.root, () => heading(t.root) === 'Pair with a Mac');
    expect(text(t)).toContain('Sign-in cancelled. Nothing was saved.');
    expect(waiting(t)).toBe(false);
    expect(buttonNamed(t.root, 'Sign in with Google')?.disabled).toBe(false);
    expect(t.vault.has(ACCOUNT_VAULT_KEY)).toBe(false);
  });

  it('a sign-in that failed behind the lock: the unlock lands back on the pair screen with why', async () => {
    const t = await signInBehindLock((redirect) => ({ url: redirect.replace(/state=[^&]+/, 'state=x') }));
    await new Promise((r) => setTimeout(r, 20));
    expect(heading(t.root)).toBe('AASC is locked');
    click(t.root, 'Unlock');
    await until(t.root, () => heading(t.root) === 'Pair with a Mac');
    expect(t.root.querySelector('[role="alert"]')?.textContent).toContain('didn’t match');
    expect(waiting(t)).toBe(false);
    expect(t.vault.has(ACCOUNT_VAULT_KEY)).toBe(false);
  });
});

// A locked keychain: the token is there but can't be read. Never the same as a missing token (Nov 17 2026).
describe('a sign-in this phone can’t read right now', () => {
  // Nothing goes to AASC Cloud. The list's own "does it answer" check of each computer (macReach.ts, Nov 27 2026)
  // is the GET /api/auth/status opening one starts with, so it isn't counted.
  const requests = (t: Harness) => t.mac.calls.filter((c) => !(c.method === 'GET' && c.url.endsWith('/api/auth/status'))).length;

  it('is not a sign-out when the list refreshes: nothing is asked, the account and its Macs stay on show', async () => {
    const t = createHarness({ authSession: true });
    await signInFromPair(t);
    t.mac.calls.length = 0;
    t.faults.vaultRead = true;
    click(t.root, 'Pair with a QR code');
    click(t.root, 'Your computers');
    await new Promise((r) => setTimeout(r, 50));
    expect(heading(t.root)).toBe('Your computers');
    expect(text(t)).toContain('Signed in as owner@example.com');
    expect(text(t)).not.toContain('signed this phone out');
    expect(buttonNamed(t.root, 'Connect to Kason-MBP')).not.toBeNull();
    expect(requests(t)).toBe(0);
    t.faults.vaultRead = false;
    expect(t.vault.has(ACCOUNT_VAULT_KEY)).toBe(true);
    expect(await currentAccount(t.deps)).not.toBeNull();
  });

  it('says so in place of the list, with Try again, and lists again once it can be read', async () => {
    const t = createHarness({ authSession: true, mac: { account: { macs: [] } } });
    await t.app.start();
    await signIn(t);
    await until(t.root, () => heading(t.root) === 'Your computers' && text(t).includes('No computers on your account yet'));
    t.mac.calls.length = 0;
    t.faults.vaultRead = true;
    click(t.root, 'Pair with a QR code');
    click(t.root, 'Your computers');
    await until(t.root, () => text(t).includes('This phone can’t read its sign-in right now. Unlock it and try again.'));
    expect(text(t)).toContain('Signed in as owner@example.com');
    expect(text(t)).not.toContain('signed this phone out');
    expect(text(t)).not.toContain('Couldn’t reach AASC Cloud');
    expect(requests(t)).toBe(0);
    t.faults.vaultRead = false;
    click(t.root, 'Try again');
    await until(t.root, () => text(t).includes('No computers on your account yet'));
    expect(requests(t)).toBe(1);
  });

  it('is not a sign-out when connecting to an account Mac: the row says why, nothing is asked', async () => {
    const t = createHarness({ authSession: true });
    await signInFromPair(t);
    t.mac.calls.length = 0;
    t.faults.vaultRead = true;
    click(t.root, 'Connect to Kason-MBP');
    await until(t.root, () => t.root.querySelector('[role="alert"]') !== null);
    expect(t.root.querySelector('[role="alert"]')?.textContent).toContain('This phone can’t read its sign-in right now. Unlock it and try again.');
    expect(heading(t.root)).toBe('Your computers');
    expect(text(t)).toContain('Signed in as owner@example.com');
    expect(buttonNamed(t.root, 'Try connecting to Kason-MBP again')).not.toBeNull();
    expect(requests(t)).toBe(0);
    t.faults.vaultRead = false;
    expect(t.vault.has(ACCOUNT_VAULT_KEY)).toBe(true);
  });
});

describe('a sign-in whose email can’t be stored', () => {
  it('leaves no token behind and shows nobody signed in', async () => {
    const t = createHarness({ authSession: true });
    const set = t.deps.store.set.bind(t.deps.store);
    t.deps.store.set = async (key, value) => {
      if (key === ACCOUNT_PREFS_KEY) throw new Error('preferences unavailable');
      return set(key, value);
    };
    await t.app.start();
    await signIn(t);
    await until(t.root, () => t.root.querySelector('[role="alert"]') !== null);
    expect(heading(t.root)).toBe('Pair with a Mac');
    expect(t.root.querySelector('[role="alert"]')?.textContent).toContain('nothing was saved');
    expect(t.vault.has(ACCOUNT_VAULT_KEY)).toBe(false);
    expect(await currentAccount(t.deps)).toBeNull();
    expect(text(t)).not.toContain('Signed in as');
    expect(buttonNamed(t.root, 'Sign in with Google')).not.toBeNull();
  });
});

// Plan 18: the account's directory (GET /v1/machines) may hint at a Mac's home-network address, which Bonjour was
// the only source of before. The hint is asked for once the list is on show, changes no row, and is used only when
// the Mac's Tailscale address does not answer. The account-enroll flow asks no home-network question either way (it
// never did): it names the home network while it tries, and a Mac reached that way is saved with the home network
// on, which Your computers then marks unencrypted.
describe('an account Mac and the directory’s home-network hint', () => {
  const MBP = '7d3e9a2c-1b4f-4c6d-8e2f-3a5b6c7d8e9f';
  const HOME = new URL(LAN).hostname;
  const MACHINES = 'https://api.aasc.work/v1/machines';
  const withHint = { macs: [{ deviceId: MBP, name: 'Kason-MBP', lan: HOME, tailnet: '100.101.102.103', port: 3333 }] };
  const urls = (t: Harness) => t.mac.calls.map((c) => c.url);

  /**
   * Each GET /v1/machines waits for its gate (one that never opens: a directory that does not answer); everything
   * else goes through. Returns the directory requests the phone has made so far.
   */
  function holdDirectory(t: Harness, gate: Promise<void> | (() => Promise<void>)): string[] {
    const real = t.deps.requester.request.bind(t.deps.requester);
    const asked: string[] = [];
    t.deps.requester.request = async (req) => {
      if (req.url === MACHINES) {
        asked.push(req.url);
        await (typeof gate === 'function' ? gate() : gate);
      }
      return real(req);
    };
    return asked;
  }

  it.each<[string, HarnessOptions]>([
    ['found by Bonjour', {
      mac: { reachable: [LAN], account: { macs: [{ deviceId: MBP, name: 'Kason-MBP', tailnet: null, port: 3333 }] } },
      discovery: async () => ({ services: [{ host: HOME, port: 3333 }], local: ['192.168.1.5'] }),
    }],
    ['hinted by the directory', {
      mac: { reachable: [LAN], account: { macs: [{ deviceId: MBP, name: 'Kason-MBP', lan: HOME, tailnet: null, port: 3333 }] } },
    }],
  ])('%s: the same words while trying, no question asked, the same row saved', async (_how, opts) => {
    const t = createHarness({ authSession: true, ...opts });
    await signInFromPair(t);
    const shown: string[] = [];
    const watch = new MutationObserver(() => {
      shown.push(`${t.root.dataset.screen}: ${text(t)}`);
    });
    watch.observe(t.root, { childList: true, subtree: true, characterData: true, attributes: true });
    click(t.root, 'Connect to Kason-MBP');
    await until(t.root, () => t.navigations.length > 0);
    watch.disconnect();
    expect(shown.some((s) => s.includes(`Trying Home network (${HOME}:3333)…`))).toBe(true);
    expect(shown.some((s) => s.startsWith('lan-offer') || s.includes('Use the home network?'))).toBe(false);
    expect(t.navigations).toEqual([`${LAN}/`]);
    expect(t.cookies.map((c) => c.origin)).toEqual([LAN]);
    const [saved] = await loadMacs(t.deps.store);
    expect(saved).toMatchObject({ name: 'Kason-MBP', status: 'active', backendDeviceId: MBP, lan: HOME, tailnet: null, lanAllowed: true, lastPath: 'lan' });
    expect(t.mac.enrolled()).toHaveLength(1);
  });

  it('asks the directory once, after the list, and the row on show does not change', async () => {
    const t = createHarness({ authSession: true, mac: { account: withHint } });
    await signInFromPair(t);
    const lists = urls(t).filter((u) => u.startsWith('https://api.aasc.work/v1/enroll/macs') || u === MACHINES);
    expect(lists).toEqual(['https://api.aasc.work/v1/enroll/macs', MACHINES]);
    expect(text(t)).toContain('Kason-MBP');
    expect(text(t)).not.toContain(HOME); // an address hint is not something a row shows
    expect(Array.from(t.root.querySelectorAll('.mac-name')).map((n) => n.textContent)).toEqual(['Kason-MBP']);
  });

  it('asks no directory when every Mac on the account is already saved here: no row is left that a hint could serve', async () => {
    const t = createHarness({ authSession: true, search: '?tap=1', mac: { account: withHint } });
    await seedMac(t, { ...KASON_MBP, backendDeviceId: MBP });
    await t.app.start();
    click(t.root, 'Pair another computer');
    await signIn(t);
    await until(t.root, () => text(t).includes('Every computer on your account is on this phone'));
    await new Promise((r) => setTimeout(r, 20));
    expect(urls(t)).toContain('https://api.aasc.work/v1/enroll/macs');
    expect(urls(t)).not.toContain(MACHINES);
  });

  it('Tailscale answers: the hint is never dialled, and the Mac is saved as it was before the hint existed', async () => {
    const t = createHarness({ authSession: true, mac: { reachable: [TAILNET, LAN], account: withHint } });
    await signInFromPair(t);
    click(t.root, 'Connect to Kason-MBP');
    await until(t.root, () => t.navigations.length > 0);
    expect(t.navigations).toEqual([`${TAILNET}/`]);
    expect(urls(t).filter((u) => u.startsWith(LAN))).toEqual([]); // not even a probe
    const [saved] = await loadMacs(t.deps.store);
    expect(saved).toMatchObject({ lan: null, tailnet: '100.101.102.103', lanAllowed: false, lastPath: 'tailnet' });
  });

  it('Tailscale does not answer: the hinted home address is what reaches the Mac', async () => {
    const t = createHarness({ authSession: true, mac: { reachable: [LAN], account: withHint } });
    await signInFromPair(t);
    click(t.root, 'Connect to Kason-MBP');
    await until(t.root, () => t.navigations.length > 0);
    expect(t.navigations).toEqual([`${LAN}/`]);
    const [saved] = await loadMacs(t.deps.store);
    expect(saved).toMatchObject({ lan: HOME, tailnet: null, lanAllowed: true, lastPath: 'lan' });
  });

  it.each<['forbidden' | 'absent']>([['forbidden'], ['absent']])('a %s directory: the list and Connect are what they were', async (directory) => {
    const t = createHarness({ authSession: true, mac: { reachable: [TAILNET, LAN], account: { ...withHint, directory } } });
    await signInFromPair(t);
    click(t.root, 'Connect to Kason-MBP');
    await until(t.root, () => t.navigations.length > 0);
    expect(t.navigations).toEqual([`${TAILNET}/`]);
    expect(await currentAccount(t.deps)).not.toBeNull();
  });

  it('a directory that never answers does not hold the list back: the Macs are on show while it is still asked', async () => {
    const t = createHarness({ authSession: true, mac: { account: withHint } });
    const asked = holdDirectory(t, new Promise<void>(() => undefined));
    await signInFromPair(t); // "Kason-MBP" is listed
    expect(buttonNamed(t.root, 'Connect to Kason-MBP')?.disabled).toBe(false);
    expect(asked).toEqual([MACHINES]); // asked once, and still waiting
    expect(urls(t)).not.toContain(MACHINES);
  });

  it('Connect tapped while the hint is on its way waits for it, then uses it', async () => {
    let release: () => void = () => undefined;
    const t = createHarness({ authSession: true, mac: { reachable: [LAN], account: withHint } });
    holdDirectory(t, new Promise<void>((resolve) => { release = resolve; }));
    await signInFromPair(t);
    // The list's own "does it answer" check of the row (macReach.ts) is done first; only Connect's dialling counts.
    await until(t.root, () => t.root.querySelector('[data-reach]') !== null);
    t.mac.calls.length = 0;
    click(t.root, 'Connect to Kason-MBP');
    await until(t.root, () => text(t).includes('Looking for Kason-MBP…'));
    await new Promise((r) => setTimeout(r, 30));
    expect(urls(t).filter((u) => u.startsWith(LAN) || u.startsWith(TAILNET))).toEqual([]); // nothing dialled yet
    release();
    await until(t.root, () => t.navigations.length > 0);
    expect(t.navigations).toEqual([`${LAN}/`]);
  });

  // The hint may never come. Connect waits for it no longer than the limit (3 s on a phone; short here), whatever
  // the step is stuck on, and then goes on with the list as it was.
  describe('Connect while the hint never arrives', () => {
    const QUICK: ShellTiming = { pollMs: 5, pollMaxMs: 60_000, hintsMs: 40 };
    const unhinted = { macs: [{ deviceId: MBP, name: 'Kason-MBP', tailnet: '100.101.102.103', port: 3333 }] };
    const lines = (t: Harness) => t.mac.calls.map((c) => `${c.method} ${c.url}`);
    const tryAgain = 'Try connecting to Kason-MBP again';

    /** At home with Tailscale silent, where only the hint could reach the Mac: tap Connect and wait for the row to settle. */
    async function connectAtHome(t: Harness): Promise<string[]> {
      await new Promise((r) => setTimeout(r, 10)); // the list's own directory request, where it is answered, is done
      t.mac.calls.length = 0;
      click(t.root, 'Connect to Kason-MBP');
      expect(lines(t)).toEqual([]); // nothing is dialled before the hint has had its time
      await until(t.root, () => buttonNamed(t.root, tryAgain)?.disabled === false);
      return lines(t);
    }

    it('the directory never answers: Connect goes on at the limit, unhinted, with exactly an unhinted Connect’s requests', async () => {
      const plain = createHarness({ authSession: true, timing: QUICK, mac: { reachable: [LAN], account: unhinted } });
      await signInFromPair(plain);
      const without = await connectAtHome(plain);
      expect(without).toEqual([`GET ${TAILNET}/api/auth/status`]); // Tailscale is silent, and there is no other address
      expect(text(plain)).toContain('Offline');
      document.body.replaceChildren();

      let answerLate: () => void = () => undefined;
      const t = createHarness({ authSession: true, timing: QUICK, mac: { reachable: [LAN], account: withHint } });
      const asked = holdDirectory(t, new Promise<void>((resolve) => { answerLate = resolve; }));
      await signInFromPair(t);
      expect(asked).toEqual([MACHINES]); // on its way, and it stays that way
      expect(await connectAtHome(t)).toEqual(without);
      expect(text(t)).toContain('Offline');
      expect(t.store.get(MACS_KEY) ?? '[]').toBe('[]');

      // The answer comes after all, with the hint that would have reached the Mac: nothing changes.
      answerLate();
      await until(t.root, () => lines(t).includes(`GET ${MACHINES}`));
      await new Promise((r) => setTimeout(r, 20));
      expect(text(t)).toContain('Offline');
      expect(t.navigations).toEqual([]);
      click(t.root, tryAgain);
      await until(t.root, () => lines(t).filter((l) => l === `GET ${TAILNET}/api/auth/status`).length === 2 && buttonNamed(t.root, tryAgain)?.disabled === false);
      expect(lines(t).filter((l) => l.includes(LAN))).toEqual([]); // the late hint was never taken up
      expect(t.store.get(MACS_KEY) ?? '[]').toBe('[]');
      expect(asked).toEqual([MACHINES]);
    });

    it('the directory never answers and Tailscale works: Connect goes on at the limit, over Tailscale as before', async () => {
      const t = createHarness({ authSession: true, timing: QUICK, mac: { reachable: [TAILNET, LAN], account: withHint } });
      holdDirectory(t, new Promise<void>(() => undefined));
      await signInFromPair(t);
      click(t.root, 'Connect to Kason-MBP');
      await until(t.root, () => t.navigations.length > 0);
      expect(t.navigations).toEqual([`${TAILNET}/`]);
      expect(urls(t).filter((u) => u.startsWith(LAN))).toEqual([]);
    });

    it('the phone’s own vault hangs while the hint is read (it does not throw): Connect goes on at the limit too', async () => {
      const t = createHarness({ authSession: true, timing: QUICK, mac: { reachable: [TAILNET, LAN], account: withHint } });
      // The first read of the account token after the list was asked is the hint step's: that one never answers.
      let armed = false;
      const request = t.deps.requester.request.bind(t.deps.requester);
      t.deps.requester.request = async (req) => {
        if (req.url.endsWith('/v1/enroll/macs')) armed = true;
        return request(req);
      };
      const get = t.deps.vault.get.bind(t.deps.vault);
      let hung = 0;
      t.deps.vault.get = (key) => {
        if (!armed || key !== ACCOUNT_VAULT_KEY) return get(key);
        armed = false;
        hung += 1;
        return new Promise<string | null>(() => undefined);
      };
      await signInFromPair(t);
      expect(hung).toBe(1);
      click(t.root, 'Connect to Kason-MBP');
      await until(t.root, () => t.navigations.length > 0);
      expect(t.navigations).toEqual([`${TAILNET}/`]);
      expect(urls(t)).not.toContain(MACHINES); // the token was never read, so the directory was never asked
      expect(await currentAccount(t.deps)).not.toBeNull(); // and a vault that hangs is not a sign-out
    });
  });

  it('a late hint for a list that was replaced meanwhile is dropped: the newer list stays', async () => {
    const STUDIO_ID = '00000000-0000-4000-8000-000000000003';
    const open: Array<() => void> = [];
    const t = createHarness({ authSession: true, mac: { account: withHint } });
    const asked = holdDirectory(t, () => new Promise<void>((resolve) => { open.push(resolve); }));
    await signInFromPair(t); // the first list (Kason-MBP) is on show, its hint held
    t.mac.account.setMacs([{ deviceId: STUDIO_ID, name: 'Studio', lan: '192.168.1.40', tailnet: '100.88.1.7', port: 3333 }]);
    click(t.root, 'Pair with a QR code');
    click(t.root, 'Your computers'); // asks the list again
    await until(t.root, () => buttonNamed(t.root, 'Connect to Studio') !== null && asked.length === 2);
    open[1](); // the newer list's hint first,
    await new Promise((r) => setTimeout(r, 10));
    open[0](); // then the older one's, late
    await new Promise((r) => setTimeout(r, 10));
    click(t.root, 'AASC Cloud account'); // draws the list again from what is held
    expect(Array.from(t.root.querySelectorAll('.mac-name')).map((n) => n.textContent)).toEqual(['Studio']);
  });

  it('a hint that arrives after the phone signed out changes nothing on show', async () => {
    let release: () => void = () => undefined;
    const t = createHarness({ authSession: true, mac: { account: withHint } });
    holdDirectory(t, new Promise<void>((resolve) => { release = resolve; }));
    await signInFromPair(t);
    click(t.root, 'AASC Cloud account');
    click(t.root, 'Sign out of AASC Cloud');
    await until(t.root, () => heading(t.root) === 'Pair with a Mac');
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(heading(t.root)).toBe('Pair with a Mac');
    expect(text(t)).not.toContain('Kason-MBP');
    expect(await currentAccount(t.deps)).toBeNull();
  });
});
