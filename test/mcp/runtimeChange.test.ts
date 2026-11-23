// test/mcp/runtimeChange.test.ts — the model/effort change box (server/mcp/runtimeChange.ts): a change is typed only
// when its session is free, one at a time per session, and is final only once the card's runtime record shows it.
import { describe, expect, it, vi } from 'vitest';
import type { Session } from '../../src/types/session.js';
import type { PromptRequest, PromptResult } from '../../server/promptSubmit.js';
import {
  CLAUDE_CONFIRM_MS,
  CODEX_CONFIRM_MS,
  createRuntimeChangeBox,
  questionMatches,
  runtimeShows,
  switchQuestion,
  WAIT_TTL_MS,
  type ChangeCheck,
  type ChangeRequest,
  type SettingChange,
} from '../../server/mcp/runtimeChange.js';
import { makeSession, NOW } from './toolHarness.js';

vi.mock('../../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

const TERM = 'term-rc1';

interface World {
  card: Session;
  clock: { now: number };
  typed: string[];
  outcome: PromptResult;
  controller: { clientId: string; lastActivityAt: number; lastInputAt?: number } | null;
  queue: boolean;
  rows: Array<{ summary: string; outcome: string }>;
  /** What the terminal shows; null = no screen reader. */
  screen: string[] | null;
  pressed: string[];
}

function setup(over: Partial<Session> = {}) {
  const w: World = {
    card: makeSession('s-rc', { cliSource: 'claude', terminalId: TERM, status: 'waiting', lastActivityAt: NOW - 10_000, ...over }),
    clock: { now: NOW },
    typed: [],
    outcome: { outcome: 'unconfirmed', typed: true },
    controller: null,
    queue: false,
    rows: [],
    screen: null,
    pressed: [],
  };
  const box = createRuntimeChangeBox({
    sessions: () => [w.card],
    controller: () => w.controller,
    hasRoom: () => true,
    submit: async (req: PromptRequest) => {
      w.typed.push(req.text);
      return w.outcome;
    },
    queueWillSend: async () => w.queue,
    activity: { logActivity: (r) => { w.rows.push({ summary: r.summary, outcome: r.outcome }); return r as never; } },
    now: () => w.clock.now,
    screen: async () => w.screen,
    press: (_terminalId, keys) => {
      w.pressed.push(keys);
    },
    manual: true,
  });
  const ask = (over2: Partial<ChangeRequest> = {}, check: () => ChangeCheck = () => ({ go: true })): SettingChange =>
    box.schedule({
      centralId: 'central-1',
      sessionId: w.card.sessionId,
      terminalId: TERM,
      cli: 'claude',
      kind: 'effort',
      value: 'low',
      self: false,
      check,
      ...over2,
    });
  /** The CLI records a setting (sessionRuntime.ts), at the clock's time. */
  const record = (rt: Session['runtime']): void => {
    w.card = { ...w.card, runtime: { ...w.card.runtime, ...rt } };
  };
  return { w, box, ask, record };
}

describe('typing only when the session is free', () => {
  it('waits through a turn, types once idle, and confirms from the runtime record', async () => {
    const { w, box, ask, record } = setup({ status: 'working' });
    const seen: SettingChange[] = [];
    box.onChange((c) => seen.push(c));
    const c = ask();

    await box.tick();
    expect(w.typed).toEqual([]);

    w.card = { ...w.card, status: 'waiting', lastActivityAt: NOW - 5_000 };
    await box.tick();
    expect(w.typed).toEqual(['/effort low']);
    expect(box.get(c.changeId)?.state).toBe('typed');

    await box.tick();
    expect(box.get(c.changeId)?.state).toBe('typed');

    record({ effort: 'low', effortAt: NOW, effortSet: true });
    await box.tick();
    expect(box.get(c.changeId)?.state).toBe('confirmed');
    expect(seen.map((x) => x.state)).toEqual(['confirmed']);
    expect(w.rows).toEqual([{ summary: 'The CLI confirmed the effort change in the session.', outcome: 'ok' }]);
    expect(w.rows[0].summary).not.toContain('low');
    expect(w.typed).toHaveLength(1);
  });

  it('holds for a card that only just went idle, an open dialog, a draft, a person, and a queue about to send', async () => {
    const { w, box, ask } = setup({ lastActivityAt: NOW - 1_000 });
    ask();
    await box.tick();
    expect(w.typed).toEqual([]);

    w.card = { ...w.card, lastActivityAt: NOW - 10_000, status: 'approval' };
    await box.tick();
    expect(w.typed).toEqual([]);

    w.card = { ...w.card, status: 'waiting' };
    w.controller = { clientId: 'browser-1', lastActivityAt: NOW - 120_000, lastInputAt: NOW - 5_000 };
    await box.tick();
    expect(w.typed).toEqual([]);

    w.controller = { clientId: 'browser-1', lastActivityAt: NOW - 10_000 };
    await box.tick();
    expect(w.typed).toEqual([]);

    w.controller = { clientId: 'mcp:central-1', lastActivityAt: NOW - 1_000 };
    w.queue = true;
    await box.tick();
    expect(w.typed).toEqual([]);

    w.queue = false;
    await box.tick();
    expect(w.typed).toEqual(['/effort low']);
  });

  it('a check that says wait holds it; one that refuses ends it not applied, with nothing typed', async () => {
    const { w, box, ask } = setup();
    let check: ChangeCheck = { go: false, wait: true };
    const c = ask({}, () => check);
    await box.tick();
    expect(box.get(c.changeId)?.state).toBe('waiting');

    check = { go: false, wait: false, reason: 'That session is hands-off' };
    await box.tick();
    expect(box.get(c.changeId)).toMatchObject({ state: 'not-applied', reason: 'That session is hands-off' });
    expect(w.typed).toEqual([]);
  });

  it('expires when the session never comes free', async () => {
    const { w, box, ask } = setup({ status: 'working' });
    const c = ask();
    w.clock.now = NOW + WAIT_TTL_MS + 1;
    await box.tick();
    expect(box.get(c.changeId)?.state).toBe('expired');
    expect(w.rows[0]).toMatchObject({ outcome: 'failed' });
  });
});

describe('order and replacement', () => {
  it('types the effort only after the model is confirmed', async () => {
    const { w, box, ask, record } = setup();
    const model = ask({ kind: 'model', value: 'opus' });
    w.clock.now += 1;
    const effort = ask({ kind: 'effort', value: 'low' });

    await box.tick();
    expect(w.typed).toEqual(['/model opus']);
    await box.tick();
    expect(w.typed).toEqual(['/model opus']);

    record({ launchModel: 'opus', launchModelAt: w.clock.now, model: 'Opus 5.5', modelAt: w.clock.now });
    await box.tick();
    expect(box.get(model.changeId)?.state).toBe('confirmed');
    await box.tick();
    expect(w.typed).toEqual(['/model opus', '/effort low']);
    expect(box.get(effort.changeId)?.state).toBe('typed');
  });

  it('a newer change of the same kind replaces one not yet typed', async () => {
    const { w, box, ask } = setup({ status: 'working' });
    const first = ask({ value: 'low' });
    const second = ask({ value: 'high' });
    expect(box.get(first.changeId)?.state).toBe('replaced');
    w.card = { ...w.card, status: 'waiting' };
    await box.tick();
    expect(w.typed).toEqual(['/effort high']);
    expect(box.get(second.changeId)?.state).toBe('typed');
    expect(w.rows).toEqual([]);
  });
});

describe('not applied', () => {
  it('when the CLI has no such command, or the typing stopped part-way', async () => {
    const a = setup();
    a.w.outcome = { outcome: 'unknown-command', typed: true };
    const c = a.ask();
    await a.box.tick();
    expect(a.box.get(c.changeId)).toMatchObject({ state: 'not-applied', reason: 'the CLI has no /effort command' });

    const b = setup();
    b.w.outcome = { outcome: 'stopped', typed: true };
    const d = b.ask();
    await b.box.tick();
    expect(b.box.get(d.changeId)?.state).toBe('not-applied');
    expect(b.w.typed).toHaveLength(1);
  });

  it('a send that typed nothing is tried again, three times in all', async () => {
    const { w, box, ask } = setup();
    w.outcome = { outcome: 'gave-up', typed: false };
    const c = ask();
    await box.tick();
    await box.tick();
    expect(box.get(c.changeId)?.state).toBe('waiting');
    await box.tick();
    expect(box.get(c.changeId)?.state).toBe('not-applied');
    expect(w.typed).toHaveLength(3);
  });

  it('when no record comes: a minute for Claude, half an hour for Codex', async () => {
    const claude = setup();
    const c = claude.ask();
    await claude.box.tick();
    claude.w.clock.now = NOW + CLAUDE_CONFIRM_MS + 1;
    await claude.box.tick();
    expect(claude.box.get(c.changeId)).toMatchObject({ state: 'not-applied', reason: expect.stringContaining('did not record') });

    const codex = setup({ cliSource: 'codex' });
    const d = codex.ask({ cli: 'codex' });
    await codex.box.tick();
    codex.w.clock.now = NOW + CLAUDE_CONFIRM_MS + 1;
    await codex.box.tick();
    expect(codex.box.get(d.changeId)?.state).toBe('typed');
    codex.w.clock.now = NOW + CODEX_CONFIRM_MS + 1;
    await codex.box.tick();
    expect(codex.box.get(d.changeId)).toMatchObject({ state: 'not-applied', reason: expect.stringContaining('Codex') });
  });

  it('a record from before the typing does not count', async () => {
    const { box, ask, record } = setup();
    record({ effort: 'low', effortAt: NOW - 60_000, effortSet: true });
    const c = ask();
    await box.tick();
    await box.tick();
    expect(box.get(c.changeId)?.state).toBe('typed');
  });
});

describe('waitFor', () => {
  it('resolves on the final state, or as it is when the time runs out', async () => {
    const { box, ask, record } = setup();
    const c = ask();
    const quick = await box.waitFor(c.changeId, 5);
    expect(quick?.state).toBe('waiting');

    const waiting = box.waitFor(c.changeId, 5_000);
    await box.tick();
    record({ effort: 'low', effortAt: NOW, effortSet: true });
    await box.tick();
    expect((await waiting)?.state).toBe('confirmed');
  });
});

describe('runtimeShows', () => {
  const at = { modelAt: 10, launchModelAt: 10, effortAt: 10 };
  it('matches a model by its chosen name, its label, or its family for an alias', () => {
    expect(runtimeShows({ runtime: { ...at, launchModel: 'opus' } }, 'model', 'opus', 5)).toBe(true);
    expect(runtimeShows({ runtime: { ...at, model: 'Opus 5.5' } }, 'model', 'claude-opus-5-5', 5)).toBe(true);
    expect(runtimeShows({ runtime: { ...at, model: 'Opus 5.5' } }, 'model', 'opus', 5)).toBe(true);
    expect(runtimeShows({ runtime: { ...at, model: 'Sonnet 5.5' } }, 'model', 'opus', 5)).toBe(false);
    expect(runtimeShows({ runtime: { ...at, model: 'Opus 5.5' } }, 'model', 'opus', 20)).toBe(false);
    expect(runtimeShows({ runtime: { ...at, effort: 'low' } }, 'effort', 'low', 5)).toBe(true);
    expect(runtimeShows({ runtime: { ...at, effort: 'high' } }, 'effort', 'low', 5)).toBe(false);
    expect(runtimeShows({}, 'effort', 'low', 5)).toBe(false);
  });
});

/** Claude Code 2.1.330's question, as its screen shows it (strings from its own code: `Zge`). */
const question = (label: string, focusYes = true, title = 'Switch model?'): string[] => [
  '  earlier output',
  ` ${title}`,
  ' Your next response will be slower and use more tokens',
  ` This conversation is cached for the current model. Switching to ${label} means the full history gets re-read.`,
  `${focusYes ? ' ❯' : '  '} 1. Yes, switch to ${label}`,
  `${focusYes ? '  ' : ' ❯'} 2. No, go back`,
];

describe('the CLI kept what it had, or asked first (Nov 23 2026)', () => {
  it('"Kept model as" after the typing ends the change at once, not after the minute', async () => {
    const { w, box, ask, record } = setup();
    const c = ask({ kind: 'model', value: 'opus' });
    await box.tick();
    expect(box.get(c.changeId)?.state).toBe('typed');
    record({ modelKeptAt: NOW });
    await box.tick();
    expect(box.get(c.changeId)).toMatchObject({ state: 'not-applied', reason: expect.stringContaining('kept its current model') });
    expect(w.rows[0]).toMatchObject({ outcome: 'failed' });
  });

  it('a kept stamp from before the typing does not count', async () => {
    const { box, ask, record } = setup();
    record({ effortKeptAt: NOW - 60_000 });
    const c = ask();
    await box.tick();
    await box.tick();
    expect(box.get(c.changeId)?.state).toBe('typed');
  });

  it('answers "Switch model?" with Enter once, when it names the model asked for and Yes is focused', async () => {
    const { w, box, ask, record } = setup();
    const c = ask({ kind: 'model', value: 'opus' });
    await box.tick();
    w.screen = question('Opus 5.5');
    await box.tick();
    await box.tick();
    expect(w.pressed).toEqual(['\r']);
    record({ launchModel: 'opus', launchModelAt: NOW, model: 'Opus 5.5', modelAt: NOW });
    await box.tick();
    expect(box.get(c.changeId)?.state).toBe('confirmed');
    expect(w.rows[0].summary).toBe('The CLI confirmed the model change in the session, after AASC answered its switch question.');
  });

  it('answers "Change effort level?" the same way', async () => {
    const { w, box, ask } = setup();
    ask({ value: 'low' });
    await box.tick();
    w.screen = question('low', true, 'Change effort level?');
    await box.tick();
    expect(w.pressed).toEqual(['\r']);
  });

  it('a focused "No" (a draft in the box) gets Esc, and the change is not applied', async () => {
    const { w, box, ask } = setup();
    const c = ask({ kind: 'model', value: 'opus' });
    await box.tick();
    w.screen = question('Opus 5.5', false);
    await box.tick();
    expect(w.pressed).toEqual(['\x1b']);
    expect(box.get(c.changeId)).toMatchObject({ state: 'not-applied', reason: expect.stringContaining('could not answer it safely') });
  });

  it('a question naming another model, or with a person at the session, is left to the person', async () => {
    const other = setup();
    const c = other.ask({ kind: 'model', value: 'opus' });
    await other.box.tick();
    other.w.screen = question('Sonnet 5.5');
    await other.box.tick();
    expect(other.w.pressed).toEqual([]);
    other.w.clock.now = NOW + CLAUDE_CONFIRM_MS + 1;
    await other.box.tick();
    expect(other.box.get(c.changeId)).toMatchObject({ state: 'not-applied', reason: expect.stringContaining('waiting for the person') });

    const person = setup();
    person.ask({ kind: 'model', value: 'opus' });
    await person.box.tick();
    person.w.screen = question('Opus 5.5');
    person.w.controller = { clientId: 'browser-1', lastActivityAt: NOW - 1_000 };
    await person.box.tick();
    expect(person.w.pressed).toEqual([]);
  });

  it('a check that now refuses (hands-off) leaves the question alone', async () => {
    const { w, box, ask } = setup();
    let check: ChangeCheck = { go: true };
    ask({ kind: 'model', value: 'opus' }, () => check);
    await box.tick();
    check = { go: false, wait: false, reason: 'hands-off' };
    w.screen = question('Opus 5.5');
    await box.tick();
    expect(w.pressed).toEqual([]);
  });

  it('Codex is never answered: it asks no such question', async () => {
    const { w, box, ask } = setup({ cliSource: 'codex' });
    ask({ cli: 'codex', kind: 'model', value: 'gpt-5' });
    await box.tick();
    w.screen = question('gpt-5');
    await box.tick();
    expect(w.pressed).toEqual([]);
  });
});

describe('switchQuestion / questionMatches', () => {
  it('finds the question below its title only, and which option is focused', () => {
    expect(switchQuestion(question('Opus 5.5'), 'model')).toEqual({ label: 'Opus 5.5', yesFocused: true });
    expect(switchQuestion(question('Opus 5.5', false), 'model')).toEqual({ label: 'Opus 5.5', yesFocused: false });
    expect(switchQuestion(question('Opus 5.5'), 'effort')).toBeNull();
    expect(switchQuestion([' ❯ 1. Yes, switch to Opus 5.5'], 'model')).toBeNull();
    expect(switchQuestion([], 'model')).toBeNull();
  });

  it('matches a label to the value asked for', () => {
    expect(questionMatches('model', 'opus', 'Opus 5.5')).toBe(true);
    expect(questionMatches('model', 'claude-opus-5-5', 'Opus 5.5')).toBe(true);
    expect(questionMatches('model', 'opus', 'Sonnet 5.5')).toBe(false);
    expect(questionMatches('effort', 'low', 'low')).toBe(true);
    expect(questionMatches('effort', 'low', 'high')).toBe(false);
  });
});
