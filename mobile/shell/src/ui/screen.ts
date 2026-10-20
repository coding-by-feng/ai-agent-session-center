// screen.ts — the shell's screens as data, and what a screen can ask the app to do (AASC-17).
import type { Candidate } from '../connectionPlan.js';
import type { ManualEntry } from '../manualEntry.js';
import type { RawShare } from '../native.js';
import type { PairingLink } from '../pairingLink.js';
import type { SavedMac } from '../savedMacs.js';
import type { ShareTarget } from '../shareToQueue.js';

export type ApproveState = 'waiting' | 'unreachable' | 'stalled' | 'refused' | 'error' | 'cancelling';
export type UnpairStep = 'idle' | 'confirm' | 'busy' | 'unreachable';
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
    }
  | { name: 'confirm'; link: PairingLink; allowLan: boolean; phoneName: string; busy: string | null; error: string | null }
  /** Holds the Mac itself: a refusal removes it from the list while this screen still names it. */
  | { name: 'approve'; mac: SavedMac; state: ApproveState; message: string | null }
  /** `unpair`: the row asking "Unpair from …?" (Oct 20 2026); one row at a time. */
  | { name: 'macs'; notice: string | null; unpair?: { macId: string; step: Exclude<UnpairStep, 'idle'> } | null }
  | { name: 'settings'; macId: string; step: UnpairStep; notice: string | null }
  | { name: 'connecting'; macId: string; back: string; reauth: boolean; status: string }
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
}
