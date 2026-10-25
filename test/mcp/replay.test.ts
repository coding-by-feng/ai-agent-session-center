// test/mcp/replay.test.ts — the replay check (server/mcp/replay.ts, run by scripts/mcp-route-replay.ts): would
// resolveProject have picked the folder each recent session was started in, from its first prompt and the folders that
// were active in the week before? Fixture rows only: no database is opened, and nothing here prints a prompt.
import { describe, expect, it } from 'vitest';
import {
  CANDIDATE_DAYS,
  REPLAY_BAR,
  REPLAY_MIN_SAMPLES,
  SAMPLE_DAYS,
  formatReplayReport,
  pickSamples,
  scoreReplay,
  type ReplayRow,
  type ReplaySample,
} from '../../server/mcp/replay.js';
import type { KnownProject } from '../../server/mcp/projectIndex.js';
import { NOW } from './toolHarness.js';
import { AGENT, HOME, SITE } from './routerFixtures.js';

const DAY = 86_400_000;
const PROMPT = 'fix the flaky queue test please, it fails on CI';

/** A session that started `daysAgo` days ago in `projectPath`, with a first prompt and activity until `lastAgo` days ago. */
function row(over: Partial<ReplayRow> & { daysAgo?: number; lastAgo?: number } = {}): ReplayRow {
  const { daysAgo = 1, lastAgo = daysAgo, ...rest } = over;
  return {
    id: `s-${Math.random().toString(36).slice(2)}`,
    projectPath: AGENT,
    startedAt: NOW - daysAgo * DAY,
    lastActivityAt: NOW - lastAgo * DAY,
    firstPrompt: PROMPT,
    firstPromptAt: NOW - daysAgo * DAY,
    ...rest,
  };
}

const options = { now: NOW, home: HOME };

describe('pickSamples', () => {
  it('samples skip commands, shell lines, short prompts and home', () => {
    const rows = [
      row({ projectPath: AGENT, firstPrompt: PROMPT }),
      row({ projectPath: AGENT, firstPrompt: '/clear' }),
      row({ projectPath: AGENT, firstPrompt: '/review the whole of the last pull request' }),
      row({ projectPath: AGENT, firstPrompt: '/plugin:command with some arguments here' }),
      row({ projectPath: AGENT, firstPrompt: '!ls -la ~/projects and then some more' }),
      row({ projectPath: AGENT, firstPrompt: '   !echo it is a shell line here, truly' }),
      row({ projectPath: AGENT, firstPrompt: 'short one' }),
      row({ projectPath: AGENT, firstPrompt: '12345678901234' }),
      row({ projectPath: AGENT, firstPrompt: '   12345678901234     ' }),
      row({ projectPath: HOME, firstPrompt: PROMPT }),
      row({ projectPath: `${HOME}/`, firstPrompt: PROMPT }),
      row({ projectPath: '/', firstPrompt: PROMPT }),
      row({ projectPath: '/home', firstPrompt: PROMPT }),
      row({ projectPath: '   ', firstPrompt: PROMPT }),
      row({ projectPath: AGENT, firstPrompt: null, firstPromptAt: null }),
    ];

    const samples = pickSamples(rows, options);

    expect(samples.map((s) => s.text)).toEqual([PROMPT]);
    expect(samples[0].truth).toBe(AGENT);
  });

  it('keeps a prompt of exactly 15 characters, and one that starts with a path rather than a command', () => {
    const rows = [
      row({ firstPrompt: '123456789012345' }),
      row({ firstPrompt: `${AGENT}/src/ledger.ts has a bug in it` }),
      row({ firstPrompt: '/Users/kason/proj fix the failing test' }),
    ];

    expect(pickSamples(rows, options)).toHaveLength(3);
  });

  it('takes the first prompt of each session in the last 14 days, and no older one', () => {
    const rows = [
      row({ daysAgo: 0.5 }),
      row({ daysAgo: SAMPLE_DAYS - 0.1 }),
      row({ daysAgo: SAMPLE_DAYS + 0.1, lastAgo: 1 }),
      row({ daysAgo: 30, lastAgo: 29 }),
    ];

    expect(pickSamples(rows, options)).toHaveLength(2);
  });

  it('dates a sample by its first prompt, else by when the session started', () => {
    const late = row({ daysAgo: 20, lastAgo: 1, firstPromptAt: NOW - 2 * DAY });
    const noTime = row({ daysAgo: 3, firstPromptAt: null });

    const samples = pickSamples([late, noTime], options);

    expect(samples.map((s) => s.at).sort((a, b) => a - b)).toEqual([NOW - 3 * DAY, NOW - 2 * DAY]);
  });

  it('candidates are the folders with activity in the 7 days before the sample, as live projects with that recency', () => {
    const sampleRow = row({ projectPath: AGENT, daysAgo: 2 });
    const rows = [
      sampleRow,
      row({ projectPath: SITE, daysAgo: 5, lastAgo: 4 }), // active 4 days ago: in the week before
      row({ projectPath: SITE, daysAgo: 8, lastAgo: 3 }), // the same folder, more recently: that one counts
      row({ projectPath: `${HOME}/code/old`, daysAgo: 12, lastAgo: 9.5 }), // active, but more than 7 days before the sample
      row({ projectPath: `${HOME}/code/later`, daysAgo: 1, lastAgo: 0.5 }), // active only after the sample
      row({ projectPath: HOME, daysAgo: 4, lastAgo: 3 }), // home is never a project
      row({ projectPath: '/', daysAgo: 4, lastAgo: 3 }),
      row({ projectPath: '  ', daysAgo: 4, lastAgo: 3 }),
    ];

    const sample = pickSamples(rows, options).find((s) => s.truth === AGENT && s.at === NOW - 2 * DAY);

    expect(sample?.candidates).toEqual<KnownProject[]>([
      { folder: SITE, name: 'site', sources: ['live'], lastActiveAt: NOW - 3 * DAY, roomIds: [] },
    ]);
  });

  it('a candidate folder is named once, whatever its spelling, at its latest activity', () => {
    const rows = [
      row({ projectPath: AGENT, daysAgo: 1 }),
      row({ projectPath: SITE, daysAgo: 6, lastAgo: 4 }),
      row({ projectPath: `${SITE}/`, daysAgo: 6, lastAgo: 5 }),
    ];

    const sample = pickSamples(rows, options).find((s) => s.truth === AGENT);

    expect(sample?.candidates.map((c) => [c.folder, c.lastActiveAt])).toEqual([[SITE, NOW - 4 * DAY]]);
  });

  it('a session is never a candidate for its own sample', () => {
    const only = row({ projectPath: AGENT, daysAgo: 3, lastAgo: 3 });

    const samples = pickSamples([only], options);

    expect(samples[0].candidates).toEqual([]);
  });

  it('uses the windows the plan names', () => {
    expect(SAMPLE_DAYS).toBe(14);
    expect(CANDIDATE_DAYS).toBe(7);
    expect(REPLAY_BAR).toBe(0.7);
    expect(REPLAY_MIN_SAMPLES).toBe(30);
  });

  it('changes nothing it is given', () => {
    const rows = Object.freeze([Object.freeze(row())]);

    expect(() => pickSamples(rows, options)).not.toThrow();
  });
});

const candidate = (folder: string, ago = 1): KnownProject => ({
  folder, name: folder.split('/').pop() ?? '', sources: ['live'], lastActiveAt: NOW - ago * DAY, roomIds: [],
});

/** A sample whose prompt names `named`'s project (or nothing), whose truth is `truth`, with both as candidates. */
function sample(text: string, truth: string, candidates: KnownProject[] = [candidate(AGENT, 2), candidate(SITE, 1)]): ReplaySample {
  return { at: NOW, text, truth, candidates };
}

describe('scoreReplay', () => {
  it('accuracy counts top-1 matches', () => {
    const samples = [
      ...Array.from({ length: 30 }, () => sample('look into the agent manager queue please', AGENT)),
      ...Array.from({ length: 10 }, () => sample('look into the site footer please now', AGENT)),
    ];

    const result = scoreReplay(samples, HOME);

    expect(result).toMatchObject({ samples: 40, correct: 30, accuracy: 0.75, status: 'pass' });
  });

  it('below the bar is a fail, at the bar a pass', () => {
    const wrong = (n: number) => Array.from({ length: n }, () => sample('look into the site footer please now', AGENT));
    const right = (n: number) => Array.from({ length: n }, () => sample('look into the agent manager queue', AGENT));

    expect(scoreReplay([...right(21), ...wrong(9)], HOME)).toMatchObject({ accuracy: 0.7, status: 'pass' });
    expect(scoreReplay([...right(20), ...wrong(10)], HOME).status).toBe('fail');
  });

  it('with no name to go on, the most recently active folder is the pick (low confidence)', () => {
    const result = scoreReplay([sample('tidy up the backlog for me please', SITE)], HOME);

    expect(result.correct).toBe(1);
  });

  it('fewer than 30 samples reports insufficient', () => {
    const right = (n: number) => Array.from({ length: n }, () => sample('look into the agent manager queue', AGENT));

    expect(scoreReplay(right(29), HOME)).toMatchObject({ samples: 29, accuracy: 1, status: 'insufficient' });
    expect(scoreReplay(right(30), HOME)).toMatchObject({ samples: 30, accuracy: 1, status: 'pass' });
    expect(scoreReplay([], HOME)).toMatchObject({ samples: 0, correct: 0, accuracy: null, status: 'insufficient', worstMisses: [] });
  });

  it('a sample whose truth is not among its candidates is a miss', () => {
    const result = scoreReplay([sample('look into the agent manager queue', `${HOME}/code/new`)], HOME);

    expect(result.correct).toBe(0);
    expect(result.worstMisses).toEqual([{ truth: 'new', picked: 'agent-manager', confidence: 'high' }]);
  });

  it('a sample with no candidates is a miss with nothing picked', () => {
    const result = scoreReplay([sample('look into the agent manager queue', AGENT, [])], HOME);

    expect(result.worstMisses).toEqual([{ truth: 'agent-manager', picked: null, confidence: 'none' }]);
  });

  it('lists at most the ten worst misses, the most confident first, as folder names only', () => {
    const SECRET = 'pay the invoice for the secret merger';
    const high = Array.from({ length: 6 }, () => sample(`${SECRET} in agent manager`, SITE));
    const low = Array.from({ length: 8 }, () => sample(`${SECRET} somewhere`, AGENT, [candidate(SITE, 1), candidate(AGENT, 3)]));
    const medium = Array.from({ length: 2 }, () => sample(`${SECRET} agent manager and site`, `${HOME}/code/third`));

    const result = scoreReplay([...low, ...medium, ...high], HOME);

    expect(result.worstMisses).toHaveLength(10);
    expect(result.worstMisses.map((m) => m.confidence)).toEqual([...Array(6).fill('high'), ...Array(2).fill('medium'), ...Array(2).fill('low')]);
    expect(result.worstMisses[0]).toEqual({ truth: 'site', picked: 'agent-manager', confidence: 'high' });
    expect(JSON.stringify(result)).not.toContain('merger');
  });
});

describe('formatReplayReport', () => {
  const SECRET = 'wire the money to the secret account';

  it('says the accuracy, the sample count, the bar and the worst misses by folder name, and never a prompt', () => {
    const samples = [
      ...Array.from({ length: 35 }, () => sample('look into the agent manager queue', AGENT)),
      sample(`${SECRET} for agent manager`, SITE),
    ];

    const text = formatReplayReport(scoreReplay(samples, HOME)).join('\n');

    expect(text).toContain('36');
    expect(text).toMatch(/97\.2 %/);
    expect(text).toMatch(/PASS/);
    expect(text).toContain('truth site');
    expect(text).toContain('picked agent-manager');
    expect(text).not.toContain('secret');
    expect(text).not.toContain(HOME);
  });

  it('says insufficient, and how many more are needed', () => {
    const text = formatReplayReport(scoreReplay([sample('look into the agent manager queue', AGENT)], HOME)).join('\n');

    expect(text).toMatch(/INSUFFICIENT/);
    expect(text).toMatch(/1 sample/);
    expect(text).toMatch(/30/);
  });

  it('says fail, with the bar it missed', () => {
    const samples = Array.from({ length: 30 }, () => sample('look into the site footer please now', AGENT));

    const text = formatReplayReport(scoreReplay(samples, HOME)).join('\n');

    expect(text).toMatch(/FAIL/);
    expect(text).toMatch(/70 %/);
  });
});
