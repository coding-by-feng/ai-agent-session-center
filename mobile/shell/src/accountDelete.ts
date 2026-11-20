// accountDelete.ts — Delete the AASC Cloud account, the phone's half (Nov 20 2026).
//
// The phone deletes nothing itself. It opens the same sign-in sheet as a sign-in, with intent=delete
// (accountSignIn.ts prepares it: fresh verifier, `c`, `s`, the match code), and the backend's page "Delete
// your AASC Cloud account?" does the deleting when its one button is pressed. The sheet then comes back to
// this OS's return URL with `deleted=1` and the state: no code, nothing to redeem, no delete request and no
// /v1/devices/pair from here.
//
// What the sheet comes back with never says what became of this phone's account. The person may have picked
// another Google account in it, and the button deletes even when the sheet doesn't come back (closed after
// the press, or on Android a return that never reached the app). So once the sheet has opened, however it
// ended, the phone asks for its own account's Macs once (accountMacs.ts): a 401 means its token is no longer
// known, and that call has then already forgotten the account here, exactly as any other 401 does (one that
// another call got meanwhile counts the same: the token is gone from the vault). Only a sheet that never
// opened asks nothing. Saved Macs are never touched. Nothing here logs.
import { listAccountMacs } from './accountMacs.js';
import { accountCredentialState, callbackQuery, sameText, SHEET_BUSY_TEXT, type AccountInfo, type PendingSignIn } from './accountSignIn.js';
import type { ShellDeps } from './native.js';

const signedInAs = (email: string | null) => (email ? ` as ${email}` : '');

export const DELETE_TEXT = {
  deleted: 'Your AASC Cloud account was deleted.',
  /** The sheet never opened (no sheet in this build, or it couldn't start): nothing happened anywhere. */
  notOpened: 'Deleting did not finish. Nothing changed on this phone.',
  unknown: 'Could not reach AASC Cloud. If you deleted this account, this phone signs out the next time it connects.',
  /** The sheet ended without the delete page's return, and this phone's account still answers. */
  stillSignedIn: (email: string | null) => `Nothing changed on this phone. It is still signed in${signedInAs(email)}.`,
  /** The delete page's return came, and this phone's account still answers. */
  otherAccount: (email: string | null) => `A different Google account was deleted. This phone is still signed in${signedInAs(email)}.`,
} as const;

export interface DeleteOutcome {
  /** True only for `deleted`: the account's token and email are gone from this phone. */
  forgotten: boolean;
  /**
   * `deleted`: this phone's token is no longer known. With the account kept: `cancelled` the sheet was closed,
   * `refused` it never opened or returned something that isn't the delete page's return, `other-account` the page's
   * return came yet this account still answers, `unknown` the account couldn't be asked about.
   */
  reason: 'deleted' | 'cancelled' | 'refused' | 'other-account' | 'unknown';
  /** What the phone says. Never a URL, a state or a code. */
  message: string;
}

type DeleteDeps = Pick<ShellDeps, 'authSession' | 'vault' | 'store' | 'requester'>;

const kept = (reason: Exclude<DeleteOutcome['reason'], 'deleted'>, message: string): DeleteOutcome => ({ forgotten: false, reason, message });

/**
 * Is `url` the delete page's return for `pending`? Exactly this OS's return URL plus a query, one `state` equal to
 * this flow's, one `deleted` that is `1`, and no `code` (a code belongs to a sign-in, which this never was).
 */
function isDeleteReturn(url: string, pending: PendingSignIn): boolean {
  const query = callbackQuery(url, pending.returnUrl);
  if (!query) return false;
  const states = query.getAll('state');
  if (states.length !== 1 || !sameText(states[0], pending.state)) return false;
  const deleted = query.getAll('deleted');
  return deleted.length === 1 && deleted[0] === '1' && !query.has('code');
}

/**
 * Open the sheet for `pending` (prepared with intent 'delete': the challenge the user just saw the code for) and say
 * what became of `account`, the one this phone is signed in to. Only a 401 from the account's own list forgets it,
 * and that list is asked whenever the sheet opened: a closed sheet or a wrong return doesn't prove nothing was deleted.
 */
export async function finishAccountDelete(deps: DeleteDeps, pending: PendingSignIn, account: AccountInfo): Promise<DeleteOutcome> {
  if (!deps.authSession || pending.intent !== 'delete') return kept('refused', DELETE_TEXT.notOpened);
  let result;
  try {
    result = await deps.authSession.start(pending.startUrl, pending.callback);
  } catch (err) {
    // Never opened, so nothing can have been deleted and nothing is asked.
    const busy = (err as { code?: unknown } | null)?.code === 'BUSY';
    return kept('refused', busy ? SHEET_BUSY_TEXT : DELETE_TEXT.notOpened);
  }
  const closed = !('url' in result) || typeof result.url !== 'string';
  const pageReturned = 'url' in result && typeof result.url === 'string' && isDeleteReturn(result.url, pending);

  const gone: DeleteOutcome = { forgotten: true, reason: 'deleted', message: DELETE_TEXT.deleted };
  const read = await accountCredentialState(deps.vault);
  // A token this phone can't read right now (a locked keychain) proves nothing: only the backend's 401 does.
  if (read.status === 'unreadable') return kept('unknown', DELETE_TEXT.unknown);
  // Already forgotten here: a 401 for another call (the list refreshing behind the sheet) got there first.
  if (read.status === 'none') return gone;
  const listed = await listAccountMacs(deps);
  if (listed.status === 'signed-out') return gone;
  if (listed.status !== 'ok') return kept('unknown', DELETE_TEXT.unknown);
  if (pageReturned) return kept('other-account', DELETE_TEXT.otherAccount(account.email));
  return kept(closed ? 'cancelled' : 'refused', DELETE_TEXT.stillSignedIn(account.email));
}
