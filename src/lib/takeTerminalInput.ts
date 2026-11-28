/**
 * takeTerminalInput — the queue compose row's "Take the text from Claude's input box" button
 * (Nov 13 2026). The user dictates into Claude with its own hold-Space voice feature (or types
 * there); this moves that text into the queue box, where they check it and click ADD. The server
 * reads the box off the screen and clears it (server/inputBoxCapture.ts). Images AASC attached in
 * the terminal (shown there as `[Image #N]`) come back too, as queue attachments (Nov 28 2026).
 */
import type { QueueImageAttachment } from '@/stores/queueStore';

export type TakeInputOutcome =
  | { kind: 'text'; text: string; cleared: boolean; images: QueueImageAttachment[] }
  | { kind: 'empty' }
  | { kind: 'error'; message: string };

const FAILED_MESSAGE = "Couldn't read Claude's input box.";

/** The server's images, keeping only well-formed image data URLs. */
function imagesOf(raw: unknown): QueueImageAttachment[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (i): i is QueueImageAttachment =>
      !!i && typeof i === 'object' && typeof (i as QueueImageAttachment).name === 'string'
      && typeof (i as QueueImageAttachment).dataUrl === 'string' && (i as QueueImageAttachment).dataUrl.startsWith('data:image/'),
  );
}

/** POST /api/terminals/:id/take-input, as one of three outcomes. Never throws. */
export async function takeTerminalInput(terminalId: string): Promise<TakeInputOutcome> {
  try {
    const res = await fetch(`/api/terminals/${encodeURIComponent(terminalId)}/take-input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const body = (await res.json().catch(() => ({}))) as {
      data?: { text?: unknown; cleared?: unknown; images?: unknown };
      error?: string;
    };
    // The server says why in words a person can act on (no box, a paste in it, a send in flight…).
    if (!res.ok) return { kind: 'error', message: typeof body.error === 'string' && body.error ? body.error : FAILED_MESSAGE };
    const text = typeof body.data?.text === 'string' ? body.data.text : '';
    const images = imagesOf(body.data?.images);
    if (!text.trim() && images.length === 0) return { kind: 'empty' };
    return { kind: 'text', text, cleared: body.data?.cleared === true, images };
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
