/**
 * hooks/opencode-plugin/server.js — the OpenCode 2.x plugin's translator, fed the events and hook payloads
 * OpenCode 2.3.2 sent in tmux probes (Nov 23 2026). No OpenCode runs here.
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error plain JS module shipped to OpenCode as-is
import { createRelay, readHost, toolName, toolInput } from '../hooks/opencode-plugin/server.js';

const SES = 'ses_df83e11abffetyKHwFK5Q4KwCR';
const host = { pid: 50475, tty: '/dev/ttys120', command: 'opencode --standalone --auto' };

function relay(extra: Record<string, unknown> = {}) {
  const lines: Record<string, unknown>[] = [];
  const r = createRelay({ host, emit: (o: Record<string, unknown>) => lines.push(o), now: () => 1000, lite: false, terminalId: 'term-1', ...extra });
  return { r, lines };
}

describe('opencode plugin relay', () => {
  it('turns a probed turn into SessionStart → prompt → tools → Stop for the TUI’s pid and tty', () => {
    const { r, lines } = relay();
    r.onEvent({ type: 'session.created', data: { sessionID: SES, location: { directory: '/work/app' }, model: { id: 'deepseek' } } });
    r.onPrompt({ sessionID: SES, prompt: { text: 'Run ls' }, delivery: 'steer' });
    r.onEvent({ type: 'session.execution.started', data: { sessionID: SES } });
    r.onToolBefore({ tool: 'shell', sessionID: SES, input: { command: 'ls -la .' } });
    r.onToolAfter({ tool: 'shell', sessionID: SES, status: 'completed' });
    r.onEvent({ type: 'session.text.ended', data: { sessionID: SES, text: 'DONE' } });
    r.onEvent({ type: 'session.execution.succeeded', data: { sessionID: SES } });

    expect(lines.map((l) => l.hook_event_name)).toEqual(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']);
    for (const l of lines) {
      expect(l).toMatchObject({ session_id: SES, cli_source: 'opencode', claude_pid: 50475, tty_path: '/dev/ttys120', agent_terminal_id: 'term-1', cwd: '/work/app', permission_mode: 'auto' });
    }
    expect(lines[0]).toMatchObject({ startup_command: 'opencode --standalone --auto', model: 'deepseek' });
    expect(lines[1]).toMatchObject({ prompt: 'Run ls' });
    expect(lines[2]).toMatchObject({ tool_name: 'Bash', tool_input: { command: 'ls -la .' }, agent_tool: 'shell' });
    expect(lines[4]).toMatchObject({ response: 'DONE', stop_reason: 'end_turn' });
  });

  it('starts a resumed session (no session.created) on its first event', () => {
    const { r, lines } = relay();
    r.onPrompt({ sessionID: SES, prompt: { text: 'hi' } });
    expect(lines.map((l) => l.hook_event_name)).toEqual(['SessionStart', 'UserPromptSubmit']);
  });

  it('reports a permission dialog and an Esc / failure as the end of the turn', () => {
    const { r, lines } = relay();
    r.onEvent({ type: 'session.created', data: { sessionID: SES } });
    r.onEvent({ type: 'permission.asked', data: { id: 'per_1', sessionID: SES, action: 'shell', resources: ['echo hello'] } });
    r.onEvent({ type: 'session.execution.interrupted', data: { sessionID: SES } });
    r.onEvent({ type: 'session.execution.failed', data: { sessionID: SES, error: { type: 'provider.auth', message: 'HTTP 403' } } });
    expect(lines.slice(1).map((l) => [l.hook_event_name, l.stop_reason ?? l.tool_name])).toEqual([
      ['PermissionRequest', 'Bash'], ['Stop', 'USER_CANCELED'], ['Stop', 'ERROR'],
    ]);
    expect(lines[1]).toMatchObject({ tool_input: { command: 'echo hello' } });
    expect(lines[3]).toMatchObject({ error: 'HTTP 403' });
  });

  it('never lets a subagent’s session take the card', () => {
    const { r, lines } = relay();
    r.onEvent({ type: 'session.created', data: { sessionID: SES } });
    r.onEvent({ type: 'session.execution.started', data: { sessionID: SES } });
    r.onEvent({ type: 'session.created', data: { sessionID: 'ses_child0000001' } });
    r.onEvent({ type: 'session.created', data: { sessionID: 'ses_child0000002', parentID: SES } });
    r.onToolBefore({ tool: 'read', sessionID: 'ses_child0000001', input: { filePath: '/a' } });
    r.onPrompt({ sessionID: 'ses_child0000002', prompt: { text: 'sub task' } });
    r.onEvent({ type: 'session.execution.succeeded', data: { sessionID: 'ses_child0000001' } });
    expect(lines.map((l) => l.session_id)).toEqual([SES]);
  });

  it('sends no tool events for a lite (Automation) session, and ends every started session on shutdown', () => {
    const { r, lines } = relay({ lite: true });
    r.onPrompt({ sessionID: SES, prompt: { text: 'x' } });
    r.onToolBefore({ tool: 'shell', sessionID: SES, input: {} });
    r.onToolAfter({ tool: 'shell', sessionID: SES, status: 'completed' });
    r.onShutdown();
    expect(lines.map((l) => l.hook_event_name)).toEqual(['SessionStart', 'UserPromptSubmit', 'SessionEnd']);
  });

  it('maps tool names and inputs', () => {
    expect(toolName('read')).toBe('Read');
    expect(toolName('subagent')).toBe('Task');
    expect(toolName('custom_tool')).toBe('custom_tool');
    expect(toolInput('read', { filePath: '/x.ts' })).toEqual({ file_path: '/x.ts' });
    expect(toolInput('grep', { pattern: 'foo' })).toEqual({ pattern: 'foo' });
  });

  describe('readHost', () => {
    const ps = (out: Record<string, string>) => (args: string[]) => out[args[1]] ?? '';
    it('binds to the TUI that started this standalone server', () => {
      expect(readHost(50475, ps({ 'args=': 'opencode --standalone\n', 'tty=': 'ttys120\n' })))
        .toEqual({ pid: 50475, tty: '/dev/ttys120', command: 'opencode --standalone' });
    });
    it('reports nothing on the shared background server or under a non-TUI parent', () => {
      expect(readHost(1, ps({}))).toBeNull();
      expect(readHost(0, ps({}))).toBeNull();
      expect(readHost(77, ps({ 'args=': '/bin/zsh -l' }))).toBeNull();
      expect(readHost(78, ps({ 'args=': 'opencode serve --service' }))).toBeNull();
    });
  });
});
