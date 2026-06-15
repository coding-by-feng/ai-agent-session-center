// test/floatingSpawnerCli.test.ts — resolveOriginCli precedence
// Verifies the floating AI-popup spawner picks the SAME CLI as its parent
// session: cliSource (authoritative) > launch command > model id > 'claude'.
// Regression guard for codex/gemini parents being misdetected as claude.
import { describe, it, expect, vi } from 'vitest';

// The spawner pulls in DB-backed modules at import time; stub them so the unit
// under test (a pure function) loads without side effects.
vi.mock('../server/sessionStore.js', () => ({
  getSession: vi.fn(),
  getSessionByTerminalId: vi.fn(),
  createTerminalSession: vi.fn(),
}));
vi.mock('../server/sshManager.js', () => ({
  createTerminal: vi.fn(),
  consumePendingLink: vi.fn(),
  writeWhenReady: vi.fn(),
  injectClaudeCommandsWhenReady: vi.fn(),
}));
vi.mock('../server/extractPreviousAnswer.js', () => ({ readClaudeLastAssistant: vi.fn() }));
vi.mock('../server/config.js', () => ({
  reconstructPermissionFlags: (c: string) => c,
  applyClaudeLaunchFlags: (c: string) => c,
}));
vi.mock('../server/logger.js', () => ({ default: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { resolveOriginCli } from '../server/floatingSessionSpawner.js';

type Origin = Parameters<typeof resolveOriginCli>[0];
const origin = (o: Partial<Origin>): Origin => o as Origin;

describe('resolveOriginCli — popup inherits the parent CLI', () => {
  it('prefers the authoritative cliSource over everything else', () => {
    expect(resolveOriginCli(origin({ cliSource: 'codex' }))).toBe('codex');
    expect(resolveOriginCli(origin({ cliSource: 'gemini' }))).toBe('gemini');
    expect(resolveOriginCli(origin({ cliSource: 'claude' }))).toBe('claude');
  });

  it('cliSource wins even when the command/model would say otherwise', () => {
    // The real-world bug: sshCommand defaults to "claude" but cli_source is codex.
    expect(
      resolveOriginCli(origin({ cliSource: 'codex', sshCommand: 'claude', model: 'gpt-5' })),
    ).toBe('codex');
    expect(
      resolveOriginCli(origin({ cliSource: 'gemini', sshCommand: 'claude' })),
    ).toBe('gemini');
  });

  it('is case-insensitive on cliSource', () => {
    expect(resolveOriginCli(origin({ cliSource: 'Codex' }))).toBe('codex');
    expect(resolveOriginCli(origin({ cliSource: 'GEMINI' }))).toBe('gemini');
  });

  it('falls back to the launch command when cliSource is absent', () => {
    expect(resolveOriginCli(origin({ startupCommand: 'codex --yolo' }))).toBe('codex');
    expect(resolveOriginCli(origin({ startupCommand: 'gemini -p hi' }))).toBe('gemini');
    expect(resolveOriginCli(origin({ startupCommand: 'claude' }))).toBe('claude');
    // tolerates a leading path
    expect(resolveOriginCli(origin({ startupCommand: '/usr/local/bin/codex' }))).toBe('codex');
  });

  it('honours the command precedence order startupCommand → sshCommand → sshConfig.command', () => {
    expect(resolveOriginCli(origin({ sshCommand: 'gemini' }))).toBe('gemini');
    expect(resolveOriginCli(origin({ sshConfig: { username: 'x', workingDir: '~', command: 'codex' } as Origin['sshConfig'] }))).toBe('codex');
  });

  it('an explicit launch command outranks the model id (matches src/lib/cliDetect.ts precedence)', () => {
    // A real codex/gemini session carries cliSource, so this only governs the
    // no-cliSource fallback: command is a stronger signal than model.
    expect(resolveOriginCli(origin({ startupCommand: 'codex', model: 'claude-opus-4-8' }))).toBe('codex');
    expect(resolveOriginCli(origin({ startupCommand: 'gemini', model: 'gpt-5' }))).toBe('gemini');
  });

  it('falls back to the model id when neither cliSource nor command match', () => {
    expect(resolveOriginCli(origin({ model: 'gpt-5-codex' }))).toBe('codex');
    expect(resolveOriginCli(origin({ model: 'gemini-2.5-pro' }))).toBe('gemini');
    expect(resolveOriginCli(origin({ model: 'claude-opus-4-8' }))).toBe('claude');
    expect(resolveOriginCli(origin({ model: 'o3-mini' }))).toBe('codex');
  });

  it('defaults to claude when nothing is identifiable', () => {
    expect(resolveOriginCli(origin({}))).toBe('claude');
    expect(resolveOriginCli(origin({ cliSource: 'mystery-cli', startupCommand: 'node foo.js' }))).toBe('claude');
  });
});
