// takeTerminalInput.test.ts — moving Claude's input-box text (dictated or typed) into the queue box.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { insertAtCaret, takeTerminalInput } from './takeTerminalInput';

describe('insertAtCaret', () => {
  it('fills an empty box', () => {
    expect(insertAtCaret('', '  hello world ')).toEqual({ value: 'hello world', caret: 11 });
  });

  it('appends with one space when the caret is unknown', () => {
    expect(insertAtCaret('fix this', 'and that')).toEqual({ value: 'fix this and that', caret: 17 });
    expect(insertAtCaret('fix this ', 'and that')).toEqual({ value: 'fix this and that', caret: 17 });
  });

  it('inserts at the caret, spaced from the text on both sides', () => {
    expect(insertAtCaret('fix bug', 'the queue', 3)).toEqual({ value: 'fix the queue bug', caret: 13 });
    expect(insertAtCaret('fix', 'please', 0)).toEqual({ value: 'please fix', caret: 6 });
  });

  it('leaves the box alone for blank text', () => {
    expect(insertAtCaret('keep', '   ', 2)).toEqual({ value: 'keep', caret: 2 });
  });
});

describe('takeTerminalInput', () => {
  afterEach(() => vi.unstubAllGlobals());
  const respond = (status: number, body: unknown) =>
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })));

  it('posts to the terminal and returns its text', async () => {
    respond(200, { success: true, data: { text: 'dictated words', cleared: true } });
    expect(await takeTerminalInput('term 1')).toEqual({ kind: 'text', text: 'dictated words', cleared: true });
    expect(fetch).toHaveBeenCalledWith('/api/terminals/term%201/take-input', expect.objectContaining({ method: 'POST' }));
  });

  it('reports an empty box', async () => {
    respond(200, { success: true, data: { text: '', cleared: true } });
    expect(await takeTerminalInput('t1')).toEqual({ kind: 'empty' });
  });

  it('shows the server\'s reason, or a fallback when it gives none', async () => {
    respond(409, { success: false, code: 'HAS_ATTACHMENT', error: "Claude's input box holds a paste or an image." });
    expect(await takeTerminalInput('t1')).toEqual({ kind: 'error', message: expect.stringContaining('paste') });
    respond(500, {});
    expect(await takeTerminalInput('t1')).toEqual({ kind: 'error', message: "Couldn't read Claude's input box." });
  });

  it('passes the server error on, and never throws on a network failure', async () => {
    respond(409, { error: 'This device was not recognised. Reload it and try again.', code: 'CONTROL_HELD' });
    expect(await takeTerminalInput('t1')).toEqual({ kind: 'error', message: expect.stringContaining('not recognised') });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
    expect((await takeTerminalInput('t1')).kind).toBe('error');
  });
});
