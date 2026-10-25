/**
 * HandsOffToggle — the person's switch that keeps every central (server/mcp) from typing into one session,
 * handing it a task or queuing work for it. Centrals can still read it. An icon button in the title's actions,
 * right after Pin (SessionSwitcher): the shared IconButton as a toggle, one name ("Hands off"), the state in
 * aria-pressed and in the glyph (a ring while off, a disc while on) and the tooltip's words. It has no word of
 * its own on purpose: a labelled button here squeezed the title to nothing in a 1100px top bar.
 *
 * It does not flip until the server says it took the change. "On" is a protection, so a switch that shows it
 * while the server refused would be a lie: a click waits for the answer, then shows what the server said; a
 * refusal or a failure leaves the state as it was and says why. The answer is applied to the session store at
 * once (the server's own `session_update` follows and says the same), so the button does not lag behind its
 * own click.
 *
 * While the request is out the button is busy, not disabled: a disabled button drops keyboard focus (Chromium
 * resets it to the page and never gives it back), which would throw a person who pressed Space out of the
 * title's actions. It stays enabled and focused, says `aria-busy`, looks quieter (HandsOffToggle.module.css)
 * and ignores clicks until the answer is in.
 *
 * It is offered only where it can work: this Mac, with central sessions on (`mcpStore.available`), and never on
 * a central itself, which no central steers.
 */
import { useCallback, useRef, useState } from 'react';
import type { Session } from '@/types';
import { useMcpStore } from '@/stores/mcpStore';
import { useSessionStore } from '@/stores/sessionStore';
import { handsOffFailureText, putHandsOff } from '@/lib/handsOff';
import { tooltips } from '@/lib/tooltips';
import { showToast } from '@/components/ui/ToastContainer';
import IconButton from '@/components/ui/IconButton';
import { HandsOffIcon } from '@/components/ui/icons';
import styles from '@/styles/modules/HandsOffToggle.module.css';

interface HandsOffToggleProps {
  session: Session;
}

/**
 * What switching it on says, at the moment a person wonders about the task a central was handing over: a task AASC
 * was still typing in stops (before AASC types more of it), and one the session is already running is not touched.
 * Two sentences, so it stays up longer than a toast's default.
 */
const HANDS_OFF_ON_TEXT =
  'Hands off: centrals can read this session but not steer it. ' +
  'A task AASC is still typing in stops; one already running keeps going until it ends or you stop it.';
const HANDS_OFF_ON_MS = 6000;

/** The card as the store now holds it, with the flag set or (when off) removed: absent means a central may steer it. */
function applyHandsOff(sessionId: string, on: boolean): void {
  const current = useSessionStore.getState().sessions.get(sessionId);
  if (!current) return;
  // `replacesId` is a one-shot of the update that re-keyed the card: not carried into this one.
  const { handsOff: _before, replacesId: _rekey, ...rest } = current;
  void _before;
  void _rekey;
  useSessionStore.getState().updateSession(on ? { ...rest, handsOff: true } : rest);
}

export default function HandsOffToggle({ session }: HandsOffToggleProps) {
  const available = useMcpStore((s) => s.available);
  const [busy, setBusy] = useState(false);
  // The guard itself is a ref, not the state: two clicks in one tick would both read `busy` as false.
  const inFlight = useRef(false);
  const on = session.handsOff === true;
  const sessionId = session.sessionId;

  const handleToggle = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const result = await putHandsOff(sessionId, !on);
      if (!result.ok) {
        showToast(handsOffFailureText(result.reason), 'error');
        return;
      }
      applyHandsOff(sessionId, result.handsOff);
      if (result.handsOff) showToast(HANDS_OFF_ON_TEXT, 'info', HANDS_OFF_ON_MS);
      else showToast('Centrals may steer this session again', 'info');
    } finally {
      // Always let go, so a failure can never leave the switch stuck.
      inFlight.current = false;
      setBusy(false);
    }
  }, [on, sessionId]);

  if (available !== true || session.central) return null;

  const copy = on ? tooltips.ctrlHandsOffOn : tooltips.ctrlHandsOffOff;
  return (
    <IconButton
      size="sm"
      label={copy.label}
      ariaLabel="Hands off"
      description={copy.description}
      pressed={on}
      className={busy ? styles.busy : undefined}
      aria-busy={busy || undefined}
      // As Pin does (SessionSwitcher): a click must not take focus from the terminal, or the Space or Enter meant for
      // the terminal would press this again. Keyboard focus is untouched: Tab still lands here and Space presses it.
      onMouseDown={(e) => e.preventDefault()}
      onClick={handleToggle}
    >
      <HandsOffIcon filled={on} />
    </IconButton>
  );
}
