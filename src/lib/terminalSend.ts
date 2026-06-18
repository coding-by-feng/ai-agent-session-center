/**
 * Sending a composed prompt to a terminal's PTY (queue Auto-Enter / "send now").
 *
 * Auto-Enter quirk: CLI TUIs such as Claude Code / Codex / Gemini treat
 * `text + "\r"` arriving in a SINGLE pty read as a bracketed-paste-like burst
 * and insert the trailing carriage return as a literal newline — so the prompt
 * is typed but never submitted. Writing the prompt text, pausing briefly so the
 * TUI has consumed it, then writing a STANDALONE "\r" makes the carriage return
 * register as a real Enter keypress. This mirrors the working manual flow (paste
 * the text, then press Enter as a separate keystroke).
 */

/** Pause between the prompt-text write and the submitting Enter keystroke. */
export const SUBMIT_ENTER_DELAY_MS = 1000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function writeToTerminalApi(terminalId: string, data: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/terminals/${terminalId}/write`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Write `text` to the terminal, then — when `autoEnter` is set — submit it with a
 * SEPARATE Enter keystroke (`\r`) after `delayMs`. The submit `\r` is never
 * concatenated onto the text (that is the bug this avoids). Returns true only if
 * every attempted write succeeded; if the text write fails, no Enter is sent.
 */
export async function sendPromptToTerminal(
  terminalId: string,
  text: string,
  autoEnter: boolean,
  delayMs: number = SUBMIT_ENTER_DELAY_MS,
): Promise<boolean> {
  const textOk = await writeToTerminalApi(terminalId, text);
  if (!textOk) return false;
  if (!autoEnter) return true;
  await sleep(delayMs);
  return writeToTerminalApi(terminalId, '\r');
}
