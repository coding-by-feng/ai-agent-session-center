import { describe, it, expect, vi } from 'vitest';
import { cleanText, safeJson } from '../cli/client/sanitize.js';
import { serverError } from '../cli/client/http.js';
import { sendNow } from '../cli/client/send.js';

/** Anything a terminal acts on: C0 but \n, DEL, C1, bidi/zero-width format characters, U+2028/9. */
const UNSAFE = /[\x00-\x09\x0B-\x1F\x7F-\x9F\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;
const OSC52 = 'x\x1b]52;c;aGVsbG8=\x07';

describe('cleanText', () => {
  it('drops OSC 52, 8-bit CSI, bidi overrides and zero-width characters', () => {
    expect(cleanText(`${OSC52}title`)).toBe('x]52;c;aGVsbG8=title');
    expect(cleanText('a\x9b31mb')).toBe('a31mb');
    expect(cleanText('evil\u202etxt.exe')).toBe('eviltxt.exe');
    expect(cleanText('zero\u200bwidth\ufeff')).toBe('zerowidth');
    expect(cleanText('line\u2028sep')).toBe('linesep');
    expect(cleanText('plain Ünïcode 中文 ✓')).toBe('plain Ünïcode 中文 ✓');
  });
});

describe('safeJson', () => {
  it('stays valid JSON, with C1 and format characters escaped', () => {
    const value = { title: `${OSC52}\x9b31m\u202e` };
    const text = safeJson(value);
    // Pretty-printed JSON has newlines and spaces, nothing else a terminal acts on.
    expect(text).not.toMatch(UNSAFE);
    expect(JSON.parse(text)).toEqual(value);
  });
});

describe('serverError', () => {
  it('strips C0, C1 and format characters from the server’s sentence', () => {
    expect(serverError({ error: `nope${OSC52}\x9b2J\u202e` })).toBe('nopex]52;c;aGVsbG8=2J');
  });
});

describe('send’s y/N prompt', () => {
  it('cleans the status the server reported', async () => {
    const confirm = vi.fn(async () => false);
    await sendNow(
      { request: async () => ({ status: 200, data: null }), sleep: async () => {}, confirm, out: () => {} },
      { ref: 'vps:2', session: { sessionId: 's', status: `working${OSC52}`, terminalId: 't' } },
      'hi', { force: false },
    );
    expect(confirm).toHaveBeenCalledTimes(1);
    const question = (confirm.mock.calls[0] as unknown as [string])[0];
    expect(question).not.toMatch(UNSAFE);
    expect(question).toContain('vps:2 is workingx]52');
  });
});
