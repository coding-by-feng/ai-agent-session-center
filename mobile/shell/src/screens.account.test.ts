// @vitest-environment jsdom
// Plan 17: Sign in with Google on the pair screen, and the account's Macs in Your Macs.
import { afterEach, describe, expect, it } from 'vitest';
import { ACCOUNT_PREFS_KEY, ACCOUNT_VAULT_KEY, matchCode } from './accountSignIn';
import { loadMacs, MACS_KEY } from './savedMacs';
import { buttonNamed, click, createHarness, heading, KASON_MBP, seedMac, TAILNET, until } from './testing/shellHarness';

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
  await until(t.root, () => heading(t.root) === 'Your Macs' && text(t).includes('Kason-MBP'));
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
    await until(t.root, () => heading(t.root) === 'Your Macs');
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

describe('Your Macs with an account', () => {
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
    expect(heading(t.root)).toBe('Your Macs');
  });

  it('leaves out an account Mac already saved here', async () => {
    const t = createHarness({ authSession: true, search: '?tap=1' });
    await seedMac(t, { ...KASON_MBP, backendDeviceId: '7d3e9a2c-1b4f-4c6d-8e2f-3a5b6c7d8e9f' });
    await t.app.start();
    click(t.root, 'Pair another Mac');
    await signIn(t);
    await until(t.root, () => heading(t.root) === 'Your Macs' && text(t).includes('owner@example.com'));
    await until(t.root, () => text(t).includes('Every Mac on your account is on this phone'));
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
    expect(heading(t.root)).toBe('Your Macs');
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
    click(t.root, 'Pair another Mac');
    await signIn(t);
    await until(t.root, () => heading(t.root) === 'Your Macs' && text(t).includes('owner@example.com'));
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
    click(t.root, 'Your Macs');
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
    expect(heading(t.root)).toBe('Your Macs');
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
    await until(t.root, () => heading(t.root) === 'Your Macs' && text(t).includes('owner@example.com'));
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
