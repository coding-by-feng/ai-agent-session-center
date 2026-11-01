import { describe, expect, it } from 'vitest';
import {
  buildLiveActivityCard,
  LIVE_ACTIVITY_DETAIL_MAX,
  LIVE_ACTIVITY_TITLE_MAX,
  sameLiveActivityCard,
  type LiveActivitySession,
} from './liveActivityCard';

const s = (status: string, lastActivityAt: number, title = `t${lastActivityAt}`, extra: Partial<LiveActivitySession> = {}): LiveActivitySession =>
  ({ status, lastActivityAt, title, ...extra });

describe('buildLiveActivityCard', () => {
  it('leads with the working session, then the latest others newest first, and counts the rest', () => {
    const card = buildLiveActivityCard([
      s('waiting', 1), s('idle', 5), s('working', 3), s('waiting', 4), s('waiting', 2), s('idle', 6),
    ]);
    expect(card.rows.map((r) => r.title)).toEqual(['t3', 't6', 't5', 't4']);
    expect(card.more).toBe(2);
  });

  it('lead: the newest waiting-on-you session, else the newest working one, else the newest done one', () => {
    expect(buildLiveActivityCard([s('working', 5), s('approval', 1), s('input', 2)]).rows[0].title).toBe('t2');
    expect(buildLiveActivityCard([s('waiting', 9), s('working', 1), s('prompting', 3)]).rows[0].title).toBe('t3');
    expect(buildLiveActivityCard([s('waiting', 1), s('idle', 4)]).rows[0].title).toBe('t4');
  });

  it('marks each status and leaves ended or starting sessions off', () => {
    const card = buildLiveActivityCard([
      s('approval', 6), s('input', 5), s('prompting', 4), s('working', 3), s('ended', 9), s('connecting', 8),
    ]);
    expect(card.rows.map((r) => r.mark).sort()).toEqual(['needs', 'needs', 'working', 'working']);
    expect(card.more).toBe(0);
  });

  it('headline: needs you beats working beats finished', () => {
    expect(buildLiveActivityCard([s('working', 2), s('approval', 1)]).headline).toBe('needs');
    expect(buildLiveActivityCard([s('waiting', 2), s('working', 1)]).headline).toBe('working');
    expect(buildLiveActivityCard([s('waiting', 2), s('idle', 1)]).headline).toBe('finished');
  });

  it('counts needs and working across every live session, not just the rows shown', () => {
    const card = buildLiveActivityCard([
      s('waiting', 9), s('waiting', 8), s('waiting', 7), s('waiting', 6), s('approval', 1), s('working', 2),
    ]);
    expect(card.headline).toBe('needs');
    expect(card.needs).toBe(1);
    expect(card.working).toBe(1);
  });

  it('flags idle rows (still mark done, so an older app draws them as ✓) and counts every idle session', () => {
    const card = buildLiveActivityCard([
      s('idle', 9), s('waiting', 8), s('idle', 7), s('idle', 6), s('idle', 5), s('working', 1),
    ]);
    expect(card.rows.map((r) => [r.title, r.mark, r.idle])).toEqual([
      ['t1', 'working', undefined], ['t9', 'done', true], ['t8', 'done', undefined], ['t7', 'done', true],
    ]);
    expect(card.idle).toBe(4);
    expect(card.headline).toBe('working');
  });

  it('an all-idle card stays headline finished (the native side reads the idle count)', () => {
    const card = buildLiveActivityCard([s('idle', 2), s('idle', 1)]);
    expect(card.headline).toBe('finished');
    expect(card.idle).toBe(2);
    expect(card.rows.every((r) => r.idle)).toBe(true);
  });

  it('leaves muted sessions off', () => {
    expect(buildLiveActivityCard([s('approval', 1, 'x', { muted: true })]).rows).toEqual([]);
  });

  it('has no rows when nothing is live (the native side ends the activity)', () => {
    const card = buildLiveActivityCard([s('ended', 1)]);
    expect(card.rows).toEqual([]);
    expect(card.headline).toBe('finished');
  });

  it('falls back to the project name, flattens whitespace and clips long titles', () => {
    const [a, b] = buildLiveActivityCard([
      s('waiting', 2, '', { projectName: 'agent-manager' }),
      s('waiting', 1, `line one\n\tline two ${'x'.repeat(80)}`),
    ]).rows;
    expect(a.title).toBe('agent-manager');
    expect(b.title.startsWith('line one line two x')).toBe(true);
    expect(b.title).toHaveLength(LIVE_ACTIVITY_TITLE_MAX);
    expect(b.title.endsWith('…')).toBe(true);
  });
});

describe('buildLiveActivityCard timers', () => {
  const prompt = (timestamp: number) => ({ text: 'p', timestamp });

  it('a working row counts from its newest prompt', () => {
    const [row] = buildLiveActivityCard([s('working', 50, 'w', { promptHistory: [prompt(10), prompt(40)] })]).rows;
    expect(row.startedAt).toBe(40);
  });

  it('a waiting-on-you row counts from when its request was raised', () => {
    const [row] = buildLiveActivityCard([
      s('approval', 50, 'a', { promptHistory: [prompt(10)], pendingRequest: { raisedAt: 30 } }),
    ]).rows;
    expect(row.startedAt).toBe(30);
  });

  it('a working row with no prompt counts from its last activity; a done row has no timer', () => {
    const card = buildLiveActivityCard([s('working', 50), s('waiting', 40, 'd', { promptHistory: [prompt(10)] })]);
    expect(card.rows[0].startedAt).toBe(50);
    expect(card.rows[1].startedAt).toBeUndefined();
  });

  it('drops a start time that is not a positive number', () => {
    const [row] = buildLiveActivityCard([s('working', 0, 'w', { promptHistory: [prompt(Number.NaN)] })]).rows;
    expect(row.startedAt).toBeUndefined();
  });
});

describe('buildLiveActivityCard preview line', () => {
  const at = (text: string, timestamp: number) => ({ text, timestamp });

  it('only the lead row carries one', () => {
    const card = buildLiveActivityCard([
      s('working', 9, 'w', { responseLog: [at('reading the map', 9)] }),
      s('waiting', 5, 'd', { responseLog: [at('done', 5)] }),
    ]);
    expect(card.rows[0].detail).toBe('reading the map');
    expect(card.rows[1].detail).toBeUndefined();
  });

  it('working: the latest response of this turn, else its latest tool call', () => {
    const turn = { promptHistory: [{ text: 'p', timestamp: 20 }] };
    expect(buildLiveActivityCard([
      s('working', 30, 'w', { ...turn, responseLog: [at('old', 10), at('new', 25)] }),
    ]).rows[0].detail).toBe('new');
    expect(buildLiveActivityCard([
      s('working', 30, 'w', { ...turn, responseLog: [at('old', 10)], toolLog: [{ tool: 'Edit', input: 'src/a.ts', timestamp: 22 }] }),
    ]).rows[0].detail).toBe('Edit · src/a.ts');
    expect(buildLiveActivityCard([
      s('working', 30, 'w', { ...turn, responseLog: [at('old', 10)], toolLog: [{ tool: 'Edit', input: 'x', timestamp: 5 }] }),
    ]).rows[0].detail).toBeUndefined();
  });

  it('waiting on you: what it asks for', () => {
    expect(buildLiveActivityCard([
      s('approval', 30, 'a', { pendingTool: 'Bash', pendingToolDetail: 'rm -rf dist' }),
    ]).rows[0].detail).toBe('Bash · rm -rf dist');
    expect(buildLiveActivityCard([s('input', 30, 'a', { waitingDetail: 'Which region?' })]).rows[0].detail).toBe('Which region?');
  });

  it('done: its last response, flattened and clipped', () => {
    const [row] = buildLiveActivityCard([s('waiting', 30, 'd', { responseLog: [at(`All set.\n\n${'y'.repeat(200)}`, 30)] })]).rows;
    expect(row.detail?.startsWith('All set. y')).toBe(true);
    expect(row.detail).toHaveLength(LIVE_ACTIVITY_DETAIL_MAX);
  });
});

describe('sameLiveActivityCard', () => {
  it('is false with nothing sent and true for equal content', () => {
    const card = buildLiveActivityCard([s('working', 1)]);
    expect(sameLiveActivityCard(null, card)).toBe(false);
    expect(sameLiveActivityCard(buildLiveActivityCard([s('working', 1)]), card)).toBe(true);
    expect(sameLiveActivityCard(buildLiveActivityCard([s('waiting', 1)]), card)).toBe(false);
  });
});
