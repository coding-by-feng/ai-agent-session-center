/**
 * @module dialogCloseWatch
 * Ends a session's approval/input wait as soon as the user answers the dialog in its
 * terminal, instead of waiting for the agent's next hook.
 *
 * The hook that normally ends a wait can be minutes away: a subagent's dialog clears
 * only on that subagent's own next event (pendingRequests.ts), and an approved Bash
 * sends its PostToolUse only when the command finishes. Until then the card kept its
 * "!" badge and the alarm kept ringing while the terminal already showed the agent
 * working again. So after someone types into a waiting session's terminal, read the
 * screen: once the live working spinner is back, the dialog is gone.
 *
 * A keystroke alone proves nothing: moving through a dialog's options, or a second
 * queued dialog, leaves the session waiting, and no spinner comes back for those.
 */
import { BUSY_SPINNER_RE } from './approvalDetector.js';
import { stripAnsi } from '../src/lib/ansi.js';

/** When to look at the screen after the last keystroke (ms). */
export const DIALOG_CLOSE_CHECKS_MS: readonly number[] = [400, 1200, 2500];

/**
 * Footer and prompt lines of the CLIs' dialogs: Claude's permission and question
 * dialogs ("Do you want to proceed?", "Enter to select · … · Esc to cancel") and
 * Codex's approvals ("Allow command?", "Press enter to confirm or esc to cancel").
 */
const DIALOG_MARKERS = ['Do you want to', 'Would you like to', 'Esc to cancel', 'Enter to select', 'enter to confirm', 'Allow command?'];
/** Cursor moves stand in for spaces once escapes are stripped ("Doyouwanttoproceed?"). */
const looseWords = (phrase: string): string =>
  phrase.split(' ').map((w) => w.replace(/[?]/g, '\\?')).join('\\s*');
const DIALOG_MARKER_RE = new RegExp(DIALOG_MARKERS.map(looseWords).join('|'), 'gi');
/**
 * Busy cues: the spinner with its elapsed time, or the footer's "esc to interrupt".
 * Claude redraws only the characters that change, so the whole spinner line is written
 * once per full redraw; the footer comes with the redraw that follows the answer.
 */
const BUSY_CUE_RE = new RegExp(`${BUSY_SPINNER_RE.source}|esc\\s*to\\s*interrupt`, 'gi');

/** Index of the last match of a global regex in `text`, or -1. */
function lastMatchIndex(re: RegExp, text: string): number {
  let last = -1;
  for (const m of text.matchAll(re)) last = m.index ?? last;
  return last;
}

/**
 * Has the dialog closed with the agent working again? The ring holds raw redraws, so a
 * spinner drawn just before the dialog opened is still in the tail under it: a busy cue
 * counts only when it was drawn after the last dialog line.
 */
export function dialogClosedAndBusy(output: string | null | undefined): boolean {
  if (!output) return false;
  const tail = stripAnsi(output).slice(-3000);
  const spinner = lastMatchIndex(BUSY_CUE_RE, tail);
  return spinner >= 0 && spinner > lastMatchIndex(DIALOG_MARKER_RE, tail);
}

export interface DialogCloseDeps {
  /** Is the session on this terminal waiting for the user (approval / input)? Called per keystroke: keep it cheap. */
  isAwaitingAnswer: (terminalId: string) => boolean;
  /** The terminal's recent output, or null when it is gone. */
  readTail: (terminalId: string) => string | null;
  /** Put the session back to working. Returns false when it had already moved on. */
  release: (terminalId: string) => boolean;
}

export interface DialogCloseWatch {
  /** Someone typed into this terminal. */
  noteInput: (terminalId: string) => void;
  /** Drop every pending check (shutdown, tests). */
  stopAll: () => void;
}

export function createDialogCloseWatch(deps: DialogCloseDeps): DialogCloseWatch {
  /** terminalId -> the checks scheduled after its latest keystroke */
  const pending = new Map<string, ReturnType<typeof setTimeout>[]>();

  const cancel = (terminalId: string): void => {
    for (const t of pending.get(terminalId) ?? []) clearTimeout(t);
    pending.delete(terminalId);
  };

  const check = (terminalId: string, last: boolean): void => {
    if (!deps.isAwaitingAnswer(terminalId)) {
      cancel(terminalId); // a hook got there first
      return;
    }
    if (dialogClosedAndBusy(deps.readTail(terminalId))) {
      cancel(terminalId);
      deps.release(terminalId);
      return;
    }
    if (last) pending.delete(terminalId);
  };

  return {
    noteInput(terminalId) {
      if (!deps.isAwaitingAnswer(terminalId)) return;
      // Restart from the latest keystroke: an answer is often several keys (arrow, Enter).
      cancel(terminalId);
      const lastIdx = DIALOG_CLOSE_CHECKS_MS.length - 1;
      pending.set(terminalId, DIALOG_CLOSE_CHECKS_MS.map((ms, i) =>
        setTimeout(() => check(terminalId, i === lastIdx), ms)));
    },
    stopAll() {
      for (const id of [...pending.keys()]) cancel(id);
    },
  };
}
