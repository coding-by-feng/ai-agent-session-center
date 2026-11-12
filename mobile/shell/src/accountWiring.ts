// accountWiring.ts — AASC Cloud sign-in and the account's Macs wired into the app (plan 17).
// app.ts owns the screens and the boot order; this owns the account state between screens: who is
// signed in (email and host only: the token stays in the vault) and what the account lists.
import { enrollViaAccount } from './accountEnroll.js';
import { listAccountMacs, unsavedAccountMacs, type AccountMac } from './accountMacs.js';
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
}

export type AccountActions = Pick<
  Actions, 'signInWithGoogle' | 'confirmAccountMatch' | 'cancelAccountMatch' | 'signOutAccount' | 'toggleAccountMenu' | 'refreshAccount' | 'enrollMac'
>;

export function createAccountWiring(host: AccountHost) {
  const { deps } = host;
  let account: AccountInfo | null = null;
  let listed: AccountMac[] = [];
  let status: AccountView['status'] = 'loading';
  let refreshing: Promise<void> | null = null;
  /** The sign-in the match-code screen is about (review M2): it holds the verifier, so memory only. */
  let pending: PendingSignIn | null = null;

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

  async function load(): Promise<void> {
    if (!account) return;
    const out = await listAccountMacs(deps);
    if (!account) return; // signed out meanwhile
    if (out.status === 'signed-out') {
      signedOutByCloud('AASC Cloud signed this phone out. Sign in again to see your account’s Macs.');
      return;
    }
    if (out.status === 'ok') {
      listed = out.macs;
      status = 'ready';
    } else status = 'unavailable';
    if (host.screen().name === 'macs') host.redraw();
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

  const actions: AccountActions = {
    // Review M2: first the code for this sign-in's challenge; the sheet opens only from Continue, with that same one.
    signInWithGoogle: host.guard(async () => {
      const s = host.screen();
      if (s.name !== 'pair' || s.accountBusy || account) return;
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
      const my = host.gen();
      host.update({ busy: true });
      const out = await finishGoogleSignIn(deps, ready, host.phoneName());
      if (my !== host.gen()) return;
      if (!out.ok) {
        host.show(out.reason === 'cancelled' ? host.pair(out.message) : host.pair(null, out.message));
        return;
      }
      account = out.account;
      status = 'loading';
      host.show(host.home(null));
      void refresh();
    }),
    cancelAccountMatch() {
      if (host.screen().name !== 'account-match') return;
      pending = null;
      host.show(host.pair(null));
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
      const target = listed.find((m) => m.deviceId === deviceId);
      if (!target || s.name !== 'macs' || s.enroll?.step === 'busy') return;
      const my = host.gen();
      host.update({ enroll: { deviceId, step: 'busy', message: `Looking for ${target.name}…` }, notice: null, accountMenu: false });
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
      return { email: account.email, macs: unsavedAccountMacs(listed, host.macs()), listedAny: listed.length > 0, status };
    },
  };
}

export type AccountWiring = ReturnType<typeof createAccountWiring>;
