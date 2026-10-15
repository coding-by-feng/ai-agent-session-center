/**
 * PhoneFloatingSheet — an AI popup (a floating fork) on a phone (AASC-20).
 *
 * The desktop floats it in a draggable window or pops it out into one; a phone
 * has neither, so it gets the full height of the screen as a sheet, with the
 * terminal's phone face (key bar, compose box, actions sheet) inside. Pop-out,
 * minimize-to-pill and resizing have no phone meaning and are not offered.
 *
 * The session exists before any of this is drawn (see the floating-fork
 * invariants): the sheet only shows it. Closing the sheet (×, Escape, the
 * backdrop) HIDES the popup and leaves it running, and Info → AI popups
 * ("Open") brings it back; only "End" closes it, after a confirm, through the store's
 * close(), which saves the answer under AI POPUPS before the terminal is killed.
 */
import { useCallback, useMemo, useState } from 'react';
import BottomSheet, { ConfirmSheet } from '@/components/ui/BottomSheet';
import Button from '@/components/ui/Button';
import TerminalContainer from '@/components/terminal/TerminalContainer';
import { useFloatingSessionsStore, type FloatingSession } from '@/stores/floatingSessionsStore';
import { useSessionStore } from '@/stores/sessionStore';
import { useWsStore } from '@/stores/wsStore';
import type { Session } from '@/types';
import styles from '@/styles/modules/PhoneExtras.module.css';

export interface PhoneFloatingSheetProps {
  /** The shown session's popups, oldest first. */
  floats: readonly FloatingSession[];
}

/** The session a popup's terminal belongs to, once its first hook has landed. */
function sessionIdOfTerminal(sessions: ReadonlyMap<string, Session>, terminalId: string): string | null {
  for (const s of sessions.values()) if (s.terminalId === terminalId) return s.sessionId;
  return null;
}

export default function PhoneFloatingSheet({ floats }: PhoneFloatingSheetProps) {
  const shownId = useFloatingSessionsStore((s) => s.phoneShown);
  const setShown = useFloatingSessionsStore((s) => s.setPhoneShown);
  const closeFloat = useFloatingSessionsStore((s) => s.close);
  const shown = floats.find((f) => f.terminalId === shownId) ?? null;
  const [confirmEnd, setConfirmEnd] = useState(false);

  // Same socket rule as FloatingTerminalPanel: re-derive on reconnect.
  const client = useWsStore((s) => s.client);
  const connected = useWsStore((s) => s.connected);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `connected` swaps the socket inside the stable client
  const ws = useMemo(() => client?.getRawSocket() ?? null, [client, connected]);

  // The popup's own session drives the baton (typing from a phone) and read-aloud.
  const ownSessionId = useSessionStore((s) => (shown ? sessionIdOfTerminal(s.sessions, shown.terminalId) : null));

  // Stable: BottomSheet re-runs its focus effect whenever onClose changes.
  const hide = useCallback(() => setShown(null), [setShown]);
  const cancelEnd = useCallback(() => setConfirmEnd(false), []);
  const end = useCallback(() => {
    setConfirmEnd(false);
    if (shown) closeFloat(shown.terminalId);
  }, [shown, closeFloat]);

  return (
    <>
      <BottomSheet
        open={!!shown}
        onClose={hide}
        title={shown?.label ?? 'AI popup'}
        fullHeight
        flush
        headerAction={(
          <Button variant="danger" className={styles.floatEnd} onClick={() => setConfirmEnd(true)}>
            End
          </Button>
        )}
      >
        {shown && (
          <div className={styles.floatBody} data-testid="phone-float-sheet">
            {floats.length > 1 && (
              <div className={styles.floatBar}>
                <div className={styles.floatChips} role="group" aria-label="AI popups">
                  {floats.map((f, i) => (
                    <button
                      key={f.terminalId}
                      type="button"
                      className={styles.floatChip}
                      aria-pressed={f.terminalId === shown.terminalId}
                      onClick={() => setShown(f.terminalId)}
                      title={f.label}
                    >
                      {i + 1}. {f.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className={styles.floatTerminal}>
              <TerminalContainer
                terminalId={shown.terminalId}
                ws={ws}
                showReconnect={false}
                // The ROOT session, as on the desktop: lookups and float scoping.
                originSessionId={shown.originSessionId}
                controlSessionId={ownSessionId}
                inSheet
              />
            </div>
          </div>
        )}
      </BottomSheet>
      <ConfirmSheet
        open={confirmEnd && !!shown}
        title="End this AI popup?"
        message="Its terminal closes. The answer so far is kept under AI POPUPS."
        confirmLabel="End popup"
        danger
        onConfirm={end}
        onCancel={cancelEnd}
      />
    </>
  );
}
