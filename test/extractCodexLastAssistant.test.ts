// test/extractCodexLastAssistant.test.ts — readCodexLastAssistant: the previous answer a ✦ translate-answer popup
// reads off a Codex rollout (Oct 30 2026; before it, translate-answer refused every Codex card).
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCodexLastAssistant } from '../server/extractPreviousAnswer.js';

let dir = '';
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ''; });

function rollout(records: unknown[]): string {
  dir = mkdtempSync(join(tmpdir(), 'codex-last-'));
  const file = join(dir, 'rollout.jsonl');
  writeFileSync(file, records.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n');
  return file;
}

const assistant = (...texts: string[]) => ({
  type: 'response_item',
  payload: { type: 'message', role: 'assistant', content: texts.map((text) => ({ type: 'output_text', text })) },
});
const user = (text: string) => ({
  type: 'response_item',
  payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
});

describe('readCodexLastAssistant', () => {
  it('returns the newest assistant message, its text blocks joined', () => {
    const file = rollout([user('first'), assistant('old answer'), user('second'), assistant('new', 'answer'),
      { type: 'event_msg', payload: { type: 'token_count' } }]);
    expect(readCodexLastAssistant(file)).toBe('new\nanswer');
  });

  it('skips torn lines and tool calls after the answer', () => {
    const file = rollout([assistant('the answer'), '{"type":"respo',
      { type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{}' } }]);
    expect(readCodexLastAssistant(file)).toBe('the answer');
  });

  it('falls back to the agent_message event when there is no response item', () => {
    const file = rollout([{ type: 'event_msg', payload: { type: 'agent_message', message: 'from the event' } }]);
    expect(readCodexLastAssistant(file)).toBe('from the event');
  });

  it('is null for a missing file or one with no answer', () => {
    expect(readCodexLastAssistant('/nonexistent/rollout.jsonl')).toBeNull();
    expect(readCodexLastAssistant(rollout([user('only a question')]))).toBeNull();
  });
});
