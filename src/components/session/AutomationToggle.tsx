/**
 * AutomationToggle — the person's mark for an unattended session: lite hooks (server/sessionHookLevel.ts). The
 * session's agent sends only start, prompt, approval, stop and end, so a long automated run costs the dashboard
 * less; its tool activity and subagents stop showing live.
 *
 * An icon button in the title's actions, after Hands off (SessionSwitcher), on the same pattern: the shared
 * IconButton as a toggle, the state in aria-pressed and in the glyph (an outlined gear while off, a solid one while
 * on), the words in the tooltip. Not a fourth labelled toggle beside Mute / Share / Alert: those three already fill
 * the 230px docked-left rail.
 *
 * The mark is read when the agent's terminal starts, so a change reaches it at its next launch: while an agent
 * runs, the toast offers Restart now (a busy session is asked first, as the toolbar's Restart does).
 *
 * Offered only where it can work: a session on this computer (the variable lives in this Mac's PTY), in the Full
 * edition. A marked session on another host still shows it, so the mark can be cleared.
 */
import { useCallback } from 'react';
import type { Session } from '@/types';
import { useSessionStore } from '@/stores/sessionStore';
import { automationChangedMessage, canUseAutomation, isAutomation } from '@/lib/sessionHookLevel';
import { restartConfirmMessage, restartNeedsConfirm, requestSessionRestart } from '@/lib/restartSession';
import { sessionDisplayTitle } from '@/lib/sessionDisplayTitle';
import { IS_LITE } from '@/lib/edition';
import { tooltips } from '@/lib/tooltips';
import { showToast } from '@/components/ui/ToastContainer';
import IconButton from '@/components/ui/IconButton';
import { AutomationIcon } from '@/components/ui/icons';

interface AutomationToggleProps {
  session: Session;
}

/** Long enough to reach the Restart now action. */
const RESTART_OFFER_MS = 8000;

async function restartFromToast(sessionId: string): Promise<void> {
  const live = useSessionStore.getState().sessions.get(sessionId);
  if (restartNeedsConfirm(live?.status) && !window.confirm(restartConfirmMessage(sessionDisplayTitle(live)))) return;
  const restart = await requestSessionRestart(sessionId);
  if (!restart.ok) showToast(restart.error, 'error');
}

export default function AutomationToggle({ session }: AutomationToggleProps) {
  const setHookLevel = useSessionStore((s) => s.setHookLevel);
  const on = isAutomation(session);
  const sessionId = session.sessionId;

  const handleToggle = useCallback(async () => {
    const result = await setHookLevel(sessionId, !on);
    if (!result.ok) {
      showToast(result.error, 'error');
      return;
    }
    const message = automationChangedMessage(!on, result.appliesOnRestart);
    // Restart opens a fresh dashboard terminal: a card with none (an agent started outside AASC) gets the words only.
    if (!result.appliesOnRestart || !session.terminalId) {
      showToast(message, 'info');
      return;
    }
    showToast(message, 'info', RESTART_OFFER_MS, {
      label: 'Restart now',
      onClick: () => { void restartFromToast(sessionId); },
    });
  }, [on, session.terminalId, sessionId, setHookLevel]);

  if (IS_LITE || (!on && !canUseAutomation(session))) return null;

  const copy = on ? tooltips.ctrlAutomationOn : tooltips.ctrlAutomationOff;
  return (
    <IconButton
      size="sm"
      label={copy.label}
      ariaLabel="Automation"
      description={copy.description}
      pressed={on}
      // As Pin and Hands off do: a click must not take focus from the terminal.
      onMouseDown={(e) => e.preventDefault()}
      onClick={handleToggle}
      data-testid="automation-toggle"
    >
      <AutomationIcon filled={on} />
    </IconButton>
  );
}
