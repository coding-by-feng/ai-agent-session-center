/**
 * Conversation transcript helpers for the CONVERSATION tab.
 *
 * `fetchTranscript` reads the real Claude Code JSONL transcript via the server
 * for untruncated fidelity. `reconstructFromLogs` rebuilds an equivalent (but
 * truncated) interleaved view from the in-memory session logs as a fallback when
 * no transcript is available.
 *
 * The ConversationEntry union mirrors the server-side definition in
 * server/extractPreviousAnswer.ts — keep both in sync.
 */
import type { PromptEntry, ResponseEntry, ToolLogEntry, SessionEvent } from '@/types';

/** One interleaved conversation entry. */
export type ConversationEntry =
  | { role: 'user'; text: string; timestamp: number }
  | { role: 'assistant'; text: string; timestamp: number }
  | { role: 'tool_use'; tool: string; input: string; timestamp: number }
  | { role: 'tool_result'; tool?: string; output: string; timestamp: number; isError?: boolean }
  | { role: 'event'; eventType: string; detail: string; timestamp: number }
  // Synthesized client-side by transformEntries() from harness plumbing:
  | { role: 'command'; name: string; args?: string; stdout?: string; timestamp: number }
  | { role: 'system'; text: string; timestamp: number };

interface TranscriptResponse {
  success: boolean;
  data: ConversationEntry[];
}

/**
 * Fetch the full interleaved transcript for a session from the server. Returns
 * [] on any non-ok / empty response so callers can fall back to in-memory logs.
 */
export async function fetchTranscript(sessionId: string): Promise<ConversationEntry[]> {
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/transcript`);
    if (!res.ok) return [];
    const body = (await res.json()) as TranscriptResponse;
    if (!body?.success || !Array.isArray(body.data)) return [];
    return body.data;
  } catch {
    return [];
  }
}

/**
 * Rebuild an interleaved conversation view from the in-memory session logs.
 * Used when no real transcript is available. Entries are sorted by timestamp
 * ascending so the conversation reads top-to-bottom.
 */
export function reconstructFromLogs(
  prompts: PromptEntry[],
  responses: ResponseEntry[],
  toolCalls: ToolLogEntry[],
  events: SessionEvent[],
): ConversationEntry[] {
  const entries: ConversationEntry[] = [];

  for (const p of prompts) {
    entries.push({ role: 'user', text: p.text, timestamp: p.timestamp });
  }
  for (const r of responses) {
    entries.push({ role: 'assistant', text: r.text, timestamp: r.timestamp });
  }
  for (const t of toolCalls) {
    entries.push({ role: 'tool_use', tool: t.tool, input: t.input, timestamp: t.timestamp });
    if (t.failed || t.error) {
      entries.push({
        role: 'tool_result',
        tool: t.tool,
        output: t.error || 'Tool failed',
        timestamp: t.timestamp,
        isError: true,
      });
    }
  }
  for (const e of events) {
    entries.push({ role: 'event', eventType: e.type, detail: e.detail, timestamp: e.timestamp });
  }

  return entries.sort((a, b) => a.timestamp - b.timestamp);
}
