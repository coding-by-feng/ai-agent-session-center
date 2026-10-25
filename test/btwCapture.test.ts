import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseBtwScreen,
  renderScreen,
  noteBtwChunk,
  resetBtwStates,
  withBtwAnswer,
  BTW_KEEP,
  type BtwCaptureDeps,
} from '../server/btwCapture.js';

const FOOTER = '↑/↓ to scroll · c to copy · f to fork · Esc to dismiss';

describe('parseBtwScreen', () => {
  it('reads the question and the answer between it and the footer', () => {
    const screen = [
      'gates and a short re-review, then the P4 live check',
      '* Cogitating… (running Stop hooks… 1/4 · 2m 38s)',
      '',
      '/btw how many tasks are the remaining?',
      '',
      '⏺ Eight steps are left before the final report.',
      '',
      '  Finishing P4 (5 steps)',
      '  1. Round-2 fix wave',
      '',
      '  Nothing is committed or merged until you ask.',
      '',
      FOOTER,
    ];
    expect(parseBtwScreen(screen)).toEqual({
      question: 'how many tasks are the remaining?',
      answer: 'Eight steps are left before the final report.\n\nFinishing P4 (5 steps)\n1. Round-2 fix wave\n\nNothing is committed or merged until you ask.',
    });
  });

  it('takes the newest /btw when an older one is still on screen', () => {
    const screen = ['/btw first?', 'old answer', '/btw second?', 'new answer', FOOTER];
    expect(parseBtwScreen(screen)).toEqual({ question: 'second?', answer: 'new answer' });
  });

  it('is null without the footer, without a question, or with an empty answer', () => {
    expect(parseBtwScreen(['/btw q?', 'answer'])).toBeNull();
    expect(parseBtwScreen(['answer only', FOOTER])).toBeNull();
    expect(parseBtwScreen(['/btw q?', '   ', FOOTER])).toBeNull();
  });

  it('ignores a line that merely mentions /btw mid-text', () => {
    expect(parseBtwScreen(['you can run /btw later', 'x', FOOTER])).toBeNull();
  });
});

describe('renderScreen', () => {
  it('resolves cursor-move redraws into the screen a terminal shows', async () => {
    // The CLI draws, then rewrites part of the answer in place — raw bytes would interleave both.
    const bytes = Buffer.from(
      '/btw how many?\r\n' +
      'Eight steps are lXXXXXXXXXXXXXXX\r\n' +
      `${FOOTER}` +
      '\x1b[1A\x1b[18G' + 'eft before report.' + '\x1b[K',
    );
    const rows = await renderScreen({ bytes, cols: 80, rows: 6 });
    expect(parseBtwScreen(rows)).toEqual({ question: 'how many?', answer: 'Eight steps are left before report.' });
  });

  it('reads the alternate screen a full-screen TUI draws on', async () => {
    const bytes = Buffer.from('main screen text\r\n\x1b[?1049h\x1b[H' + `/btw alt?\r\nalt answer\r\n${FOOTER}`);
    const rows = await renderScreen({ bytes, cols: 80, rows: 5 });
    expect(parseBtwScreen(rows)).toEqual({ question: 'alt?', answer: 'alt answer' });
  });
});

describe('noteBtwChunk', () => {
  let screen: string;
  let deps: BtwCaptureDeps;
  let onAnswer: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    resetBtwStates();
    screen = '';
    onAnswer = vi.fn();
    deps = {
      snapshot: () => ({ bytes: Buffer.from(screen), cols: 80, rows: 6 }),
      onAnswer,
    };
  });
  afterEach(() => {
    resetBtwStates();
    vi.useRealTimers();
  });

  /** Let the settle timer fire and the async headless write finish. */
  async function settle(ms = 3000): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms);
    vi.useRealTimers();
    await new Promise((r) => setTimeout(r, 50));
    vi.useFakeTimers();
  }

  it('does nothing until a chunk draws the footer', async () => {
    screen = '/btw q?\r\nanswer\r\n';
    noteBtwChunk('t1', 'plain output', deps);
    await settle();
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it('captures once the output settles, and not again for the same answer', async () => {
    screen = `/btw q?\r\nthe answer\r\n${FOOTER}`;
    noteBtwChunk('t1', `the answer\r\n${FOOTER}`, deps);
    await settle();
    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(onAnswer.mock.calls[0][0]).toBe('t1');
    expect(onAnswer.mock.calls[0][1]).toMatchObject({ question: 'q?', answer: 'the answer' });

    noteBtwChunk('t1', FOOTER, deps); // a redraw of the same panel
    await settle();
    expect(onAnswer).toHaveBeenCalledTimes(1);
  });

  it('reports a grown answer again', async () => {
    screen = `/btw q?\r\npart one\r\n${FOOTER}`;
    noteBtwChunk('t1', FOOTER, deps);
    await settle();
    screen = `/btw q?\r\npart one\r\npart two\r\n${FOOTER}`;
    noteBtwChunk('t1', FOOTER, deps);
    await settle();
    expect(onAnswer).toHaveBeenCalledTimes(2);
    expect(onAnswer.mock.calls[1][1].answer).toBe('part one\npart two');
  });

  it('matches a footer split across two chunks', async () => {
    screen = `/btw q?\r\nans\r\n${FOOTER}`;
    noteBtwChunk('t1', '↑/↓ to scroll · c to co', deps);
    noteBtwChunk('t1', 'py · f to fork · Esc', deps);
    await settle();
    expect(onAnswer).toHaveBeenCalledTimes(1);
  });

  it('survives a terminal that is gone by capture time', async () => {
    deps = { ...deps, snapshot: () => null };
    noteBtwChunk('t1', FOOTER, deps);
    await settle();
    expect(onAnswer).not.toHaveBeenCalled();
  });
});

describe('withBtwAnswer', () => {
  it('appends a new question without touching the old list', () => {
    const prev = [{ question: 'a', answer: 'x', at: 1 }];
    const next = withBtwAnswer(prev, { question: 'b', answer: 'y', at: 2 });
    expect(next).toEqual([...prev, { question: 'b', answer: 'y', at: 2 }]);
    expect(prev).toHaveLength(1);
  });

  it('replaces a growing answer to the newest question and keeps its time', () => {
    const next = withBtwAnswer([{ question: 'a', answer: 'part', at: 1 }], { question: 'a', answer: 'part and more', at: 9 });
    expect(next).toEqual([{ question: 'a', answer: 'part and more', at: 1 }]);
  });

  it('keeps a repeated question with a different answer as its own entry', () => {
    const next = withBtwAnswer([{ question: 'a', answer: 'yes', at: 1 }], { question: 'a', answer: 'no', at: 2 });
    expect(next).toHaveLength(2);
  });

  it('keeps only the newest BTW_KEEP', () => {
    let list = withBtwAnswer(undefined, { question: 'q0', answer: 'a', at: 0 });
    for (let i = 1; i < BTW_KEEP + 3; i++) list = withBtwAnswer(list, { question: `q${i}`, answer: 'a', at: i });
    expect(list).toHaveLength(BTW_KEEP);
    expect(list[0].question).toBe('q3');
  });
});
