// @vitest-environment jsdom
// Delete the AASC Cloud account from the phone (Nov 20 2026): the start URL, the checks on the return, and
// what the phone forgets. The phone sends no delete request: the backend's page deletes, the phone only asks
// its own account list afterwards whether its token still counts. It asks whenever the sheet opened, however
// the sheet ended: the page's button deletes even when the sheet never comes back.
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { finishAccountDelete } from './accountDelete';
import { listAccountMacs } from './accountMacs';
import {
  ACCOUNT_HOST, ACCOUNT_PREFS_KEY, ACCOUNT_VAULT_KEY, currentAccount, finishGoogleSignIn, matchCode, prepareGoogleSignIn, signInWithGoogle,
  type AccountInfo, type PendingSignIn,
} from './accountSignIn';
import type { AuthSessionResult } from './native';
import { MACS_KEY } from './savedMacs';
import { createHarness, seedMac, STUDIO, type Harness, type HarnessOptions } from './testing/shellHarness';

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

const ME: AccountInfo = { email: 'owner@example.com', host: ACCOUNT_HOST };
const B64U43 = /^[A-Za-z0-9_-]{43}$/;
const LIST = `GET https://${ACCOUNT_HOST}/v1/enroll/macs`;
const NOT_OPENED = 'Deleting did not finish. Nothing changed on this phone.';
const STILL_SIGNED_IN = 'Nothing changed on this phone. It is still signed in as owner@example.com.';
const DELETED = 'Your AASC Cloud account was deleted.';
const UNREACHABLE = 'Could not reach AASC Cloud. If you deleted this account, this phone signs out the next time it connects.';

const isDelete = (startUrl: string) => new URL(startUrl).searchParams.get('intent') === 'delete';

/** A sheet whose sign-ins go through and whose delete comes back as the test says (`redirect`: nothing deleted yet). */
const sheet = (onDelete: (redirect: string) => AuthSessionResult | Promise<AuthSessionResult>) =>
  async (startUrl: string, redirect: string | null): Promise<AuthSessionResult> => (isDelete(startUrl) ? onDelete(redirect!) : { url: redirect! });

/**
 * A sheet in which "Delete my account" was pressed (this account is gone from the backend) and which then ends as the
 * test says: closed, or with a return that is not the delete page's.
 */
const pressedSheet = (get: () => Harness, end: (redirect: string) => AuthSessionResult) =>
  async (startUrl: string, redirect: string | null): Promise<AuthSessionResult> =>
    (isDelete(startUrl) ? end(get().mac.googleRedirect(startUrl)!) : { url: redirect! });

/** Returns that are not this flow's delete return: each fails one of the checks. */
const BAD_RETURNS: ReadonlyArray<readonly [string, 'android' | 'ios', (r: string) => string]> = [
  ['with another flow’s state', 'android', (r) => r.replace(/state=[^&]+/, 'state=someone-elses-state')],
  ['with a state one character off', 'android', (r) => r.replace(/state=([^&])/, (_m, first: string) => `state=${first === 'A' ? 'B' : 'A'}`)],
  ['with no state', 'android', (r) => r.replace(/&state=[^&]+/, '')],
  ['with an empty state', 'android', (r) => r.replace(/state=[^&]+/, 'state=')],
  ['with two states', 'android', (r) => `${r}&state=someone-elses-state`],
  ['with a code', 'android', (r) => `${r}&code=AAAAAAAAAAAAAAAAAAAAAA`],
  ['with an empty code', 'android', (r) => `${r}&code=`],
  ['with deleted=0', 'android', (r) => r.replace('deleted=1', 'deleted=0')],
  ['with deleted=true', 'android', (r) => r.replace('deleted=1', 'deleted=true')],
  ['with deleted=11', 'android', (r) => r.replace('deleted=1', 'deleted=11')],
  ['with no deleted', 'android', (r) => r.replace('deleted=1&', '')],
  ['with deleted twice', 'android', (r) => `${r}&deleted=0`],
  ['with deleted only after the #', 'android', (r) => r.replace('deleted=1&', '').concat('#deleted=1')],
  ['to another site', 'android', (r) => r.replace('https://aasc.work/auth/google', 'https://evil.example/auth/google')],
  ['to a longer path', 'android', (r) => r.replace('/auth/google?', '/auth/googlex?')],
  ['to the other OS’s return address', 'android', (r) => r.replace('https://aasc.work/auth/google', 'work.aasc.mobile://auth/google')],
  ['to another scheme', 'ios', (r) => r.replace('work.aasc.mobile://', 'work.aasc.mobilex://')],
  ['with no query at all', 'ios', () => 'work.aasc.mobile://auth/google'],
];

/** What this phone keeps for its saved Macs: the list and each Mac's key (everything but the account's token). */
const savedMacs = (t: Harness) => JSON.stringify([t.store.get(MACS_KEY), [...t.vault].filter(([k]) => k !== ACCOUNT_VAULT_KEY)]);

/** A phone signed in to the account with one Mac paired by QR; the calls and sheets so far are cleared. */
async function signedIn(opts: HarnessOptions = {}) {
  const t = createHarness({ authSession: true, ...opts });
  await seedMac(t, STUDIO);
  expect((await signInWithGoogle(t.deps, 'Pixel')).ok).toBe(true);
  t.mac.calls.length = 0;
  t.extras.authStarts.length = 0;
  return { t, macsBefore: savedMacs(t) };
}

async function prepared(t: Harness): Promise<PendingSignIn> {
  const pending = await prepareGoogleSignIn(t.deps, 'delete');
  if (!pending.ok) throw new Error('not prepared');
  return pending;
}

const requests = (t: Harness) => t.mac.calls.map((c) => `${c.method} ${c.url}`);

async function expectAccountKept(t: Harness, macsBefore: string): Promise<void> {
  expect(await currentAccount(t.deps)).toEqual(ME);
  expect(t.vault.has(ACCOUNT_VAULT_KEY)).toBe(true);
  expect(savedMacs(t)).toBe(macsBefore);
}

describe('the delete start URL', () => {
  it('Android: carries intent=delete, a fresh challenge and state, and the App Link to return to', async () => {
    const t = createHarness({ authSession: true, os: 'android' });
    const pending = await prepared(t);
    const start = new URL(pending.startUrl);
    expect(start.origin + start.pathname).toBe('https://api.aasc.work/v1/auth/google/start');
    expect([...start.searchParams.keys()].sort()).toEqual(['c', 'intent', 'return', 's']);
    expect(start.searchParams.get('intent')).toBe('delete');
    expect(start.searchParams.get('c')).toMatch(B64U43);
    expect(start.searchParams.get('s')).toMatch(B64U43);
    expect(start.searchParams.get('c')).toBe(createHash('sha256').update(pending.verifier).digest('base64url'));
    expect(start.searchParams.get('return')).toBe('https://aasc.work/auth/google');
    expect(pending.callback).toEqual({ prefix: 'https://aasc.work/auth/google' });
    expect(pending.startUrl).not.toContain(pending.verifier);
    expect(t.extras.authStarts).toHaveLength(0); // nothing opens yet
    expect(t.mac.calls).toHaveLength(0);
  });

  it('iOS: returns to work.aasc.mobile://auth/google through the session’s callback scheme', async () => {
    const t = createHarness({ authSession: true, os: 'ios' });
    const pending = await prepared(t);
    const start = new URL(pending.startUrl);
    expect(start.searchParams.get('intent')).toBe('delete');
    expect(start.searchParams.get('c')).toMatch(B64U43);
    expect(start.searchParams.get('s')).toMatch(B64U43);
    expect(start.searchParams.get('return')).toBe('work.aasc.mobile://auth/google');
    expect(pending.callback).toEqual({ scheme: 'work.aasc.mobile' });
  });

  it('shows the sign-in match code for its own challenge', async () => {
    const t = createHarness({ authSession: true });
    const pending = await prepared(t);
    expect(pending.matchCode).toBe(await matchCode(new URL(pending.startUrl).searchParams.get('c')!));
  });

  it('never reuses a verifier, challenge or state', async () => {
    const t = createHarness({ authSession: true });
    const all = [await prepared(t), await prepared(t), await prepared(t)];
    const signIn = await prepareGoogleSignIn(t.deps);
    if (!signIn.ok) throw new Error('not prepared');
    const every = [...all, signIn];
    expect(new Set(every.map((p) => p.verifier)).size).toBe(4);
    expect(new Set(every.map((p) => p.state)).size).toBe(4);
    expect(new Set(every.map((p) => new URL(p.startUrl).searchParams.get('c'))).size).toBe(4);
  });

  it('a sign-in start URL still carries no intent', async () => {
    const t = createHarness({ authSession: true });
    const signIn = await prepareGoogleSignIn(t.deps);
    if (!signIn.ok) throw new Error('not prepared');
    expect([...new URL(signIn.startUrl).searchParams.keys()].sort()).toEqual(['c', 'return', 's']);
  });

  it('without a sign-in sheet there is nothing to prepare', async () => {
    const t = createHarness();
    expect(await prepareGoogleSignIn(t.deps, 'delete')).toMatchObject({ ok: false, reason: 'unavailable' });
  });
});

describe('finishAccountDelete', () => {
  it('this account deleted: the list answers 401, the account is forgotten and the phone says so', async () => {
    const { t, macsBefore } = await signedIn();
    const pending = await prepared(t);
    const out = await finishAccountDelete(t.deps, pending, ME);
    expect(out).toEqual({ forgotten: true, reason: 'deleted', message: 'Your AASC Cloud account was deleted.' });
    expect(t.extras.authStarts.map((s) => s.url)).toEqual([pending.startUrl]); // the very URL the code was shown for
    expect(t.mac.account.deleted()).toBe(true);
    // The phone's whole part: one look at its own list. No delete request, no pairing.
    expect(requests(t)).toEqual([LIST]);
    expect(t.vault.has(ACCOUNT_VAULT_KEY)).toBe(false);
    expect(t.store.get(ACCOUNT_PREFS_KEY)).toBe('');
    expect(await currentAccount(t.deps)).toBeNull();
    expect(savedMacs(t)).toBe(macsBefore);
  });

  // ── The sheet opened and ended without the delete page's return ─────────────────────────────────────────
  // The page's button deletes even when the sheet never comes back (Android: the App Link may not route to the
  // app), so the phone never says "nothing" unchecked: it looks at its own account first, as after a valid return.

  it('a closed sheet with nothing deleted: one look at the list, the account stays, and the phone says nothing changed', async () => {
    const { t, macsBefore } = await signedIn({ authSession: sheet(() => ({ cancelled: true })) });
    const out = await finishAccountDelete(t.deps, await prepared(t), ME);
    expect(out).toEqual({ forgotten: false, reason: 'cancelled', message: STILL_SIGNED_IN });
    expect(requests(t)).toEqual([LIST]);
    expect(t.mac.account.deleted()).toBe(false);
    await expectAccountKept(t, macsBefore);
  });

  it('a closed sheet, and this account has no address to name', async () => {
    const { t } = await signedIn({ authSession: sheet(() => ({ cancelled: true })) });
    const out = await finishAccountDelete(t.deps, await prepared(t), { email: null, host: ACCOUNT_HOST });
    expect(out).toEqual({ forgotten: false, reason: 'cancelled', message: 'Nothing changed on this phone. It is still signed in.' });
  });

  it('a closed sheet after the button was pressed: the list answers 401, the account is forgotten and the phone says deleted', async () => {
    const made: { t: Harness; macsBefore: string } = await signedIn({ authSession: pressedSheet(() => made.t, () => ({ cancelled: true })) });
    const { t } = made;
    const out = await finishAccountDelete(t.deps, await prepared(t), ME);
    expect(out).toEqual({ forgotten: true, reason: 'deleted', message: DELETED });
    expect(t.mac.account.deleted()).toBe(true);
    expect(requests(t)).toEqual([LIST]);
    expect(t.vault.has(ACCOUNT_VAULT_KEY)).toBe(false);
    expect(await currentAccount(t.deps)).toBeNull();
    expect(savedMacs(t)).toBe(made.macsBefore);
  });

  it('a closed sheet and a cloud that can’t be reached: the account stays and the phone says what happens next', async () => {
    const made: { t: Harness; macsBefore: string } = await signedIn({
      authSession: pressedSheet(() => made.t, () => {
        made.t.mac.setBackendDown(true);
        return { cancelled: true };
      }),
    });
    const { t } = made;
    const out = await finishAccountDelete(t.deps, await prepared(t), ME);
    expect(out).toEqual({ forgotten: false, reason: 'unknown', message: UNREACHABLE });
    expect(requests(t)).toEqual([LIST]);
    await expectAccountKept(t, made.macsBefore);
  });

  it('a closed sheet and any other answer (a 503) keeps the account too', async () => {
    const { t, macsBefore } = await signedIn({ authSession: sheet(() => ({ cancelled: true })) });
    const asked: string[] = [];
    const deps = { ...t.deps, requester: { request: async (req: { url: string }) => { asked.push(req.url); return { status: 503, data: null }; } } };
    expect(await finishAccountDelete(deps, await prepared(t), ME)).toEqual({ forgotten: false, reason: 'unknown', message: UNREACHABLE });
    expect(asked).toEqual([`https://${ACCOUNT_HOST}/v1/enroll/macs`]);
    await expectAccountKept(t, macsBefore);
  });

  it('a closed sheet and a token the phone can’t read right now: the account stays, nothing is asked', async () => {
    const made: { t: Harness; macsBefore: string } = await signedIn({
      authSession: pressedSheet(() => made.t, () => {
        made.t.faults.vaultRead = true;
        return { cancelled: true };
      }),
    });
    const { t } = made;
    const out = await finishAccountDelete(t.deps, await prepared(t), ME);
    expect(out).toEqual({ forgotten: false, reason: 'unknown', message: UNREACHABLE });
    expect(requests(t)).toEqual([]);
    t.faults.vaultRead = false;
    await expectAccountKept(t, made.macsBefore);
  });

  it('a closed sheet when a 401 elsewhere already forgot the account: deleted, with nothing more to ask', async () => {
    const made: { t: Harness; macsBefore: string } = await signedIn({
      authSession: async (startUrl, redirect) => {
        if (!isDelete(startUrl)) return { url: redirect! };
        made.t.mac.googleRedirect(startUrl);
        expect(await listAccountMacs(made.t.deps)).toEqual({ status: 'signed-out' }); // the app's own list refresh
        return { cancelled: true };
      },
    });
    const { t } = made;
    const out = await finishAccountDelete(t.deps, await prepared(t), ME);
    expect(out).toEqual({ forgotten: true, reason: 'deleted', message: DELETED });
    expect(requests(t)).toEqual([LIST]); // the refresh's, not a second one
    expect(savedMacs(t)).toBe(made.macsBefore);
  });

  it.each(BAD_RETURNS)('a return %s, nothing deleted: one look at the list, the account stays, and the phone says nothing changed', async (_name, os, tamper) => {
    const { t, macsBefore } = await signedIn({ os, authSession: sheet((redirect) => ({ url: tamper(redirect) })) });
    const out = await finishAccountDelete(t.deps, await prepared(t), ME);
    expect(out).toEqual({ forgotten: false, reason: 'refused', message: STILL_SIGNED_IN });
    expect(requests(t)).toEqual([LIST]);
    await expectAccountKept(t, macsBefore);
  });

  it.each(BAD_RETURNS)('a return %s after the button was pressed: the account is forgotten and the phone says deleted', async (_name, os, tamper) => {
    const made: { t: Harness; macsBefore: string } = await signedIn({ os, authSession: pressedSheet(() => made.t, (redirect) => ({ url: tamper(redirect) })) });
    const { t } = made;
    const out = await finishAccountDelete(t.deps, await prepared(t), ME);
    expect(out).toEqual({ forgotten: true, reason: 'deleted', message: DELETED });
    expect(requests(t)).toEqual([LIST]);
    expect(await currentAccount(t.deps)).toBeNull();
    expect(savedMacs(t)).toBe(made.macsBefore);
  });

  it('a return that isn’t the delete page’s and a cloud that can’t be reached: the account stays', async () => {
    const made: { t: Harness; macsBefore: string } = await signedIn({
      authSession: pressedSheet(() => made.t, (redirect) => {
        made.t.mac.setBackendDown(true);
        return { url: redirect.replace(/state=[^&]+/, 'state=x') };
      }),
    });
    const { t } = made;
    expect(await finishAccountDelete(t.deps, await prepared(t), ME)).toEqual({ forgotten: false, reason: 'unknown', message: UNREACHABLE });
    expect(requests(t)).toEqual([LIST]);
    await expectAccountKept(t, made.macsBefore);
  });

  // ── The delete page's own return ────────────────────────────────────────────────────────────────────────

  it('the untampered return of that same sheet is the delete page’s (what the bad returns above lack is the tampering’s doing)', async () => {
    const { t } = await signedIn({ authSession: sheet((redirect) => ({ url: redirect })) });
    const out = await finishAccountDelete(t.deps, await prepared(t), ME);
    // This sheet deleted nothing, so the list still answers: after the page's own return that reads "a different account".
    expect(out).toEqual({
      forgotten: false, reason: 'other-account',
      message: 'A different Google account was deleted. This phone is still signed in as owner@example.com.',
    });
    expect(requests(t)).toEqual([LIST]);
  });

  it('another Google account was picked in the sheet: this phone stays signed in and names its own', async () => {
    const { t, macsBefore } = await signedIn({ mac: { account: { deletes: 'another' } } });
    const out = await finishAccountDelete(t.deps, await prepared(t), ME);
    expect(out).toEqual({
      forgotten: false, reason: 'other-account',
      message: 'A different Google account was deleted. This phone is still signed in as owner@example.com.',
    });
    expect(requests(t)).toEqual([LIST]);
    await expectAccountKept(t, macsBefore);
  });

  it('another account, and this one has no address to name', async () => {
    const { t } = await signedIn({ mac: { account: { deletes: 'another' } } });
    const out = await finishAccountDelete(t.deps, await prepared(t), { email: null, host: ACCOUNT_HOST });
    expect(out.message).toBe('A different Google account was deleted. This phone is still signed in.');
  });

  it('a cloud that can’t be reached afterwards keeps the account and says what happens next', async () => {
    const { t, macsBefore } = await signedIn();
    const pending = await prepared(t);
    t.mac.setBackendDown(true);
    const out = await finishAccountDelete(t.deps, pending, ME);
    expect(out).toEqual({
      forgotten: false, reason: 'unknown',
      message: 'Could not reach AASC Cloud. If you deleted this account, this phone signs out the next time it connects.',
    });
    expect(requests(t)).toEqual([LIST]);
    await expectAccountKept(t, macsBefore);
  });

  it('any other answer (a 503) keeps the account too', async () => {
    const { t, macsBefore } = await signedIn();
    const asked: string[] = [];
    const deps = { ...t.deps, requester: { request: async (req: { url: string }) => { asked.push(req.url); return { status: 503, data: null }; } } };
    const out = await finishAccountDelete(deps, await prepared(t), ME);
    expect(out).toMatchObject({ forgotten: false, reason: 'unknown' });
    expect(asked).toEqual([`https://${ACCOUNT_HOST}/v1/enroll/macs`]);
    await expectAccountKept(t, macsBefore);
  });

  it('a token the phone can’t read right now (a locked keychain) is never taken for a deleted account', async () => {
    const { t, macsBefore } = await signedIn();
    const pending = await prepared(t);
    t.faults.vaultRead = true;
    const out = await finishAccountDelete(t.deps, pending, ME);
    expect(out).toMatchObject({ forgotten: false, reason: 'unknown' });
    expect(requests(t)).toEqual([]);
    t.faults.vaultRead = false;
    await expectAccountKept(t, macsBefore);
  });

  it('a 401 elsewhere that forgot the account while the sheet was open is the same news, with nothing more to ask', async () => {
    // The app's own list refresh can be under way: it gets the 401 first and forgets the account before this looks.
    const made: { t: Harness; macsBefore: string } = await signedIn({
      authSession: async (startUrl, redirect) => {
        if (!isDelete(startUrl)) return { url: redirect! };
        const back = made.t.mac.googleRedirect(startUrl)!; // "Delete my account" pressed: this account is gone
        expect(await listAccountMacs(made.t.deps)).toEqual({ status: 'signed-out' });
        return { url: back };
      },
    });
    const { t } = made;
    const out = await finishAccountDelete(t.deps, await prepared(t), ME);
    expect(out).toEqual({ forgotten: true, reason: 'deleted', message: 'Your AASC Cloud account was deleted.' });
    expect(requests(t)).toEqual([LIST]); // the refresh's, not a second one
    expect(await currentAccount(t.deps)).toBeNull();
    expect(savedMacs(t)).toBe(made.macsBefore);
  });

  // ── The sheet never opened: nothing happened, so nothing is asked ───────────────────────────────────────

  it('a sheet that can’t open changes nothing and asks nothing; one already open says so', async () => {
    const failing = await signedIn({ authSession: sheet(() => { throw new Error('plugin not implemented'); }) });
    expect(await finishAccountDelete(failing.t.deps, await prepared(failing.t), ME))
      .toEqual({ forgotten: false, reason: 'refused', message: NOT_OPENED });
    expect(requests(failing.t)).toEqual([]);
    await expectAccountKept(failing.t, failing.macsBefore);

    const busy = await signedIn({ authSession: sheet(() => { throw Object.assign(new Error('busy'), { code: 'BUSY' }); }) });
    expect(await finishAccountDelete(busy.t.deps, await prepared(busy.t), ME))
      .toEqual({ forgotten: false, reason: 'refused', message: 'A sign-in is already open. Finish or close it first.' });
    expect(requests(busy.t)).toEqual([]);
    await expectAccountKept(busy.t, busy.macsBefore);
  });

  it('without a sign-in sheet nothing opens and nothing is asked', async () => {
    const { t, macsBefore } = await signedIn();
    const pending = await prepared(t);
    const out = await finishAccountDelete({ ...t.deps, authSession: undefined }, pending, ME);
    expect(out).toEqual({ forgotten: false, reason: 'refused', message: NOT_OPENED });
    expect(t.extras.authStarts).toHaveLength(0);
    expect(requests(t)).toEqual([]);
    await expectAccountKept(t, macsBefore);
  });

  it('a sign-in’s pending never deletes, and a delete’s pending never signs in', async () => {
    const { t, macsBefore } = await signedIn();
    const signIn = await prepareGoogleSignIn(t.deps);
    if (!signIn.ok) throw new Error('not prepared');
    expect(await finishAccountDelete(t.deps, signIn, ME)).toEqual({ forgotten: false, reason: 'refused', message: NOT_OPENED });
    expect((await finishGoogleSignIn(t.deps, await prepared(t), 'Pixel')).ok).toBe(false);
    expect(t.extras.authStarts).toHaveLength(0); // neither opened a sheet
    expect(requests(t)).toEqual([]);
    expect(t.mac.account.deleted()).toBe(false);
    await expectAccountKept(t, macsBefore);
  });

  it('logs nothing and puts no state, verifier, challenge or address in what it says', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    const said: string[] = [];
    const pendings: PendingSignIn[] = [];
    const run = async (opts: HarnessOptions) => {
      const { t } = await signedIn(opts);
      const pending = await prepared(t);
      pendings.push(pending);
      said.push(JSON.stringify(await finishAccountDelete(t.deps, pending, ME)));
    };
    await run({});
    await run({ authSession: sheet(() => ({ cancelled: true })) });
    await run({ authSession: sheet((r) => ({ url: `${r}&code=AAAAAAAAAAAAAAAAAAAAAA` })) });
    await run({ authSession: sheet((r) => ({ url: r.replace(/state=[^&]+/, 'state=x') })) });
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    for (const text of said) {
      for (const p of pendings) {
        for (const secret of [p.state, p.verifier, new URL(p.startUrl).searchParams.get('c')!]) expect(text).not.toContain(secret);
      }
      expect(text).not.toMatch(/https?:|:\/\/|state=|code=|[A-Za-z0-9_-]{22,}/);
    }
  });
});
