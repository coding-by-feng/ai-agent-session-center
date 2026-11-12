import { describe, it, expect } from 'vitest';
import { parseSessions, orderSessions, resolveRef, matchSession, type RemoteSession } from '../cli/client/sessions.js';
import { statusLabel, relativeAge, renderSessionTable, cleanCell, plural } from '../cli/client/render.js';
import { createWatchState, applyWatchMessage, formatWatchLine, notifySequence } from '../cli/client/watch.js';

const NOW = Date.parse('2026-10-29T16:00:00Z');

function session(id: string, over: Partial<RemoteSession> = {}): RemoteSession {
  return { sessionId: id, status: 'idle', title: '', projectName: '', terminalId: `term-${id}`, cliSource: 'claude', lastActivityAt: NOW, ...over };
}

describe('parseSessions', () => {
  it('reads the record GET /api/sessions answers and skips malformed entries', () => {
    const list = parseSessions({
      a: { sessionId: 'a', status: 'working', title: 'fix QR', projectName: 'aasc', terminalId: 't1', lastActivityAt: NOW, extra: 1 },
      b: { sessionId: 'b' }, // no status: skipped
      c: 'nonsense',
    });
    expect(list.map((s) => s.sessionId)).toEqual(['a']);
    expect(list[0].terminalId).toBe('t1');
  });

  it('refuses an answer that is not a session record', () => {
    expect(() => parseSessions([1, 2])).toThrow();
    expect(() => parseSessions(null)).toThrow();
  });
});

describe('orderSessions', () => {
  it('drops ended sessions and puts the most recently active first', () => {
    const ordered = orderSessions([
      session('old', { lastActivityAt: NOW - 60_000 }),
      session('gone', { status: 'ended' }),
      session('new', { lastActivityAt: NOW }),
    ]);
    expect(ordered.map((s) => s.sessionId)).toEqual(['new', 'old']);
  });
});

describe('resolveRef', () => {
  const lastLs = [
    { n: 1, server: 'vps', sessionId: 'v1' }, { n: 2, server: 'vps', sessionId: 'v2' },
    { n: 1, server: 'mac', sessionId: 'm1' },
  ];
  const ctx = { serverNames: ['vps', 'mac'], lastLs };

  it('reads server:number from the last ls', () => {
    expect(resolveRef('vps:2', ctx)).toEqual({ ok: true, server: 'vps', sessionId: 'v2' });
  });

  it('a bare number works when only one server has it', () => {
    expect(resolveRef('2', ctx)).toEqual({ ok: true, server: 'vps', sessionId: 'v2' });
  });

  it('a bare number two servers share is a usage error naming both', () => {
    const r = resolveRef('1', ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/vps:1.*mac:1|mac:1.*vps:1/);
  });

  it('an unknown number points at aasc ls', () => {
    const r = resolveRef('9', ctx);
    expect(r).toEqual({ ok: false, error: 'Unknown session "9". Run aasc ls.' });
  });

  it('anything else is a query: an id prefix or title words, optionally on one server', () => {
    expect(resolveRef('vps:migrate db', ctx)).toEqual({ ok: true, server: 'vps', query: 'migrate db' });
    expect(resolveRef('3f2a', ctx)).toEqual({ ok: true, server: null, query: '3f2a' });
    // A colon that names no server is part of the query.
    expect(resolveRef('fix: the build', ctx)).toEqual({ ok: true, server: null, query: 'fix: the build' });
  });
});

describe('matchSession', () => {
  const list = [
    session('3f2a9c00', { title: 'fix pairing QR' }),
    session('3f2a9c11', { title: 'migrate db' }),
    session('77aa0000', { title: '', projectName: 'website' }),
    session('db51e2a0', { title: 'notes cleanup' }),
  ];

  it('matches a unique id prefix of at least 6 characters', () => {
    expect(matchSession('3f2a9c0', list)).toMatchObject({ ok: true, session: { sessionId: '3f2a9c00' } });
    expect(matchSession('db51e2', list)).toMatchObject({ ok: true, session: { sessionId: 'db51e2a0' } });
  });

  it('a short hex word is never an id prefix: "db" means the title, not db51e2a0', () => {
    expect(matchSession('db', list)).toMatchObject({ ok: true, session: { sessionId: '3f2a9c11' } });
    expect(matchSession('3f2a', list)).toMatchObject({ ok: false, reason: 'none' });
  });

  it('an id match and a different title match are ambiguous', () => {
    const tricky = [...list, session('cafe01ff', { title: 'cafe01 menu' }), session('beef00aa', { title: 'notes cafe01' })];
    const r = matchSession('cafe01', tricky);
    expect(r).toMatchObject({ ok: false, reason: 'ambiguous' });
  });

  it('the same session by id and by title is still one match', () => {
    const one = [session('menu01ab', { title: 'menu01ab cleanup' })];
    expect(matchSession('menu01', one)).toMatchObject({ ok: true, session: { sessionId: 'menu01ab' } });
  });

  it('matches every word of the display title, any case', () => {
    expect(matchSession('Migrate DB', list)).toMatchObject({ ok: true, session: { sessionId: '3f2a9c11' } });
    // The display title falls back to the project.
    expect(matchSession('website', list)).toMatchObject({ ok: true, session: { sessionId: '77aa0000' } });
  });

  it('an ambiguous query lists the candidates', () => {
    const r = matchSession('3f2a9c', list);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('ambiguous');
      expect(r.error).toContain('fix pairing QR');
      expect(r.error).toContain('migrate db');
    }
  });

  it('the candidate list strips escape sequences from titles and ids', () => {
    const evil = [
      session('\x1b]52;c;aGk=\x07aaaaaa1', { title: 'x\x1b]52;c;aGk=\x07 one' }),
      session('\x1b]52;c;aGk=\x07aaaaaa2', { title: 'x\x9b31m one\u202e' }),
    ];
    const r = matchSession('one', evil);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).not.toMatch(/[\x00-\x08\x0B-\x1F\x7F-\x9F\u202e]/);
  });

  it('no match is not-found', () => {
    expect(matchSession('nothing here', list)).toMatchObject({ ok: false, reason: 'none' });
  });
});

describe('parseSessions keeps every field', () => {
  it('passes unknown fields through for ls --json', () => {
    const [s] = parseSessions({ a: { sessionId: 'a', status: 'idle', model: 'opus', planUsage: { five: 3 } } });
    expect(s).toMatchObject({ model: 'opus', planUsage: { five: 3 } });
  });
});

describe('render', () => {
  it('every status is a glyph plus a word', () => {
    for (const s of ['working', 'approval', 'input', 'waiting', 'idle', 'prompting', 'connecting', 'ended', 'mystery']) {
      expect(statusLabel(s)).toMatch(/^\S \S+/);
      expect(statusLabel(s)).toContain(s);
    }
    expect(statusLabel('approval')).toBe('! approval');
    expect(statusLabel('waiting')).toBe('✓ waiting');
  });

  it('relative ages read like the plan’s table', () => {
    expect(relativeAge(12_000)).toBe('12 s');
    expect(relativeAge(4 * 60_000)).toBe('4 min');
    expect(relativeAge(3_600_000)).toBe('1 h');
    expect(relativeAge(2 * 86_400_000)).toBe('2 d');
    expect(relativeAge(-5)).toBe('0 s');
  });

  it('strips control characters a hostile title could use to rewrite the screen', () => {
    expect(cleanCell('evil\x1b]0;pwned\x07title\r\n')).toBe('evil]0;pwnedtitle');
  });

  it('renders the table with numbers, the display title and a needs-you marker', () => {
    const out = renderSessionTable([
      session('a', { status: 'working', title: 'fix pairing QR', lastActivityAt: NOW - 4 * 60_000 }),
      session('b', { status: 'approval', title: 'migrate db', lastActivityAt: NOW - 12_000 }),
      session('c', { status: 'idle', title: '', projectName: 'notes', cliSource: 'codex', lastActivityAt: NOW - 2 * 86_400_000 }),
    ], NOW);
    const lines = out.split('\n');
    expect(lines[0]).toMatch(/#\s+STATUS\s+CLI\s+TITLE\s+ACTIVE/);
    expect(lines[1]).toMatch(/^\s*1\s+● working\s+claude\s+fix pairing QR\s+4 min/);
    expect(lines[2]).toMatch(/2\s+! approval.*12 s\s+← needs you/);
    expect(lines[3]).toMatch(/3\s+○ idle\s+codex\s+notes\s+2 d/);
  });
});

describe('watch', () => {
  it('a snapshot prints nothing; a status change prints one line; approval rings', () => {
    const state = createWatchState();
    expect(applyWatchMessage(state, 'vps', { type: 'snapshot', sessions: { b: session('b', { status: 'working', title: 'migrate db' }) } }, NOW)).toEqual([]);
    const events = applyWatchMessage(state, 'vps', { type: 'session_update', session: session('b', { status: 'approval', title: 'migrate db' }) }, NOW);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ server: 'vps', title: 'migrate db', from: 'working', to: 'approval', attention: true });
    expect(formatWatchLine(events[0])).toMatch(/vps\s+migrate db\s+working → approval\s+← needs you/);
    // The same status again is no event.
    expect(applyWatchMessage(state, 'vps', { type: 'session_update', session: session('b', { status: 'approval', title: 'migrate db' }) }, NOW)).toEqual([]);
    const back = applyWatchMessage(state, 'vps', { type: 'session_update', session: session('b', { status: 'working', title: 'migrate db' }) }, NOW);
    expect(back[0].attention).toBe(false);
  });

  it('a new session counts as a change from nothing, and a removed one is forgotten', () => {
    const state = createWatchState();
    applyWatchMessage(state, 'vps', { type: 'snapshot', sessions: {} }, NOW);
    expect(applyWatchMessage(state, 'vps', { type: 'session_update', session: session('n', { status: 'input', title: 'q' }) }, NOW))
      .toMatchObject([{ from: null, to: 'input', attention: true }]);
    applyWatchMessage(state, 'vps', { type: 'session_removed', sessionId: 'n' }, NOW);
    expect(applyWatchMessage(state, 'vps', { type: 'session_update', session: session('n', { status: 'input', title: 'q' }) }, NOW))
      .toHaveLength(1);
  });

  it('notifications use OSC 9, or OSC 777 on VTE terminals, with control characters stripped', () => {
    expect(notifySequence('vps:2 needs you', {})).toBe('\x1b]9;vps:2 needs you\x07');
    expect(notifySequence('vps:2 needs\x07 you', { VTE_VERSION: '7600' })).toBe('\x1b]777;notify;aasc;vps:2 needs you\x07');
  });
});

describe('plural', () => {
  it('never prints "1 sessions"', () => {
    expect(plural(1, 'session')).toBe('1 session');
    expect(plural(0, 'session')).toBe('0 sessions');
    expect(plural(4, 'session')).toBe('4 sessions');
  });
});
