import { describe, it, expect, vi } from 'vitest';
import { createBrain, findBrain, replyAfter, BrainError, type BrainDeps, type BrainEntry, type BrainSession } from '../../server/voice/brain.js';
import type { HookSignal } from '../../server/hookSignals.js';
import type { PromptRequest, PromptResult } from '../../server/promptSubmit.js';

const central = (id: string, kind = 'global') => ({ centralId: id, kind });
const card = (over: Partial<BrainSession> = {}): BrainSession => ({
  sessionId: 's-brain', terminalId: 'term-1', status: 'waiting', title: 'Voice', projectName: 'p',
  remoteVisible: true, centralId: 'c1', lastActivityAt: 1, ...over,
});

const LOCAL = { isLocal: true };
const say = (text: string) => (tag: string) => `[AASC · voice ${tag}] ${text}`;

function deps(over: Partial<BrainDeps> = {}): BrainDeps & { emit: (s: Partial<HookSignal>) => void; typed: string[] } {
  const listeners = new Set<(s: HookSignal) => void>();
  const typed: string[] = [];
  const base: BrainDeps = {
    centrals: () => [central('c1')],
    preferredCentralId: () => null,
    sessionOfCentral: (id) => (id === 'c1' ? card() : null),
    submit: vi.fn(async (req: PromptRequest): Promise<PromptResult> => { typed.push(req.text); return { outcome: 'submitted', typed: true }; }),
    onTerminalHook: (_t, l) => { listeners.add(l); return () => listeners.delete(l); },
    // The transcript: every typed line, each answered.
    readEntries: vi.fn(async (): Promise<BrainEntry[]> => typed.flatMap((text) => [
      { kind: 'user', text }, { kind: 'assistant', text: 'Three sessions are running.' },
    ])),
    sleep: async () => {},
  };
  const merged = { ...base, ...over };
  return {
    ...merged,
    typed,
    emit: (s) => { for (const l of [...listeners]) l({ event: 'Stop', sessionId: 's-brain', terminalId: 'term-1', status: 'waiting', ...s }); },
  };
}

describe('findBrain', () => {
  it('takes the preferred central when it exists', () => {
    const d = deps({ centrals: () => [central('c1'), central('c2')], preferredCentralId: () => 'c2', sessionOfCentral: (id) => card({ centralId: id }) });
    expect(findBrain(d)).toMatchObject({ centralId: 'c2' });
  });

  it('falls back to the only global central', () => {
    const d = deps({ centrals: () => [central('r1', 'room'), central('c1')] });
    expect(findBrain(d)).toMatchObject({ centralId: 'c1' });
  });

  it('answers no_central when no central can be chosen', () => {
    expect(findBrain(deps({ centrals: () => [] }))).toEqual({ problem: 'no_central' });
    expect(findBrain(deps({ centrals: () => [central('a'), central('b')] }))).toEqual({ problem: 'no_central' });
  });

  it('answers not_running when the central has no live terminal', () => {
    expect(findBrain(deps({ sessionOfCentral: () => card({ status: 'ended' }) }))).toEqual({ problem: 'not_running' });
    expect(findBrain(deps({ sessionOfCentral: () => card({ terminalId: null }) }))).toEqual({ problem: 'not_running' });
  });
});

describe('replyAfter', () => {
  const H = '[AASC · voice q1]';
  it('answers the last assistant text after the tagged prompt', () => {
    expect(replyAfter([
      { kind: 'user', text: `${H} hi` }, { kind: 'assistant', text: 'Let me check.' }, { kind: 'tool_use' },
      { kind: 'tool_result' }, { kind: 'assistant', text: 'Two are running.' }, { kind: 'thinking' },
    ], H)).toBe('Two are running.');
  });

  it('is null while a tool call follows the newest text (the reply is not final)', () => {
    expect(replyAfter([{ kind: 'user', text: `${H} hi` }, { kind: 'assistant', text: 'Let me check.' }, { kind: 'tool_use' }], H)).toBeNull();
  });

  it('never takes a reply to another prompt', () => {
    expect(replyAfter([{ kind: 'user', text: '[AASC · voice q0] old' }, { kind: 'assistant', text: 'old answer' }], H)).toBeNull();
    expect(replyAfter([{ kind: 'assistant', text: 'earlier' }, { kind: 'user', text: `${H} hi` }], H)).toBeNull();
  });
});

describe('createBrain.ask', () => {
  it('types the tagged text into the central and answers the reply to it after the turn ends', async () => {
    const d = deps();
    const brain = createBrain(d);
    const pending = brain.ask(say('hello'), LOCAL);
    await vi.waitFor(() => expect(d.submit).toHaveBeenCalled());
    const req = (d.submit as ReturnType<typeof vi.fn>).mock.calls[0][0] as PromptRequest;
    expect(req).toMatchObject({ sessionId: 's-brain', terminalId: 'term-1', mode: 'now' });
    expect(req.text).toMatch(/^\[AASC · voice q[a-z0-9]+\] hello$/);
    d.emit({ event: 'UserPromptSubmit', status: 'prompting' });
    d.emit({ event: 'Stop' });
    await expect(pending).resolves.toBe('Three sessions are running.');
  });

  it('gives each question its own tag', async () => {
    const d = deps();
    const brain = createBrain(d);
    const first = brain.ask(say('one'), LOCAL);
    await vi.waitFor(() => expect(d.typed).toHaveLength(1));
    d.emit({ event: 'Stop' });
    await first;
    const second = brain.ask(say('two'), LOCAL);
    await vi.waitFor(() => expect(d.typed).toHaveLength(2));
    d.emit({ event: 'Stop' });
    await second;
    const tags = d.typed.map((t) => t.split(']')[0]);
    expect(new Set(tags).size).toBe(2);
  });

  it('refuses when the central did not take the prompt', async () => {
    const d = deps({ submit: vi.fn(async (): Promise<PromptResult> => ({ outcome: 'stopped', typed: false })) });
    await expect(createBrain(d).ask(say('x'), LOCAL)).rejects.toMatchObject({ code: 'not_taken' });
  });

  it('times out when the turn never ends', async () => {
    vi.useFakeTimers();
    try {
      const d = deps();
      const pending = createBrain(d, { turnTimeoutMs: 1000 }).ask(say('x'), LOCAL).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(1500);
      const err = await pending;
      expect(err).toBeInstanceOf(BrainError);
      expect((err as BrainError).code).toBe('timeout');
    } finally {
      vi.useRealTimers();
    }
  });

  it('reads again until the reply to this prompt is written, never an older reply', async () => {
    let reads = 0;
    const d = deps();
    d.readEntries = vi.fn(async () => {
      reads += 1;
      const mine = d.typed[0];
      // First read: only the previous turn's reply; second: ours mid-tool; third: ours, final.
      if (reads === 1) return [{ kind: 'user', text: 'someone else' }, { kind: 'assistant', text: 'old reply' }];
      if (reads === 2) return [{ kind: 'user', text: mine }, { kind: 'assistant', text: 'Let me check.' }, { kind: 'tool_use' }];
      return [{ kind: 'user', text: mine }, { kind: 'assistant', text: 'new reply' }];
    });
    const pending = createBrain(d).ask(say('x'), LOCAL);
    await vi.waitFor(() => expect(d.submit).toHaveBeenCalled());
    d.emit({ event: 'Stop' });
    await expect(pending).resolves.toBe('new reply');
  });

  it('runs one question at a time', async () => {
    const d = deps();
    const brain = createBrain(d);
    const first = brain.ask(say('one'), LOCAL);
    const second = brain.ask(say('two'), LOCAL);
    await vi.waitFor(() => expect(d.submit).toHaveBeenCalledTimes(1));
    d.emit({ event: 'Stop' });
    await first;
    await vi.waitFor(() => expect(d.submit).toHaveBeenCalledTimes(2));
    d.emit({ event: 'Stop' });
    await second;
  });

  it('ends early when the central session ends mid-turn', async () => {
    const d = deps();
    const pending = createBrain(d).ask(say('x'), LOCAL).catch((e: unknown) => e);
    await vi.waitFor(() => expect(d.submit).toHaveBeenCalled());
    d.emit({ event: 'SessionEnd', status: 'ended' });
    expect(((await pending) as BrainError).code).toBe('not_running');
  });

  it('re-checks sharing for every remote question', async () => {
    let shared = true;
    const d = deps({ sessionOfCentral: () => card({ remoteVisible: shared }) });
    const brain = createBrain(d);
    const first = brain.ask(say('one'), { isLocal: false });
    await vi.waitFor(() => expect(d.submit).toHaveBeenCalledTimes(1));
    d.emit({ event: 'Stop' });
    await expect(first).resolves.toBeTruthy();
    shared = false;
    await expect(brain.ask(say('two'), { isLocal: false })).rejects.toMatchObject({ code: 'not_shared' });
    expect(d.submit).toHaveBeenCalledTimes(1);
  });

  it('drops a question still waiting when its call ends, and stops waiting on one in progress', async () => {
    const d = deps();
    const brain = createBrain(d);
    const call = new AbortController();
    const first = brain.ask(say('one'), { isLocal: true, signal: call.signal }).catch((e: unknown) => e);
    const second = brain.ask(say('two'), { isLocal: true, signal: call.signal }).catch((e: unknown) => e);
    await vi.waitFor(() => expect(d.submit).toHaveBeenCalledTimes(1));
    call.abort();
    expect(((await first) as BrainError).code).toBe('cancelled');
    expect(((await second) as BrainError).code).toBe('cancelled');
    expect(d.submit).toHaveBeenCalledTimes(1);
  });
});
