/**
 * latestAnswer — the agent's last answer in a session, for read-aloud (AASC-20).
 *
 * The transcript has it in full; the session's in-memory `responseLog` keeps an
 * excerpt of each turn's reply, used when there is no transcript (a Codex
 * session, a transcript not flushed yet).
 */
import type { ResponseEntry } from '@/types';
import { fetchTranscript, type ConversationEntry } from './transcript';

/** The text of the last assistant entry, or '' when there is none. */
export function lastAssistantText(entries: readonly ConversationEntry[]): string {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.role === 'assistant' && entry.text.trim()) return entry.text;
  }
  return '';
}

/** The newest reply excerpt in a session's response log, or ''. */
export function lastResponseText(responses: readonly ResponseEntry[] | undefined): string {
  if (!responses || responses.length === 0) return '';
  return responses[responses.length - 1].text ?? '';
}

/** The last answer: from the transcript when the server has one, else the log. */
export async function fetchLatestAnswer(sessionId: string, responses?: readonly ResponseEntry[]): Promise<string> {
  const fromTranscript = lastAssistantText(await fetchTranscript(sessionId));
  return fromTranscript || lastResponseText(responses);
}
