// dailyReview.ts — the PROMPTS Days view's server side (Nov 20 2026): one local day's typed prompts,
// grouped project › room › session, and the day's summary, written when asked and kept in SQLite.
//
//   GET  /api/daily-review?day=YYYY-MM-DD        → the grouped day + its kept summary (stale or not)
//   POST /api/daily-review/:day/summary          → writes the summary, answers it when done
//
// Host only: apiRouter mounts `requireLocalForHistory` in front, because a day crosses every session
// and a remote device may see only the sessions shared with it.
//
// The model call is injected (`runModel`): apiRouter passes the same tool-less, MCP-less `claude -p`
// the recap uses, and tests pass a fake, so no test starts a process. One summary is written at a
// time; the input is built here from the day's rows (capped by `dailySummaryInput`), so a caller
// cannot choose what goes to the model.

import { createHash } from 'crypto';
import { Router, type Request, type Response } from 'express';
import {
  DAILY_SUMMARY_INSTRUCTION,
  buildDailyReview,
  cleanDailySummary,
  clipDailyText,
  dailySummaryInput,
  dayBounds,
  type DailyPromptRow,
} from '../src/lib/dailyReview.js';
import type { DailyReview, DailySummary } from '../src/types/dailyReview.js';
import log from './logger.js';

/** The model `SUMMARIZE_CLAUDE_ARGS` runs: recorded with each summary. */
export const DAILY_SUMMARY_MODEL = 'haiku';

/** One row of `daily_reviews`. */
export interface StoredDailySummary {
  day: string;
  summary: string;
  model: string;
  promptCount: number;
  sessionCount: number;
  /** Which prompts it was written from (`fingerprint`), to tell when a newer one was typed. */
  fingerprint: string;
  generatedAt: number;
}

export interface DailyReviewDeps {
  /** Typed prompts with `from <= timestamp < to`, any order. */
  readPrompts: (from: number, to: number) => DailyPromptRow[];
  /** A lookup of the room each session is in now, made once per request. */
  roomOf: () => (sessionId: string) => string | null;
  getSummary: (day: string) => StoredDailySummary | null;
  saveSummary: (row: StoredDailySummary) => void;
  /** Ask the small model; resolves with its plain-text answer. */
  runModel: (prompt: string) => Promise<string>;
  now?: () => number;
}

export type DailyReadResult = { ok: true; review: DailyReview } | { ok: false; status: 400; error: string };
export type DailySummarizeResult =
  | { ok: true; summary: DailySummary }
  | { ok: false; status: 400 | 404 | 429 | 502; error: string };

const BAD_DAY = 'Pick a day as YYYY-MM-DD.';

/** Words for the person: never a raw error, which can carry paths. */
function reasonOf(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === 'ENOENT') return 'the Claude CLI isn’t installed on this Mac';
  if ((err as { killed?: unknown } | null)?.killed === true || code === 'ETIMEDOUT') return 'the summarizer took too long';
  return 'the summarizer failed';
}

/** The prompts a summary covers, as one short hash: a new prompt that day changes it. */
function fingerprint(review: Omit<DailyReview, 'summary' | 'summarizing'>): string {
  const ids = review.projects.flatMap((p) => p.rooms.flatMap((r) => r.sessions.flatMap((s) => s.prompts.map((q) => q.id))));
  return createHash('sha256').update(ids.sort((a, b) => a - b).join(',')).digest('hex').slice(0, 32);
}

function toSummary(row: StoredDailySummary, current: string): DailySummary {
  return { text: row.summary, model: row.model, promptCount: row.promptCount, generatedAt: row.generatedAt, stale: row.fingerprint !== current };
}

export function createDailyReviewService(deps: DailyReviewDeps): {
  read: (day: string) => DailyReadResult;
  summarize: (day: string) => Promise<DailySummarizeResult>;
  router: Router;
} {
  const now = deps.now ?? Date.now;
  let running: string | null = null;

  const grouped = (day: string) => {
    const bounds = dayBounds(day);
    if (!bounds) return null;
    return buildDailyReview(day, deps.readPrompts(bounds.from, bounds.to), deps.roomOf());
  };

  const read = (day: string): DailyReadResult => {
    const review = grouped(day);
    if (!review) return { ok: false, status: 400, error: BAD_DAY };
    const kept = deps.getSummary(day);
    return {
      ok: true,
      // Clipped for the browser only: the fingerprint and the model's input use the whole day.
      // `summarizing` names this day alone; a press on another day meanwhile still gets the 429.
      review: { ...clipDailyText(review), summary: kept ? toSummary(kept, fingerprint(review)) : null, summarizing: running === day },
    };
  };

  const summarize = async (day: string): Promise<DailySummarizeResult> => {
    const review = grouped(day);
    if (!review) return { ok: false, status: 400, error: BAD_DAY };
    if (review.promptCount === 0) return { ok: false, status: 404, error: 'Nothing was typed on this day.' };
    if (running !== null) return { ok: false, status: 429, error: 'A summary is already being written. Try again when it is done.' };
    running = day;
    try {
      const answer = cleanDailySummary(await deps.runModel(`${DAILY_SUMMARY_INSTRUCTION}\n\n---\n${dailySummaryInput(review)}`));
      if (!answer) return { ok: false, status: 502, error: 'Could not summarize: the summarizer returned nothing.' };
      const row: StoredDailySummary = {
        day,
        summary: answer,
        model: DAILY_SUMMARY_MODEL,
        promptCount: review.promptCount,
        sessionCount: review.sessionCount,
        fingerprint: fingerprint(review),
        generatedAt: now(),
      };
      deps.saveSummary(row);
      return { ok: true, summary: toSummary(row, row.fingerprint) };
    } catch (err: unknown) {
      log.warn('daily-review', `Summary of ${day} failed: ${err instanceof Error ? err.message : String(err)}`);
      return { ok: false, status: 502, error: `Could not summarize: ${reasonOf(err)}.` };
    } finally {
      running = null;
    }
  };

  const router = Router();
  router.get('/daily-review', (req: Request, res: Response) => {
    const day = typeof req.query.day === 'string' ? req.query.day : '';
    const out = read(day);
    if (!out.ok) {
      res.status(out.status).json({ success: false, error: out.error });
      return;
    }
    res.json(out.review);
  });
  router.post('/daily-review/:day/summary', async (req: Request, res: Response) => {
    const out = await summarize(String(req.params.day ?? ''));
    if (!out.ok) {
      res.status(out.status).json({ success: false, error: out.error });
      return;
    }
    res.json({ ok: true, summary: out.summary });
  });

  return { read, summarize, router };
}
