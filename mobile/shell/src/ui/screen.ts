// screen.ts — the shell's screens as data, and what a screen can ask the app to do (AASC-17).
import type { Candidate } from '../connectionPlan.js';
import type { ManualEntry } from '../manualEntry.js';
import type { PairingLink } from '../pairingLink.js';
import type { SavedMac } from '../savedMacs.js';

export type ApproveState = 'waiting' | 'unreachable' | 'stalled' | 'refused' | 'error' | 'cancelling';
export type UnpairStep = 'idle' | 'confirm' | 'busy' | 'unreachable';

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
  | { name: 'macs'; notice: string | null }
  | { name: 'settings'; macId: string; step: UnpairStep; notice: string | null }
  | { name: 'connecting'; macId: string; back: string; reauth: boolean; status: string }
  | { name: 'offline'; macId: string; back: string; reauth: boolean; tried: Candidate[]; message: string | null };

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
}

export interface ScreenContext {
  macs: readonly SavedMac[];
  scannerAvailable: boolean;
  actions: Actions;
}
