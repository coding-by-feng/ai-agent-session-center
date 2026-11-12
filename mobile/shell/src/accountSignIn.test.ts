// @vitest-environment jsdom
// Plan 17: Sign in with Google (PKCE) and the account kept on this phone.
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ACCOUNT_HOST, ACCOUNT_PREFS_KEY, ACCOUNT_VAULT_KEY, currentAccount, finishGoogleSignIn, isAuthCallback, matchCode, pkceChallenge, prepareGoogleSignIn,
  readAccountCredential, signInWithGoogle, signOutAccount,
} from './accountSignIn';
import { isBackendHost } from './pairingLink';
import { createHarness } from './testing/shellHarness';

afterEach(() => {
  document.body.replaceChildren();
});

const pairCalls = (t: ReturnType<typeof createHarness>) => t.mac.calls.filter((c) => c.url === `https://${ACCOUNT_HOST}/v1/devices/pair`);

describe('signInWithGoogle', () => {
  it('the backend host is one isBackendHost allows', () => {
    expect(isBackendHost(ACCOUNT_HOST)).toBe(true);
  });

  it('says it needs the app where there is no sign-in sheet, and asks nothing', async () => {
    const t = createHarness();
    const out = await signInWithGoogle(t.deps, 'Pixel');
    expect(out).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(t.mac.calls).toHaveLength(0);
  });

  it('Android: opens the start URL with a PKCE challenge, waits for the App Link, pairs with the verifier', async () => {
    const t = createHarness({ authSession: true, os: 'android' });
    const out = await signInWithGoogle(t.deps, 'Pixel 9');
    expect(out).toEqual({ ok: true, account: { email: 'owner@example.com', host: ACCOUNT_HOST } });
    const [{ url, callback }] = t.extras.authStarts;
    const start = new URL(url);
    expect(start.origin + start.pathname).toBe('https://api.aasc.work/v1/auth/google/start');
    expect(start.searchParams.get('return')).toBe('https://aasc.work/auth/google');
    expect(callback).toEqual({ prefix: 'https://aasc.work/auth/google' });
    const [pair] = pairCalls(t);
    const body = pair.body as { code: string; name: string; verifier: string };
    expect(body.name).toBe('Pixel 9');
    expect(body.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(start.searchParams.get('c')).toBe(createHash('sha256').update(body.verifier).digest('base64url'));
    expect(start.searchParams.get('s')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The verifier never travels in the start URL.
    expect(url).not.toContain(body.verifier);
  });

  it('iOS: returns to work.aasc.mobile://auth/google through the session’s callback scheme', async () => {
    const t = createHarness({ authSession: true, os: 'ios' });
    expect((await signInWithGoogle(t.deps, 'iPhone')).ok).toBe(true);
    const [{ url, callback }] = t.extras.authStarts;
    expect(new URL(url).searchParams.get('return')).toBe('work.aasc.mobile://auth/google');
    expect(callback).toEqual({ scheme: 'work.aasc.mobile' });
  });

  it('keeps the token in the vault only; Preferences holds the email and host', async () => {
    const t = createHarness({ authSession: true });
    await signInWithGoogle(t.deps, 'Pixel');
    const cred = await readAccountCredential(t.deps.vault);
    expect(cred).toMatchObject({ host: ACCOUNT_HOST });
    expect(cred?.token.length).toBeGreaterThan(20);
    expect(JSON.parse(t.store.get(ACCOUNT_PREFS_KEY)!)).toEqual({ email: 'owner@example.com', host: ACCOUNT_HOST });
    for (const secret of t.mac.issued) {
      for (const value of t.store.values()) expect(value).not.toContain(secret);
    }
    expect(await currentAccount(t.deps)).toEqual({ email: 'owner@example.com', host: ACCOUNT_HOST });
  });

  it('a cancelled sheet saves nothing and pairs nothing', async () => {
    const t = createHarness({ authSession: async () => ({ cancelled: true }) });
    const out = await signInWithGoogle(t.deps, 'Pixel');
    expect(out).toMatchObject({ ok: false, reason: 'cancelled' });
    expect(out.ok ? '' : out.message).toContain('Nothing was saved');
    expect(pairCalls(t)).toHaveLength(0);
    expect(t.vault.size).toBe(0);
    expect(t.store.has(ACCOUNT_PREFS_KEY)).toBe(false);
  });

  it('a callback whose state isn’t this sign-in’s is refused before the code is used', async () => {
    const t = createHarness({
      authSession: async (_url, redirect) => ({ url: redirect!.replace(/state=[^&]+/, 'state=someone-elses-state') }),
    });
    const out = await signInWithGoogle(t.deps, 'Pixel');
    expect(out).toMatchObject({ ok: false, reason: 'state' });
    expect(pairCalls(t)).toHaveLength(0);
    expect(t.vault.size).toBe(0);
  });

  it('a callback to any other address is refused', async () => {
    const t = createHarness({
      os: 'android',
      authSession: async (_url, redirect) => ({ url: redirect!.replace('https://aasc.work/auth/google', 'https://evil.example/auth/google') }),
    });
    expect(await signInWithGoogle(t.deps, 'Pixel')).toMatchObject({ ok: false, reason: 'refused' });
    expect(pairCalls(t)).toHaveLength(0);
  });

  it('a code the backend won’t take saves nothing', async () => {
    const t = createHarness({
      authSession: async (_url, redirect) => ({ url: redirect!.replace(/code=[^&]+/, 'code=AAAAAAAAAAAAAAAAAAAAAA') }),
    });
    expect(await signInWithGoogle(t.deps, 'Pixel')).toMatchObject({ ok: false, reason: 'refused' });
    expect(t.vault.size).toBe(0);
    expect(t.store.has(ACCOUNT_PREFS_KEY)).toBe(false);
  });

  it('a vault that won’t store leaves no account behind', async () => {
    const t = createHarness({ authSession: true, vaultFails: true });
    expect(await signInWithGoogle(t.deps, 'Pixel')).toMatchObject({ ok: false, reason: 'storage' });
    expect(t.store.has(ACCOUNT_PREFS_KEY)).toBe(false);
    expect(await currentAccount(t.deps)).toBeNull();
  });

  it('a sheet already open elsewhere (BUSY) says so', async () => {
    const t = createHarness({ authSession: async () => { throw Object.assign(new Error('busy'), { code: 'BUSY' }); } });
    const out = await signInWithGoogle(t.deps, 'Pixel');
    expect(out).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(out.ok ? '' : out.message).toMatch(/already open/);
  });

  it('a sheet that throws (no native plugin yet) is a calm failure', async () => {
    const t = createHarness({ authSession: async () => { throw new Error('plugin not implemented'); } });
    expect(await signInWithGoogle(t.deps, 'Pixel')).toMatchObject({ ok: false, reason: 'unavailable' });
  });
});

/** The match code as plan 17 (review M2) defines it, with node:crypto: the backend's confirm page shows the same. */
function nodeMatchCode(c: string): string {
  const h = createHash('sha256').update(`aasc-match-v1:${c}`, 'utf8').digest();
  return [0, 1, 2, 3].map((i) => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[h[i] % 32]).join('');
}

describe('matchCode', () => {
  // Test vectors from the backend (its confirm page), checked independently by the coordinator.
  it('pins the backend’s vectors: verifier → c → "C8T6", and 43 × "A" → "Z6PV"', async () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const c = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
    expect(await pkceChallenge(verifier)).toBe(c);
    expect(await matchCode(c)).toBe('C8T6');
    expect(await matchCode('A'.repeat(43))).toBe('Z6PV');
    expect(nodeMatchCode(c)).toBe('C8T6');
    expect(nodeMatchCode('A'.repeat(43))).toBe('Z6PV');
  });

  it('agrees with node:crypto on a fixed challenge and on random ones', async () => {
    const fixed = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
    expect(await matchCode(fixed)).toBe(nodeMatchCode(fixed));
    expect(await matchCode(fixed)).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/);
    for (let i = 0; i < 20; i += 1) {
      const c = createHash('sha256').update(String(i)).digest('base64url');
      expect(await matchCode(c)).toBe(nodeMatchCode(c));
    }
  });

  it('prepare shows the code for the very challenge the sheet then opens with (no new verifier, c or s)', async () => {
    const t = createHarness({ authSession: true });
    const pending = await prepareGoogleSignIn(t.deps);
    if (!('startUrl' in pending)) throw new Error('not prepared');
    expect(t.extras.authStarts).toHaveLength(0); // nothing opens before the user checks the code
    const out = await finishGoogleSignIn(t.deps, pending, 'Pixel');
    expect(out.ok).toBe(true);
    const [{ url }] = t.extras.authStarts;
    expect(url).toBe(pending.startUrl);
    const c = new URL(url).searchParams.get('c')!;
    expect(pending.matchCode).toBe(nodeMatchCode(c));
    // The verifier the backend got hashes to that same c.
    const verifier = (t.mac.calls.find((x) => x.url.endsWith('/v1/devices/pair'))!.body as { verifier: string }).verifier;
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(c);
  });

  it('prepare without a sign-in sheet says it needs the app', async () => {
    const t = createHarness();
    expect(await prepareGoogleSignIn(t.deps)).toMatchObject({ ok: false, reason: 'unavailable' });
  });
});

describe('isAuthCallback', () => {
  it('names the sign-in return URLs (with a boundary), and nothing else', () => {
    expect(isAuthCallback('https://aasc.work/auth/google?code=x&state=y')).toBe(true);
    expect(isAuthCallback('https://aasc.work/auth/google')).toBe(true);
    expect(isAuthCallback('https://aasc.work/auth/google#x')).toBe(true);
    expect(isAuthCallback('work.aasc.mobile://auth/google?code=x')).toBe(true);
    expect(isAuthCallback('https://aasc.work/auth/googlex?code=x')).toBe(false);
    expect(isAuthCallback('https://aasc.work/pair#v=2')).toBe(false);
    expect(isAuthCallback('https://evil.example/auth/google?code=x')).toBe(false);
  });
});

describe('the account on this phone', () => {
  it('sign out forgets the token and the email', async () => {
    const t = createHarness({ authSession: true });
    await signInWithGoogle(t.deps, 'Pixel');
    await signOutAccount(t.deps);
    expect(t.vault.has(ACCOUNT_VAULT_KEY)).toBe(false);
    expect(await currentAccount(t.deps)).toBeNull();
  });

  it('is signed out when Preferences names an account the vault has no token for', async () => {
    const t = createHarness({ store: { [ACCOUNT_PREFS_KEY]: JSON.stringify({ email: 'x@example.com', host: ACCOUNT_HOST }) } });
    expect(await currentAccount(t.deps)).toBeNull();
  });

  it('ignores a rewritten Preferences entry whose host isn’t under aasc.work', async () => {
    const t = createHarness({ authSession: true });
    await signInWithGoogle(t.deps, 'Pixel');
    t.store.set(ACCOUNT_PREFS_KEY, JSON.stringify({ email: 'x@example.com', host: 'evil.example' }));
    expect(await currentAccount(t.deps)).toBeNull();
  });
});
