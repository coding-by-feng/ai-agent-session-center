// replay.ts — the replay check behind P4-10: would `resolveProject` have picked the folder each recent session was
// started in, knowing only its first prompt and the folders that were active in the week before? Auto routing ships on
// when the answer is 70 % or better over at least 30 samples (scripts/mcp-route-replay.ts runs it on the owner's
// history database, read-only, once, after review).
//
// Pure: rows in, a verdict out. The script reads the database and prints; nothing here does either.
//
//   sample      the FIRST prompt of each session in the last 14 days, unless it is a slash command, a `!` shell line,
//               under 15 characters, or the session ran in the home folder (or above, or in no folder)
//   candidates  the folders with session activity (`last_activity_at`) in the 7 days before the sample, each as a
//               project with that recency: what the index would have shown as live folders at that moment
//   truth       the session's own folder
//   score       the top pick of `resolveProject(prompt, {}, candidates)` is the truth
//
// A report names folders by their last segment and never carries a prompt: what a person typed to their agent is not
// something a check of the router needs to show, or keep.

import { basename } from 'node:path';
import { normalizeFolder } from './paths.js';
import type { KnownProject } from './projectIndex.js';
import { resolveProject, type ProjectConfidence } from './resolveProject.js';
import { isWithin } from './scope.js';

/** The bar: 70 % of the samples resolved to their own folder, over at least 30 of them. */
export const REPLAY_BAR = 0.7;
export const REPLAY_MIN_SAMPLES = 30;
/** How far back a sample's session may have started, and how far before a sample its candidates were active. */
export const SAMPLE_DAYS = 14;
export const CANDIDATE_DAYS = 7;
/** A prompt shorter than this (once trimmed) says too little to route. */
export const MIN_PROMPT_CHARS = 15;
/** How many misses a result lists. */
const MISSES_SHOWN = 10;
const DAY_MS = 86_400_000;

/** A session from the history database, joined to its first prompt. */
export interface ReplayRow {
  id: string;
  /** The session's folder (`project_path`). */
  projectPath: string;
  startedAt: number;
  /** `last_activity_at`: its last activity, which is after its first prompt. */
  lastActivityAt: number;
  /** What the session's first prompt said, or null when it has none. */
  firstPrompt: string | null;
  firstPromptAt: number | null;
}

export interface ReplaySample {
  /** When the first prompt was typed. */
  at: number;
  text: string;
  /** The session's own folder, normalized. */
  truth: string;
  candidates: KnownProject[];
}

export interface ReplayOptions {
  now: number;
  /** The home folder: a session there (or above, or nowhere) is not a sample, and is no candidate. */
  home: string;
}

/** `/clear`, `/review args`, `/plugin:command` — a command's name has no slash after the first. A path is not one. */
const SLASH_COMMAND = /^\/[A-Za-z][\w:.-]*(?:\s|$)/;

/** Is this first prompt one a router could have been asked about? */
function isRoutable(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length >= MIN_PROMPT_CHARS && !trimmed.startsWith('!') && !SLASH_COMMAND.test(trimmed);
}

/** The folder as one spelling, or null when it is nowhere a project can be: blank, the home folder, or above it. */
function projectFolder(path: string, home: string): string | null {
  if (typeof path !== 'string' || path.trim() === '') return null;
  const folder = normalizeFolder(path);
  return folder === home || isWithin(home, folder) ? null : folder;
}

/** The candidates for a sample made at `at`: the folders active in the week before it. */
function candidatesAt(rows: readonly ReplayRow[], at: number, home: string): KnownProject[] {
  const from = at - CANDIDATE_DAYS * DAY_MS;
  const latest = new Map<string, number>();
  for (const row of rows) {
    if (row.lastActivityAt < from || row.lastActivityAt >= at) continue;
    const folder = projectFolder(row.projectPath, home);
    if (folder !== null) latest.set(folder, Math.max(latest.get(folder) ?? -Infinity, row.lastActivityAt));
  }
  return [...latest.entries()].map(
    ([folder, lastActiveAt]): KnownProject => ({ folder, name: basename(folder), sources: ['live'], lastActiveAt, roomIds: [] }),
  );
}

/** The samples the rows give: see the header. Each carries the candidates that were active before it. */
export function pickSamples(rows: readonly ReplayRow[], options: ReplayOptions): ReplaySample[] {
  const home = normalizeFolder(options.home);
  const since = options.now - SAMPLE_DAYS * DAY_MS;
  return rows.flatMap((row) => {
    const text = row.firstPrompt;
    const truth = projectFolder(row.projectPath, home);
    const at = row.firstPromptAt ?? row.startedAt;
    if (text === null || truth === null || !isRoutable(text) || at < since || at > options.now) return [];
    return [{ at, text, truth, candidates: candidatesAt(rows, at, home) }];
  });
}

export interface ReplayMiss {
  /** The session's folder, by its last segment. */
  truth: string;
  /** The folder resolveProject picked, by its last segment; null when it picked none. */
  picked: string | null;
  confidence: ProjectConfidence;
}

export interface ReplayResult {
  /** `insufficient` below 30 samples, whatever the accuracy; else `pass` at 70 % or better, else `fail`. */
  status: 'pass' | 'fail' | 'insufficient';
  samples: number;
  correct: number;
  /** correct / samples; null with no samples. */
  accuracy: number | null;
  /** The ten misses AASC was most sure of, most confident first. */
  worstMisses: ReplayMiss[];
}

const CONFIDENCE_RANK: Record<ProjectConfidence, number> = { high: 3, medium: 2, low: 1, none: 0 };

/** Scores every sample with `resolveProject` as a global central would, with no disk to look at. */
export function scoreReplay(samples: readonly ReplaySample[], home: string): ReplayResult {
  const env = { central: { kind: 'global', scopeRef: null }, home, known: [], exists: () => false, realpath: () => null } as const;
  const outcomes = samples.map((sample) => {
    const resolution = resolveProject(sample.text, {}, sample.candidates, env);
    const top = resolution.ranked[0];
    return { sample, picked: top?.folder ?? null, score: top?.score ?? 0, confidence: resolution.confidence };
  });
  const misses = outcomes.filter((o) => o.picked !== o.sample.truth);
  const correct = outcomes.length - misses.length;
  const accuracy = outcomes.length === 0 ? null : correct / outcomes.length;
  const status = outcomes.length < REPLAY_MIN_SAMPLES ? 'insufficient' : (accuracy ?? 0) >= REPLAY_BAR ? 'pass' : 'fail';
  const worstMisses = [...misses]
    .sort((a, b) => CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence] || b.score - a.score)
    .slice(0, MISSES_SHOWN)
    .map((o): ReplayMiss => ({
      truth: basename(o.sample.truth),
      picked: o.picked === null ? null : basename(o.picked),
      confidence: o.confidence,
    }));
  return { status, samples: outcomes.length, correct, accuracy, worstMisses };
}

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`;
const percent = (fraction: number): string => `${(fraction * 100).toFixed(1)} %`;

/** The result as the lines the script prints: accuracy, sample count, the verdict and the worst misses by folder name. */
export function formatReplayReport(result: ReplayResult): string[] {
  const needed = REPLAY_MIN_SAMPLES;
  const bar = `${Math.round(REPLAY_BAR * 100)} % over at least ${needed} samples`;
  const verdict =
    result.status === 'insufficient'
      ? `INSUFFICIENT: ${plural(result.samples, 'sample')}, at least ${needed} are needed`
      : `${bar}: ${result.status === 'pass' ? 'PASS' : 'FAIL'}`;
  const lines = [
    `MCP route replay: would AASC have picked the folder each session was started in? (the first prompt of each session in the last ${SAMPLE_DAYS} days)`,
    `samples   ${result.samples}`,
    `top-1     ${result.correct} correct, ${result.accuracy === null ? 'no accuracy without samples' : percent(result.accuracy)}`,
    `bar       ${verdict}`,
  ];
  if (result.worstMisses.length > 0) {
    lines.push('worst misses, most confident first (folder names only):');
    result.worstMisses.forEach((m, i) => lines.push(`  ${i + 1}. truth ${m.truth}, picked ${m.picked ?? 'nothing'}, ${m.confidence} confidence`));
  }
  return lines;
}
