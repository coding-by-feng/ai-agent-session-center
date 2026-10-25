// promptPeek.test.ts — the prompts a person typed into a session, newest first:
// what the strip card, the panel header and the phone's session title show to
// tell sessions apart.
import { describe, it, expect } from 'vitest';
import type { Session } from '@/types';
import { PEEK_PROMPT_COUNT, PEEK_PROMPT_MAX_CHARS, promptAge, typedPrompts } from './promptPeek';

const at = (min: number) => 1_800_000_000_000 + min * 60_000;
const s = (prompts: Array<[string, number]>, over: Partial<Session> = {}): Session =>
  ({
    sessionId: 'x',
    status: 'idle',
    promptHistory: prompts.map(([text, timestamp]) => ({ text, timestamp })),
    ...over,
  }) as unknown as Session;

describe('typedPrompts', () => {
  it('lists the last five, newest first', () => {
    const list = typedPrompts(s([['one', at(1)], ['two', at(2)], ['three', at(3)], ['four', at(4)], ['five', at(5)], ['six', at(6)]]));
    expect(PEEK_PROMPT_COUNT).toBe(5);
    expect(list.map((p) => p.text)).toEqual(['six', 'five', 'four', 'three', 'two']);
    expect(list[0].at).toBe(at(6));
  });

  it('leaves out what the harness put in: tags, skill bodies, notifications, re-invocations', () => {
    const list = typedPrompts(s([
      ['fix the cart', at(1)],
      ['<task-notification><status>completed</status></task-notification>', at(2)],
      ['<command-name>/rar</command-name>', at(3)],
      ['Use the `retouch-ascii-review` skill on the request below and follow it exactly.\n\nfix it', at(4)],
      ['(Re-invocation of /raab — the skill instructions were previously loaded)', at(5)],
      ['/raab add a kill button', at(6)],
    ]));
    expect(list.map((p) => p.text)).toEqual(['/raab add a kill button', 'fix the cart']);
  });

  it('fills up to five from further back when the newest are injected', () => {
    const typed = Array.from({ length: 6 }, (_, i): [string, number] => [`typed ${i}`, at(i)]);
    const injected = Array.from({ length: 4 }, (_, i): [string, number] => [`<system-reminder>${i}</system-reminder>`, at(10 + i)]);
    expect(typedPrompts(s([...typed, ...injected])).map((p) => p.text)).toEqual(['typed 5', 'typed 4', 'typed 3', 'typed 2', 'typed 1']);
  });

  it('puts each on one line and cuts a long one', () => {
    const long = `${'word '.repeat(80)}end`;
    const [first, second] = typedPrompts(s([[long, at(1)], ['line one\n\n  line two', at(2)]]));
    expect(first.text).toBe('line one line two');
    expect(second.text.length).toBe(PEEK_PROMPT_MAX_CHARS + 1);
    expect(second.text.endsWith('…')).toBe(true);
  });

  it('skips blanks and anything that is not text', () => {
    const list = typedPrompts(s([['  ', at(1)], [null as unknown as string, at(2)], ['real', at(3)]]));
    expect(list.map((p) => p.text)).toEqual(['real']);
  });

  it('falls back to the prompt in flight when the history is empty, as the LIVE board does', () => {
    expect(typedPrompts(s([], { currentPrompt: 'just asked' })).map((p) => p.text)).toEqual(['just asked']);
    expect(typedPrompts(s([], { currentPrompt: '<command-name>/x</command-name>' }))).toEqual([]);
  });

  it('copes with a session that has no history at all', () => {
    expect(typedPrompts({ sessionId: 'x' } as unknown as Session)).toEqual([]);
  });

  it('takes a smaller count when asked', () => {
    expect(typedPrompts(s([['a', at(1)], ['b', at(2)], ['c', at(3)]]), 2).map((p) => p.text)).toEqual(['c', 'b']);
  });
});

describe('promptAge', () => {
  const now = at(0);
  it('reads like the LIVE board: <1m, minutes, hours, days', () => {
    expect(promptAge(now - 20_000, now)).toBe('<1m');
    expect(promptAge(now - 14 * 60_000, now)).toBe('14m');
    expect(promptAge(now - 3 * 3_600_000, now)).toBe('3h');
    expect(promptAge(now - 2 * 86_400_000, now)).toBe('2d');
  });

  it('never reads negative when the clocks disagree, and is blank for a bad time', () => {
    expect(promptAge(now + 30_000, now)).toBe('<1m');
    expect(promptAge(Number.NaN, now)).toBe('');
    expect(promptAge(0, now)).toBe('');
  });
});
