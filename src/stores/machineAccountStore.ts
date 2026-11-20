/**
 * machineAccountStore — the saves of the devices panel's "Account" group (plan 18 stage 2): what this computer
 * tells and allows its AASC Cloud account, and the ticks still on their way to the server.
 *
 * One queue for the page, not one per mounted group. The group unmounts whenever its panel closes or the Switch
 * tab is pressed, and a tick made a moment before that still has to be saved (the person asked for it). Kept in
 * the group, the queue would die with it; kept here, it finishes, and a group mounted again while saves are still
 * going out shows them and builds its next tick on their answers instead of on a read that is already stale.
 *
 * ## The rule
 *
 * One save at a time. Each tick is saved on top of what the save before it ANSWERED, never on the values from
 * before it, so two quick ticks cannot undo each other. The server takes the three settings whole, so a tick is
 * kept as the smallest change (`AccountChange`) and turned into a whole choice only when its turn comes. A save
 * that fails drops the ticks waiting behind it: the boxes then show exactly what is saved, and the error says why.
 *
 * `saved` is null before the first read, and on a computer with no account UI to show (`publisher.state:
 * 'no-cloud'`, or a server without the route).
 */
import { create } from 'zustand';
import {
  saveMachineSettings,
  type AccountAddressKind, type ComputerEnrollMode, type MachineAccountChoice, type MachineAccountSettings,
} from '@/lib/machineAccountApi';

/** One tick: the smallest thing a person can change. */
export type AccountChange =
  | { set: 'showOnAccount'; to: boolean }
  | { set: 'address'; kind: AccountAddressKind; to: boolean }
  | { set: 'computerEnroll'; to: ComputerEnrollMode };

function applyChange(choice: MachineAccountChoice, change: AccountChange): MachineAccountChoice {
  if (change.set === 'showOnAccount') return { ...choice, showOnAccount: change.to };
  if (change.set === 'computerEnroll') return { ...choice, computerEnroll: change.to };
  return { ...choice, addresses: { ...choice.addresses, [change.kind]: change.to } };
}

function choiceOf(settings: MachineAccountSettings): MachineAccountChoice {
  return { showOnAccount: settings.showOnAccount, addresses: settings.addresses, computerEnroll: settings.computerEnroll };
}

/** What the boxes show: the saved settings with the ticks still waiting to be saved on top. */
export function withWaiting(saved: MachineAccountSettings, waiting: readonly AccountChange[]): MachineAccountSettings {
  return { ...saved, ...waiting.reduce(applyChange, choiceOf(saved)) };
}

/** Settings worth showing, or null: a computer not signed in to AASC Cloud shows no account UI at all (AASC-64). */
function shown(settings: MachineAccountSettings | null): MachineAccountSettings | null {
  return settings !== null && settings.publisher.state !== 'no-cloud' ? settings : null;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface MachineAccountState {
  /** What the server last answered. */
  saved: MachineAccountSettings | null;
  /** Ticks not saved yet, oldest first; a save is out for the first. */
  waiting: AccountChange[];
  saving: boolean;
  /** Why the last save failed, as the server (or the API client) said it; gone at the next tick. */
  error: string | null;
  /**
   * Take what a read answered. Ignored while saves are out: their answers are newer than any read made meanwhile.
   * `opening`: the read a group makes when it mounts, which also clears an error left from an earlier visit.
   */
  adopt: (settings: MachineAccountSettings | null, opening?: boolean) => void;
  /** One tick: shown at once, saved in its turn. */
  change: (tick: AccountChange) => void;
}

export const useMachineAccountStore = create<MachineAccountState>((set, get) => {
  const drain = async (): Promise<void> => {
    if (get().saving) return;
    set({ saving: true });
    for (;;) {
      const { saved, waiting } = get();
      if (saved === null || waiting.length === 0) break;
      try {
        const answer = shown(await saveMachineSettings(applyChange(choiceOf(saved), waiting[0])));
        // Ticks made while this save was out are behind it in the list; with nothing to show, none can be saved.
        set((s) => ({ saved: answer, waiting: answer === null ? [] : s.waiting.slice(1) }));
      } catch (err) {
        set({ waiting: [], error: errorText(err) });
      }
    }
    set({ saving: false });
  };

  return {
    saved: null,
    waiting: [],
    saving: false,
    error: null,
    adopt: (settings, opening = false) => {
      if (get().saving) return;
      set(opening ? { saved: shown(settings), error: null } : { saved: shown(settings) });
    },
    change: (tick) => {
      if (get().saved === null) return;
      set((s) => ({ waiting: [...s.waiting, tick], error: null }));
      void drain();
    },
  };
});
