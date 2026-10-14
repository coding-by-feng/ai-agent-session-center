/**
 * terminalCompose — what the phone's compose box and key bar send to a terminal
 * (AASC-18), and why a write failed when it did.
 *
 * The compose box submits the way the queue does (`terminalSend.ts`): the whole
 * text in one write, then Enter as a write of its own after a short pause. A
 * single `text + "\r"` write reads to Claude Code and Codex as a paste, and the
 * trailing carriage return lands as a newline in the input box instead of
 * submitting it. One tap of Send is still one action: the text, then its Enter.
 *
 * Unlike `sendPromptToTerminal`, a failure here says why, because a phone has
 * two refusals a person can act on: another device holds the session's control
 * baton (409 CONTROL_HELD), or the agent is no longer the terminal's foreground
 * program, so the keystrokes would reach the shell underneath (409
 * AGENT_NOT_RUNNING, server/mobile/phoneProfile.ts).
 */
import { SUBMIT_ENTER_DELAY_MS } from './terminalSend';

/** The keys on the phone's key bar, in the order they are drawn. */
export const PHONE_KEYS = ['esc', 'tab', 'up', 'down', '1', '2', '3', 'enter'] as const;
export type PhoneKey = (typeof PHONE_KEYS)[number];

/** The bytes each key writes. Arrows match the terminal toolbar's (`useTerminal`). */
export const PHONE_KEY_SEQUENCES: Readonly<Record<PhoneKey, string>> = {
  esc: '\x1b',
  tab: '\t',
  up: '\x1b[A',
  down: '\x1b[B',
  '1': '1',
  '2': '2',
  '3': '3',
  enter: '\r',
};

/** What each key is called out loud (the visible face is a glyph or a digit). */
export const PHONE_KEY_LABELS: Readonly<Record<PhoneKey, string>> = {
  esc: 'Escape',
  tab: 'Tab',
  up: 'Up arrow',
  down: 'Down arrow',
  '1': 'Choose 1',
  '2': 'Choose 2',
  '3': 'Choose 3',
  enter: 'Enter',
};

/** What a phone shows when its keystrokes reach no agent. The server's own words (wsManager, phoneProfile). */
export const AGENT_NOT_RUNNING_MESSAGE = 'A phone can type only while the agent is running';

export type TerminalWriteFailure = 'agent-not-running' | 'control-held' | 'not-found' | 'failed';

export type TerminalWriteResult =
  | { ok: true }
  | { ok: false; reason: TerminalWriteFailure; message: string };

interface WriteReply {
  error?: string;
  code?: string;
}

function failureFor(status: number, reply: WriteReply | null): TerminalWriteResult {
  if (status === 409 && reply?.code === 'AGENT_NOT_RUNNING') {
    return { ok: false, reason: 'agent-not-running', message: reply.error || AGENT_NOT_RUNNING_MESSAGE };
  }
  if (status === 409) {
    return { ok: false, reason: 'control-held', message: reply?.error || 'Another device is driving this session' };
  }
  if (status === 404) {
    return { ok: false, reason: 'not-found', message: 'This terminal is gone. Reconnect it, then try again.' };
  }
  return { ok: false, reason: 'failed', message: reply?.error || `Could not send (HTTP ${status})` };
}

/** One write to the terminal's PTY. Never throws. */
export async function writeTerminal(terminalId: string, data: string): Promise<TerminalWriteResult> {
  try {
    const res = await fetch(`/api/terminals/${encodeURIComponent(terminalId)}/write`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data }),
    });
    if (res.ok) return { ok: true };
    const reply = (await res.json().catch(() => null)) as WriteReply | null;
    return failureFor(res.status, reply);
  } catch {
    return { ok: false, reason: 'failed', message: 'Could not reach the Mac. Check the connection and try again.' };
  }
}

/** What the compose box sends for `draft`: trailing blank lines dropped, the rest as typed. */
export function composedText(draft: string): string {
  return draft.replace(/\s+$/, '');
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Submit the compose box: `text`, then Enter after `delayMs`. `onTextSent` runs
 * once the text is in the terminal (the box clears there, not after the pause).
 * If the text write fails, no Enter is sent.
 */
export async function submitComposed(
  terminalId: string,
  text: string,
  onTextSent?: () => void,
  delayMs: number = SUBMIT_ENTER_DELAY_MS,
): Promise<TerminalWriteResult> {
  const sent = await writeTerminal(terminalId, text);
  if (!sent.ok) return sent;
  onTextSent?.();
  await sleep(delayMs);
  return writeTerminal(terminalId, PHONE_KEY_SEQUENCES.enter);
}
