// @vitest-environment jsdom
// Delete AASC Cloud account… in the account menu of Your Macs (Nov 20 2026): the confirm step, the sign-in
// match code, the sheet, and what the phone says and forgets afterwards.
import { afterEach, describe, expect, it } from 'vitest';
import { listAccountMacs } from './accountMacs';
import { ACCOUNT_VAULT_KEY, matchCode, signInWithGoogle } from './accountSignIn';
import { LOCK_SETTINGS_KEY } from './lockGate';
import type { AuthSessionResult } from './native';
import { loadMacs } from './savedMacs';
import { buttonNamed, click, createHarness, heading, seedMac, STUDIO, until, type Harness, type HarnessOptions } from './testing/shellHarness';

afterEach(() => {
  document.body.replaceChildren();
});

const DELETE = 'Delete AASC Cloud account…';
const ASK = 'Delete your AASC Cloud account?';
const LIST = 'GET https://api.aasc.work/v1/enroll/macs';
const text = (t: { root: HTMLElement }) => t.root.textContent ?? '';
const notice = (t: { root: HTMLElement }) => t.root.querySelector('.notice')?.textContent ?? '';
const isDelete = (startUrl: string) => new URL(startUrl).searchParams.get('intent') === 'delete';
const requests = (t: Harness) => t.mac.calls.map((c) => `${c.method} ${c.url}`);

/** A sheet whose sign-ins go through and whose delete comes back as the test says (`redirect`: nothing deleted yet). */
const sheet = (onDelete: (redirect: string) => AuthSessionResult | Promise<AuthSessionResult>) =>
  async (startUrl: string, redirect: string | null): Promise<AuthSessionResult> => (isDelete(startUrl) ? onDelete(redirect!) : { url: redirect! });

/** The app on Your Macs, signed in to the account (its first list answered); calls and sheets so far are cleared. */
async function signedInApp(opts: HarnessOptions = {}, savedMac = false): Promise<Harness> {
  const t = createHarness({ authSession: true, search: '?tap=1', ...opts });
  if (savedMac) await seedMac(t, STUDIO);
  expect((await signInWithGoogle(t.deps, 'Pixel')).ok).toBe(true);
  await t.app.start();
  if (opts.biometric) click(t.root, 'Unlock');
  await until(t.root, () => heading(t.root) === 'Your Macs' && buttonNamed(t.root, 'Connect to Kason-MBP') !== null);
  t.mac.calls.length = 0;
  t.extras.authStarts.length = 0;
  return t;
}

async function openConfirm(t: Harness): Promise<void> {
  click(t.root, 'AASC Cloud account');
  click(t.root, DELETE);
  await until(t.root, () => heading(t.root) === ASK);
}

/** From Your Macs through the confirm step to the match code (nothing opened yet). */
async function toMatchCode(t: Harness): Promise<string> {
  await openConfirm(t);
  click(t.root, 'Continue');
  await until(t.root, () => heading(t.root) === 'Check this code');
  return t.root.querySelector('.code')?.textContent ?? '';
}

/** The whole flow: the sheet opens from the match code's Continue. */
async function deleteThrough(t: Harness): Promise<void> {
  await toMatchCode(t);
  click(t.root, 'Continue');
  await until(t.root, () => notice(t) !== '');
}

describe('Delete AASC Cloud account… in the account menu', () => {
  it('is the menu’s only destructive-looking button: Sign out, which can be undone, is the plain one', async () => {
    const t = await signedInApp();
    click(t.root, 'AASC Cloud account');
    const menu = t.root.querySelector('#account-menu')!;
    const out = buttonNamed(menu, 'Sign out of AASC Cloud')!;
    expect(out.className).toContain('btn-secondary');
    expect(out.className).not.toContain('btn-danger');
    expect(Array.from(menu.querySelectorAll('.btn-danger')).map((b) => b.textContent?.trim())).toEqual([DELETE]);
  });

  it('sits under Sign out, apart from it, in the destructive style', async () => {
    const t = await signedInApp();
    expect(buttonNamed(t.root, DELETE)).toBeNull(); // the menu is closed
    click(t.root, 'AASC Cloud account');
    const del = buttonNamed(t.root, DELETE)!;
    const out = buttonNamed(t.root, 'Sign out of AASC Cloud')!;
    expect(del.className).toContain('btn-danger');
    const all = Array.from(t.root.querySelectorAll('button'));
    expect(all.indexOf(del)).toBeGreaterThan(all.indexOf(out));
    // Its own group under a divider (a fixed gap), never pushed away by auto margins.
    const group = del.closest('.account-delete');
    expect(group).not.toBeNull();
    expect(group!.contains(out)).toBe(false);
    expect(group!.closest('#account-menu')).not.toBeNull();
  });

  it('is absent when signed out', async () => {
    const t = createHarness({ authSession: true, search: '?tap=1' });
    await seedMac(t, STUDIO);
    await t.app.start();
    expect(heading(t.root)).toBe('Your Macs');
    expect(buttonNamed(t.root, 'AASC Cloud account')).toBeNull();
    expect(buttonNamed(t.root, /Delete AASC Cloud account/)).toBeNull();
  });

  it('is absent where the app has no sign-in sheet, while Sign out stays', async () => {
    const first = await signedInApp();
    document.body.replaceChildren();
    const t = createHarness({
      fakeMac: first.mac, search: '?tap=1', store: Object.fromEntries(first.store), vault: Object.fromEntries(first.vault),
    });
    await t.app.start();
    await until(t.root, () => heading(t.root) === 'Your Macs' && text(t).includes('owner@example.com'));
    click(t.root, 'AASC Cloud account');
    expect(buttonNamed(t.root, 'Sign out of AASC Cloud')).not.toBeNull();
    expect(buttonNamed(t.root, /Delete AASC Cloud account/)).toBeNull();
    expect(t.root.querySelector('.account-delete')).toBeNull();
  });
});

describe('the confirm step', () => {
  it('says what goes and what stays, with Cancel and Continue; nothing is opened or asked before Continue', async () => {
    const t = await signedInApp();
    await openConfirm(t);
    expect(text(t)).toContain(
      'This removes your account, its devices, synced notes, resources and saved projects from AASC Cloud. '
      + 'Sessions and files on your computers are not touched. You finish in a Google sign-in sheet.');
    expect(Array.from(t.root.querySelectorAll('button')).map((b) => b.textContent?.trim()).sort()).toEqual(['Cancel', 'Continue']);
    expect(buttonNamed(t.root, 'Continue')?.className).toContain('btn-danger');
    expect(t.extras.authStarts).toHaveLength(0);
    expect(requests(t)).toEqual([]);
    expect(t.mac.account.deleted()).toBe(false);
    expect(JSON.stringify(t.app.current())).not.toMatch(/verifier|[A-Za-z0-9_-]{43}/); // the screen holds nothing secret
  });

  it('Cancel goes back to Your Macs, still signed in, with nothing opened or asked', async () => {
    const t = await signedInApp();
    await openConfirm(t);
    click(t.root, 'Cancel');
    expect(heading(t.root)).toBe('Your Macs');
    expect(text(t)).toContain('Signed in as owner@example.com');
    expect(t.extras.authStarts).toHaveLength(0);
    expect(requests(t)).toEqual([]);
    expect(t.vault.has(ACCOUNT_VAULT_KEY)).toBe(true);
  });

  it('Continue shows the sign-in match code for this challenge; only its Continue opens the sheet, with intent=delete', async () => {
    const t = await signedInApp();
    const shown = await toMatchCode(t);
    expect(shown).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/);
    expect(text(t)).toContain('You’ll see the same code on the next page. Continue only if they match.');
    expect(t.extras.authStarts).toHaveLength(0);
    expect(requests(t)).toEqual([]);
    expect(t.mac.account.deleted()).toBe(false);
    const state = t.app.current();
    expect(state).toMatchObject({ name: 'account-match', code: shown });
    expect(JSON.stringify(state)).not.toMatch(/verifier|[A-Za-z0-9_-]{43}/);
    click(t.root, 'Continue');
    await until(t.root, () => notice(t) !== '');
    expect(t.extras.authStarts).toHaveLength(1);
    const start = new URL(t.extras.authStarts[0].url);
    expect(start.searchParams.get('intent')).toBe('delete');
    expect(await matchCode(start.searchParams.get('c')!)).toBe(shown);
  });

  it('Cancel at the match code goes back to Your Macs, still signed in, with nothing opened', async () => {
    const t = await signedInApp();
    await toMatchCode(t);
    click(t.root, 'Cancel');
    expect(heading(t.root)).toBe('Your Macs');
    expect(text(t)).toContain('Signed in as owner@example.com');
    expect(t.extras.authStarts).toHaveLength(0);
    expect(requests(t)).toEqual([]);
  });

  it('each try gets a new challenge and code; a cancelled one is never reused', async () => {
    const t = await signedInApp();
    const codes: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      codes.push(await toMatchCode(t));
      click(t.root, 'Cancel');
    }
    expect(new Set(codes).size).toBeGreaterThan(1);
  });
});

describe('after the sheet', () => {
  it('this account deleted: the phone forgets it, says so, and offers sign-in again', async () => {
    const t = await signedInApp();
    await deleteThrough(t);
    expect(notice(t)).toBe('Your AASC Cloud account was deleted.');
    expect(heading(t.root)).toBe('Pair with a Mac'); // signed out with nothing saved
    expect(buttonNamed(t.root, 'Sign in with Google')).not.toBeNull();
    expect(t.vault.has(ACCOUNT_VAULT_KEY)).toBe(false);
    expect(requests(t)).toEqual([LIST]); // no delete request, no pairing
  });

  it('this account deleted: the Macs saved on this phone stay', async () => {
    const t = await signedInApp({}, true);
    const before = JSON.stringify([await loadMacs(t.deps.store), [...t.vault].filter(([k]) => k !== ACCOUNT_VAULT_KEY)]);
    await deleteThrough(t);
    expect(notice(t)).toBe('Your AASC Cloud account was deleted.');
    expect(heading(t.root)).toBe('Your Macs');
    expect(buttonNamed(t.root, /^Studio/)).not.toBeNull();
    expect(buttonNamed(t.root, 'AASC Cloud account')).toBeNull(); // the account section went with the account
    expect(JSON.stringify([await loadMacs(t.deps.store), [...t.vault].filter(([k]) => k !== ACCOUNT_VAULT_KEY)])).toBe(before);
  });

  it('this account deleted, and a 401 elsewhere forgot it first: the phone still says deleted, not "could not reach"', async () => {
    const t: Harness = await signedInApp({
      authSession: async (startUrl, redirect) => {
        if (!isDelete(startUrl)) return { url: redirect! };
        const back = t.mac.googleRedirect(startUrl)!;
        await listAccountMacs(t.deps); // a list refresh under way gets the 401 and forgets the account
        return { url: back };
      },
    }, true);
    await deleteThrough(t);
    expect(notice(t)).toBe('Your AASC Cloud account was deleted.');
    expect(heading(t.root)).toBe('Your Macs');
    expect(buttonNamed(t.root, /^Studio/)).not.toBeNull();
    expect(buttonNamed(t.root, 'AASC Cloud account')).toBeNull();
  });

  it('a closed sheet with nothing deleted: the phone checks its account, then says nothing changed and keeps everything', async () => {
    const t = await signedInApp({ authSession: sheet(() => ({ cancelled: true })) }, true);
    await deleteThrough(t);
    expect(notice(t)).toBe('Nothing changed on this phone. It is still signed in as owner@example.com.');
    expect(heading(t.root)).toBe('Your Macs');
    expect(text(t)).toContain('Signed in as owner@example.com');
    expect(buttonNamed(t.root, /^Studio/)).not.toBeNull();
    expect(t.vault.has(ACCOUNT_VAULT_KEY)).toBe(true);
    expect(requests(t)).toEqual([LIST]);
  });

  it('a closed sheet after the button was pressed: the phone finds its account gone and says deleted', async () => {
    const t: Harness = await signedInApp({
      authSession: async (startUrl, redirect) => {
        if (!isDelete(startUrl)) return { url: redirect! };
        t.mac.googleRedirect(startUrl); // "Delete my account" pressed; the sheet never comes back
        return { cancelled: true };
      },
    }, true);
    await deleteThrough(t);
    expect(notice(t)).toBe('Your AASC Cloud account was deleted.');
    expect(heading(t.root)).toBe('Your Macs');
    expect(buttonNamed(t.root, /^Studio/)).not.toBeNull();
    expect(buttonNamed(t.root, 'AASC Cloud account')).toBeNull();
    expect(t.vault.has(ACCOUNT_VAULT_KEY)).toBe(false);
    expect(requests(t)).toEqual([LIST]);
  });

  it('a closed sheet and a cloud that can’t be reached: the account stays and the phone says what happens next', async () => {
    const t = await signedInApp({ authSession: sheet(() => ({ cancelled: true })) }, true);
    await toMatchCode(t);
    t.mac.setBackendDown(true);
    click(t.root, 'Continue');
    await until(t.root, () => notice(t) !== '');
    expect(notice(t)).toBe('Could not reach AASC Cloud. If you deleted this account, this phone signs out the next time it connects.');
    expect(text(t)).toContain('Signed in as owner@example.com');
    expect(t.vault.has(ACCOUNT_VAULT_KEY)).toBe(true);
  });

  it.each([
    ['a state that isn’t this flow’s', (r: string) => r.replace(/state=[^&]+/, 'state=x')],
    ['a code', (r: string) => `${r}&code=AAAAAAAAAAAAAAAAAAAAAA`],
    ['no deleted=1', (r: string) => r.replace('deleted=1', 'deleted=0')],
    ['an unexpected address', (r: string) => r.replace('https://aasc.work/auth/google', 'https://evil.example/auth/google')],
  ])('a return with %s, nothing deleted: the phone checks its account, then says nothing changed and keeps everything', async (_name, tamper) => {
    const t = await signedInApp({ authSession: sheet((redirect) => ({ url: tamper(redirect) })) }, true);
    await deleteThrough(t);
    expect(notice(t)).toBe('Nothing changed on this phone. It is still signed in as owner@example.com.');
    expect(text(t)).toContain('Signed in as owner@example.com');
    expect(buttonNamed(t.root, /^Studio/)).not.toBeNull();
    expect(t.vault.has(ACCOUNT_VAULT_KEY)).toBe(true);
    expect(requests(t)).toEqual([LIST]);
  });

  it('a return that isn’t the delete page’s after the button was pressed: the phone finds its account gone and says deleted', async () => {
    const t: Harness = await signedInApp({
      authSession: async (startUrl, redirect) => (isDelete(startUrl)
        ? { url: `${t.mac.googleRedirect(startUrl)!}&code=AAAAAAAAAAAAAAAAAAAAAA` }
        : { url: redirect! }),
    }, true);
    await deleteThrough(t);
    expect(notice(t)).toBe('Your AASC Cloud account was deleted.');
    expect(buttonNamed(t.root, /^Studio/)).not.toBeNull();
    expect(t.vault.has(ACCOUNT_VAULT_KEY)).toBe(false);
  });

  it('a sheet that can’t open says deleting did not finish, and asks nothing', async () => {
    const t = await signedInApp({ authSession: sheet(() => { throw new Error('plugin not implemented'); }) }, true);
    await deleteThrough(t);
    expect(notice(t)).toBe('Deleting did not finish. Nothing changed on this phone.');
    expect(text(t)).toContain('Signed in as owner@example.com');
    expect(requests(t)).toEqual([]);
  });

  it('another Google account was deleted: this phone stays signed in and the notice names its account', async () => {
    const t = await signedInApp({ mac: { account: { deletes: 'another' } } }, true);
    await deleteThrough(t);
    expect(notice(t)).toBe('A different Google account was deleted. This phone is still signed in as owner@example.com.');
    expect(text(t)).toContain('Signed in as owner@example.com');
    expect(t.vault.has(ACCOUNT_VAULT_KEY)).toBe(true);
    expect(requests(t)).toEqual([LIST]);
  });

  it('a cloud that can’t be reached afterwards keeps the account and says what happens next', async () => {
    const t = await signedInApp({}, true);
    await toMatchCode(t);
    t.mac.setBackendDown(true);
    click(t.root, 'Continue');
    await until(t.root, () => notice(t) !== '');
    expect(notice(t)).toBe('Could not reach AASC Cloud. If you deleted this account, this phone signs out the next time it connects.');
    expect(text(t)).toContain('Signed in as owner@example.com');
    expect(buttonNamed(t.root, /^Studio/)).not.toBeNull();
    expect(t.vault.has(ACCOUNT_VAULT_KEY)).toBe(true);
  });
});

// Android: the sheet is another activity, so the app pauses and resumes around it, and the lock can come up on the way back.
describe('the lock coming up while the sheet is open', () => {
  const lockAtOnce = { [LOCK_SETTINGS_KEY]: JSON.stringify({ enabled: true, relockAfterMinutes: 0 }) };

  /** The sheet: the app pauses, comes back locked, and the delete page’s return arrives (this account deleted). */
  function lockedSheet(get: () => Harness, beforeReturn: () => void = () => undefined) {
    return async (startUrl: string, redirect: string | null): Promise<AuthSessionResult> => {
      if (!isDelete(startUrl)) return { url: redirect! };
      const t = get();
      t.extras.pause!();
      await new Promise((r) => setTimeout(r, 5));
      t.extras.resume!();
      await until(t.root, () => heading(t.root) === 'AASC is locked');
      beforeReturn();
      return { url: t.mac.googleRedirect(startUrl)! };
    };
  }

  it('an answer that arrives behind the lock is said after the unlock', async () => {
    const t: Harness = await signedInApp({ biometric: { available: true, pass: true }, store: lockAtOnce, authSession: lockedSheet(() => t) });
    await toMatchCode(t);
    click(t.root, 'Continue');
    await until(t.root, () => !t.vault.has(ACCOUNT_VAULT_KEY)); // decided while locked
    expect(heading(t.root)).toBe('AASC is locked');
    click(t.root, 'Unlock');
    await until(t.root, () => notice(t) !== '');
    expect(notice(t)).toBe('Your AASC Cloud account was deleted.');
    expect(heading(t.root)).toBe('Pair with a Mac');
    expect(buttonNamed(t.root, 'Sign in with Google')).not.toBeNull();
  });

  it('an answer that arrives after the unlock, back on the waiting screen, is said too', async () => {
    let release: () => void = () => undefined;
    const t: Harness = await signedInApp({
      biometric: { available: true, pass: true }, store: lockAtOnce,
      authSession: lockedSheet(() => t, () => { release = t.mac.holdNextBackendRequest(); }),
    });
    await toMatchCode(t);
    click(t.root, 'Continue');
    await until(t.root, () => requests(t).includes(LIST)); // the list is asked, and held
    click(t.root, 'Unlock');
    await until(t.root, () => heading(t.root) === 'Check this code');
    expect(buttonNamed(t.root, 'Continue')?.disabled).toBe(true);
    release();
    await until(t.root, () => notice(t) !== '');
    expect(notice(t)).toBe('Your AASC Cloud account was deleted.');
    expect(heading(t.root)).toBe('Pair with a Mac');
  });
});
