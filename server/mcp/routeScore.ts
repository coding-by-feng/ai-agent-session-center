// routeScore.ts — what a session earns toward being reused for a task (the router's "score" step; router.ts
// re-exports `scoreSession`). Five terms, each with its own weight (routerConfig.ts; the spec's starting values):
//
//   same folder        the session sits in the project's own folder (a folder below it earns nothing)     +3
//   task words         the task's words are in the session's title, summary, remark, last ten prompts
//                      or edited files                                                                    +2
//   idle or waiting    the session is ready for a prompt                                                  +2
//   context headroom   at most half the context window is used                                            +1
//   recent activity    the session was active within the hour                                             +1
//
// Pure: `now` and the edited files are handed in (the router fetches the files for its best few candidates only).
// Every reason is AASC's own words and numbers: no word of the task, a title, a prompt or a path is ever echoed into
// one, so a reason can go into the activity log as it is.
//
// "Task words" are the task's significant words: whole words of three letters or more, not filler (`the`, `please`,
// `fix`, `make sure`) and not a word of the project's own folder path (every session in the project shares those, so
// they say nothing about which one knows the task). A session matches when it holds two of them (all of them when the
// task has fewer). It is a nudge between sessions of one project, not a judgement of relevance.

import { z } from 'zod';
import type { Session } from '../../src/types/session.js';
import { bodyOf, rowsOf } from './apiBody.js';
import type { InternalClient } from './client.js';
import { normalizeFolder } from './paths.js';
import type { ToolContext } from './registry.js';
import type { RouterWeights } from './routerConfig.js';
import { toSessionCard } from './scope.js';
import { seg } from './tools/define.js';
import { ago } from './tools/views.js';

const HOUR_MS = 3_600_000;
/** Headroom: at most this much of the context window used (%). */
const HEADROOM_PCT = 50;
/** How many of a session's latest prompts are read, and how much of each. */
const PROMPTS_READ = 10;
const PROMPT_CHARS = 2_000;
/** How much of any other text (title, summary, remark) is read. */
const TEXT_CHARS = 4_000;
/** How many edited files, and how much of each path, are read. */
const FILES_READ = 200;
const PATH_CHARS = 300;
const MIN_WORD = 3;

const changedFileSchema = z.object({ path: z.string() });

const FILLER: ReadonlySet<string> = new Set(
  (
    'the and for are but not you all any can had her was one our out has him his how its may new now old see two who did she use way why yes ' +
    'that this with from have will your what when where which while would could should about after again also been before being between both does ' +
    'done each else even every into just like make many more most much must need only other over please same some such than then them there these ' +
    'they those through very want were their here upon under until too still since really once ever never always another because cannot doing during ' +
    'either might within without yet ' +
    // What every task says: not what it is about.
    'fix add update change changes run check look find implement remove delete write create build using used let lets help try sure thing things ' +
    'something anything everything stuff whole part parts code get got take put give goes going went come make made'
  ).split(' '),
);

const WORD = /[\p{L}\p{N}]+/gu;

const wordsIn = (text: string): string[] => text.toLowerCase().match(WORD) ?? [];

/** The significant words of `text`, minus `exclude`. */
function significantWords(text: string, exclude: ReadonlySet<string>): Set<string> {
  const found = new Set<string>();
  for (const word of wordsIn(text)) {
    if (word.length >= MIN_WORD && !/^\d+$/.test(word) && !FILLER.has(word) && !exclude.has(word)) found.add(word);
  }
  return found;
}

/** The words of the project's own folder path: shared by every session in it. */
const projectWords = (folder: string): ReadonlySet<string> => new Set(wordsIn(folder));

/** Does the task have any significant words (so that looking at a session's edited files could matter)? */
export function hasTaskWords(task: string, projectFolder: string): boolean {
  return significantWords(task, projectWords(projectFolder)).size > 0;
}

const textOf = (value: unknown, max: number): string => (typeof value === 'string' ? value.slice(0, max) : '');

/** The words a session holds: its title, summary, remark, last prompts and the files it edited. */
function sessionWords(session: Session, files: readonly string[]): Set<string> {
  const prompts = Array.isArray(session.promptHistory) ? session.promptHistory.slice(-PROMPTS_READ) : [];
  const parts = [
    textOf(session.title, TEXT_CHARS),
    textOf(session.summary, TEXT_CHARS),
    textOf(session.remark, TEXT_CHARS),
    ...prompts.map((p) => textOf(p?.text, PROMPT_CHARS)),
    ...files.slice(0, FILES_READ).map((f) => textOf(f, PATH_CHARS)),
  ];
  return significantWords(parts.join('\n'), new Set());
}

export interface SessionScore {
  score: number;
  reasons: string[];
}

const TASK_WORDS_REASON = 'task words match';

/** Did the task's words already match what the session holds? (Then its edited files need not be read.) */
export const hasWordMatch = (scored: SessionScore): boolean => scored.reasons.some((r) => r.startsWith(TASK_WORDS_REASON));

/**
 * The score of `session` for `task` in `project`, and why. `files` are the paths the session edited (the router asks
 * for them only for its best few candidates). A term whose weight is 0 adds nothing and is not listed.
 */
export function scoreSession(
  session: Session,
  task: string,
  project: { folder: string },
  ctx: Pick<ToolContext, 'now'>,
  weights: RouterWeights,
  files: readonly string[] = [],
): SessionScore {
  const reasons: string[] = [];
  let score = 0;
  const earn = (points: number, reason: string): void => {
    if (points <= 0) return;
    score += points;
    reasons.push(reason);
  };

  if (session.projectPath.trim() !== '' && normalizeFolder(session.projectPath) === normalizeFolder(project.folder)) {
    earn(weights.sameFolder, 'same folder');
  }

  const wanted = significantWords(task, projectWords(project.folder));
  if (wanted.size > 0) {
    const held = sessionWords(session, files);
    const shared = [...wanted].filter((word) => held.has(word)).length;
    if (shared >= Math.min(2, wanted.size)) earn(weights.taskWords, `${TASK_WORDS_REASON} (${shared})`);
  }

  if (session.status === 'idle' || session.status === 'waiting') earn(weights.idleOrWaiting, session.status);

  const { contextPct } = toSessionCard(session, []);
  if (contextPct !== null && contextPct <= HEADROOM_PCT) earn(weights.headroom, `ctx ${contextPct} %`);

  const quiet = ctx.now() - session.lastActivityAt;
  if (quiet <= HOUR_MS) earn(weights.recentActivity, `active ${ago(Math.max(0, quiet))}`);

  return { score, reasons };
}

/**
 * The paths a session edited (GET /sessions/:id/changes), or none when the route does not answer: scoring never
 * fails because a transcript could not be read.
 */
export async function editedFiles(client: InternalClient, sessionId: string): Promise<string[]> {
  let path: string;
  try {
    path = `/sessions/${seg(sessionId)}/changes`;
  } catch {
    // An id a route path cannot carry (a hook may name a session with any text): there is nothing to ask for.
    return [];
  }
  const body = bodyOf(await client.get(path));
  const files = typeof body === 'object' && body !== null ? (body as { files?: unknown }).files : null;
  return rowsOf(files, changedFileSchema).map((file) => file.path);
}
