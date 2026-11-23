/**
 * hooks/dashboard-hook-agy.sh — the Antigravity CLI relay, fed payloads shaped like the ones agy 1.5.14 sent in a
 * probe (Nov 23 2026). It writes to a scratch queue (AASC_HOOK_MQ_DIR), never the live one, and spawns no agent.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const SCRIPT = join(__dirname, '..', 'hooks', 'dashboard-hook-agy.sh');
const CONV = 'd291a3f2-c43a-4537-a7e8-3a1033272cef';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'agy-relay-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function run(event: string, payload: Record<string, unknown>, env: Record<string, string> = {}): string {
  return execFileSync('bash', [SCRIPT, event], {
    input: JSON.stringify(payload),
    env: { ...process.env, AASC_HOOK_MQ_DIR: dir, AGENT_MANAGER_TERMINAL_ID: 'term-test-1', AASC_HOOK_LEVEL: '', ...env },
    encoding: 'utf8',
  });
}

async function queued(count: number): Promise<Record<string, unknown>[]> {
  const file = join(dir, 'queue.jsonl');
  for (let i = 0; i < 100; i += 1) {
    if (existsSync(file)) {
      const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
      if (lines.length >= count) return lines.map((l) => JSON.parse(l));
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
}

const common = { conversationId: CONV, cwd: '/work/app', workspacePaths: ['/work/app'], modelName: 'gemini-3.8-flash-high', lastUserInput: 'fix the test' };

describe('dashboard-hook-agy.sh', () => {
  it('answers PreToolUse with nothing (a `{}` denies the tool) and every other event with `{}`', () => {
    expect(run('PreToolUse', { ...common, hookEventName: 'PreToolUse', toolCall: { id: 't1', name: 'run_command', args: { CommandLine: 'ls' } } })).toBe('');
    expect(run('SessionStart', { ...common, hookEventName: 'SessionStart' }).trim()).toBe('{}');
    expect(run('Stop', { ...common, hookEventName: 'Stop', terminationReason: 'NO_TOOL_CALL' }).trim()).toBe('{}');
    expect(run('PostInvocation', { ...common, invocationNum: 0 }).trim()).toBe('{}');
  });

  it('maps a turn onto the Claude events the server knows, tagged antigravity', async () => {
    run('SessionStart', { ...common, hookEventName: 'SessionStart' });
    await queued(1);
    run('PreInvocation', { ...common, hookEventName: 'PreInvocation', invocationNum: 0, initialNumSteps: 1 });
    await queued(2);
    run('PreToolUse', { ...common, hookEventName: 'PreToolUse', stepIdx: 2, toolCall: { id: 't1', name: 'run_command', args: { CommandLine: 'npm test' } } });
    await queued(3);
    run('PostToolUse', { ...common, hookEventName: 'PostToolUse', stepIdx: 2, toolCall: { id: 't1', name: 'run_command', args: { CommandLine: 'npm test' } }, error: 'exit status 1' });
    await queued(4);
    run('PreToolUse', { ...common, hookEventName: 'PreToolUse', toolCall: { id: 't2', name: 'view_file', args: { AbsolutePath: '/work/app/a.ts' } } });
    const events = await queued(5);

    expect(events.map((e) => e.hook_event_name)).toEqual(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUseFailure', 'PreToolUse']);
    for (const e of events) {
      expect(e).toMatchObject({ session_id: CONV, cli_source: 'antigravity', cwd: '/work/app', agent_terminal_id: 'term-test-1' });
      expect(e).not.toHaveProperty('transcript_path');
    }
    expect(events[1]).toMatchObject({ prompt: 'fix the test' });
    expect(events[2]).toMatchObject({ tool_name: 'Bash', tool_input: { command: 'npm test' }, agent_tool: 'run_command' });
    expect(events[3]).toMatchObject({ tool_name: 'Bash', error: 'exit status 1' });
    expect(events[4]).toMatchObject({ tool_name: 'Read', tool_input: { file_path: '/work/app/a.ts' } });
  });

  it('drops the later model calls of a turn: only invocationNum 0 is the prompt', async () => {
    run('PreInvocation', { ...common, invocationNum: 1, initialNumSteps: 3 });
    run('PostInvocation', { ...common, invocationNum: 0 });
    run('PreInvocation', { ...common, invocationNum: 0, initialNumSteps: 5 });
    const events = await queued(1);
    await new Promise((r) => setTimeout(r, 300));
    expect(events).toHaveLength(1);
    expect(events[0].hook_event_name).toBe('UserPromptSubmit');
  });

  it('reads the reply for Stop from the transcript’s last model text', async () => {
    const transcript = join(dir, 'transcript_full.jsonl');
    writeFileSync(transcript, [
      { type: 'USER_INPUT', source: 'USER_EXPLICIT', content: '<USER_REQUEST>x</USER_REQUEST>' },
      { type: 'PLANNER_RESPONSE', source: 'MODEL', content: null },
      { type: 'GENERIC', source: 'MODEL', content: 'ran ls' },
      { type: 'PLANNER_RESPONSE', source: 'MODEL', content: 'All tests pass.' },
    ].map((l) => JSON.stringify(l)).join('\n') + '\n');
    run('Stop', { ...common, hookEventName: 'Stop', transcriptPath: transcript, terminationReason: 'USER_CANCELED', executionNum: 0 });
    const [stop] = await queued(1);
    expect(stop).toMatchObject({ hook_event_name: 'Stop', response: 'All tests pass.', stop_reason: 'USER_CANCELED', agent_transcript_path: transcript });
  });

  it('sends only lifecycle events for a lite (Automation) session', async () => {
    const env = { AASC_HOOK_LEVEL: 'lite' };
    run('PreToolUse', { ...common, toolCall: { id: 't', name: 'run_command', args: {} } }, env);
    run('PostToolUse', { ...common, toolCall: { id: 't', name: 'run_command', args: {} } }, env);
    run('Stop', { ...common, terminationReason: 'NO_TOOL_CALL' }, env);
    const events = await queued(1);
    await new Promise((r) => setTimeout(r, 300));
    expect(events.map((e) => e.hook_event_name)).toEqual(['Stop']);
  });

  it('writes nothing for a payload with no conversation id', async () => {
    run('SessionStart', { cwd: '/x' });
    await new Promise((r) => setTimeout(r, 400));
    expect(existsSync(join(dir, 'queue.jsonl'))).toBe(false);
  });
});
