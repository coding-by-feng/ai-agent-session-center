// sessions.test.ts — AASC-19: session list parsing, safe labels, HTTP helpers.
import { describe, it, expect } from 'vitest';
import { parseSessions, listSessions, SESSION_REF } from './sessions';
import { cleanLabel, clip, stripInvisible } from './text';
import { errorCode, field, bearer, type HttpRequester, type HttpRequest } from './http';
import { parseSessionDeepLink } from '../../../src/lib/deepLink';

describe('cleanLabel / clip', () => {
  it('drops controls, line separators and bidi overrides, and collapses spaces', () => {
    expect(cleanLabel('  Fix\tlogin\nbug\u2028now ', 40)).toBe('Fix login bug now');
    expect(cleanLabel('abc\u202Eevil\u202C', 40)).toBe('abcevil');
    expect(cleanLabel('\u001B[31mred', 40)).toBe('[31mred');
    expect(cleanLabel(42, 40)).toBe('');
  });

  it('cuts by user-perceived characters, never inside an emoji', () => {
    expect(clip('abcdef', 4)).toBe('abc…');
    expect(clip('abc', 3)).toBe('abc');
    const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';
    expect(clip(`${family}${family}${family}`, 2)).toBe(`${family}…`);
    expect(clip('anything', 0)).toBe('');
  });

  it('strips characters that smuggle invisible text, but keeps emoji joiners', () => {
    expect(stripInvisible('ok\u{E0072}\u{E006D}\u{E0020}\u{E002D}\u{E0072}\u{E0066}!')).toBe('ok!');
    expect(stripInvisible('a\u200Bb\u2062c\u{E0101}d')).toBe('abcd');
    expect(cleanLabel('x\uFFF9y', 10)).toBe('xy');
    const heart = '\u2764\uFE0F';
    expect(stripInvisible(heart)).toBe(heart);
  });

  it('keeps newlines and tabs when only stripping invisible characters', () => {
    expect(stripInvisible('a\n\tb\u200Fc\uFEFF')).toBe('a\n\tbc');
  });
});

describe('http helpers', () => {
  it('reads both error envelopes', () => {
    expect(errorCode({ success: false, error: { code: 'push_unconfigured', message: 'x' } })).toBe('push_unconfigured');
    expect(errorCode({ error: 'Not found', code: 'PHONE_NOT_ALLOWED' })).toBe('PHONE_NOT_ALLOWED');
    expect(errorCode(null)).toBeNull();
    expect(field({ a: { b: 1 } }, ['a', 'b'])).toBe(1);
    expect(field('x', ['a'])).toBeUndefined();
    expect(bearer('t')).toEqual({ Authorization: 'Bearer t' });
  });
});

describe('parseSessions', () => {
  const record = {
    a: { sessionId: 'a', status: 'approval', title: 'Fix login', projectName: 'web', lastActivityAt: 10, startedAt: 1, muted: false },
    b: { sessionId: 'b', status: 'working', title: '', projectName: 'api', lastActivityAt: 20, startedAt: 2, interruption: { kind: 'overload' } },
    c: { sessionId: 'c', status: 'waiting', title: '', projectName: '', muted: true },
  };

  it('reads the GET /api/sessions record and falls back like sessionDisplayTitle', () => {
    const list = parseSessions(record);
    expect(list.map((s) => [s.sessionId, s.title, s.muted, s.hasInterruption])).toEqual([
      ['a', 'Fix login', false, false],
      ['b', 'api', false, true],
      ['c', 'Unnamed', true, false],
    ]);
    expect(list[2].lastActivityAt).toBe(0);
  });

  it('also reads an array, and drops malformed or duplicate entries', () => {
    const list = parseSessions([
      record.a,
      record.a,
      { sessionId: '../etc', status: 'idle' },
      { sessionId: 'x', status: 'dancing' },
      { sessionId: 'y', status: 'idle', lastActivityAt: -5 },
      'junk',
      null,
    ]);
    expect(list.map((s) => s.sessionId)).toEqual(['a', 'y']);
    expect(list[1].lastActivityAt).toBe(0);
    expect(parseSessions('nope')).toEqual([]);
    expect(parseSessions(null)).toEqual([]);
  });

  it('caps a title', () => {
    const [s] = parseSessions([{ sessionId: 'a', status: 'idle', title: 'x'.repeat(500) }]);
    expect([...s.title].length).toBe(80);
  });

  it('accepts exactly the ids the Mac deep link accepts', () => {
    for (const id of ['abc', 'term-1_2', 'a'.repeat(64), 'a'.repeat(65), 'a b', '']) {
      expect(SESSION_REF.test(id)).toBe(parseSessionDeepLink(`?session=${encodeURIComponent(id)}`) !== null);
    }
  });
});

describe('listSessions', () => {
  function requester(answer: { status: number; data: unknown } | Error): HttpRequester & { calls: HttpRequest[] } {
    const calls: HttpRequest[] = [];
    return {
      calls,
      async request(req) {
        calls.push(req);
        if (answer instanceof Error) throw answer;
        return answer;
      },
    };
  }

  it('sends the session token as a bearer header and parses the answer', async () => {
    const http = requester({ status: 200, data: { a: { sessionId: 'a', status: 'idle' } } });
    const res = await listSessions(http, 'http://100.101.102.103:3333', 'sess');
    expect(res.status === 'ok' && res.sessions.map((s) => s.sessionId)).toEqual(['a']);
    expect(http.calls[0]).toEqual({ method: 'GET', url: 'http://100.101.102.103:3333/api/sessions', headers: { Authorization: 'Bearer sess' } });
  });

  it('maps failures to states the shell can show', async () => {
    expect(await listSessions(requester({ status: 401, data: {} }), 'o', 't')).toEqual({ status: 'signed-out' });
    expect(await listSessions(requester(new Error('offline')), 'o', 't')).toEqual({ status: 'offline' });
    expect((await listSessions(requester({ status: 500, data: {} }), 'o', 't')).status).toBe('error');
  });
});
