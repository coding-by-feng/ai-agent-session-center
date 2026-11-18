/**
 * sendProceed.ts — the desktop rail's amber P, in one click (Nov 17 2026): sends "proceed" to the
 * session whose last answer asks for it (`owesProceed`), through the Mac's confirmed prompt route
 * (POST /api/sessions/:id/prompt, `mode: 'now'`): the Mac types it, presses Enter until the CLI takes
 * it, and refuses while a dialog is open. Every outcome is a toast. The server clears
 * `pendingProceedAt` on the prompt, so the P goes away by itself.
 *
 * Lives in lib/chat with the route's client; the rail loads it with `import()` on click, so it stays
 * out of the desktop's entry chunk (phoneChunkBoundary.test.ts).
 */
import { showToast } from '@/components/ui/ToastContainer';
import { DEFAULT_QUICK_REPLY } from './quickReply';
import { promptOutcome, sendPrompt, waitForPrompt } from './promptApi';

export const PROCEED_TEXT = DEFAULT_QUICK_REPLY;

const sending = new Set<string>();

/** Send "proceed" to `sessionId`. Resolves to whether the CLI took it. Never throws. */
export async function sendProceed(sessionId: string): Promise<boolean> {
  if (sending.has(sessionId)) return false;
  sending.add(sessionId);
  try {
    const posted = await sendPrompt(sessionId, { text: PROCEED_TEXT, mode: 'now' });
    if (!posted.ok) {
      showToast(posted.error.message, 'error');
      return false;
    }
    const result = await waitForPrompt(sessionId, posted.key);
    if (result !== 'submitted' && result !== 'unconfirmed') {
      const outcome = promptOutcome(result);
      showToast(outcome.message, outcome.unsure ? 'info' : 'error');
      return false;
    }
    showToast(`Sent “${PROCEED_TEXT}”`, 'success');
    return true;
  } catch {
    showToast(`Couldn’t send “${PROCEED_TEXT}”. Try again.`, 'error');
    return false;
  } finally {
    sending.delete(sessionId);
  }
}
