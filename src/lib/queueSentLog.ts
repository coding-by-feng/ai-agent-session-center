/**
 * Which prompts the prompt queue sent — so the CONVERSATION tab can badge them.
 *
 * Nothing in a Claude transcript says where a prompt came from, so the
 * scheduler records each successful send here and the view matches transcript
 * entries back against it. The records are kept on the Mac, per session
 * (server/queueSent.ts, stores/queueSentStore.ts); this module is the pure
 * normalize + match logic both sides share.
 *
 * Matching is by text + time, not session id: a session can be re-keyed after
 * the send (resume, terminal adoption), and the same text sent to several
 * sessions is a queue send in each of them.
 */
export interface QueueSent {
  text: string;
  sentAt: number;
}

export const QUEUE_SENT_CAP = 300;
/** How far a transcript timestamp may sit from the send and still be that send. */
export const QUEUE_SENT_WINDOW_MS = 5 * 60_000;
/** Image paths are appended after the text and Claude may reflow the tail, so only the head is compared. */
const MATCH_PREFIX_CHARS = 80;

const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim();

export function appendQueueSent(log: readonly QueueSent[], rec: QueueSent): QueueSent[] {
  // Only the compared head is kept: a pasted 8 KB prompt would otherwise fill the store.
  const text = normalize(rec.text).slice(0, MATCH_PREFIX_CHARS);
  if (!text) return [...log];
  return [...log, { text, sentAt: rec.sentAt }].slice(-QUEUE_SENT_CAP);
}

/** After a whole (uncut) sent text, the transcript may only add the uploaded image paths. */
const RE_APPENDED_PATH = /^ \S*[\\/]/;

/**
 * Records are normalized and cut to the head when written (appendQueueSent),
 * so no per-record work is repeated here for every transcript entry.
 */
export function isQueueSent(log: readonly QueueSent[], text: string, timestamp: number): boolean {
  const entry = normalize(text);
  if (!entry) return false;
  return log.some((rec) => {
    if (!rec.text || Math.abs(timestamp - rec.sentAt) > QUEUE_SENT_WINDOW_MS) return false;
    if (!entry.startsWith(rec.text)) return false;
    // A head shorter than the cap is the whole prompt: "fix" must not claim a
    // hand-typed "fix the login redirect" — only an exact match or image paths after it.
    if (rec.text.length >= MATCH_PREFIX_CHARS) return true;
    const rest = entry.slice(rec.text.length);
    return rest === '' || RE_APPENDED_PATH.test(rest);
  });
}
