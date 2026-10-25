/**
 * The session's `/btw` side answers as chat entries (Oct 25 2026). Claude never writes a `/btw`
 * exchange to the transcript, so the server reads it off the terminal (`server/btwCapture.ts`) and
 * sends it on the session; the chat merges it in by time as a `/btw <question>` command row.
 */
import type { BtwAnswer } from '@/types/session';
import type { ChatCommandEntry, ChatEntry } from '@/types/chat';

/** One `/btw` exchange as a command entry. Keyed by its capture time, so a growing answer keeps its row. */
export const btwEntry = (b: BtwAnswer): ChatCommandEntry => ({
  kind: 'command',
  key: `btw:${b.at}`,
  timestamp: b.at,
  name: 'btw',
  args: b.question,
  output: b.answer,
});

/**
 * `entries` (oldest first) with the `/btw` answers placed by time. An answer older than the oldest
 * loaded entry is left out while older pages remain (`hasOlder`): it belongs to a page not loaded yet.
 */
export function withBtwEntries(
  entries: readonly ChatEntry[],
  answers: readonly BtwAnswer[] | undefined,
  hasOlder: boolean,
): readonly ChatEntry[] {
  if (!answers || answers.length === 0) return entries;
  const oldest = entries.length ? entries[0].timestamp : 0;
  const extra = answers.filter((b) => !hasOlder || b.at >= oldest).map(btwEntry);
  if (extra.length === 0) return entries;
  const out: ChatEntry[] = [];
  let i = 0;
  for (const entry of entries) {
    while (i < extra.length && extra[i].timestamp < entry.timestamp) out.push(extra[i++]);
    out.push(entry);
  }
  while (i < extra.length) out.push(extra[i++]);
  return out;
}
