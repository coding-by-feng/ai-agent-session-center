// terminalCompose.test.ts — what the phone's compose box and keys send (AASC-18).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  AGENT_NOT_RUNNING_MESSAGE,
  PHONE_KEY_SEQUENCES,
  composedText,
  submitComposed,
  writeTerminal,
} from './terminalCompose';

type Reply = { status: number; body?: unknown };

function stubFetch(...replies: Reply[]) {
  const queue = [...replies];
  type FakeFetch = (url: string, init?: RequestInit) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;
  const fetchMock = vi.fn<FakeFetch>(async () => {
    const r = queue.shift() ?? { status: 200, body: { ok: true } };
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body ?? {} };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** The `data` of every write, in order. */
const written = (fetchMock: ReturnType<typeof stubFetch>) =>
  fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).data as string);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('PHONE_KEY_SEQUENCES', () => {
  it('writes the bytes a terminal expects for each key', () => {
    expect(PHONE_KEY_SEQUENCES).toEqual({
      esc: '\x1b', tab: '\t', up: '\x1b[A', down: '\x1b[B', '1': '1', '2': '2', '3': '3', enter: '\r',
    });
  });
});

describe('composedText', () => {
  it('drops trailing blank lines and spaces, keeps the rest as typed', () => {
    expect(composedText('  fix it\nplease \n\n')).toBe('  fix it\nplease');
    expect(composedText('   \n ')).toBe('');
  });
});

describe('writeTerminal', () => {
  it('posts the data to the terminal write route', async () => {
    const fetchMock = stubFetch({ status: 200 });
    await expect(writeTerminal('term-1', 'hi')).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith('/api/terminals/term-1/write', expect.objectContaining({ method: 'POST' }));
  });

  it('says the agent is not running on 409 AGENT_NOT_RUNNING', async () => {
    stubFetch({ status: 409, body: { error: AGENT_NOT_RUNNING_MESSAGE, code: 'AGENT_NOT_RUNNING' } });
    await expect(writeTerminal('term-1', 'hi')).resolves.toEqual({
      ok: false, reason: 'agent-not-running', message: AGENT_NOT_RUNNING_MESSAGE,
    });
  });

  it('says another device drives on 409 CONTROL_HELD', async () => {
    stubFetch({ status: 409, body: { error: 'Another device is driving this session', code: 'CONTROL_HELD' } });
    const result = await writeTerminal('term-1', 'hi');
    expect(result).toMatchObject({ ok: false, reason: 'control-held' });
  });

  it('never throws when the Mac cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    const result = await writeTerminal('term-1', 'hi');
    expect(result).toMatchObject({ ok: false, reason: 'failed' });
  });
});

describe('submitComposed', () => {
  beforeEach(() => vi.useFakeTimers());

  it('writes the whole text once, then Enter on its own after the pause', async () => {
    const fetchMock = stubFetch({ status: 200 }, { status: 200 });
    const onTextSent = vi.fn();
    const done = submitComposed('term-1', 'run the tests', onTextSent, 1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(written(fetchMock)).toEqual(['run the tests']);
    expect(onTextSent).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(done).resolves.toEqual({ ok: true });
    expect(written(fetchMock)).toEqual(['run the tests', '\r']);
  });

  it('sends no Enter when the text was refused', async () => {
    const fetchMock = stubFetch({ status: 409, body: { code: 'AGENT_NOT_RUNNING' } });
    const onTextSent = vi.fn();
    const result = await submitComposed('term-1', 'hello', onTextSent, 1000);
    expect(result).toMatchObject({ ok: false, reason: 'agent-not-running' });
    expect(written(fetchMock)).toEqual(['hello']);
    expect(onTextSent).not.toHaveBeenCalled();
  });
});
