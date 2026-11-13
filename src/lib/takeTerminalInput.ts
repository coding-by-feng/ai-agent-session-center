/**
 * takeTerminalInput — the queue compose row's "Take the text from Claude's input box" button
 * (Nov 13 2026). The user dictates into Claude with its own hold-Space voice feature (or types
 * there); this moves that text into the queue box, where they check it and click ADD. The server
 * reads the box off the screen and clears it (server/inputBoxCapture.ts).
 */

export type TakeInputOutcome =
  | { kind: 'text'; text: string; cleared: boolean }
  | { kind: 'empty' }
  | { kind: 'error'; message: string };

const FAILED_MESSAGE = "Couldn't read Claude's input box.";

/** POST /api/terminals/:id/take-input, as one of three outcomes. Never throws. */
export async function takeTerminalInput(terminalId: string): Promise<TakeInputOutcome> {
  try {
    const res = await fetch(`/api/terminals/${encodeURIComponent(terminalId)}/take-input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const body = (await res.json().catch(() => ({}))) as {
      data?: { text?: unknown; cleared?: unknown };
      error?: string;
    };
    // The server says why in words a person can act on (no box, a paste in it, a send in flight…).
    if (!res.ok) return { kind: 'error', message: typeof body.error === 'string' && body.error ? body.error : FAILED_MESSAGE };
    const text = typeof body.data?.text === 'string' ? body.data.text : '';
    if (!text.trim()) return { kind: 'empty' };
    return { kind: 'text', text, cleared: body.data?.cleared === true };
  } catch {
    return { kind: 'error', message: FAILED_MESSAGE };
  }
}

/**
 * Put `insert` into `current` at `caret` (the end when unknown), with one space between it and any
 * text on either side. Returns the new value and where the caret goes (just after the insert).
 */
export function insertAtCaret(
  current: string,
  insert: string,
  caret: number | null = null,
): { value: string; caret: number } {
  const addition = insert.trim();
  if (!addition) return { value: current, caret: caret ?? current.length };
  const at = caret === null ? current.length : Math.max(0, Math.min(caret, current.length));
  const before = current.slice(0, at);
  const after = current.slice(at);
  const lead = before && !/\s$/.test(before) ? ' ' : '';
  const trail = after && !/^\s/.test(after) ? ' ' : '';
  const value = `${before}${lead}${addition}${trail}${after}`;
  return { value, caret: before.length + lead.length + addition.length };
}
