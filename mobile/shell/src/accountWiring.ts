// accountWiring.ts — AASC Cloud sign-in and the account's Macs wired into the app (plan 17).
// app.ts owns the screens and the boot order; this owns the account state between screens: who is
// signed in (email and host only: the token stays in the vault) and what the account lists.
import { DELETE_TEXT, finishAccountDelete } from './accountDelete.js';
import { enrollViaAccount } from './accountEnroll.js';
import { listAccountMacs, unsavedAccountMacs, withDirectoryHints, type AccountMac } from './accountMacs.js';
import {
  currentAccount, finishGoogleSignIn, prepareGoogleSignIn, signOutAccount, type AccountInfo, type PendingSignIn,
} from './accountSignIn.js';
import type { Candidate } from './connectionPlan.js';
import type { ShellDeps } from './native.js';
import type { SavedMac } from './savedMacs.js';
import type { AccountView, Actions, Screen } from './ui/screen.js';

export interface AccountHost {
  deps: ShellDeps;
  macs(): SavedMac[];
  setMacs(next: SavedMac[]): void;
  screen(): Screen;
  show(next: Screen): void;
  update(patch: Partial<Record<string, unknown>>): void;
  /** Draw the current screen again (its state unchanged). */
  redraw(): void;
  gen(): number;
  home(notice?: string | null): Screen;
  /** The pair screen, with a notice or a sign-in error. */
  pair(notice: string | null, accountError?: string | null): Screen;
  serial<T>(fn: () => Promise<T>): Promise<T>;
  guard(fn: () => Promise<void>): () => void;
  phoneName(): string;
  /** Open a saved Mac the normal way (app connect → signInAndOpen). */
  open(mac: SavedMac): Promise<void>;
  tryingText(mac: { name: string; port: number }, c: Candidate): string;
  /** Plan 18: how long the directory's address hints may take (accountMacs DIRECTORY_HINTS_MS); tests shorten it. */
  hintsMs?: number;
}

export type AccountActions = Pick<
  Actions,
  | 'signInWithGoogle' | 'confirmAccountMatch' | 'cancelAccountMatch' | 'signOutAccount' | 'toggleAccountMenu' | 'refreshAccount' | 'enrollMac'
  | 'askDeleteAccount' | 'confirmDeleteAccount' | 'cancelDeleteAccount'
>;

const SIGNED_OUT_TEXT = 'AASC Cloud signed this phone out. Sign in again to see your account’s Macs.';

export function createAccountWiring(host: AccountHost) {
  const { deps } = host;
  let account: AccountInfo | null = null;
  let listed: AccountMac[] = [];
  let status: AccountView['status'] = 'loading';
  let refreshing: Promise<void> | null = null;
  /** The sign-in (or delete) the match-code screen is about (review M2): it holds the verifier, so memory only. */
  let pending: PendingSignIn | null = null;
  /**
   * Where a sheet's answer (sign-in or delete) lands when the lock covered its waiting screen as it came back: on
   * Android the sheet is another activity, so the app resumes from it and may lock first. Shown when the lock gives
   * that screen back (`settle`).
   */
  let landing: (() => Screen) | null = null;
  /**
   * Plan 18: the directory's address hints for the list on show, while they are on their way. Connect waits for
   * this, so it must end: withDirectoryHints bounds its whole step (DIRECTORY_HINTS_MS), whatever that is stuck on.
   */
  let hinting: Promise<void> | null = null;

  function forget(): void {
    account = null;
    listed = [];
    status = 'loading';
  }

  /** Signed out by the cloud (a 401, a revoked phone): the list goes, with a word on why. */
  function signedOutByCloud(notice: string): void {
    forget();
    const s = host.screen();
    if (s.name === 'macs' || s.name === 'pair') host.show(host.home(notice));
  }

  /**
   * Plan 18: ask the account's directory for address hints (a Mac's home-network address) for a list already on
   * show, so the directory never holds the list back. A hint changes no row, so nothing is redrawn; a list that was
   * replaced or forgotten meanwhile keeps what it has. Only this list asks: the delete and revoked checks never do.
   */
  function addHints(base: AccountMac[]): void {
    const mine: Promise<void> = withDirectoryHints(deps, base, host.hintsMs).then((hinted) => {
      if (account && listed === base) listed = hinted;
    }, () => undefined).finally(() => {
      if (hinting === mine) hinting = null;
    });
    hinting = mine;
  }

  async function load(): Promise<void> {
    if (!account) return;
    const out = await listAccountMacs(deps);
    if (!account) return; // signed out meanwhile
    if (out.status === 'signed-out') {
      signedOutByCloud(SIGNED_OUT_TEXT);
      return;
    }
    if (out.status === 'ok') {
      listed = out.macs;
      status = 'ready';
    } else status = out.unreadable ? 'unreadable' : 'unavailable'; // either way the account stays
    if (host.screen().name === 'macs') host.redraw();
    // Only for a Mac still to connect: with every listed Mac saved here, no row is left that a hint could serve.
    if (out.status === 'ok' && unsavedAccountMacs(out.macs, host.macs()).length > 0) addHints(out.macs);
  }

  /** Ask the account for its Macs again; one ask at a time. */
  function refresh(): Promise<void> {
    if (!account) return Promise.resolve();
    refreshing ??= load().catch(() => {
      status = 'unavailable';
    }).finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  /**
   * A sheet came back: show where its answer lands (`to`). Decided by the screen on show, not by `gen`: the lock may
   * have shown, and given the waiting screen back, while the sheet was open, and an answer dropped for that would
   * leave "Waiting for the sign-in page…" up for good. `changed`: the account was signed in or forgotten, so a
   * list or pair screen on show is drawn again as well.
   */
  function land(to: () => Screen, changed: boolean): void {
    const s = host.screen();
    if (s.name === 'locked') landing = to;
    else if ((s.name === 'account-match' && s.busy) || (changed && (s.name === 'macs' || s.name === 'pair'))) host.show(to());
  }

  /** The delete's sheet, and what the phone then says. Forgotten is forgotten whatever shows. */
  async function runDelete(ready: PendingSignIn, signedIn: AccountInfo): Promise<void> {
    const out = await finishAccountDelete(deps, ready, signedIn);
    if (out.forgotten) forget();
    land(() => host.home(out.message), out.forgotten);
  }

  /** The sign-in's sheet. Stored is signed in, whatever shows; a failure goes back to the pair screen with why. */
  async function runSignIn(ready: PendingSignIn): Promise<void> {
    const out = await finishGoogleSignIn(deps, ready, host.phoneName());
    if (!out.ok) {
      land(() => (out.reason === 'cancelled' ? host.pair(out.message) : host.pair(null, out.message)), false);
      return;
    }
    account = out.account;
    status = 'loading';
    land(() => host.home(null), true);
    void refresh();
  }

  const actions: AccountActions = {
    // Review M2: first the code for this sign-in's challenge; the sheet opens only from Continue, with that same one.
    signInWithGoogle: host.guard(async () => {
      const s = host.screen();
      if (s.name !== 'pair' || s.accountBusy || account) return;
      landing = null;
      const my = host.gen();
      host.update({ accountBusy: true, accountError: null, notice: null });
      const ready = await prepareGoogleSignIn(deps);
      if (my !== host.gen()) return;
      if (!ready.ok) {
        host.update({ accountBusy: false, accountError: ready.message });
        return;
      }
      pending = ready;
      host.show({ name: 'account-match', code: ready.matchCode, busy: false });
    }),
    confirmAccountMatch: host.guard(async () => {
      const s = host.screen();
      const ready = pending;
      if (s.name !== 'account-match' || s.busy || !ready || ready.matchCode !== s.code) return;
      pending = null; // one sheet per challenge
      if (ready.intent === 'delete') {
        const signedIn = account;
        if (!signedIn) {
          host.show(host.home(SIGNED_OUT_TEXT)); // signed out meanwhile: nothing here to delete from
          return;
        }
        host.update({ busy: true });
        await runDelete(ready, signedIn);
        return;
      }
      host.update({ busy: true });
      await runSignIn(ready);
    }),
    cancelAccountMatch() {
      if (host.screen().name !== 'account-match') return;
      const wasDelete = pending?.intent === 'delete';
      pending = null;
      host.show(wasDelete ? host.home(null) : host.pair(null));
    },
    // Nov 20 2026: Delete AASC Cloud account… Nothing is made, opened or asked until the confirm step's Continue.
    askDeleteAccount() {
      if (host.screen().name === 'macs' && account && deps.authSession) host.show({ name: 'account-delete' });
    },
    confirmDeleteAccount: host.guard(async () => {
      if (host.screen().name !== 'account-delete') return;
      if (!account) {
        host.show(host.home(SIGNED_OUT_TEXT));
        return;
      }
      landing = null;
      const my = host.gen();
      const ready = await prepareGoogleSignIn(deps, 'delete');
      if (my !== host.gen()) return;
      if (!ready.ok) {
        host.show(host.home(DELETE_TEXT.notOpened));
        return;
      }
      // The same match-code step as a sign-in: the backend's delete page shows this challenge's code too.
      pending = ready;
      host.show({ name: 'account-match', code: ready.matchCode, busy: false });
    }),
    cancelDeleteAccount() {
      if (host.screen().name === 'account-delete') host.show(host.home(null));
    },
    signOutAccount: host.guard(async () => {
      await signOutAccount(deps);
      forget();
      host.show(host.home('Signed out of AASC Cloud. Macs saved on this phone stay.'));
    }),
    toggleAccountMenu() {
      const s = host.screen();
      if (s.name === 'macs') host.update({ accountMenu: !s.accountMenu });
    },
    refreshAccount: () => {
      status = 'loading';
      host.redraw();
      void refresh();
    },
    enrollMac: (deviceId) => host.guard(async () => {
      const s = host.screen();
      const row = listed.find((m) => m.deviceId === deviceId);
      if (!row || s.name !== 'macs' || s.enroll?.step === 'busy') return;
      const my = host.gen();
      host.update({ enroll: { deviceId, step: 'busy', message: `Looking for ${row.name}…` }, notice: null, accountMenu: false });
      await hinting; // plan 18: this list's address hints, if still on their way
      const target = listed.find((m) => m.deviceId === deviceId) ?? row;
      const out = await host.serial(() => enrollViaAccount(deps, host.macs(), target, {
        phoneName: host.phoneName(),
        proceed: () => my === host.gen(),
        onTry: (c) => {
          if (my === host.gen()) host.update({ enroll: { deviceId, step: 'busy', message: host.tryingText({ name: target.name, port: Number(new URL(c.origin).port) }, c) } });
        },
      }));
      if (out.ok) {
        host.setMacs(out.macs); // saved whatever the screen does now
        if (my === host.gen()) await host.open(out.mac);
        else if (host.screen().name === 'macs') host.redraw();
        return;
      }
      if (out.reason === 'signed-out') {
        forget();
        if (my === host.gen()) host.show(host.home(out.message));
        return;
      }
      if (my !== host.gen() || out.reason === 'cancelled') return;
      host.update({ enroll: { deviceId, step: out.reason === 'unreachable' ? 'offline' : 'failed', message: out.message } });
    })(),
  };

  return {
    actions,
    /** Read the account this phone signed in to before (local only); the list follows in the background. */
    async start(): Promise<void> {
      account = await currentAccount(deps).catch(() => null);
      if (account) void refresh();
    },
    signedIn: () => account !== null,
    canSignIn: () => Boolean(deps.authSession) && account === null,
    refresh,
    view(): AccountView | null {
      if (!account) return null;
      return {
        email: account.email, macs: unsavedAccountMacs(listed, host.macs()), listedAny: listed.length > 0, status,
        canDelete: Boolean(deps.authSession),
      };
    },
    /**
     * Every screen about to show passes through here (app.ts `show`). The lock shows the screen from before it
     * again: a sheet whose answer came meanwhile no longer waits for the sign-in page, it shows where that landed.
     */
    settle(next: Screen): Screen {
      if (!landing || next.name !== 'account-match' || !next.busy) return next;
      const to = landing;
      landing = null;
      return to();
    },
  };
}

export type AccountWiring = ReturnType<typeof createAccountWiring>;
