// test/chatFixtures.ts — synthetic Claude transcript and Codex rollout records for the chat and changes
// tests (AASC-41, AASC-44). Same structure as the CLIs' files, invented content: nothing is copied from a
// real transcript.
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const T0 = Date.parse('2026-10-15T10:00:00.000Z');
let tick = 0;
/** An ISO time a second after the last one handed out. */
export const at = (): string => new Date(T0 + 1000 * tick++).toISOString();

// ── Claude ───────────────────────────────────────────────────────────────────

type Block = Record<string, unknown>;

export const claude = {
  user: (content: string | Block[], extra: Record<string, unknown> = {}) =>
    ({ type: 'user', timestamp: at(), sessionId: 's', message: { role: 'user', content }, ...extra }),
  assistant: (content: string | Block[], extra: Record<string, unknown> = {}) =>
    ({ type: 'assistant', timestamp: at(), sessionId: 's', message: { role: 'assistant', model: 'claude-opus-5-5', content }, ...extra }),
  system: (subtype: string, extra: Record<string, unknown> = {}) =>
    ({ type: 'system', subtype, timestamp: at(), sessionId: 's', ...extra }),
  text: (text: string): Block => ({ type: 'text', text }),
  thinking: (thinking: string): Block => ({ type: 'thinking', thinking, signature: 'sig' }),
  toolUse: (id: string, name: string, input: unknown): Block => ({ type: 'tool_use', id, name, input }),
  toolResult: (toolUseId: string, content: unknown, isError = false): Block =>
    ({ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }),
  /** One assistant record calling one tool. */
  call: (id: string, name: string, input: unknown) => claude.assistant([claude.toolUse(id, name, input)]),
  /** One user record answering one tool. */
  result: (id: string, content: unknown, isError = false) => claude.user([claude.toolResult(id, content, isError)]),
};

// ── Codex ────────────────────────────────────────────────────────────────────

const item = (payload: Record<string, unknown>) => ({ timestamp: at(), type: 'response_item', payload });
const event = (payload: Record<string, unknown>) => ({ timestamp: at(), type: 'event_msg', payload });

export const codex = {
  meta: (id = '01a1288a-2ace-70c2-95a6-0b63700796e5') =>
    ({ timestamp: at(), type: 'session_meta', payload: { id, cwd: '/proj', cli_version: '1.0.0', base_instructions: { text: 'x' } } }),
  turnContext: (model: string, effort: string) =>
    ({ timestamp: at(), type: 'turn_context', payload: { model, effort, cwd: '/proj', approval_policy: 'never' } }),
  user: (...texts: string[]) =>
    item({ type: 'message', role: 'user', content: texts.map((text) => ({ type: 'input_text', text })) }),
  userBlocks: (content: Block[]) => item({ type: 'message', role: 'user', content }),
  developer: (text: string) => item({ type: 'message', role: 'developer', content: [{ type: 'input_text', text }] }),
  assistant: (text: string, phase = 'final_answer') =>
    item({ type: 'message', role: 'assistant', phase, content: [{ type: 'output_text', text }] }),
  reasoning: (summary: string[] = []) =>
    item({ type: 'reasoning', summary: summary.map((text) => ({ type: 'summary_text', text })), encrypted_content: 'enc' }),
  functionCall: (callId: string, name: string, args: unknown) =>
    item({ type: 'function_call', call_id: callId, name, arguments: typeof args === 'string' ? args : JSON.stringify(args) }),
  functionOutput: (callId: string, output: unknown) => item({ type: 'function_call_output', call_id: callId, output }),
  customCall: (callId: string, name: string, input: string) =>
    item({ type: 'custom_tool_call', call_id: callId, name, input, status: 'completed' }),
  customOutput: (callId: string, output: unknown) => item({ type: 'custom_tool_call_output', call_id: callId, output }),
  compacted: () => ({ timestamp: at(), type: 'compacted', payload: { message: '', replacement_history: [] } }),
  aborted: () => event({ type: 'turn_aborted', reason: 'interrupted' }),
  tokenCount: () => event({ type: 'token_count', info: null }),
  userEcho: (text: string) => event({ type: 'item_completed', item: { type: 'UserMessage', id: 'u', content: [{ type: 'text', text }] } }),
  fileChange: (id: string, changes: Record<string, Record<string, unknown>>, status = 'completed') =>
    event({ type: 'item_completed', item: { type: 'FileChange', id, changes, status, stdout: 'Success', stderr: '' } }),
};

// ── Files ────────────────────────────────────────────────────────────────────

export const jsonl = (records: unknown[]): string => records.map((r) => `${JSON.stringify(r)}\n`).join('');

export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function writeJsonl(file: string, records: unknown[]): string {
  writeFileSync(file, jsonl(records));
  return file;
}

export function appendJsonl(file: string, records: unknown[]): void {
  appendFileSync(file, jsonl(records));
}
