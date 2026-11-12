// screen.ts — the shell's screens as data, and what a screen can ask the app to do (AASC-17).
import type { AccountMac } from '../accountMacs.js';
import type { Candidate } from '../connectionPlan.js';
import type { DeviceNoun } from '../formFactor.js';
import type { ManualEntry } from '../manualEntry.js';
import type { RawShare } from '../native.js';
import type { PairingLink } from '../pairingLink.js';
import type { SavedMac } from '../savedMacs.js';
import type { ShareTarget } from '../shareToQueue.js';

export type ApproveState = 'waiting' | 'unreachable' | 'stalled' | 'refused' | 'error' | 'cancelling';
export type UnpairStep = 'idle' | 'confirm' | 'busy' | 'unreachable';
/** Plan 17: an account Mac's row — connecting, couldn't be reached (Offline), or refused. */
export type EnrollStep = 'busy' | 'offline' | 'failed';
export type ShareStep = 'pick-mac' | 'loading' | 'pick-session' | 'sending' | 'done' | 'error';

export type Screen =
  | { name: 'needs-app' }
  | {
      name: 'pair';
      notice: string | null;
      error: string | null;
      linkText: string;
      /** The typed-code form, flat so each field is kept on its own. */
      address: string;
      port: string;
      code: string;
      manualOpen: boolean;
      manualError: { field: keyof ManualEntry; message: string } | null;
      /** Plan 17: Sign in with Google under way / why it failed. */
      accountBusy?: boolean;
      accountError?: string | null;
    }
  | { name: 'confirm'; link: PairingLink; allowLan: boolean; phoneName: string; busy: string | null; error: string | null }
  /** Holds the Mac itself: a refusal removes it from the list while this screen still names it. */
  | { name: 'approve'; mac: SavedMac; state: ApproveState; message: string | null }
  /** `unpair`: the row asking "Unpair from …?" (Oct 20 2026); one row at a time. */
  | {
      name: 'macs';
      notice: string | null;
      unpair?: { macId: string; step: Exclude<UnpairStep, 'idle'> } | null;
      /** Plan 17: the account row's menu (Sign out) is open. */
      accountMenu?: boolean;
      /** Plan 17: connecting to one of the account's Macs; `message` is the status line or what went wrong. */
      enroll?: { deviceId: string; step: EnrollStep; message: string | null } | null;
    }
  | { name: 'settings'; macId: string; step: UnpairStep; notice: string | null }
  | { name: 'connecting'; macId: string; back: string; reauth: boolean; status: string }
  /** Nov 10 2026: the Mac answered on its home address with the home network off (lanOffer.ts); asked once. */
  | { name: 'lan-offer'; macId: string; back: string; reauth: boolean }
  | { name: 'offline'; macId: string; back: string; reauth: boolean; tried: Candidate[]; message: string | null }
  /** AASC-21: an item shared from another app, on its way to a session's queue (paused). */
  | {
      name: 'share';
      share: RawShare;
      step: ShareStep;
      macId: string | null;
      origin: string | null;
      targets: ShareTarget[];
      message: string | null;
      added: boolean;
    }
  /**
   * Review M2: before the sign-in sheet opens, the code the backend's confirm page will show for this sign-in's
   * challenge. Only the code (not secret); the verifier, challenge and state stay in accountWiring's memory.
   */
  | { name: 'account-match'; code: string; busy: boolean }
  /** AASC-21: the biometric lock; what follows the unlock is the app's, not the screen's. */
  | { name: 'locked'; busy: boolean; failed: boolean }
  /** AASC-21 / AASC-19: this phone's own settings (lock, notifications). */
  | { name: 'phone'; notice: string | null };

export type ScreenName = Screen['name'];

export interface Actions {
  /** Keep what the user typed on the current screen (no re-render). */
  remember(patch: Partial<Record<string, unknown>>): void;
  /** Change the current screen's state and draw it again (focus stays where it was). */
  update(patch: Partial<Record<string, unknown>>): void;
  scan(): void;
  submitLink(): void;
  submitManual(): void;
  pair(): void;
  cancelPair(): void;
  cancelApproval(macId: string): void;
  checkAgain(macId: string): void;
  open(macId: string): void;
  retry(): void;
  showMacs(): void;
  showPair(): void;
  showSettings(macId: string): void;
  setLanAllowed(macId: string, allowed: boolean): void;
  /** The home-network offer: turn it on and open the Mac over it. */
  useHomeNetwork(macId: string): void;
  /** The home-network offer: keep it off and open the Mac as already found. */
  skipHomeNetwork(macId: string): void;
  askUnpair(macId: string): void;
  unpair(macId: string, force: boolean): void;
  keepPaired(macId: string): void;
  shareTo(macId: string): void;
  shareSession(sessionId: string): void;
  finishShare(): void;
  unlock(): void;
  showPhone(): void;
  setLockEnabled(enabled: boolean): void;
  setRelockMinutes(minutes: number): void;
  /** Plan 17: AASC Cloud sign-in and the account's Macs. */
  signInWithGoogle(): void;
  /** Review M2: the codes match: open the sign-in sheet. */
  confirmAccountMatch(): void;
  cancelAccountMatch(): void;
  signOutAccount(): void;
  toggleAccountMenu(): void;
  refreshAccount(): void;
  enrollMac(deviceId: string): void;
}

/** Plan 17: the signed-in AASC Cloud account, as the screens show it (nothing secret). */
export interface AccountView {
  email: string | null;
  /** The account's Macs no saved row has yet. */
  macs: AccountMac[];
  /** Has the account listed any Mac at all (saved here or not)? */
  listedAny: boolean;
  status: 'loading' | 'ready' | 'unavailable';
}

/** This phone's lock, when the app has biometrics wired (null: no lock on this build). */
export interface LockView {
  available: boolean;
  enabled: boolean;
  relockAfterMinutes: number;
}

export interface ScreenContext {
  macs: readonly SavedMac[];
  scannerAvailable: boolean;
  actions: Actions;
  lock: LockView | null;
  /** What the phone settings say about notifications. */
  pushNote: string;
  /** What the screens call this device: "this phone", "this iPad", "this tablet" (formFactor.ts). */
  device: DeviceNoun;
  /** Plan 17: the signed-in account, or null. */
  account: AccountView | null;
  /** Plan 17: this build has the sign-in sheet and no account is signed in. */
  canSignIn: boolean;
}
