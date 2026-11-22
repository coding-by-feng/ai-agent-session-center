/**
 * The daily review's server side (Nov 20 2026): GET a day's prompts grouped project › room › session,
 * POST to have the day summarized and kept. The model is injected: no `claude` process starts here,
 * and the database is a fake, so nothing touches a real sessions.db.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { createDailyReviewService, type DailyReviewDeps, type StoredDailySummary } from '../server/dailyReview.js';
import { DAILY_SUMMARY_INSTRUCTION, DAILY_TEXT_MAX, type DailyPromptRow } from '../src/lib/dailyReview.js';

const DAY = '2026-11-20';
const at = (h: number, m = 0) => new Date(2026, 10, 20, h, m).getTime();
const row = (id: number, over: Partial<DailyPromptRow> = {}): DailyPromptRow => ({
  id, session_id: 's1', text: `prompt ${id}`, timestamp: at(9, id),
  project_name: 'agent-manager', project_path: '/w/am', session_title: 'Plan 18', ...over,
});

let rows: DailyPromptRow[];
let stored: Map<string, StoredDailySummary>;
let asked: string[];
let release: Array<(text: string) => void>;
let fail: Array<(err: Error) => void>;
let ranges: Array<[number, number]>;
let deps: DailyReviewDeps;

beforeEach(() => {
  rows = [row(1), row(2), row(3, { session_id: 's2', session_title: 'Sketch' })];
  stored = new Map();
  asked = [];
  release = [];
  fail = [];
  ranges = [];
  deps = {
    readPrompts: (from, to) => {
      ranges.push([from, to]);
      return rows.filter((r) => r.timestamp >= from && r.timestamp < to);
    },
    roomOf: () => (id) => (id === 's1' ? 'Cloud' : null),
    getSummary: (day) => stored.get(day) ?? null,
    saveSummary: (s) => { stored.set(s.day, s); },
    runModel: (prompt) => new Promise<string>((ok, no) => { asked.push(prompt); release.push(ok); fail.push(no); }),
    now: () => at(17, 5),
  };
});
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('read', () => {
  it('refuses a day that is not YYYY-MM-DD', () => {
    const svc = createDailyReviewService(deps);
    expect(svc.read('2026-02-30')).toEqual({ ok: false, status: 400, error: 'Pick a day as YYYY-MM-DD.' });
    expect(ranges).toEqual([]);
  });

  it('reads exactly that local day and groups it, with no summary yet', () => {
    const out = createDailyReviewService(deps).read(DAY);
    expect(ranges).toEqual([[at(0), new Date(2026, 10, 21).getTime()]]);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.review).toMatchObject({ day: DAY, promptCount: 3, sessionCount: 2, projectCount: 1, summary: null, summarizing: false });
    expect(out.review.projects[0].rooms.map((r) => r.name)).toEqual(['Cloud', 'No room']);
  });

  it('clips a very long prompt in what it answers, and says how long it was', () => {
    rows = [row(1, { text: 'x'.repeat(DAILY_TEXT_MAX + 500) }), row(2)];
    const out = createDailyReviewService(deps).read(DAY);
    if (!out.ok) throw new Error('expected a day');
    const [long, short] = out.review.projects[0].rooms[0].sessions[0].prompts;
    expect(long.text).toHaveLength(DAILY_TEXT_MAX);
    expect(long.fullLength).toBe(DAILY_TEXT_MAX + 500);
    expect(short).toEqual({ id: 2, text: 'prompt 2', timestamp: at(9, 2) });
  });
});

describe('summarize', () => {
  it('has nothing to summarize on a day with no prompts', async () => {
    rows = [];
    expect(await createDailyReviewService(deps).summarize(DAY)).toEqual({ ok: false, status: 404, error: 'Nothing was typed on this day.' });
    expect(asked).toEqual([]);
  });

  it('asks the model once with the instruction and the day, keeps the answer, and reads it back fresh', async () => {
    const svc = createDailyReviewService(deps);
    const pending = svc.summarize(DAY);
    await settle();
    expect(asked).toHaveLength(1);
    expect(asked[0].startsWith(DAILY_SUMMARY_INSTRUCTION)).toBe(true);
    expect(asked[0]).toContain('Session: Plan 18');
    expect(svc.read(DAY).ok && (svc.read(DAY) as { review: { summarizing: boolean } }).review.summarizing).toBe(true);

    release[0]('Sure, here you go:\n- agent-manager: built the switcher\n- agent-manager: sketched the daily review');
    const out = await pending;
    expect(out).toEqual({
      ok: true,
      summary: {
        text: '• agent-manager: built the switcher\n• agent-manager: sketched the daily review',
        model: 'haiku', promptCount: 3, generatedAt: at(17, 5), stale: false,
      },
    });
    expect(stored.get(DAY)).toMatchObject({ day: DAY, promptCount: 3, sessionCount: 2, model: 'haiku' });
    const again = svc.read(DAY);
    expect(again.ok && again.review.summary).toMatchObject({ stale: false, promptCount: 3 });
    expect(again.ok && again.review.summarizing).toBe(false);
  });

  it('marks the kept summary stale once a newer prompt is typed that day', async () => {
    const svc = createDailyReviewService(deps);
    const pending = svc.summarize(DAY);
    await settle();
    release[0]('- done');
    await pending;
    rows = [...rows, row(9, { timestamp: at(17, 30) })];
    const out = svc.read(DAY);
    expect(out.ok && out.review.summary?.stale).toBe(true);
  });

  it('runs one summary at a time', async () => {
    const svc = createDailyReviewService(deps);
    const first = svc.summarize(DAY);
    await settle();
    expect(await svc.summarize(DAY)).toEqual({ ok: false, status: 429, error: 'A summary is already being written. Try again when it is done.' });
    release[0]('- ok');
    await first;
    expect(asked).toHaveLength(1);
  });

  it('shows the run only on the day being written; another day still waits its turn', async () => {
    const OTHER = '2026-11-19';
    rows = [...rows, row(7, { timestamp: new Date(2026, 10, 19, 10).getTime() })];
    const svc = createDailyReviewService(deps);
    const first = svc.summarize(DAY);
    await settle();
    const other = svc.read(OTHER);
    expect(other.ok && other.review.summarizing).toBe(false);
    expect(await svc.summarize(OTHER)).toMatchObject({ ok: false, status: 429 });
    release[0]('- ok');
    await first;
  });

  it('says why in words when the CLI is missing, keeps nothing, and frees the slot', async () => {
    const svc = createDailyReviewService(deps);
    const pending = svc.summarize(DAY);
    await settle();
    fail[0](Object.assign(new Error('spawn claude ENOENT /usr/local/secret/path'), { code: 'ENOENT' }));
    const out = await pending;
    expect(out).toEqual({ ok: false, status: 502, error: 'Could not summarize: the Claude CLI isn’t installed on this Mac.' });
    expect(stored.size).toBe(0);
    const read = svc.read(DAY);
    expect(read.ok && read.review.summarizing).toBe(false);
  });

  it('keeps nothing when the model answers with nothing', async () => {
    const svc = createDailyReviewService(deps);
    const pending = svc.summarize(DAY);
    await settle();
    release[0]('  \n');
    expect(await pending).toEqual({ ok: false, status: 502, error: 'Could not summarize: the summarizer returned nothing.' });
    expect(stored.size).toBe(0);
  });
});

describe('routes', () => {
  let server: Server | null = null;
  let base = '';
  const start = async () => {
    const app = express();
    app.use(express.json());
    app.use('/api', createDailyReviewService(deps).router);
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => server!.once('listening', () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  };
  afterEach(async () => {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    server = null;
  });

  it('GET answers the grouped day, and 400 for a bad day', async () => {
    await start();
    const ok = await fetch(`${base}/daily-review?day=${DAY}`);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ day: DAY, promptCount: 3 });
    const bad = await fetch(`${base}/daily-review?day=nope`);
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ success: false, error: 'Pick a day as YYYY-MM-DD.' });
  });

  it('POST waits for the summary and answers it', async () => {
    await start();
    const res = fetch(`${base}/daily-review/${DAY}/summary`, { method: 'POST' });
    for (let i = 0; i < 50 && release.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    release[0]('- agent-manager: shipped');
    const out = await res;
    expect(out.status).toBe(200);
    expect(await out.json()).toMatchObject({ ok: true, summary: { text: '• agent-manager: shipped' } });
  });
});
