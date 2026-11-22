import { describe, it, expect, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createCallMemory } from '../../server/voice/callMemory.js';
import {
  extractFromCall, extractPrompt, parseCandidates, worthExtracting, MIN_CALL_MS,
} from '../../server/voice/callMemoryExtract.js';
import type { TranscriptLine } from '../../server/voice/transcriptLog.js';

const line = (role: 'user' | 'assistant', text: string, startMs = 0): TranscriptLine => ({ role, text, startMs, endMs: startMs + 1_000 });

const lines: TranscriptLine[] = [
  line('user', 'can you check the central section', 0),
  line('assistant', 'Checking the central session.', 2_000),
  line('user', 'no I meant the central session not section', 5_000),
  line('user', 'and from now on open new web work in agent manager work trees', 40_000),
  line('user', 'make the logo blue', 50_000),
];

describe('worthExtracting', () => {
  it('runs only for a call long enough with a lasting cue or several requests', () => {
    expect(worthExtracting(lines, 60_000)).toBe(true);
    expect(worthExtracting(lines, MIN_CALL_MS - 1)).toBe(false);
    expect(worthExtracting([line('user', 'what is running'), line('user', 'ok thanks')], 60_000)).toBe(false);
    expect(worthExtracting([line('user', 'a'), line('user', 'b'), line('user', 'c')], 60_000)).toBe(true);
  });
});

describe('extractPrompt', () => {
  it('gives the model the person’s lines apart from the voice’s, the known names and the projects', () => {
    const prompt = extractPrompt(lines, { names: ['AASC docs'], projects: ['/repo/agent-manager'] });
    expect(prompt).toContain('PERSON: no I meant the central session not section');
    expect(prompt).toContain('VOICE: Checking the central session.');
    expect(prompt).toContain('/repo/agent-manager');
    expect(prompt).toContain('AASC docs');
    expect(prompt).toMatch(/temporary/i);
  });
});

describe('parseCandidates', () => {
  const projects = ['/repo/agent-manager'];
  it('keeps well-formed items whose evidence is the person’s own words', () => {
    const raw = 'Here you go:\n```json\n' + JSON.stringify([
      { kind: 'correction', heard: 'central section', meant: 'central session', scope: 'global' },
      { kind: 'preference', heard: 'from now on open new web work in agent manager work trees', meant: 'Open new web work in agent-manager worktrees', scope: 'project:/repo/agent-manager' },
    ]) + '\n```';
    expect(parseCandidates(raw, lines, projects)).toEqual([
      { kind: 'correction', heard: 'central section', meant: 'central session', scope: 'global' },
      { kind: 'preference', heard: 'from now on open new web work in agent manager work trees', meant: 'Open new web work in agent-manager worktrees', scope: 'project:/repo/agent-manager' },
    ]);
  });

  it('drops an item the person never said (only the voice did, or nobody), a bad kind, and garbage', () => {
    const raw = JSON.stringify([
      { kind: 'preference', heard: 'Checking the central session', meant: 'Always check the central', scope: 'global' },
      { kind: 'preference', heard: 'delete every session at night', meant: 'Delete sessions nightly', scope: 'global' },
      { kind: 'rule', heard: 'make the logo blue', meant: 'x', scope: 'global' },
    ]);
    expect(parseCandidates(raw, lines, projects)).toEqual([]);
    expect(parseCandidates('not json', lines, projects)).toEqual([]);
  });

  it('turns a project the person cannot see, or an unknown scope, into global (they choose at review)', () => {
    const raw = JSON.stringify([{ kind: 'correction', heard: 'central section', meant: 'central session', scope: 'project:/somewhere/else' }]);
    expect(parseCandidates(raw, lines, projects)[0].scope).toBe('global');
  });
});

describe('extractFromCall', () => {
  it('asks the model once and stores its proposals', async () => {
    const memory = createCallMemory({ db: () => new DatabaseSync(':memory:') });
    const runModel = vi.fn(async () => JSON.stringify([{ kind: 'correction', heard: 'central section', meant: 'central session', scope: 'global' }]));
    const added = await extractFromCall({ lines, durationMs: 60_000, context: { names: [], projects: [] }, runModel, memory, callId: 'c1' });
    expect(runModel).toHaveBeenCalledTimes(1);
    expect(added.map((i) => [i.kind, i.status])).toEqual([['correction', 'proposed']]);
  });

  it('does not ask for a short call, and a failing model costs nothing but a log line', async () => {
    const memory = createCallMemory({ db: () => new DatabaseSync(':memory:') });
    const runModel = vi.fn(async () => { throw new Error('claude not found'); });
    expect(await extractFromCall({ lines, durationMs: 5_000, context: { names: [], projects: [] }, runModel, memory, callId: 'c1' })).toEqual([]);
    expect(runModel).not.toHaveBeenCalled();
    expect(await extractFromCall({ lines, durationMs: 60_000, context: { names: [], projects: [] }, runModel, memory, callId: 'c1' })).toEqual([]);
  });
});
