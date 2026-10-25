/**
 * "It is ready — send anyway" (Ruling P4-54): the person's release of the `not-started` queue hold on one card, in
 * this window only.
 *
 * Local by design — never synced to the server or another window, never persisted, and no tool or route a central can
 * reach sets it. A release is tied to the card (session id + terminal): a replaced card gets the hold back.
 *
 * Only the window that fires the queue can honour a release (Ruling P4-57), so only it offers one: the scheduler
 * opens `releaseWindow` while it is mounted and this device fires the queue.
 */
import { create } from 'zustand';

interface Card {
  sessionId: string;
  terminalId: string | null;
}

const keyOf = (card: Card): string => `${card.sessionId}\u0000${card.terminalId ?? ''}`;

interface StartReleaseState {
  released: ReadonlySet<string>;
  /** True while this window's scheduler is mounted and fires the queue. */
  releaseWindow: boolean;
  release: (card: Card) => void;
}

export const useStartReleaseStore = create<StartReleaseState>((set) => ({
  released: new Set(),
  releaseWindow: false,
  release: (card) => set((state) => ({ released: new Set([...state.released, keyOf(card)]) })),
}));

/** Non-reactive read, for the scheduler's tick. */
export function isStartReleased(card: Card): boolean {
  return useStartReleaseStore.getState().released.has(keyOf(card));
}

/** Reactive read, for the queue panel. */
export function useIsStartReleased(card: Card | null | undefined): boolean {
  return useStartReleaseStore((state) => (card ? state.released.has(keyOf(card)) : false));
}

/** The scheduler's call: open the window while it fires the queue, close it when it stops or unmounts. */
export function setReleaseWindow(on: boolean): void {
  if (useStartReleaseStore.getState().releaseWindow === on) return;
  useStartReleaseStore.setState({ releaseWindow: on });
}

/** Non-reactive read of the window flag. */
export function isReleaseWindow(): boolean {
  return useStartReleaseStore.getState().releaseWindow;
}

/** Reactive read: may this window release a hold? */
export function useIsReleaseWindow(): boolean {
  return useStartReleaseStore((state) => state.releaseWindow);
}
