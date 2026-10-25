/**
 * resourceUsage — how often each skill and command in the RESOURCES Library was used
 * in the last 90 days (Oct 23 2026), counted from AASC's own history.
 *
 * Two kinds of use:
 * - **typed** — a prompt naming it (`/name`, `$name`, Codex's `[$name](…/SKILL.md)`
 *   mention), each prompt once: the same tokens the `/` lists rank by (commandUsage.ts).
 * - **agent** — Claude's `Skill` tool calls (`tool_calls`, input `{"skill":"name",…}`),
 *   minus the first call for a prompt that already typed that skill: "… /rar" typed and then
 *   run by the model is one use, not two. The prompt is the latest one the user sent in that
 *   session (harness rows skipped), so a `/loop 10m /rar` counts each later run, and a skill
 *   the typed one chains into still counts. Codex has no Skill tool: its count is typed only.
 *
 * Rules, instructions and memory load into every session; nothing invokes them, so they
 * never get a count (`resourceTokens` answers none).
 *
 * Pure apart from the injected readers (`db.getPromptUsesSince` / `db.getSkillCallsSince`
 * in index.ts), so the tests never open the database.
 */
import type { ResourceSummary, ResourceUsage } from '../src/types/resources.js';
import { promptTokens, USAGE_CACHE_MS, USAGE_WINDOW_MS } from './commandUsage.js';
import log from './logger.js';

/** The window in days, for the client's "in the last 90 days". */
export const USAGE_WINDOW_DAYS = Math.round(USAGE_WINDOW_MS / 86_400_000);

/** A prompt naming at least one `/` or `$` (harness rows starting with `<` left out by the reader). */
export interface PromptUse {
  timestamp: number;
  text: string;
}

/** One `Skill` tool call, with the latest prompt the user sent in its session at or before it. */
export interface SkillCall {
  sessionId: string;
  timestamp: number;
  /** `tool_calls.tool_input_summary`: the call's input as JSON, cut at 100 characters. */
  input: string;
  /** That prompt's time and text (null when the session has none before the call). */
  promptAt: number | null;
  prompt: string | null;
}

/** Uses of one token as typed ("/rar", "$rar"). */
export interface TokenUse {
  typed: number;
  agent: number;
  lastAt: number;
}

/** `sessionIds` null reads every session; a list reads only those (a phone's shared ones). */
export interface UsageReaders {
  prompts(sinceMs: number, sessionIds: string[] | null): PromptUse[];
  skillCalls(sinceMs: number, sessionIds: string[] | null): SkillCall[];
}

export interface ResourceUsageCounter {
  /**
   * Token → uses in the window, over `sessionIds` (default every session: the Mac's own
   * Library). Never throws. When a read fails it answers the last good counts for that
   * scope, or null when there are none: unknown must not read as "not used".
   */
  counts(sessionIds?: readonly string[] | null): ReadonlyMap<string, TokenUse> | null;
}

/** Scopes kept at once: the Mac's own plus a few phones' shared-session sets. */
const MAX_SCOPES = 8;

/** A skill name as the Skill tool takes it: word segments joined by `:` or `.` (`plugin:name`). */
const SKILL_INPUT_RE = /"skill":"([A-Za-z0-9][\w-]*(?:[:.][\w-]+)*)"/;

/** The skill a stored `Skill` call ran, or null. */
export function skillOfCall(input: string): string | null {
  return SKILL_INPUT_RE.exec(input)?.[1] ?? null;
}

/** "superpowers:brainstorming" → "brainstorming": how a plugin skill can also be typed. */
function bareName(skill: string): string {
  return skill.slice(skill.lastIndexOf(':') + 1);
}

function bump(counts: Map<string, TokenUse>, token: string, at: number, kind: 'typed' | 'agent'): void {
  const prev = counts.get(token) ?? { typed: 0, agent: 0, lastAt: 0 };
  counts.set(token, { ...prev, [kind]: prev[kind] + 1, lastAt: Math.max(prev.lastAt, at) });
}

/** Typed tokens from `prompts`, plus the agent's Skill calls that no prompt had typed. */
export function countTokenUses(prompts: Iterable<PromptUse>, calls: Iterable<SkillCall>): Map<string, TokenUse> {
  const counts = new Map<string, TokenUse>();
  for (const p of prompts) {
    for (const token of promptTokens(p.text)) bump(counts, token, p.timestamp, 'typed');
  }
  // The typed prompt absorbs its FIRST call of that skill; a re-run, or a loop's next turn
  // answering the same prompt, is a use of its own.
  const absorbed = new Set<string>();
  for (const call of calls) {
    const skill = skillOfCall(call.input);
    if (!skill) continue;
    const typed = call.prompt ? promptTokens(call.prompt) : null;
    const key = `${call.sessionId}\n${call.promptAt}\n${skill}`;
    if (typed && (typed.has(`/${skill}`) || typed.has(`/${bareName(skill)}`)) && !absorbed.has(key)) {
      absorbed.add(key);
      continue;
    }
    bump(counts, `/${skill}`, call.timestamp, 'agent');
  }
  return counts;
}

/**
 * How the resource is called by its agent: a Claude skill or command `/name` (a plugin's
 * also `/plugin:name`; a command in a subfolder, catalogued `ns:name`, also `/name`, which is
 * how Claude Code names it today), a Codex skill `$name`, a Codex prompt `/prompts:name`, a
 * shared (`~/.agents`) skill either way. Every other type: none — it is loaded, never invoked.
 */
export function resourceTokens(r: ResourceSummary): string[] {
  if (r.type !== 'skill' && r.type !== 'command') return [];
  if (r.agent === 'codex' && r.type === 'command') return [`/prompts:${r.name}`];
  const nested = !r.pluginName && r.type === 'command' && r.name.includes(':');
  const names = r.pluginName ? [`${r.pluginName}:${r.name}`, r.name] : nested ? [r.name, bareName(r.name)] : [r.name];
  if (r.agent === 'codex') return names.map((n) => `$${n}`);
  const slash = names.map((n) => `/${n}`);
  return r.agent === 'shared' ? [...slash, ...names.map((n) => `$${n}`)] : slash;
}

/**
 * Resource id → its uses, for every skill or command used in the window; the rest are left out.
 * A token counts in full for every resource that answers to it (a skill and a command of one
 * name, a Claude and a shared skill): the history cannot tell which one ran, so `sharedWith`
 * says how many others the same count went to.
 */
export function usageById(
  counts: ReadonlyMap<string, TokenUse>,
  resources: readonly ResourceSummary[],
): Record<string, ResourceUsage> {
  const used = new Map<string, string[]>();
  const claimants = new Map<string, Set<string>>();
  for (const r of resources) {
    const tokens = resourceTokens(r).filter((t) => counts.has(t));
    if (tokens.length === 0) continue;
    used.set(r.id, tokens);
    for (const t of tokens) claimants.set(t, new Set([...(claimants.get(t) ?? []), r.id]));
  }
  const out: Record<string, ResourceUsage> = {};
  for (const [id, tokens] of used) {
    const others = new Set(tokens.flatMap((t) => [...(claimants.get(t) ?? [])]).filter((o) => o !== id));
    const sum = tokens.reduce((acc, token) => {
      const u = counts.get(token) as TokenUse;
      return { typed: acc.typed + u.typed, agent: acc.agent + u.agent, lastAt: Math.max(acc.lastAt, u.lastAt) };
    }, { typed: 0, agent: 0, lastAt: 0 });
    out[id] = { ...sum, tokens, ...(others.size > 0 ? { sharedWith: others.size } : {}) };
  }
  return out;
}

export function createResourceUsage(read: UsageReaders, now: () => number = Date.now): ResourceUsageCounter {
  const cache = new Map<string, { at: number; counts: Map<string, TokenUse> }>();
  return {
    counts(sessionIds = null) {
      if (sessionIds && sessionIds.length === 0) return new Map();
      const ids = sessionIds ? [...sessionIds].sort() : null;
      const key = ids ? ids.join('\n') : '*';
      const t = now();
      const hit = cache.get(key);
      if (hit && t - hit.at < USAGE_CACHE_MS) return hit.counts;
      let counts: Map<string, TokenUse>;
      try {
        const since = t - USAGE_WINDOW_MS;
        counts = countTokenUses(read.prompts(since, ids), read.skillCalls(since, ids));
      } catch (err: unknown) {
        // Not kept, so the next asks again; meanwhile the last good counts beat "not used".
        log.warn('resource-usage', `reading the history failed: ${err instanceof Error ? err.message : String(err)}`);
        return hit?.counts ?? null;
      }
      cache.delete(key);
      if (cache.size >= MAX_SCOPES) cache.delete(cache.keys().next().value as string);
      cache.set(key, { at: t, counts });
      return counts;
    },
  };
}
