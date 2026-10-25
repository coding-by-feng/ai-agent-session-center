// handsOffSetter.ts — the hands-off switch as the dashboard's route is handed it (server/index.ts).
//
// The store's setter broadcasts the flipped card at once, and a window replaces its whole card with every
// `session_update`. A hook update still held in hookProcessor's 250 ms throttle was copied from the card before the
// flip: sent after it, that copy puts the old flag back on every window until the session reports in again, and the
// toggle reads wrong meanwhile (Ruling 55). So the held update is brought up to date with the card the setter
// answers. The store cannot do this itself, because hookProcessor imports the store; the copy waiting in the
// store's own 20 ms batch is dropped by `setSessionHandsOff`.
//
// Turning it ON for a session that is a central's own worker also makes that worker the person's: it is released and
// the run its central left in its queue is paused (centralRun.ts, Ruling P4-30). A person's own session is untouched.

import type { Session } from '../../src/types/session.js';
import { handsOffTurnedOn } from './centralRun.js';

/** Sets or clears the flag on a session, and answers the card as it now is, or null when there is none. */
export type HandsOffSetter = (sessionId: string, on: boolean) => Session | null;

/**
 * `set` (sessionStore's `setSessionHandsOff`), followed by `refreshHeldUpdate` (hookProcessor's
 * `refreshPendingSessionUpdate`) for the card it answers. The held update is looked up under the card's own id, the one
 * the hook pipeline holds it under, whichever (re-keyed) id the caller used. When the switch turned on, `turnedOn` is
 * told the card (by default the handler deliverWiring.ts installs: centralRun.ts `releaseOnHandsOff`).
 */
export function createHandsOffSetter(
  set: HandsOffSetter,
  refreshHeldUpdate: (sessionId: string, card: Session) => void,
  turnedOn: (card: Session) => void = handsOffTurnedOn,
): HandsOffSetter {
  return (sessionId, on) => {
    const card = set(sessionId, on);
    if (card !== null) refreshHeldUpdate(card.sessionId, card);
    if (card !== null && on) turnedOn(card);
    return card;
  };
}
