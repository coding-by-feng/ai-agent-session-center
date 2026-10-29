/**
 * Did the user stop the turn? Claude Code writes the answer into its own
 * transcript: on Esc, or a declined tool, it appends a user entry
 * "[Request interrupted by user]" (or "… for tool use]") carrying
 * `interruptedMessageId` and the turn's `promptId`, and fires no hook for it.
 * Shapes below are copied from real 2.1.247 / 2.1.266 transcripts.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { turnWasInterrupted, readTranscriptTail, checkTurnInterrupted, stoppedTurn } from '../server/transcriptInterrupt.js';

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
const reply = (messageId: string, kind: 'text' | 'tool_use' = 'text') =>
  j({ type: 'assistant', message: { id: messageId, role: 'assistant', content: [{ type: kind, text: 'x' }] } });
/** A time `ms` after 06:12:00Z on Oct 29 2026, as transcripts stamp it. */
const at = (ms: number) => new Date(Date.UTC(2026, 9, 29, 6, 12, 0) + ms).toISOString();
const stamped = (raw: string, ms: number) => JSON.stringify({ ...JSON.parse(raw), timestamp: at(ms) });
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

/**
 * The same question asked without a Stop: neither CLI fires a hook when Esc stops a turn
 * (no Claude Stop after 21 of 21 interrupts in AASC's database, 2.1.241–2.1.312; nothing
 * from Codex after 2 of 2), so the store reads it off the file as it is written. Codex
 * lines are copied from real 0.164 rollouts.
 */
describe('stoppedTurn', () => {
  const T = '01a17bdf-9218-7313-acf3-7e4317b6e95d';
  const T2 = '01a17bdf-eabd-7ef0-83d8-9cc7cf8f5540';
  const codex = (type: string, payload: Record<string, unknown> = {}) =>
    j({ timestamp: '2026-10-27T05:40:21.975Z', type: 'event_msg', payload: { type, ...payload } });
  const aborted = (turnId: string, reason = 'interrupted') =>
    codex('turn_aborted', { turn_id: turnId, reason, started_at: 1793079611, completed_at: 1793079621 });
  const reasoning = () => j({ timestamp: '2026-10-27T05:40:21.955Z', type: 'response_item', payload: { type: 'reasoning' } });

  it('Claude: Esc while it was writing stops the turn of that prompt', () => {
    expect(stoppedTurn([prompt(P), attachment(), assistant('thinking'), marker(P), snapshot()])).toEqual({ turnId: P, at: null });
  });

  it('Claude: a declined tool stops it too (Claude waits for input after one)', () => {
    const lines = [
      prompt(P), assistant('tool_use'),
      toolResult(P, { toolDenialKind: 'user-rejected' }),
      marker(P, '[Request interrupted by user for tool use]'),
    ];
    expect(stoppedTurn(lines)).toEqual({ turnId: P, at: null });
  });

  it('Claude: meta entries written after the marker are skipped', () => {
    const meta = j({ type: 'user', isMeta: true, promptId: P, message: { role: 'user', content: 'Caveat: local command output' } });
    expect(stoppedTurn([prompt(P), marker(P), meta])).toEqual({ turnId: P, at: null });
  });

  it('Claude: a turn that finished, or is still running, was not stopped', () => {
    expect(stoppedTurn([prompt(P), assistant('tool_use'), toolResult(P), assistant('text')])).toBeNull();
    expect(stoppedTurn([prompt(P), assistant('thinking')])).toBeNull();
  });

  it('REGRESSION GUARD: Claude writes the marker just before a prompt typed into a busy turn; that prompt runs', () => {
    // Real 2.1.312 order: the marker, then ~200 ms later the new prompt under the SAME promptId.
    const command = j({ type: 'user', promptId: P2, message: { role: 'user', content: '<command-message>update-feature-docs</command-message>' } });
    expect(stoppedTurn([prompt(P), assistant('text'), marker(P2), command])).toBeNull();
    // Read in between, the marker is newest, but nothing of its turn comes before it.
    expect(stoppedTurn([prompt(P), assistant('tool_use'), toolResult(P), assistant('text'), marker(P2)])).toBeNull();
    // Real 2.1.289 order: a typed prompt declines the tool, and the turn goes on with it.
    expect(stoppedTurn([
      prompt(P), assistant('tool_use'), toolResult(P, { toolDenialKind: 'user-rejected' }),
      marker(P, '[Request interrupted by user for tool use]'), prompt(P, 'fix this instead'),
    ])).toBeNull();
  });

  it('REGRESSION GUARD: Claude 2.1.286 writes a prompt typed into a busy turn, then the marker 3 ms later; that prompt runs', () => {
    // Real 6ef43d1a: "continue" at 22:57:20, the marker under its promptId 3 ms later, then the turn ran.
    expect(stoppedTurn([
      stamped(prompt(P), -60_000), assistant('text'),
      stamped(prompt(P2, 'continue'), 0), marker(P2, undefined, { timestamp: at(3) }),
    ])).toBeNull();
  });

  it('a stop half a second after its prompt is the user\'s (the quickest real one seen: 514 ms)', () => {
    expect(stoppedTurn([stamped(prompt(P), 0), marker(P, undefined, { timestamp: at(514) })]))
      .toEqual({ turnId: P, at: Date.parse(at(514)) });
  });

  it('REGRESSION GUARD: Claude 2.1.312 stamps the cut-off tool\'s result and the marker with the new prompt\'s id; the message it interrupted is the old turn\'s', () => {
    // Real 49ccf192: the new prompt's own entry follows ~270 ms later, after the watcher may have read.
    expect(stoppedTurn([
      prompt(P), reply('msg_old', 'tool_use'), toolResult(P2),
      marker(P2, undefined, { interruptedMessageId: 'msg_old' }),
    ])).toBeNull();
  });

  it('the message a real stop interrupted is its own turn\'s; one the tail does not hold decides nothing', () => {
    expect(stoppedTurn([prompt(P), reply('msg_p'), marker(P, undefined, { interruptedMessageId: 'msg_p' })]))
      .toEqual({ turnId: P, at: null });
    expect(stoppedTurn([prompt(P), assistant('thinking'), marker(P, undefined, { interruptedMessageId: 'msg_gone' })]))
      .toEqual({ turnId: P, at: null });
  });

  it('Claude: a shutdown and a subagent\'s own interruption are not the user stopping the turn', () => {
    expect(stoppedTurn([prompt(P), marker(P, undefined, { interruptedByShutdown: true })])).toBeNull();
    expect(stoppedTurn([prompt(P), assistant('tool_use'), marker(P, undefined, { isSidechain: true })])).toBeNull();
  });

  it('Claude: a marker without a promptId still counts, with no turn to match', () => {
    const bare = j({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } });
    expect(stoppedTurn([prompt(P), bare])).toEqual({ turnId: null, at: null });
  });

  it('Claude: Esc pressed twice, or a tail that starts inside the turn, still counts', () => {
    expect(stoppedTurn([prompt(P), assistant('thinking'), marker(P), marker(P)])).toEqual({ turnId: P, at: null });
    expect(stoppedTurn([assistant('thinking'), marker(P)])).toEqual({ turnId: P, at: null });
  });

  it('Codex: turn_aborted (interrupted) stops the turn it names, past the lines written after it', () => {
    const lines = [codex('task_started', { turn_id: T }), reasoning(), aborted(T), codex('token_count'), codex('thread_settings_applied')];
    expect(stoppedTurn(lines)).toEqual({ turnId: T, at: null });
  });

  it('Codex: a turn started after the abort, a finished turn, or one another turn replaced, was not stopped', () => {
    expect(stoppedTurn([aborted(T), codex('task_started', { turn_id: T2 }), reasoning()])).toBeNull();
    expect(stoppedTurn([codex('task_started', { turn_id: T }), reasoning(), codex('task_complete', { turn_id: T })])).toBeNull();
    expect(stoppedTurn([codex('task_started', { turn_id: T }), aborted(T, 'replaced')])).toBeNull();
  });

  it('tolerates junk and a half-written last line', () => {
    expect(stoppedTurn(['', 'not json', prompt(P), marker(P), '{"type":"user","promptId":"'])).toEqual({ turnId: P, at: null });
    expect(stoppedTurn(['{"type":"event_msg","payload":{"type":"turn_ab', aborted(T), '{"type":"event_'])).toEqual({ turnId: T, at: null });
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
