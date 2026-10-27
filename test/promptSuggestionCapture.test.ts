// test/promptSuggestionCapture.test.ts — Claude Code's grey "next prompt" suggestion read off the
// terminal screen after a turn (Oct 26 2026). The fixture is a real Claude Code 2.1.310 PTY recording.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  armSuggestionWatch,
  disarmSuggestion,
  isTypingInput,
  noteSuggestionChunk,
  parseSuggestionScreen,
  resetSuggestionStates,
  SUGGESTION_CAP,
  type SuggestionCaptureDeps,
} from '../server/promptSuggestionCapture.js';
import { renderScreenCells, type ScreenCell } from '../server/headlessScreen.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/claude-prompt-suggestion.json', import.meta.url), 'utf8')) as {
  cols: number; rows: number; chunks: string[];
};
const RULE = '─'.repeat(40);

/** A screen row from text; `dim` marks which characters are drawn dim. */
const row = (text: string, dim: (i: number) => boolean = () => false): ScreenCell[] =>
  [...text].map((ch, i) => ({ ch, dim: dim(i) }));
const dimAfter = (start: number) => (i: number) => i >= start;

describe('parseSuggestionScreen', () => {
  it('reads the dim suggestion off a real Claude Code screen', async () => {
    const rows = await renderScreenCells({ bytes: Buffer.from(fixture.chunks.join('')), cols: fixture.cols, rows: fixture.rows });
    expect(parseSuggestionScreen(rows)).toBe('ls -la');
  });

  it('is null before the suggestion arrives (same session, one chunk earlier)', async () => {
    const bytes = Buffer.from(fixture.chunks.slice(0, -1).join(''));
    const rows = await renderScreenCells({ bytes, cols: fixture.cols, rows: fixture.rows });
    expect(parseSuggestionScreen(rows)).toBeNull();
  });

  it('never offers text the user typed (not dim) as a suggestion', () => {
    expect(parseSuggestionScreen([row(RULE), row('❯ run the tests'), row(RULE)])).toBeNull();
  });

  it('is null for a draft that only partly matches a suggestion', () => {
    expect(parseSuggestionScreen([row(RULE), row('❯ run the tests', (i) => i > 6), row(RULE)])).toBeNull();
  });

  it('joins a suggestion that wraps onto a second row', () => {
    const rows = [row(RULE), row('❯ update the docs for the', dimAfter(2)), row('  new flag', dimAfter(2)), row(RULE)];
    expect(parseSuggestionScreen(rows)).toBe('update the docs for the new flag');
  });

  it('ignores Claude’s own dim hints in the box', () => {
    const hint = 'Press up to edit queued messages';
    expect(parseSuggestionScreen([row(RULE), row(`❯ ${hint}`, dimAfter(2)), row(RULE)])).toBeNull();
  });

  it('is null with no input box on screen', () => {
    expect(parseSuggestionScreen([row('just output', () => true)])).toBeNull();
  });

  it('caps a very long suggestion', () => {
    const long = 'x'.repeat(SUGGESTION_CAP + 50);
    const got = parseSuggestionScreen([row(RULE), row(`❯ ${long}`, dimAfter(2)), row(RULE)]);
    expect(got?.length).toBe(SUGGESTION_CAP);
  });
});

describe('isTypingInput', () => {
  it('counts keys and pasted text, not mouse reports', () => {
    expect(isTypingInput('a')).toBe(true);
    expect(isTypingInput('\r')).toBe(true);
    expect(isTypingInput('\x1b[A')).toBe(true);
    expect(isTypingInput('\x1b[<0;12;5M\x1b[<0;12;5m')).toBe(false);
    expect(isTypingInput('\x1b[<64;3;9M')).toBe(false);
    expect(isTypingInput('')).toBe(false);
  });
});

describe('the watch after a turn', () => {
  let deps: SuggestionCaptureDeps & { onSuggestion: ReturnType<typeof vi.fn> };
  const bytesSoFar: string[] = [];
  beforeEach(() => {
    vi.useFakeTimers();
    resetSuggestionStates();
    bytesSoFar.length = 0;
    deps = {
      snapshot: () => ({ bytes: Buffer.from(bytesSoFar.join('')), cols: fixture.cols, rows: fixture.rows }),
      onSuggestion: vi.fn(),
    };
  });
  afterEach(() => {
    resetSuggestionStates();
    vi.useRealTimers();
  });

  /** Feed the recording up to (not including) the suggestion chunk, then arm as Stop would. */
  const toStop = () => {
    for (const c of fixture.chunks.slice(0, -1)) bytesSoFar.push(c);
    armSuggestionWatch('t1', deps);
  };
  const flush = async (ms: number) => {
    await vi.advanceTimersByTimeAsync(ms);
    await vi.runOnlyPendingTimersAsync();
  };

  it('reports the suggestion once it is drawn, after the output settles', async () => {
    toStop();
    const last = fixture.chunks[fixture.chunks.length - 1];
    bytesSoFar.push(last);
    noteSuggestionChunk('t1', last, deps);
    await flush(1000);
    expect(deps.onSuggestion).toHaveBeenCalledTimes(1);
    expect(deps.onSuggestion.mock.calls[0][0]).toBe('t1');
    expect(deps.onSuggestion.mock.calls[0][1]).toMatchObject({ text: 'ls -la' });
  });

  it('replays nothing for output without dim text', async () => {
    toStop();
    const snapshot = vi.spyOn(deps, 'snapshot');
    noteSuggestionChunk('t1', 'plain output\r\n', deps);
    await flush(1000);
    expect(snapshot).not.toHaveBeenCalled();
  });

  it('stops watching once the window ends', async () => {
    toStop();
    await flush(11_000);
    const last = fixture.chunks[fixture.chunks.length - 1];
    bytesSoFar.push(last);
    noteSuggestionChunk('t1', last, deps);
    await flush(1000);
    expect(deps.onSuggestion).not.toHaveBeenCalled();
  });

  it('reports nothing after the user starts typing (disarmed)', async () => {
    toStop();
    const last = fixture.chunks[fixture.chunks.length - 1];
    bytesSoFar.push(last);
    noteSuggestionChunk('t1', last, deps);
    disarmSuggestion('t1');
    await flush(1000);
    expect(deps.onSuggestion).not.toHaveBeenCalled();
  });

  it('ignores chunks for a terminal that was never armed', async () => {
    noteSuggestionChunk('t2', '\x1b[2mhello\x1b[22m', deps);
    await flush(1000);
    expect(deps.onSuggestion).not.toHaveBeenCalled();
  });
});
