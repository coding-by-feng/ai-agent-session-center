/**
 * Codex's memory citation. When a memory informed a reply, Codex (0.166+) is told to "append one
 * citation block at the end of the final reply, outside code fences":
 *
 *   <oai-mem-citation>
 *   <citation_entries>
 *   MEMORY.md:208-208|note=[…]
 *   </citation_entries>
 *   <rollout_ids>
 *   01a19f80-…
 *   </rollout_ids>
 *   </oai-mem-citation>
 *
 * Codex's own terminal hides it; the rollout keeps it raw, so every AASC reader of a Codex reply
 * (phone Chat, the Stop hook's reply, the floating popups' previous answer) drops it here.
 */

const OPEN_TAG = '<oai-mem-citation>';
const CLOSE_TAG = '</oai-mem-citation>';

/**
 * The reply without a citation block that ends it (or that a cap cut off). A block followed by
 * more text, one inside a code fence, or a tag written inline (`` `<oai-mem-citation>` ``) is a
 * mention, not a citation, and stays. Pure; returns the input unchanged when there is nothing to drop.
 */
export function stripCodexMemoryCitation(text: string): string {
  const start = text.lastIndexOf(OPEN_TAG);
  if (start < 0) return text;
  // A citation starts the reply or follows whitespace; a backtick or letter before it is a mention.
  if (start > 0 && !/\s/.test(text[start - 1])) return text;
  const before = text.slice(0, start);
  // An odd number of fences before it: the tag is inside a code block.
  if ((before.match(/```/g) ?? []).length % 2 === 1) return text;
  const close = text.indexOf(CLOSE_TAG, start);
  if (close >= 0 && text.slice(close + CLOSE_TAG.length).trim() !== '') return text;
  return before.trimEnd();
}
