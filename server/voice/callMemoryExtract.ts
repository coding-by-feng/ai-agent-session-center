// callMemoryExtract.ts — after a voice call, propose what may be worth keeping (Nov 22 2026; callMemory.ts keeps it).
//
// One headless model pass on this Mac (the `claude` CLI, as the session summary uses), only for a call that lasted
// MIN_CALL_MS with a lasting cue ("from now on", "always", "no, I meant") or several requests. The model gets the
// person's lines apart from the voice's, the session titles and projects the caller can see (to resolve misheard
// names), and answers a JSON list. Its answer is never trusted: each item must be a known kind, its `heard` must be
// the person's own words (EVIDENCE_SHARE of its words in one PERSON line, so text the voice read aloud from a
// session cannot pose as a preference), and a scope outside the caller's projects becomes global. Everything stays a
// proposal until the person keeps it.

import { z } from 'zod';
import log from '../logger.js';
import type { TranscriptLine } from './transcriptLog.js';
import { MEMORY_KINDS, type CallMemory, type MemoryCandidate, type MemoryItem } from './callMemory.js';

/** A call shorter than this is not looked at. */
export const MIN_CALL_MS = 30_000;
/** Without a lasting cue, this many of the person's lines make a call worth a look (patterns). */
export const MANY_REQUESTS = 3;
/** The most items one call may propose. */
export const MAX_CANDIDATES = 5;
/** The transcript given to the model, at most. */
const TRANSCRIPT_MAX = 12_000;
/** Share of `heard`'s words that must be in one of the person's lines. */
const EVIDENCE_SHARE = 0.8;

/** The same headless call as the session summary (apiRouter SUMMARIZE_CLAUDE_ARGS): no tools, no MCP. */
export const EXTRACT_CLAUDE_ARGS: readonly string[] = ['-p', '--model', 'haiku', '--tools', '', '--strict-mcp-config'];
export const EXTRACT_TIMEOUT_MS = 60_000;

const LASTING_CUE =
  /\b(from now on|always|never|by default|every time|whenever|each time|i prefer|i'd rather|i would rather|i like it when|please remember|remember that|next time|no,? i meant|i mean[t]?|not .{1,40} but|it'?s called|call it)\b/i;

export function worthExtracting(lines: readonly TranscriptLine[], durationMs: number): boolean {
  if (durationMs < MIN_CALL_MS) return false;
  const mine = lines.filter((l) => l.role === 'user');
  return mine.some((l) => LASTING_CUE.test(l.text)) || mine.length >= MANY_REQUESTS;
}

export interface ExtractContext {
  /** Session titles the caller can see. */
  names: readonly string[];
  /** Project folders of those sessions. */
  projects: readonly string[];
}

export function extractPrompt(lines: readonly TranscriptLine[], context: ExtractContext): string {
  const transcript = lines
    .map((l) => `${l.role === 'user' ? 'PERSON' : 'VOICE'}: ${l.text.replace(/\s+/g, ' ').trim()}`)
    .join('\n')
    .slice(-TRANSCRIPT_MAX);
  return [
    'Below is a voice call between a PERSON and an assistant VOICE that runs coding agents for them (AASC). The PERSON lines are speech-to-text and may hold mistakes.',
    'List only what is worth keeping for future calls and other sessions:',
    '- "preference": a lasting wish the PERSON stated ("from now on", "always", "by default", "I prefer").',
    '- "correction": the PERSON corrected a meaning or a misheard word ("no, I meant X"). heard = the wrong words, meant = the right ones.',
    '- "pattern": something the PERSON clearly does as a habit in calls (only if it is plain from this call).',
    'Leave out temporary task details (what to build now, one-off requests such as "make the logo blue"), anything the VOICE said, secrets, and anything about other people.',
    'Fix speech-to-text mistakes in "meant" using these known names: sessions: ' + (context.names.join('; ') || '(none)') + '; projects: ' + (context.projects.join('; ') || '(none)') + '. "ASC" usually means AASC.',
    'Answer with a JSON array only, at most ' + String(MAX_CANDIDATES) + ' items, each {"kind","heard","meant","scope"}: heard = the PERSON\'s words as transcribed, meant = one plain sentence of what they meant, scope = "global" or "project:<one of the projects above>" when it is clearly about that project. Answer [] when nothing qualifies.',
    '',
    transcript,
  ].join('\n');
}

const Candidate = z.object({
  kind: z.string(),
  heard: z.string().min(1).max(400),
  meant: z.string().min(1).max(400),
  scope: z.string().max(1100).optional(),
});

const words = (text: string): string[] => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter((w) => w.length > 2);

/** Whether the person (never the voice) said these words in one line of the call. */
export function saidByPerson(heard: string, lines: readonly TranscriptLine[]): boolean {
  const wanted = words(heard);
  if (wanted.length === 0) return false;
  return lines.some((l) => {
    if (l.role !== 'user') return false;
    const have = new Set(words(l.text));
    return wanted.filter((w) => have.has(w)).length / wanted.length >= EVIDENCE_SHARE;
  });
}

/** The first JSON array in the model's answer (it may wrap it in prose or a code fence). */
function jsonArray(text: string): unknown {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

export function parseCandidates(text: string, lines: readonly TranscriptLine[], projects: readonly string[]): MemoryCandidate[] {
  const parsed = jsonArray(text);
  if (!Array.isArray(parsed)) return [];
  const out: MemoryCandidate[] = [];
  for (const raw of parsed.slice(0, MAX_CANDIDATES)) {
    const c = Candidate.safeParse(raw);
    if (!c.success) continue;
    const kind = MEMORY_KINDS.find((k) => k === c.data.kind);
    if (!kind || !saidByPerson(c.data.heard, lines)) continue;
    const project = c.data.scope?.startsWith('project:') ? c.data.scope.slice('project:'.length) : null;
    const scope = project !== null && projects.includes(project) ? `project:${project}` : 'global';
    out.push({ kind, heard: c.data.heard.trim(), meant: c.data.meant.trim(), scope });
  }
  return out;
}

export interface ExtractInput {
  lines: readonly TranscriptLine[];
  durationMs: number;
  context: ExtractContext;
  runModel(prompt: string): Promise<string>;
  memory: CallMemory;
  callId: string;
}

/** Proposes what this call taught; never throws (a failure is a log line, and nothing is proposed). */
export async function extractFromCall(input: ExtractInput): Promise<MemoryItem[]> {
  if (!worthExtracting(input.lines, input.durationMs)) return [];
  try {
    const answer = await input.runModel(extractPrompt(input.lines, input.context));
    const proposed = input.memory.propose(parseCandidates(answer, input.lines, input.context.projects), input.callId);
    if (proposed.length > 0) log.info('voice', `Call memory: ${proposed.length} item(s) to review from ${input.callId}`);
    return proposed;
  } catch (err) {
    log.warn('voice', `Call memory extraction failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}
