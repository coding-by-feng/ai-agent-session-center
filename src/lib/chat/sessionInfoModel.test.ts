// sessionInfoModel.test.ts — a session's Info facts and checks on the phone (AASC-46).
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Session } from '@/types';
import {
  canRestartSession,
  contextWords,
  drivingWords,
  formatRunTime,
  killMessage,
  modelWords,
  planWords,
  restartBlocker,
  restartMessage,
  sendSessionCommand,
} from './sessionInfoModel';

const s = (over: Partial<Session> = {}) => ({ source: 'ssh', terminalId: 'term-1', isFork: false, status: 'idle', ...over }) as Session;

describe('restart', () => {
  it('is offered for the agent\'s own live terminal only, and says why not otherwise', () => {
    expect(canRestartSession(s())).toBe(true);
    expect(restartBlocker(s())).toBeNull();
    expect(canRestartSession(s({ status: 'ended' }))).toBe(false);
    expect(restartBlocker(s({ status: 'ended' }))).toMatch(/resume/);
    expect(restartBlocker(s({ isFork: true }))).toMatch(/fork/);
    expect(restartBlocker(s({ terminalId: null }))).toMatch(/no terminal/);
    expect(restartBlocker(s({ source: 'hook' }))).toMatch(/started from AASC/);
  });

  it('warns that a busy session\'s turn stops', () => {
    expect(restartMessage('web', 'working')).toMatch(/current turn is stopped/);
    expect(restartMessage('web', 'idle')).toMatch(/agent quits/);
    expect(killMessage('web')).toMatch(/"web" stops/);
  });
});

describe('facts in words', () => {
  it('formats the run time to now, or to the end', () => {
    expect(formatRunTime({ startedAt: 0, endedAt: null }, 30_000)).toBe('under a minute');
    expect(formatRunTime({ startedAt: 0, endedAt: null }, 4 * 60_000)).toBe('4m');
    expect(formatRunTime({ startedAt: 0, endedAt: null }, 72 * 60_000)).toBe('1h 12m');
    expect(formatRunTime({ startedAt: 0, endedAt: 60 * 60_000 }, 10 * 3_600_000)).toBe('1h 0m');
    expect(formatRunTime({ startedAt: 0, endedAt: null }, 50 * 3_600_000)).toBe('2d 2h');
  });

  it('says who drives without the word baton', () => {
    expect(drivingWords('driver', null)).toBe('This phone');
    expect(drivingWords('asked', null)).toBe('This phone');
    expect(drivingWords('spectator', 'MacBook')).toBe('MacBook');
    expect(drivingWords('free', null)).toBe('Nobody right now');
    expect(drivingWords('solo', null)).toBe('Nobody right now');
  });

  it('names the live model and effort first', () => {
    expect(modelWords({ model: 'opus', runtime: { model: 'claude-opus-5-5', effort: 'high' } } as Session)).toBe('Opus 5.5 · high');
    expect(modelWords({ model: 'sonnet', effortLevel: 'low' } as Session)).toBe('Sonnet · low');
    expect(modelWords({ model: '' } as Session)).toBeNull();
  });

  it('shows the context share only when reported (never a made-up 0 %)', () => {
    expect(contextWords({ runtime: { context: { pct: 37.6, size: 200_000 } } } as unknown as Session)).toBe('38% used');
    expect(contextWords({ runtime: {} } as Session)).toBeNull();
  });

  it('names the plan windows as the desktop and the Usage sheet do (Oct 20 2026)', () => {
    const now = 1_000_000;
    const planUsage = { cli: 'claude', asOf: now - 60_000, windows: [{ minutes: 300, usedPercent: 42.2, resetsAt: null }, { minutes: 10_080, usedPercent: 61, resetsAt: null }] };
    const s = (over: object) => ({ cliSource: 'claude', ...over }) as unknown as Session;
    expect(planWords(s({ planUsage }), now)).toBe('5-hour 42% · Weekly 61%');
    expect(planWords(s({ planUsage: null }), now)).toBeNull();
  });

  it('drops a window that has reset and says when the reading is old, by the desktop’s rules', () => {
    const now = 10_000_000;
    const planUsage = {
      cli: 'claude', asOf: now - 60 * 60_000,
      windows: [{ minutes: 300, usedPercent: 90, resetsAt: now - 1000 }, { minutes: 10_080, usedPercent: 61, resetsAt: now + 86_400_000 }],
    };
    expect(planWords({ cliSource: 'claude', planUsage } as unknown as Session, now)).toBe('Weekly 61% · an old reading');
  });
});

describe('sendSessionCommand', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('asks the Mac to type the command, with a fresh request key', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(sendSessionCommand('s 1', '/model sonnet')).resolves.toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/sessions/s%201/prompt');
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ text: '/model sonnet', mode: 'now' });
    expect(body.key).toMatch(/^[A-Za-z0-9._:-]{8,64}$/);
    await sendSessionCommand('s1', '/effort high');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).key).not.toBe(body.key);
  });

  it('passes the Mac\'s refusal on in its words', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'MacBook is driving this session' }), { status: 423 })));
    await expect(sendSessionCommand('s1', '/model opus')).resolves.toEqual({ ok: false, error: 'MacBook is driving this session' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 500 })));
    await expect(sendSessionCommand('s1', '/model opus')).resolves.toEqual({ ok: false, error: 'Your Mac refused it (HTTP 500)' });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    await expect(sendSessionCommand('s1', '/model opus')).resolves.toEqual({ ok: false, error: 'Couldn’t reach your Mac.' });
  });
});
