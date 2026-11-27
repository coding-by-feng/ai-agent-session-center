// accountSignIn.ts — Sign in with Google for AASC Cloud, the phone's half (plan 17).
//
// The phone never talks to Google. It makes a verifier `v` and a state `s`, opens the backend's start
// URL with c = SHA-256(v) in the system's sign-in sheet (deps.authSession), and the backend sends the
// sheet back to this OS's return URL with a one-use code. The phone checks `s`, then redeems the code
// with `v` (POST /v1/devices/pair): a copied redirect is useless without the verifier, which never
// leaves this function. The account token goes to the vault; Preferences keeps only the email and host
// (nothing secret), for the screens. Nothing here logs.
//
// The same sheet, opened with intent=delete, ends on the backend's "Delete your AASC Cloud account?" page
// (accountDelete.ts): one preparation (verifier, `c`, `s`, match code) serves both, told apart by `intent`.
import { b64urlEncode, randomB64url } from './enrollCrypto.js';
import { field } from './http.js';
import type { ShellDeps } from './native.js';
import { isBackendHost } from './pairingLink.js';
import { cleanLabel } from './text.js';

/** AASC Cloud (passes isBackendHost). */
export const ACCOUNT_HOST = 'api.aasc.work';
/** Preferences: `{ email, host }` of the signed-in account. Not secret. */
export const ACCOUNT_PREFS_KEY = 'aasc.account.v1';
/** Vault: `{ host, deviceId, token }`, this phone's account device. */
export const ACCOUNT_VAULT_KEY = 'account.v1';
export const IOS_RETURN_URL = 'work.aasc.mobile://auth/google';
/** Only ASWebAuthenticationSession sees this scheme: it is not registered in Info.plist (plan 08 §5). */
export const IOS_CALLBACK_SCHEME = 'work.aasc.mobile';
export const ANDROID_RETURN_URL = 'https://aasc.work/auth/google';

const CODE = /^[A-Za-z0-9_-]{22}$/;

/**
 * Is `url` a Google sign-in return (either OS's), boundary included? On Android the verified App Link also
 * reaches @capacitor/app's appUrlOpen (and can be a cold start's launch URL); only the AuthSession plugin's
 * promise consumes it, so the shell's link handling ignores it (plan 17).
 */
export function isAuthCallback(url: string): boolean {
  return [ANDROID_RETURN_URL, IOS_RETURN_URL].some((base) => url.startsWith(base) && /^(?:$|[?#/])/.test(url.slice(base.length)));
}
const EMAIL_MAX = 254;
const NAME_MAX = 128;

export interface AccountInfo {
  email: string | null;
  host: string;
}

export interface AccountCredential {
  host: string;
  deviceId: string;
  token: string;
}

export type SignInOutcome =
  | { ok: true; account: AccountInfo }
  | { ok: false; reason: 'unavailable' | 'cancelled' | 'state' | 'refused' | 'storage'; message: string };

type AccountDeps = Pick<ShellDeps, 'os' | 'authSession' | 'http' | 'vault' | 'store'>;

/** What the sheet is opened for: signing this phone in, or the backend's delete page (accountDelete.ts). */
export type AuthIntent = 'sign-in' | 'delete';

/** The native plugin's BUSY: another sheet is still open. */
export const SHEET_BUSY_TEXT = 'A sign-in is already open. Finish or close it first.';

/** The vault holds the account token but can't be read right now (a locked keychain). `device`: what this is called. */
export const signInUnreadableText = (device = 'phone'): string => `This ${device} can’t read its sign-in right now. Unlock it and try again.`;

const NOT_STORED_TEXT = 'This phone couldn’t store the sign-in securely, so nothing was saved.';

const fail = (reason: Exclude<SignInOutcome, { ok: true }>['reason'], message: string): SignInOutcome => ({ ok: false, reason, message });

/** Are two texts equal? Texts of one length are compared to the end, with no early exit at the first difference. */
export function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** The query of `raw` when it is exactly `returnUrl` plus a query; null for any other address. */
export function callbackQuery(raw: string, returnUrl: string): URLSearchParams | null {
  const noHash = raw.split('#')[0];
  const at = noHash.indexOf('?');
  if (at < 0 || noHash.slice(0, at) !== returnUrl) return null;
  return new URLSearchParams(noHash.slice(at + 1));
}

function cleanEmail(raw: unknown): string | null {
  const email = cleanLabel(raw, EMAIL_MAX);
  return email.includes('@') ? email : null;
}

/** PKCE `c` for a verifier: b64url(SHA-256(utf8(verifier))). Exported for the pinned backend vector. */
export async function pkceChallenge(verifier: string): Promise<string> {
  return b64urlEncode(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
}

const MATCH_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * Review M2: four characters the phone shows before it opens the sheet and the backend shows on its confirm page,
 * both from the PKCE challenge `c`: h = SHA-256(utf8('aasc-match-v1:' + c)), code[i] = ALPHABET[h[i] % 32]. A user
 * who started no sign-in, or whose page shows another code, has a confirm page someone else set up.
 */
export async function matchCode(c: string): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`aasc-match-v1:${c}`)));
  return [0, 1, 2, 3].map((i) => MATCH_ALPHABET[h[i] % 32]).join('');
}

/**
 * A sign-in made ready but not yet opened: what the sheet opens and what its answer is checked against. Holds the
 * verifier, so it lives only in memory (accountWiring), never in a screen, Preferences or a log.
 */
export interface PendingSignIn {
  ok: true;
  /** What its sheet is for; each finish takes only its own kind. */
  intent: AuthIntent;
  startUrl: string;
  returnUrl: string;
  callback: { scheme?: string; prefix?: string };
  state: string;
  verifier: string;
  /** Not secret: shown on the phone and on the backend's confirm page. */
  matchCode: string;
}

/**
 * A fresh verifier, `c`, `s` and the match code for one sheet (nothing opened, nothing sent). `intent` 'delete' adds
 * `intent=delete` to the start URL: same host, same rules for `c` and `s`, same return URL.
 */
export async function prepareGoogleSignIn(
  deps: Pick<ShellDeps, 'os' | 'authSession'>, intent: AuthIntent = 'sign-in',
): Promise<PendingSignIn | Extract<SignInOutcome, { ok: false }>> {
  if (!deps.authSession) return { ok: false, reason: 'unavailable', message: 'Sign-in with Google needs the AASC app.' };
  const ios = deps.os === 'ios';
  const returnUrl = ios ? IOS_RETURN_URL : ANDROID_RETURN_URL;
  const verifier = randomB64url(32);
  const state = randomB64url(32);
  const c = await pkceChallenge(verifier);
  // The backend's "Sign in to AASC Cloud" page: Google, GitHub, Microsoft or Apple (Nov 28 2026).
  const start = new URL('/v1/auth/start', `https://${ACCOUNT_HOST}`);
  start.search = new URLSearchParams({ c, s: state, return: returnUrl, ...(intent === 'delete' ? { intent } : {}) }).toString();
  return {
    ok: true, intent, startUrl: start.href, returnUrl, state, verifier, matchCode: await matchCode(c),
    callback: ios ? { scheme: IOS_CALLBACK_SCHEME } : { prefix: ANDROID_RETURN_URL },
  };
}

/**
 * Open the sheet for `pending` (the same verifier, `c` and `s` the user just saw the code for) and finish: check the
 * state, redeem the code with the verifier. `name` is how the account lists this phone. Nothing is kept unless every
 * step worked: a cancel, another sign-in's state, a refused code or a vault that won't store leave no account behind.
 */
export async function finishGoogleSignIn(deps: AccountDeps, pending: PendingSignIn, name: string): Promise<SignInOutcome> {
  if (!deps.authSession) return fail('unavailable', 'Sign-in with Google needs the AASC app.');
  // A delete's sheet returns no code and must never pair anything.
  if (pending.intent !== 'sign-in') return fail('refused', 'Sign-in didn’t finish, so nothing was saved. Try again.');
  const { returnUrl, state, verifier } = pending;
  let result;
  try {
    result = await deps.authSession.start(pending.startUrl, pending.callback);
  } catch (err) {
    // The native plugin rejects with BUSY while another sign-in sheet is open (BAD_URL, ORIGIN_REFUSED, FAILED otherwise).
    const busy = (err as { code?: unknown } | null)?.code === 'BUSY';
    return fail('unavailable', busy ? SHEET_BUSY_TEXT : 'The sign-in sheet couldn’t open. Nothing was saved.');
  }
  if (!('url' in result) || typeof result.url !== 'string') return fail('cancelled', 'Sign-in cancelled. Nothing was saved.');
  const query = callbackQuery(result.url, returnUrl);
  if (!query) return fail('refused', 'Sign-in came back somewhere unexpected, so nothing was saved.');
  const gotState = query.get('state');
  if (gotState === null || !sameText(gotState, state)) {
    return fail('state', 'That sign-in didn’t match this one, so nothing was saved. Try again.');
  }
  const code = query.get('code');
  if (code === null || !CODE.test(code)) return fail('refused', 'Sign-in didn’t finish, so nothing was saved. Try again.');

  let res;
  try {
    res = await deps.http.post(`https://${ACCOUNT_HOST}/v1/devices/pair`, { code, name: cleanLabel(name, NAME_MAX) || 'Phone', verifier });
  } catch {
    return fail('refused', 'AASC Cloud didn’t answer, so nothing was saved. Try again.');
  }
  const token = field(res.data, ['data', 'token']);
  const deviceId = field(res.data, ['data', 'deviceId']);
  if ((res.status !== 200 && res.status !== 201) || typeof token !== 'string' || !token || typeof deviceId !== 'string' || !deviceId) {
    return fail('refused', 'AASC Cloud didn’t accept the sign-in, so nothing was saved. Try again.');
  }
  const account: AccountInfo = { email: cleanEmail(field(res.data, ['data', 'account', 'email'])), host: ACCOUNT_HOST };
  try {
    await deps.vault.set(ACCOUNT_VAULT_KEY, JSON.stringify({ host: ACCOUNT_HOST, deviceId, token }));
  } catch {
    return fail('storage', NOT_STORED_TEXT);
  }
  try {
    await deps.store.set(ACCOUNT_PREFS_KEY, JSON.stringify(account));
  } catch {
    // Nothing is kept unless every step worked: the token goes out of the vault again. Should even that fail, it
    // stays there unused: without its Preferences half this phone isn't signed in (currentAccount), and the next
    // sign-in writes over it.
    await deps.vault.delete(ACCOUNT_VAULT_KEY).catch(() => undefined);
    return fail('storage', NOT_STORED_TEXT);
  }
  return { ok: true, account };
}

/** Prepare and finish at once (no match-code step): tests and callers that show no screen. */
export async function signInWithGoogle(deps: AccountDeps, name: string): Promise<SignInOutcome> {
  const pending = await prepareGoogleSignIn(deps);
  return pending.ok ? finishGoogleSignIn(deps, pending, name) : pending;
}

/**
 * What the vault says about the account token. A read that fails (`unreadable`: a locked keychain) is never the same
 * as a vault that answers with no usable token (`none`): the first keeps the account, only the second is signed out.
 */
export type AccountCredentialState =
  | { status: 'ok'; cred: AccountCredential }
  | { status: 'none' }
  | { status: 'unreadable' };

export async function accountCredentialState(vault: ShellDeps['vault']): Promise<AccountCredentialState> {
  let raw: string | null;
  try {
    raw = await vault.get(ACCOUNT_VAULT_KEY);
  } catch {
    return { status: 'unreadable' };
  }
  try {
    const v: unknown = JSON.parse(raw ?? 'null');
    const host = field(v, ['host']);
    const deviceId = field(v, ['deviceId']);
    const token = field(v, ['token']);
    return typeof host === 'string' && isBackendHost(host) && typeof deviceId === 'string' && typeof token === 'string' && token
      ? { status: 'ok', cred: { host, deviceId, token } }
      : { status: 'none' };
  } catch {
    return { status: 'none' };
  }
}

/** The account token, or null: also when the vault can't be read. Where that difference matters, ask accountCredentialState. */
export async function readAccountCredential(vault: ShellDeps['vault']): Promise<AccountCredential | null> {
  const read = await accountCredentialState(vault);
  return read.status === 'ok' ? read.cred : null;
}

/** The signed-in account, or null: both halves must be there, and agree on a host under aasc.work. */
export async function currentAccount(deps: Pick<ShellDeps, 'vault' | 'store'>): Promise<AccountInfo | null> {
  let info: unknown;
  try {
    info = JSON.parse((await deps.store.get(ACCOUNT_PREFS_KEY)) || 'null');
  } catch {
    return null;
  }
  const host = field(info, ['host']);
  if (typeof host !== 'string' || !isBackendHost(host)) return null;
  const cred = await readAccountCredential(deps.vault).catch(() => null);
  if (!cred || cred.host !== host) return null;
  return { email: cleanEmail(field(info, ['email'])), host };
}

/** Forget the account on this phone: its token and its email. Each is tried even when the other fails. */
export async function signOutAccount(deps: Pick<ShellDeps, 'vault' | 'store'>): Promise<void> {
  await Promise.allSettled([deps.vault.delete(ACCOUNT_VAULT_KEY), deps.store.set(ACCOUNT_PREFS_KEY, '')]);
}
