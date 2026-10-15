/**
 * screenSlot — what a phone Screen learns from the stack that hosts it (AASC-38).
 *
 * The frame mounts the shown tab's whole stack, the top screen visible and the
 * ones under it kept (scroll positions survive a pop). Only the top screen
 * registers its scroller, so tapping the active tab scrolls THAT screen to the
 * top. Outside a frame (tests, the gallery's samples) the defaults apply.
 */
import { createContext, useContext } from 'react';

export interface ScreenSlot {
  /** This screen is the one on show. */
  isTop: boolean;
  /** The top screen hands over its scroller (null on unmount). */
  registerScroller: (el: HTMLElement | null) => void;
}

const noop = () => {};

export const ScreenSlotContext = createContext<ScreenSlot>({ isTop: true, registerScroller: noop });

export function useScreenSlot(): ScreenSlot {
  return useContext(ScreenSlotContext);
}
