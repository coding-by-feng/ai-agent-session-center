/**
 * stopHooksState (Nov 6 2026): Claude holds a prompt typed while its Stop hooks still run
 * (claude-mem's summarize hook: median 2.4 s, p90 39 s, max 124 s) and writes nothing about it
 * until they finish. AASC hears Stop from the first hook, so the card said "ready" while a
 * prompt sent then sat unseen. `stopHooksSince` marks that window; the transcript ends it.
 */
import { describe, it, expect } from 'vitest';
import { nextStopHooksSince, stopHooksSettled } from '../server/stopHooksState.js';

const NOW = 1_800_000_000_000;
const line = (o: object): string => JSON.stringify(o);
const prompt = line({ type: 'user', message: { role: 'user', content: 'build it' }, promptId: 'p1' });
const answer = line({ type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.' }] } });
const toolCall = line({ type: 'assistant', message: { stop_reason: 'tool_use', content: [] } });
const summary = line({ type: 'system', subtype: 'stop_hook_summary', hookCount: 5, hookErrors: [], preventedContinuation: false });
const hookOk = line({ type: 'attachment', attachment: { type: 'hook_success', hookName: 'Stop', hookEvent: 'Stop' } });
const blocked = line({ type: 'attachment', attachment: { type: 'hook_blocking_error', hookName: 'Stop', hookEvent: 'Stop' } });
const feedback = line({ type: 'user', isMeta: true, message: { role: 'user', content: 'Stop hook feedback:\nRun /update-feature-docs' } });
const sideAnswer = line({ type: 'assistant', isSidechain: true, message: { stop_reason: 'end_turn', content: [] } });
const turnDuration = line({ type: 'system', subtype: 'turn_duration', durationMs: 1200 });

describe('stopHooksSettled', () => {
  it('is false while the Stop hooks still run (answer written, no summary yet)', () => {
    expect(stopHooksSettled([prompt, answer, hookOk])).toBe(false);
  });

  it('is true once the summary follows the answer', () => {
    expect(stopHooksSettled([prompt, answer, hookOk, summary])).toBe(true);
    expect(stopHooksSettled([prompt, answer, summary, turnDuration])).toBe(true);
  });

  it('ignores the previous turn\'s summary', () => {
    expect(stopHooksSettled([summary, prompt, toolCall, answer])).toBe(false);
  });

  it('is false when a Stop hook blocked: Claude keeps working on its feedback', () => {
    expect(stopHooksSettled([prompt, answer, feedback, blocked, summary])).toBe(false);
  });

  it('is false again once the blocked turn goes on past the summary', () => {
    expect(stopHooksSettled([prompt, answer, feedback, blocked, summary, toolCall])).toBe(false);
  });

  it('ignores a subagent\'s sidechain entries', () => {
    expect(stopHooksSettled([prompt, answer, summary, sideAnswer])).toBe(true);
  });

  it('with no answer in the tail, says only whether a summary is there', () => {
    // A reply longer than the tail, then the summary: done.
    expect(stopHooksSettled([summary])).toBe(true);
    // Prompts queued during the hold write huge queue-operation lines that push the answer
    // out of the tail while Claude still holds them: not done (review, Nov 6 2026).
    const queued = line({ type: 'queue-operation', operation: 'enqueue', content: 'x'.repeat(70_000) });
    expect(stopHooksSettled([queued, hookOk])).toBe(false);
    expect(stopHooksSettled([])).toBe(false);
  });

  it('skips torn and foreign lines', () => {
    expect(stopHooksSettled([prompt, answer, '{"type":"assis', 'not json', summary])).toBe(true);
  });
});

describe('nextStopHooksSince', () => {
  it('starts at a Claude Stop', () => {
    expect(nextStopHooksSince(null, 'Stop', 'claude', NOW)).toBe(NOW);
  });

  it('never starts for Codex, whose rollout has no hook summary', () => {
    expect(nextStopHooksSince(null, 'Stop', 'codex', NOW)).toBeNull();
  });

  it('ends at the next turn event', () => {
    for (const event of ['UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'SessionStart', 'SessionEnd', 'PreCompact']) {
      expect(nextStopHooksSince(NOW - 5000, event, 'claude', NOW)).toBeNull();
    }
  });

  it('is kept through events that do not end it', () => {
    for (const event of ['SubagentStop', 'Notification', 'PostToolUse']) {
      expect(nextStopHooksSince(NOW - 5000, event, 'claude', NOW)).toBe(NOW - 5000);
    }
  });
});
