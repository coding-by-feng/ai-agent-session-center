/**
 * What the phone's Agents tab shows for a session's Background list (Oct 25 2026): the summary
 * line Claude Code's own panel shows ("82 agents · 1 active shell") and one line per item. Pure,
 * so the wording is testable without rendering.
 */
import type { BackgroundItem, BackgroundTasks } from '@/types/session';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "82 agents · 1 active shell", "2 shells", "Nothing running". */
export function backgroundSummary(b: BackgroundTasks): string {
  const parts: string[] = [];
  if (b.agents > 0) parts.push(plural(b.agents, 'agent', 'agents'));
  if (b.activeShells > 0) parts.push(plural(b.activeShells, 'active shell', 'active shells'));
  else if (b.shells > 0) parts.push(plural(b.shells, 'shell', 'shells'));
  return parts.length ? parts.join(' · ') : 'Nothing running';
}

/** How many items Claude listed that the session didn't keep (the list is capped). */
export function hiddenCount(b: BackgroundTasks): number {
  return Math.max(0, b.agents + b.shells - b.items.length);
}

/** A row's title: what it's doing, else the shell command, else its id. */
export function backgroundTitle(t: BackgroundItem): string {
  return t.description ?? t.command ?? t.id;
}

/** A row's type label: "Shell", "Teammate", "Subagent". */
export function backgroundKind(t: BackgroundItem): string {
  return t.type ? t.type.charAt(0).toUpperCase() + t.type.slice(1) : 'Task';
}

/** Is it still running? An empty status counts as running, as Claude's own list treats it. */
export const isRunning = (t: BackgroundItem): boolean => t.status === '' || t.status === 'running';

/** "HH:MM" in the phone's locale. */
export const clockTime = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
