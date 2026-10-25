/**
 * resourceUsage — how the Library shows a skill's or command's uses (Oct 23 2026).
 *
 * The counts come from `GET /api/resources/usage` (server/resourceUsage.ts): prompts that
 * typed it plus Claude's own Skill calls, over the last 90 days. Only skills and commands
 * are counted; a rule, CLAUDE.md or memory loads into every session and nothing invokes it.
 */
import type { ResourceSummary, ResourceType, ResourceUsage } from '@/types/resources';
import { relativeAge } from './resourceFilters';

export type ResourceSort = 'name' | 'uses';

const COUNTED: ReadonlySet<ResourceType> = new Set(['skill', 'command']);

export function isUsageCounted(type: ResourceType): boolean {
  return COUNTED.has(type);
}

export function totalUses(usage: ResourceUsage | undefined): number {
  return usage ? usage.typed + usage.agent : 0;
}

/** "· also counted for 1 other resource of that name", when the history cannot tell them apart. */
export function sharedNote(usage: ResourceUsage): string {
  const n = usage.sharedWith ?? 0;
  if (n === 0) return '';
  return ` · also counted for ${n} other ${n === 1 ? 'resource' : 'resources'} of that name`;
}

/** "1 use" / "17 uses" / "1,234 uses". */
export function usesLabel(n: number): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? 'use' : 'uses'}`;
}

export interface UsageFacts {
  headline: string;
  parts: string[];
  note?: string;
}

/** The detail pane's lines for one skill or command. */
export function usageFacts(
  summary: Pick<ResourceSummary, 'agent'>,
  usage: ResourceUsage | undefined,
  windowDays: number,
  now: number,
): UsageFacts {
  const total = totalUses(usage);
  if (!usage || total === 0) return { headline: `Not used in the last ${windowDays} days`, parts: [] };
  const parts = [
    ...(usage.typed > 0 ? [`${usage.typed.toLocaleString('en-US')} typed by you`] : []),
    ...(usage.agent > 0 ? [`${usage.agent.toLocaleString('en-US')} by the agent`] : []),
    `last used ${relativeAge(usage.lastAt, now)}`,
  ];
  const counted = `Counted as ${usage.tokens.join(', ')}${sharedNote(usage)}`;
  return {
    headline: `Used ${total.toLocaleString('en-US')}× in the last ${windowDays} days`,
    parts,
    note: summary.agent === 'codex'
      ? `${counted} · Codex keeps no record of a skill it runs on its own, so only typed uses count`
      : counted,
  };
}

/** Most used first, the latest use breaking a tie; unused ones keep their order at the end. */
export function sortByUses(
  list: readonly ResourceSummary[],
  usage: ReadonlyMap<string, ResourceUsage>,
): ResourceSummary[] {
  return list
    .map((r, i) => ({ r, i, n: totalUses(usage.get(r.id)), at: usage.get(r.id)?.lastAt ?? 0 }))
    .sort((a, b) => b.n - a.n || b.at - a.at || a.i - b.i)
    .map((x) => x.r);
}

/** `?sort=uses` → "uses"; anything else is name order. */
export function readResourceSort(params: URLSearchParams): ResourceSort {
  return params.get('sort') === 'uses' ? 'uses' : 'name';
}
