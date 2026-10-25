// test/mcp/ledgerTurn.test.ts — how the task ledger knows a task's own turn and reads its answer
// (server/mcp/ledgerTurn.ts, Rulings 46 and 48): the envelope AASC types, the head that recognises it in a prompt, the
// prompts that continue a stalled turn, and the reading of a chat page for the task's turn. Pure: no ledger, no clock.
import { describe, expect, it } from 'vitest';
import { DEFAULT_RESUME_PROMPT as WATCHDOG_RESUME_PROMPT } from '../../src/lib/resumeWatchdog.js';
import type { ChatEntry } from '../../src/types/chat.js';
import { TRUNCATION_MARKER } from '../../server/sessionTrim.js';
import {
  ANSWER_MAX,
  buildEnvelope,
  DEFAULT_RESUME_PROMPT,
  envelopeHead,
  envelopeLabel,
  isOwnPrompt,
  isResumePrompt,
  promptKeyFor,
  readTurn,
} from '../../server/mcp/ledgerTurn.js';
import { makeCentral, makeRoom } from './toolHarness.js';

const central = makeCentral();
const other = makeCentral('room', 'r1', { centralId: 'central-2', terminalId: 'term-c2' });
const CLOSING = 'Your final answer goes back to the central that sent this.';
const SENT = 1_700_000_000_000;

const user = (key: string, text: string, at = SENT): ChatEntry => ({ kind: 'user', key, timestamp: at, text });
const said = (key: string, text: string, at = SENT, truncated?: boolean): ChatEntry => ({
  kind: 'assistant',
  key,
  timestamp: at,
  text,
  ...(truncated === undefined ? {} : { truncated }),
});
const thought = (key: string, at = SENT): ChatEntry => ({ kind: 'thinking', key, timestamp: at, length: 40 });
const ran = (key: string, at = SENT): ChatEntry => ({ kind: 'tool_use', key, timestamp: at, id: `call-${key}`, name: 'Bash', input: { command: 'npm test' } });
const cancelMark = (key: string, at = SENT): ChatEntry => ({ kind: 'system', key, timestamp: at, system: 'cancelled' });

const own = buildEnvelope('T1', central, '', 'fix the flaky test', null);
const turnOf = (entries: ChatEntry[], resumes: string[] = []) => readTurn(entries, { taskId: 'T1', since: SENT, resumes });

describe('the envelope', () => {
  it('envelope text is verbatim', () => {
    expect(buildEnvelope('T12', central, '', 'fix the flaky queue test', null)).toBe(
      `[AASC · task T12 from ★ global] fix the flaky queue test\n\n${CLOSING}`,
    );
    expect(buildEnvelope('T3', other, 'Backend', 'review the diff', null)).toBe(
      `[AASC · task T3 from ★ room "Backend"] review the diff\n\n${CLOSING}`,
    );
    const project = makeCentral('project', '/Users/me/code/agent-manager', { centralId: 'central-3' });
    expect(buildEnvelope('T4', project, 'agent-manager', 'run the tests', null)).toBe(
      `[AASC · task T4 from ★ project "agent-manager"] run the tests\n\n${CLOSING}`,
    );
  });

  it('puts an answer format after the closing line', () => {
    expect(buildEnvelope('T1', central, '', 'list them', 'one line per file')).toBe(
      `[AASC · task T1 from ★ global] list them\n\n${CLOSING}\n\nAnswer format: one line per file`,
    );
  });

  it('gives a global central no label, whatever it is handed', () => {
    expect(buildEnvelope('T1', central, 'Backend', 'a', null)).toBe(`[AASC · task T1 from ★ global] a\n\n${CLOSING}`);
  });

  it('keeps a label on one line and inside its quotes', () => {
    expect(buildEnvelope('T1', other, 'Back"end]\nnext [x]', 'a', null)).toBe(
      `[AASC · task T1 from ★ room "Back'end) next (x)"] a\n\n${CLOSING}`,
    );
  });

  it('labels a room central by its room’s name and a project central by its folder', () => {
    const rooms = [makeRoom('r1', [], 'Backend'), makeRoom('r2', [], 'Docs')];
    expect(envelopeLabel(central, rooms)).toBe('');
    expect(envelopeLabel(other, rooms)).toBe('Backend');
    expect(envelopeLabel(makeCentral('room', 'r-gone'), rooms)).toBe('');
    expect(envelopeLabel(makeCentral('project', '/Users/me/code/agent-manager/'), rooms)).toBe('agent-manager');
  });

  it('names its prompt with a route-legal key that holds the task id', () => {
    const key = promptKeyFor('central-1:with/odd chars', 'T7');
    expect(key).toMatch(/^[A-Za-z0-9._:-]{8,64}$/);
    expect(key.endsWith('-task-T7')).toBe(true);
  });
});

describe('whose prompt', () => {
  it('knows the task’s own envelope by its head, from whichever central and with any label', () => {
    expect(envelopeHead('T3')).toBe('[AASC · task T3 from ');
    expect(isOwnPrompt(own, 'T1')).toBe(true);
    expect(isOwnPrompt(`  \n${own}`, 'T1')).toBe(true);
    expect(isOwnPrompt(buildEnvelope('T1', other, 'Backend', 'x', null), 'T1')).toBe(true);
  });

  it('takes no other prompt for it: another task’s, one that only quotes it, a person’s', () => {
    expect(isOwnPrompt(buildEnvelope('T10', central, '', 'x', null), 'T1')).toBe(false);
    expect(isOwnPrompt(buildEnvelope('T2', central, '', 'x', null), 'T1')).toBe(false);
    expect(isOwnPrompt(`look at this: ${own}`, 'T1')).toBe(false);
    expect(isOwnPrompt('[AASC · task T1] fix it', 'T1')).toBe(false);
    expect(isOwnPrompt('', 'T1')).toBe(false);
  });
});

describe('resume prompts', () => {
  it('holds the watchdog’s own default words', () => {
    expect(DEFAULT_RESUME_PROMPT).toBe(WATCHDOG_RESUME_PROMPT);
  });

  it('takes the watchdog’s default, the queue’s own resume prompt, and a short "continue"', () => {
    expect(isResumePrompt(DEFAULT_RESUME_PROMPT, null)).toBe(true);
    expect(isResumePrompt(`  ${DEFAULT_RESUME_PROMPT.replace(/ /g, '\n')} `, null)).toBe(true);
    expect(isResumePrompt('Pick up where the API error stopped you.', 'Pick up where the API error stopped you.')).toBe(true);
    for (const words of ['continue', 'Continue.', 'resume', 'go on', 'Keep going, please']) {
      expect(isResumePrompt(words, null), words).toBe(true);
    }
  });

  it('matches a long queue resume prompt the hook kept only the start of', () => {
    const long = `Resume the job. ${'Keep every finished step as it is. '.repeat(80)}`;
    const kept = long.slice(0, 2_000) + TRUNCATION_MARKER;

    expect(isResumePrompt(kept, long)).toBe(true);
    expect(isResumePrompt(`Something else entirely. ${TRUNCATION_MARKER}`, long)).toBe(false);
  });

  it('takes nothing else: another prompt, a long one that starts with "continue", none', () => {
    expect(isResumePrompt('fix the lint errors too', null)).toBe(false);
    expect(isResumePrompt('continue with the refactor, then rewrite every test in the folder', null)).toBe(false);
    expect(isResumePrompt('', null)).toBe(false);
    expect(isResumePrompt('   ', 'Pick up where you left off.')).toBe(false);
    // With a queue prompt of its own, the watchdog's default is just another prompt.
    expect(isResumePrompt(DEFAULT_RESUME_PROMPT, 'Pick up where you left off.')).toBe(false);
  });
});

describe('readTurn', () => {
  it('answers the turn’s final assistant message, bounded before the next prompt', () => {
    const turn = turnOf([
      user('0', 'an earlier prompt', SENT - 9),
      said('1', 'an earlier answer', SENT - 8),
      user('2', own),
      said('3', 'Looking at the test.'),
      ran('4'),
      said('5', 'Fixed it:'),
      thought('6'),
      said('7', 'the timer leaked.'),
      user('8', 'now the docs'),
      said('9', 'The docs say hello.'),
    ]);

    expect(turn).toEqual({ found: true, movedOn: true, cancelled: false, answer: 'Fixed it:\n\nthe timer leaked.', truncated: false });
  });

  it('reads past the task’s resume prompts: they continue its turn', () => {
    const turn = turnOf([user('1', own), said('2', 'Half way.'), user('3', 'continue'), said('4', 'Done after the retry.')], ['continue']);

    expect(turn).toMatchObject({ movedOn: false, answer: 'Done after the retry.' });
  });

  it('finds a cancel mark inside the turn, and only there', () => {
    expect(turnOf([user('1', own), said('2', 'Half'), cancelMark('3')]).cancelled).toBe(true);
    expect(turnOf([cancelMark('0', SENT - 5), user('1', own), said('2', 'done')]).cancelled).toBe(false);
    expect(turnOf([user('1', own), said('2', 'done'), user('3', 'next'), cancelMark('4')]).cancelled).toBe(false);
  });

  it('takes the send time as the floor when the page does not reach back to the task’s prompt', () => {
    const turn = turnOf([said('1', 'from before', SENT - 1), said('2', 'after the send', SENT + 5)]);

    expect(turn).toMatchObject({ found: false, answer: 'after the send' });
  });

  it('answers null when the turn wrote no text', () => {
    expect(turnOf([user('1', own), ran('2'), said('3', '   ')]).answer).toBeNull();
    expect(turnOf([]).answer).toBeNull();
  });

  it('a 19 000-char answer comes back whole; 25 000 is cut at ANSWER_MAX and marked truncated', () => {
    const whole = turnOf([user('1', own), said('2', 'x'.repeat(19_000))]);
    const cut = turnOf([user('1', own), said('2', 'y'.repeat(25_000))]);
    // The reader cut a block already (its own assistantCap): the turn says so too.
    const readerCut = turnOf([user('1', own), said('2', 'z'.repeat(ANSWER_MAX), SENT, true)]);

    expect(whole).toMatchObject({ answer: 'x'.repeat(19_000), truncated: false });
    expect(cut).toMatchObject({ answer: 'y'.repeat(ANSWER_MAX), truncated: true });
    expect(readerCut).toMatchObject({ answer: 'z'.repeat(ANSWER_MAX), truncated: true });
  });
});
