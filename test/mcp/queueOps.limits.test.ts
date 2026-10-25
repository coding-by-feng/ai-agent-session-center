// test/mcp/queueOps.limits.test.ts — the ops' own share of B-M4 and Ruling 52 (server/mcp/queueOps.ts). An add past
// 200 prompts in a queue, or past 20 chain steps in a prompt (before and after together), is INVALID. An automation op
// writes back the whole record, and a switch the record lacks is written as off, which is how the window reads it,
// never on; with no record stored there is nothing to write back, so it is refused. The tool tests are in
// tools.queueWriteLimits.test.ts and tools.queueWriteLockMore.test.ts.
import { describe, expect, it } from 'vitest';
import {
  addItem,
  addStep,
  MAX_ITEM_STEPS,
  MAX_QUEUE_ITEMS,
  setAutomation,
  setAutoSend,
  setPaused,
  storedResumeRetries,
} from '../../server/mcp/queueOps.js';
import { automationOf, item, NOW, refusalOf, stateOf } from './queueFixtures.js';

const prompts = (count: number) => Array.from({ length: count }, (_, i) => item(i + 1, { position: i }));
const steps = (count: number, from: number) => Array.from({ length: count }, (_, i) => ({ id: from + i, text: `step ${i}` }));

describe('the caps', () => {
  it('are 200 prompts a queue and 20 steps a prompt', () => {
    expect(MAX_QUEUE_ITEMS).toBe(200);
    expect(MAX_ITEM_STEPS).toBe(20);
  });

  it('refuse a 201st prompt, and any past it, and take a 200th', () => {
    const add = (count: number, text = 'x') => () => addItem(stateOf(prompts(count)), { sessionId: 's1', text, disabled: true }, NOW);

    expect(refusalOf(add(200)).code).toBe('INVALID');
    expect(refusalOf(add(250, 'y')).message).toMatch(/200 prompts/);
    expect(add(199)().items).toHaveLength(200);
  });

  it('refuse a 21st step in either chain, and take a 20th', () => {
    const full = stateOf([item(1, { beforeChain: steps(15, 100), afterChain: steps(5, 200) })]);
    const room = stateOf([item(1, { beforeChain: steps(15, 100), afterChain: steps(4, 200) })]);

    expect(refusalOf(() => addStep(full, { itemId: 1, chain: 'before', text: 'x' }, NOW)).code).toBe('INVALID');
    expect(refusalOf(() => addStep(full, { itemId: 1, chain: 'after', text: 'x' }, NOW)).message).toMatch(/20 chain steps/);
    expect(addStep(room, { itemId: 1, chain: 'after', text: 'x' }, NOW).items).toHaveLength(1);
  });

  it('count steps that are not readable steps too: the window keeps them in the chain', () => {
    const odd = stateOf([item(1, { beforeChain: [...steps(19, 100), 'junk'] })]);

    expect(refusalOf(() => addStep(odd, { itemId: 1, chain: 'after', text: 'x' }, NOW)).code).toBe('INVALID');
  });
});

describe('the automation record an op writes back', () => {
  it('is refused when none is stored, by every automation op, in the same words', () => {
    const none = stateOf([]);
    const refusals = [
      refusalOf(() => setPaused(none, false)),
      refusalOf(() => setAutoSend(none, true)),
      refusalOf(() => setAutomation(none, { autoEnter: false }, NOW)),
    ];

    for (const err of refusals) {
      expect(err.code).toBe('INVALID');
      expect(err.message).toBe('No automation settings are stored for this queue yet.');
      expect(err.hint).toBe('Change one queue switch in AASC first.');
    }
  });

  it('is refused for a record that is not a record', () => {
    expect(refusalOf(() => setPaused(stateOf([], ['paused'] as never), true)).code).toBe('INVALID');
  });

  it('reads only true as on: any other value of a switch is written as off', () => {
    const out = setAutoSend(stateOf([], { autoEnter: 'yes', idleGuard: 1, autoResume: null } as never), false);

    expect(out.automation).toMatchObject({ autoEnter: false, idleGuard: false, autoResume: false, skipWhenPrompting: false, paused: false });
  });

  it('keeps the switches that are on, the fields it does not know, and fills the retries and the resume prompt', () => {
    const out = setAutomation(stateOf([], { autoSend: true, autoResume: true, futureField: 'kept' } as never), { idleGuard: true }, NOW);

    expect(out.automation).toEqual({
      autoSend: true,
      autoResume: true,
      futureField: 'kept',
      paused: false,
      autoEnter: false,
      idleGuard: true,
      skipWhenPrompting: false,
      resumeMaxRetries: 3,
      resumePrompt: '',
    });
  });

  it('writes a whole stored record back as it was, but for the field it changes', () => {
    expect(setPaused(stateOf([], automationOf()), true).automation).toEqual(automationOf({ paused: true }));
  });
});

describe('storedResumeRetries', () => {
  it('is the stored attempts, rounded and kept within 1 to 10', () => {
    expect(storedResumeRetries(automationOf({ resumeMaxRetries: 6 }))).toBe(6);
    expect(storedResumeRetries(automationOf({ resumeMaxRetries: 6.4 }))).toBe(6);
    expect(storedResumeRetries(automationOf({ resumeMaxRetries: 50 }))).toBe(10);
    expect(storedResumeRetries(automationOf({ resumeMaxRetries: -2 }))).toBe(1);
  });

  it('is three, the dashboard’s own, when none are stored', () => {
    expect(storedResumeRetries(null)).toBe(3);
    expect(storedResumeRetries(automationOf({ resumeMaxRetries: 'many' }))).toBe(3);
  });
});
