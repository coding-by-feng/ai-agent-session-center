/**
 * The daily review's pure core (Nov 20 2026): which prompts count, how a day is cut out of the
 * `prompts` table, how a day's prompts are grouped project › room › session, and what is sent to
 * the model for the day's summary.
 */
import { describe, it, expect } from 'vitest';
import {
  DAILY_INPUT_MAX,
  DAILY_PROMPT_CHARS,
  DAILY_SUMMARY_LINES,
  NO_ROOM,
  buildDailyReview,
  cleanDailySummary,
  dailySummaryInput,
  dayBounds,
  isBareCommand,
  isDayKey,
  localDayKey,
  shiftDay,
  type DailyPromptRow,
} from './dailyReview';

const at = (h: number, m = 0) => new Date(2026, 10, 20, h, m).getTime();
const row = (over: Partial<DailyPromptRow> & { id: number }): DailyPromptRow => ({
  session_id: 's1',
  text: 'build it',
  timestamp: at(9),
  project_name: 'agent-manager',
  project_path: '/w/agent-manager',
  session_title: 'Plan 18 devices',
  ...over,
});

describe('day keys', () => {
  it('accepts a real calendar day and refuses anything else', () => {
    expect(isDayKey('2026-11-20')).toBe(true);
    expect(isDayKey('2028-02-29')).toBe(true);
    for (const bad of ['2026-02-30', '2026-13-01', '2026-1-01', '20261120', '', 'today', '2026-11-20T00:00']) {
      expect(isDayKey(bad)).toBe(false);
    }
  });

  it('cuts the day from this computer’s midnight to the next one', () => {
    const b = dayBounds('2026-11-20');
    expect(b).not.toBeNull();
    const from = new Date(b!.from);
    const to = new Date(b!.to);
    expect([from.getFullYear(), from.getMonth(), from.getDate(), from.getHours(), from.getMinutes()]).toEqual([2026, 10, 20, 0, 0]);
    expect([to.getMonth(), to.getDate(), to.getHours()]).toEqual([10, 21, 0]);
    expect(dayBounds('2026-02-30')).toBeNull();
  });

  it('names the local day of a moment, and steps across month and year ends', () => {
    expect(localDayKey(at(23, 59))).toBe('2026-11-20');
    expect(localDayKey(new Date(2026, 0, 5, 0, 0).getTime())).toBe('2026-01-05');
    expect(shiftDay('2026-03-01', -1)).toBe('2026-02-28');
    expect(shiftDay('2026-12-31', 1)).toBe('2027-01-01');
    expect(shiftDay('2026-11-20', 0)).toBe('2026-11-20');
  });
});

describe('which prompts count', () => {
  it('drops a bare slash command or $skill, keeps one that says something', () => {
    expect(isBareCommand('/clear')).toBe(true);
    expect(isBareCommand('  /model\n')).toBe(true);
    expect(isBareCommand('$Review')).toBe(true);
    expect(isBareCommand('/plugin:skill')).toBe(true);
    expect(isBareCommand('/rar add a daily review')).toBe(false);
    expect(isBareCommand('fix /api/foo please')).toBe(false);
    expect(isBareCommand('build it')).toBe(false);
  });
});

describe('buildDailyReview', () => {
  const rooms = new Map([['s1', 'Cloud'], ['s2', 'Cloud'], ['w1', 'Site']]);
  const rows: DailyPromptRow[] = [
    row({ id: 1, session_id: 's1', timestamp: at(9, 12), text: 'first' }),
    row({ id: 2, session_id: 's2', timestamp: at(16, 32), session_title: 'Daily review sketch', text: 'sketch it' }),
    row({ id: 3, session_id: 's1', timestamp: at(16, 30), text: 'second' }),
    row({ id: 4, session_id: 's3', timestamp: at(14, 2), session_title: 'Fix rooms icon', text: 'move the icon' }),
    row({ id: 5, session_id: 'w1', timestamp: at(10), project_name: 'website', project_path: '/w/website', session_title: '', text: 'terms page' }),
    row({ id: 6, session_id: 's3', timestamp: at(14, 5), text: '/clear' }),
    row({ id: 7, session_id: 'x', timestamp: at(11), project_name: null, project_path: null, session_title: null, text: 'orphan' }),
  ];
  const review = buildDailyReview('2026-11-20', rows, (id) => rooms.get(id) ?? null);

  it('counts the prompts, sessions and projects that remain after bare commands go', () => {
    expect(review.day).toBe('2026-11-20');
    expect(review.promptCount).toBe(6);
    expect(review.sessionCount).toBe(5);
    expect(review.projectCount).toBe(3);
  });

  it('puts the busiest project first, then by name', () => {
    expect(review.projects.map((p) => p.name)).toEqual(['agent-manager', 'Unknown project', 'website']);
    expect(review.projects[0]).toMatchObject({ path: '/w/agent-manager', promptCount: 4, sessionCount: 3 });
  });

  it('groups by room with No room last, and sessions in the order they started', () => {
    const am = review.projects[0];
    expect(am.rooms.map((r) => r.name)).toEqual(['Cloud', NO_ROOM]);
    expect(am.rooms[0].sessions.map((s) => s.title)).toEqual(['Plan 18 devices', 'Daily review sketch']);
    expect(am.rooms[1].sessions.map((s) => s.sessionId)).toEqual(['s3']);
  });

  it('keeps each session’s prompts oldest first, with its time span', () => {
    const s1 = review.projects[0].rooms[0].sessions[0];
    expect(s1.prompts.map((p) => p.text)).toEqual(['first', 'second']);
    expect(s1).toMatchObject({ promptCount: 2, firstAt: at(9, 12), lastAt: at(16, 30) });
  });

  it('names a session with no title the way the rest of the app does', () => {
    const site = review.projects.find((p) => p.name === 'website')!;
    expect(site.rooms[0].sessions[0].title).toBe('website');
  });

  it('is empty, not broken, for a day with nothing typed', () => {
    const none = buildDailyReview('2026-11-21', [], () => null);
    expect(none).toMatchObject({ promptCount: 0, sessionCount: 0, projectCount: 0, projects: [] });
  });
});

describe('dailySummaryInput', () => {
  it('lays the day out by project, room and session, each prompt on one line with its time', () => {
    const review = buildDailyReview('2026-11-20', [
      row({ id: 1, timestamp: at(9, 12), text: 'build the\nswitcher' }),
      row({ id: 2, session_id: 'w1', project_name: 'website', project_path: '/w/website', session_title: 'Terms', timestamp: at(10, 5), text: 'terms page' }),
    ], (id) => (id === 's1' ? 'Cloud' : null));
    const text = dailySummaryInput(review);
    expect(text).toContain('2 prompts in 2 sessions across 2 projects');
    expect(text).toContain('Project: agent-manager');
    expect(text).toContain('Room: Cloud');
    expect(text).toContain('Session: Plan 18 devices');
    expect(text).toContain('- 09:12 build the switcher');
    expect(text).not.toContain('Room: No room');
  });

  it('cuts a long prompt short and keeps a busy day under the cap, saying what was left out', () => {
    const long = 'x'.repeat(5_000);
    const one = dailySummaryInput(buildDailyReview('2026-11-20', [row({ id: 1, text: long })], () => null));
    const line = one.split('\n').find((l) => l.startsWith('- '))!;
    expect(line.length).toBeLessThanOrEqual(DAILY_PROMPT_CHARS + 10);

    const many = Array.from({ length: 600 }, (_, i) => row({ id: i + 1, session_id: `s${i % 40}`, timestamp: at(9) + i * 1000, text: `${i} ${'y'.repeat(400)}` }));
    const big = dailySummaryInput(buildDailyReview('2026-11-20', many, () => null));
    expect(big.length).toBeLessThanOrEqual(DAILY_INPUT_MAX);
    expect(big).toMatch(/left out/);
  });
});

describe('cleanDailySummary', () => {
  it('drops a lead-in line, keeps at most the line limit, each a bounded “• ” bullet', () => {
    const raw = ['Here is the summary:', '', ...Array.from({ length: 12 }, (_, i) => `- agent-manager: item ${i} ${'z'.repeat(i === 2 ? 500 : 5)}`)].join('\n');
    const lines = cleanDailySummary(raw).split('\n');
    expect(lines.length).toBe(DAILY_SUMMARY_LINES);
    expect(lines.every((l) => l.startsWith('• '))).toBe(true);
    expect(lines[0]).toBe('• agent-manager: item 0 zzzzz');
    expect(lines[2].length).toBeLessThanOrEqual(2 + 300 + 1);
    expect(lines[2].endsWith('…')).toBe(true);
  });

  it('is empty for an empty answer', () => {
    expect(cleanDailySummary('  \n \n')).toBe('');
  });
});
