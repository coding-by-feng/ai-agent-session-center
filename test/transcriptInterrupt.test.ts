/**
 * Did the user stop the turn that just ended? Claude Code writes the answer
 * into its own transcript: on Esc, or a declined tool, it appends a user entry
 * "[Request interrupted by user]" (or "… for tool use]") carrying
 * `interruptedMessageId` and the turn's `promptId`, then ends the turn with an
 * ordinary Stop. Shapes below are copied from real 2.1.247 / 2.1.266
 * transcripts.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { turnWasInterrupted, readTranscriptTail, checkTurnInterrupted } from '../server/transcriptInterrupt.js';

const P = 'e6687efd-aa7a-461e-8975-5a571e6bdd33';
const P2 = '7ccb55eb-0000-4000-8000-000000000000';

const j = (o: Record<string, unknown>) => JSON.stringify(o);
const prompt = (promptId: string, text = 'fix the build') =>
  j({ type: 'user', promptId, message: { role: 'user', content: text } });
const toolResult = (promptId: string, extra: Record<string, unknown> = {}) =>
  j({ type: 'user', promptId, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] }, ...extra });
const assistant = (kind: 'text' | 'tool_use' | 'thinking') =>
  j({ type: 'assistant', message: { role: 'assistant', content: [{ type: kind, text: 'x' }] } });
const marker = (promptId: string, text = '[Request interrupted by user]', extra: Record<string, unknown> = {}) =>
  j({ type: 'user', promptId, interruptedMessageId: 'msg_011CezSAuxTJKSogXqdBsHa6', message: { role: 'user', content: [{ type: 'text', text }] }, ...extra });
const attachment = () => j({ type: 'attachment' });
const snapshot = () => j({ type: 'file-history-snapshot' });

describe('turnWasInterrupted', () => {
  it('Esc while Claude was writing', () => {
    expect(turnWasInterrupted([prompt(P), attachment(), assistant('thinking'), marker(P), snapshot()], P)).toBe(true);
  });

  it('a declined tool that ended the turn', () => {
    const lines = [
      prompt(P), assistant('tool_use'),
      toolResult(P, { toolDenialKind: 'user-rejected' }),
      marker(P, '[Request interrupted by user for tool use]'),
    ];
    expect(turnWasInterrupted(lines, P)).toBe(true);
  });

  it('a turn that finished normally', () => {
    expect(turnWasInterrupted([prompt(P), assistant('tool_use'), toolResult(P), attachment(), assistant('text')], P)).toBe(false);
  });

  it('an earlier turn\'s interruption does not count for this one', () => {
    const lines = [prompt(P), assistant('thinking'), marker(P), snapshot(), prompt(P2), assistant('text')];
    expect(turnWasInterrupted(lines, P2)).toBe(false);
  });

  it('without a prompt id, the last user entry decides', () => {
    expect(turnWasInterrupted([prompt(P), assistant('thinking'), marker(P)], null)).toBe(true);
    expect(turnWasInterrupted([prompt(P), assistant('tool_use'), toolResult(P), assistant('text')], null)).toBe(false);
  });

  it('ignores an interruption caused by shutdown, and a subagent\'s own', () => {
    expect(turnWasInterrupted([prompt(P), marker(P, undefined, { interruptedByShutdown: true })], P)).toBe(false);
    expect(turnWasInterrupted([prompt(P), assistant('tool_use'), marker(P, undefined, { isSidechain: true })], P)).toBe(false);
  });

  it('finds the marker behind later entries of the same turn (a queued `!` command, as in a real 2.1.247 transcript)', () => {
    const bash = j({ type: 'user', promptId: P, message: { role: 'user', content: '<bash-input>npm run set-password</bash-input>' } });
    expect(turnWasInterrupted([prompt(P), toolResult(P, { toolDenialKind: 'user-rejected' }), marker(P), bash], P)).toBe(true);
  });

  it('skips meta entries written after the marker', () => {
    const meta = j({ type: 'user', isMeta: true, promptId: P, message: { role: 'user', content: 'Caveat: local command output' } });
    expect(turnWasInterrupted([prompt(P), marker(P), meta], P)).toBe(true);
  });

  it('does not treat a prompt that merely quotes the marker as one', () => {
    // No interruptedMessageId: only the exact marker text counts.
    const quoting = j({ type: 'user', promptId: P, message: { role: 'user', content: '[Request interrupted by user] — why does this appear?' } });
    expect(turnWasInterrupted([quoting], P)).toBe(false);
  });

  it('tolerates junk and a half-written last line', () => {
    expect(turnWasInterrupted(['', 'not json', prompt(P), marker(P), '{"type":"user","promptId":"'], P)).toBe(true);
  });
});

describe('reading the transcript tail', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aasc-transcript-'));
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  it('reads only the tail, dropping the partial first line', async () => {
    const file = join(dir, 'big.jsonl');
    const filler = Array.from({ length: 200 }, (_, i) => j({ type: 'assistant', n: i, pad: 'x'.repeat(40) }));
    writeFileSync(file, [...filler, prompt(P), marker(P)].join('\n') + '\n');
    const lines = await readTranscriptTail(file, 2048);
    expect(lines).not.toBeNull();
    expect(lines!.join('\n').length).toBeLessThanOrEqual(2048);
    // Every kept line is whole JSON (the cut one was dropped).
    for (const l of lines!.filter(Boolean)) expect(() => JSON.parse(l)).not.toThrow();
    expect(await checkTurnInterrupted(file, P)).toBe(true);
  });

  it('refuses anything that is not a .jsonl file, and a missing file', async () => {
    const file = join(dir, 'notes.txt');
    writeFileSync(file, marker(P));
    expect(await readTranscriptTail(file)).toBeNull();
    expect(await checkTurnInterrupted(join(dir, 'missing.jsonl'), P)).toBeNull();
  });
});
