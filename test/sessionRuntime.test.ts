import { describe, it, expect } from 'vitest';
import {
  mergeRuntime,
  runtimeVisiblyChanged,
  readingFromStatusLine,
  readingFromTranscript,
  launchFlagsFromRuntime,
} from '../server/sessionRuntime.js';

const T = (s: number) => new Date(Date.UTC(2026, 9, 14, 3, 0, s)).toISOString();
const at = (s: number) => Date.UTC(2026, 9, 14, 3, 0, s);

/** A transcript line exactly as Claude Code 2.1.299 writes a local command's result. */
function localCommand(command: 'model' | 'effort', stdout: string, s: number, args = ''): string {
  return JSON.stringify({
    type: 'system', subtype: 'local_command', isSidechain: false, timestamp: T(s),
    content: `<local-command-stdout>${stdout}</local-command-stdout>`,
    commandRun: { command, args },
  });
}
function assistant(model: string, s: number, sidechain = false): string {
  return JSON.stringify({
    type: 'assistant', isSidechain: sidechain, timestamp: T(s),
    message: { model, role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
  });
}

describe('readingFromTranscript', () => {
  it('reads /model and /effort from the local-command lines the CLI writes instantly', () => {
    const r = readingFromTranscript([
      localCommand('effort', 'Set effort level to high (saved as your default for new sessions): Comprehensive', 1),
      localCommand('model', 'Set model to `Opus 5.5` and saved as your default for new sessions', 2),
      localCommand('effort', 'Set effort level to max (this session only)', 3, 'max'),
    ]);
    expect(r).toEqual({
      model: 'Opus 5.5', modelAt: at(2), launchModel: 'claude-opus-5-5', launchModelAt: at(2),
      effort: 'max', effortAt: at(3), effortSet: true,
    });
  });

  it('takes the model each reply was actually answered by', () => {
    const r = readingFromTranscript([
      localCommand('model', 'Set model to `Opus 5.5` and saved as your default for new sessions', 1),
      assistant('claude-opus-5-5', 2),
      assistant('claude-sonnet-5-5', 3),
    ]);
    expect(r.model).toBe('claude-sonnet-5-5');
    expect(r.modelAt).toBe(at(3));
  });

  it('REGRESSION GUARD: a model switch after the last /effort clears the effort — Claude restores that model\'s own saved level', () => {
    const r = readingFromTranscript([
      localCommand('effort', 'Set effort level to max (this session only)', 1),
      localCommand('model', 'Set model to `Haiku 4.5` and saved as your default for new sessions', 2),
    ]);
    expect(r.model).toBe('Haiku 4.5');
    expect(r.effort).toBeNull();
    expect(r.effortAt).toBe(at(2));
  });

  it('a reply on the same model is not a switch: the effort stands', () => {
    const r = readingFromTranscript([
      assistant('claude-opus-5-5', 1),
      localCommand('effort', 'Set effort level to low (saved as your default for new sessions): Quick', 2),
      assistant('claude-opus-5-5', 3),
    ]);
    expect(r.effort).toBe('low');
  });

  it('ignores subagent lines, synthetic replies, other commands and garbage', () => {
    const r = readingFromTranscript([
      assistant('claude-opus-5-5', 1),
      assistant('claude-haiku-4-5', 2, true),
      assistant('<synthetic>', 3),
      JSON.stringify({ type: 'system', subtype: 'local_command', timestamp: T(4), content: '<local-command-stdout>Context: 40%</local-command-stdout>', commandRun: { command: 'context' } }),
      localCommand('model', 'Kept model as `Opus 5.5`', 5),
      '{not json',
      '',
    ]);
    expect(r).toEqual({ model: 'claude-opus-5-5', modelAt: at(1) });
  });

  it('says nothing about a transcript with neither signal', () => {
    expect(readingFromTranscript([])).toEqual({});
  });
});

describe('readingFromStatusLine', () => {
  it('reads the live model and effort the status line is given', () => {
    expect(readingFromStatusLine({
      session_id: 's', ts: 1000,
      model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' },
      effort: { level: 'xhigh' },
    })).toEqual({ model: 'Opus 5.5', modelAt: 1000, effort: 'xhigh', effortAt: 1000, effortSet: false });
  });

  it('a model without the effort parameter has no effort: absent means cleared', () => {
    expect(readingFromStatusLine({ session_id: 's', ts: 1000, model: { id: 'claude-haiku-4-5' } }))
      .toEqual({ model: 'claude-haiku-4-5', modelAt: 1000, effort: null, effortAt: 1000, effortSet: false });
  });

  it('rejects a snapshot without a usable timestamp or model', () => {
    expect(readingFromStatusLine({ session_id: 's', model: { id: 'x' } })).toBeNull();
    expect(readingFromStatusLine({ session_id: 's', ts: 5 })).toBeNull();
    expect(readingFromStatusLine(null)).toBeNull();
    expect(readingFromStatusLine({ session_id: 's', ts: 5, model: { id: 'a', display_name: 'x'.repeat(200) } })?.model)
      .toHaveLength(80);
  });
});

describe('runtimeVisiblyChanged', () => {
  it('is true only when the label a browser shows would change', () => {
    const a = { model: 'claude-opus-5-5', modelAt: 1, effort: 'high', effortAt: 1 };
    expect(runtimeVisiblyChanged(undefined, a)).toBe(true);
    expect(runtimeVisiblyChanged(a, { ...a, modelAt: 9, effortAt: 9 })).toBe(false);
    expect(runtimeVisiblyChanged(a, { ...a, model: 'Opus 5.5' })).toBe(false);
    expect(runtimeVisiblyChanged(a, { ...a, effort: 'max' })).toBe(true);
    expect(runtimeVisiblyChanged(a, { model: 'claude-opus-5-5', modelAt: 1, effortAt: 2 })).toBe(true);
  });
});

describe('mergeRuntime', () => {
  it('starts from nothing and reports no change for the same reading twice', () => {
    const first = mergeRuntime(undefined, { model: 'Opus 5.5', modelAt: 10, effort: 'high', effortAt: 10 });
    expect(first).toEqual({ model: 'Opus 5.5', modelAt: 10, effort: 'high', effortAt: 10 });
    expect(mergeRuntime(first!, { model: 'Opus 5.5', modelAt: 10, effort: 'high', effortAt: 10 })).toBeNull();
  });

  it('newest wins per field, whichever source it came from', () => {
    const prev = { model: 'Opus 5.5', modelAt: 10, effort: 'high', effortAt: 20 };
    // An older status-line render must not undo a newer /effort (its model time still advances).
    const later = mergeRuntime(prev, { model: 'Opus 5.5', modelAt: 15, effort: 'medium', effortAt: 15 });
    expect(later).toEqual({ ...prev, modelAt: 15 });
    expect(runtimeVisiblyChanged(prev, later!)).toBe(false);
    expect(mergeRuntime(prev, { effort: 'max', effortAt: 30 })).toEqual({ ...prev, effort: 'max', effortAt: 30 });
  });

  it('does not mutate the previous value', () => {
    const prev = Object.freeze({ model: 'Opus 5.5', modelAt: 10, effort: 'high', effortAt: 10 });
    expect(() => mergeRuntime(prev, { effort: 'low', effortAt: 11 })).not.toThrow();
    expect(prev.effort).toBe('high');
  });

  it('a newer reading on a DIFFERENT model with no effort of its own clears the old effort', () => {
    const prev = { model: 'claude-opus-5-5', modelAt: 10, effort: 'max', effortAt: 10 };
    expect(mergeRuntime(prev, { model: 'claude-haiku-4-5', modelAt: 20 }))
      .toEqual({ model: 'claude-haiku-4-5', modelAt: 20, effortAt: 20 });
    // The same model under another name (ID vs display name) is not a switch.
    expect(mergeRuntime(prev, { model: 'Opus 5.5', modelAt: 20 }))
      .toEqual({ model: 'Opus 5.5', modelAt: 20, effort: 'max', effortAt: 10 });
  });

  it('an explicit null clears the effort when it is newer', () => {
    const prev = { model: 'x', modelAt: 10, effort: 'max', effortAt: 10 };
    expect(mergeRuntime(prev, { effort: null, effortAt: 20 })).toEqual({ model: 'x', modelAt: 10, effortAt: 20 });
    expect(mergeRuntime(prev, { effort: null, effortAt: 5 })).toBeNull();
  });
});

/** A Codex rollout `turn_context` line, trimmed to the fields that matter here. */
function turnContext(model: unknown, effort: unknown, s: number): string {
  return JSON.stringify({
    timestamp: T(s), type: 'turn_context',
    payload: { turn_id: `t${s}`, cwd: '/tmp/p', model, effort, summary: 'detailed' },
  });
}

describe('readingFromTranscript — Codex rollouts', () => {
  it('takes model and effort from the newest turn_context (Codex writes one per turn)', () => {
    const r = readingFromTranscript([
      turnContext('gpt-6-astra', 'low', 1),
      JSON.stringify({ timestamp: T(2), type: 'response_item', payload: { type: 'message' } }),
      turnContext('gpt-6-astra', 'high', 3),
    ]);
    expect(r).toEqual({
      model: 'gpt-6-astra', modelAt: at(3), launchModel: 'gpt-6-astra', launchModelAt: at(3),
      effort: 'high', effortAt: at(3), effortSet: false,
    });
  });

  it('a turn with no effort, or garbage in it, says the effort is unknown', () => {
    expect(readingFromTranscript([turnContext('gpt-6-astra', null, 1)])).toEqual({
      model: 'gpt-6-astra', modelAt: at(1), launchModel: 'gpt-6-astra', launchModelAt: at(1),
      effort: null, effortAt: at(1), effortSet: false,
    });
    expect(readingFromTranscript([turnContext(42, 'HIGH; rm -rf', 1)]))
      .toEqual({ effort: null, effortAt: at(1), effortSet: false });
  });
});

describe('readingFromTranscript — the launch model', () => {
  it('REVIEW: replies alone never set it — opusplan answers from Sonnet, a fallback model too', () => {
    const r = readingFromTranscript([assistant('claude-sonnet-5-5', 1), assistant('claude-sonnet-5-5', 2)]);
    expect(r.model).toBe('claude-sonnet-5-5');
    expect(r.launchModel).toBeUndefined();
  });

  it('/model <name> launches with exactly that name, whatever the replies come from', () => {
    const r = readingFromTranscript([
      localCommand('model', 'Set model to `Opus Plan Mode` and saved as your default for new sessions', 1, 'opusplan'),
      assistant('claude-sonnet-5-5', 2),
    ]);
    expect(r).toMatchObject({ launchModel: 'opusplan', launchModelAt: at(1) });
  });

  it('a model picked in the /model menu takes the ID of the reply that follows it', () => {
    const picked = localCommand('model', 'Set model to `Sonnet 4` and saved as your default for new sessions', 1);
    expect(readingFromTranscript([picked]).launchModel).toBeUndefined();
    expect(readingFromTranscript([picked, assistant('claude-sonnet-4-0', 2), assistant('claude-opus-4-8', 3)]))
      .toMatchObject({ launchModel: 'claude-sonnet-4-0', launchModelAt: at(2) });
    expect(readingFromTranscript([localCommand('model', 'Set model to `Opus 5.5` and saved', 1)]))
      .toMatchObject({ launchModel: 'claude-opus-5-5', launchModelAt: at(1) });
  });

  it('marks an effort set by /effort, so a reported base level cannot demote ultracode', () => {
    expect(readingFromTranscript([localCommand('effort', 'Set effort level to xhigh (this session only)', 1, 'xhigh')]))
      .toMatchObject({ effort: 'xhigh', effortSet: true });
  });
});

describe('launchFlagsFromRuntime', () => {
  const launched = { model: 'claude-opus-4-8', effortLevel: 'medium' };

  it('the model the user chose and the live effort replace what the session was launched with', () => {
    expect(launchFlagsFromRuntime(
      { model: 'Opus 5.5', modelAt: 1, launchModel: 'claude-opus-5-5', launchModelAt: 1, effort: 'high', effortAt: 1 },
      launched,
    )).toEqual({ model: 'claude-opus-5-5', effortLevel: 'high' });
  });

  it('REVIEW: the model a reply came from is never a launch model by itself (opusplan, fallback)', () => {
    expect(launchFlagsFromRuntime({ model: 'claude-sonnet-5-5', modelAt: 1 }, { model: 'opusplan' }))
      .toEqual({ model: 'opusplan', effortLevel: undefined });
  });

  it('REVIEW: an effort cleared by a model switch launches with none — that model\'s own saved level', () => {
    expect(launchFlagsFromRuntime({ launchModel: 'claude-haiku-5-5', launchModelAt: 2, effortAt: 2 }, { model: 'opus', effortLevel: 'max' }))
      .toEqual({ model: 'claude-haiku-5-5', effortLevel: undefined });
    expect(launchFlagsFromRuntime({ effort: 'turbo', effortAt: 1 }, launched))
      .toEqual({ model: 'claude-opus-4-8', effortLevel: undefined });
  });

  it('REVIEW: a reported xhigh does not demote ultracode; an explicit /effort xhigh does', () => {
    const ultra = { model: 'opus', effortLevel: 'ultracode' };
    expect(launchFlagsFromRuntime({ effort: 'xhigh', effortAt: 1 }, ultra).effortLevel).toBe('ultracode');
    expect(launchFlagsFromRuntime({ effort: 'xhigh', effortAt: 1, effortSet: true }, ultra).effortLevel).toBe('xhigh');
    expect(launchFlagsFromRuntime({ effort: 'ultracode', effortAt: 1 }, {})).toEqual({ effortLevel: 'ultracode' });
  });

  it('accepts Codex\'s minimal', () => {
    expect(launchFlagsFromRuntime({ effort: 'minimal', effortAt: 1 }, {}).effortLevel).toBe('minimal');
  });

  it('nothing reported leaves the launch values alone', () => {
    expect(launchFlagsFromRuntime(undefined, launched)).toEqual(launched);
    expect(launchFlagsFromRuntime({}, {})).toEqual({});
  });
});

describe('context-window usage (status line)', () => {
  const snap = (context: unknown) => ({ session_id: 's', ts: 1000, model: { id: 'claude-opus-5-5' }, context });

  it('reads the used % Claude Code reports, with the window size and the tokens in it', () => {
    expect(readingFromStatusLine(snap({ used_percentage: 42, size: 200000, tokens: 84312 })))
      .toMatchObject({ context: { pct: 42, size: 200000, tokens: 84312 }, contextAt: 1000 });
  });

  it('works the % out from the tokens when an older CLI sends no used_percentage', () => {
    expect(readingFromStatusLine(snap({ size: 200000, tokens: 50000 }))?.context).toEqual({ pct: 25, size: 200000, tokens: 50000 });
  });

  it('clamps to 0..100 and rounds', () => {
    expect(readingFromStatusLine(snap({ used_percentage: 140, size: 1000, tokens: 1400 }))?.context?.pct).toBe(100);
    expect(readingFromStatusLine(snap({ size: 3000, tokens: 1000 }))?.context?.pct).toBe(33);
  });

  it('no usage yet (a fresh session, or right after /clear) is unknown, not 0%', () => {
    const r = readingFromStatusLine(snap({ used_percentage: null, size: 200000, tokens: null }));
    expect(r).toMatchObject({ context: null, contextAt: 1000 });
  });

  it('ignores garbage numbers rather than showing them', () => {
    expect(readingFromStatusLine(snap({ used_percentage: 'lots', size: -5, tokens: 'x' }))).toMatchObject({ context: null });
    expect(readingFromStatusLine(snap({ used_percentage: 12, size: 'big', tokens: -1 }))?.context).toEqual({ pct: 12 });
  });

  it('a snapshot from the old tap (no context key) says nothing about context', () => {
    const r = readingFromStatusLine({ session_id: 's', ts: 1000, model: { id: 'claude-opus-5-5' } });
    expect(r).not.toHaveProperty('context');
    expect(r).not.toHaveProperty('contextAt');
  });

  it('merges newest-first, clears on an explicit null, and leaves model/effort alone', () => {
    const prev = { model: 'Opus 5.5', modelAt: 10, effort: 'high', effortAt: 10 };
    const withCtx = mergeRuntime(prev, { context: { pct: 42, size: 200000 }, contextAt: 20 });
    expect(withCtx).toEqual({ ...prev, context: { pct: 42, size: 200000 }, contextAt: 20 });
    expect(mergeRuntime(withCtx!, { context: { pct: 10 }, contextAt: 15 })).toBeNull(); // older
    expect(mergeRuntime(withCtx!, { context: { pct: 42, size: 200000 }, contextAt: 20 })).toBeNull(); // same
    expect(mergeRuntime(withCtx!, { context: null, contextAt: 30 })).toEqual({ ...prev, contextAt: 30 });
  });

  it('a different % or token count is a visible change (the tooltip shows tokens); a later time alone is not', () => {
    const a = { model: 'Opus 5.5', modelAt: 1, context: { pct: 42, tokens: 8 }, contextAt: 1 };
    expect(runtimeVisiblyChanged(a, { ...a, context: { pct: 43, tokens: 8 }, contextAt: 2 })).toBe(true);
    expect(runtimeVisiblyChanged(a, { ...a, context: { pct: 42, tokens: 9 }, contextAt: 2 })).toBe(true);
    expect(runtimeVisiblyChanged(a, { ...a, contextAt: 2 })).toBe(false);
    expect(runtimeVisiblyChanged(a, { model: 'Opus 5.5', modelAt: 1, contextAt: 2 })).toBe(true);
  });
});
