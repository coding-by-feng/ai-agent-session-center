/**
 * @module liveHint
 * The one-time tip on the LIVE board: "Open a session: click its card, or
 * press LIVE." LIVE is already the active tab when the app
 * opens, so its highlight reads as "you are here", not "click me"; the tip is
 * about OPENING a session, and the LIVE tab carries a dot while it is up so
 * the word has something to point at.
 *
 * Retired for good on this device (uiStore.liveHintDismissed) by its ✕, by a
 * card click or by a LIVE click: the three things it teaches. Opening a
 * session some other way (a new session auto-selected, Cmd+E) does not retire
 * it, since that does not show the user how to come back from the board.
 * Import-free.
 */

export const LIVE_HINT_STORAGE_KEY = 'live-hint-dismissed';

export interface LiveHintInputs {
  dismissed: boolean;
  onLiveRoute: boolean;
  /** The board exists only with the 3D scene off. */
  scene3dEnabled: boolean;
  /** On a phone the agent list is the page; there is no board. */
  isMobile: boolean;
  /** The board is on screen: loaded, and at least one session listed. */
  boardShown: boolean;
  /** A session panel covers the page (selected and not minimized). */
  panelOpen: boolean;
}

export function shouldShowLiveHint(i: LiveHintInputs): boolean {
  return !i.dismissed && i.onLiveRoute && !i.scene3dEnabled && !i.isMobile && i.boardShown && !i.panelOpen;
}

/** How far into the bubble the caret sits when nothing pushes it. */
export const CARET_INSET = 24;
/** The caret never comes closer than this to either end of the bubble. */
export const CARET_MIN = 16;

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/**
 * Where the bubble goes, so its caret points at the LIVE tab. Viewport
 * coordinates in (the tab's centre, the board's content box); out, the
 * bubble's offset from the board's left edge and the caret's offset from the
 * bubble's left edge. The bubble never leaves the board, whose padding is the
 * gutter to the window edge.
 */
export function placeLiveHint(input: {
  anchorCenter: number;
  containerLeft: number;
  containerWidth: number;
  bubbleWidth: number;
}): { left: number; caretX: number } {
  const anchor = input.anchorCenter - input.containerLeft;
  const maxLeft = Math.max(0, input.containerWidth - input.bubbleWidth);
  const left = Math.round(clamp(anchor - CARET_INSET, 0, maxLeft));
  const caretX = Math.round(clamp(anchor - left, CARET_MIN, Math.max(CARET_MIN, input.bubbleWidth - CARET_MIN)));
  return { left, caretX };
}
