// test/floatingSpawnerCli.test.ts — resolveOriginCli precedence
// Verifies the floating AI-popup spawner picks the SAME CLI as its parent
// session: cliSource (authoritative) > launch command > model id > 'claude'.
// Regression guard for codex parents being misdetected as claude.
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
vi.mock('../server/extractPreviousAnswer.js', () => ({
  readClaudeLastAssistant: vi.fn(),
  // Pre-existing dependency of spawnFloatingSession's resumeId resolution —
  // this suite only ever exercised resolveOriginCli (a pure function) before,
  // so this gap was latent until a test actually calls spawnFloatingSession.
  resolveResumableClaudeSessionId: vi.fn((id: string) => id),
}));
vi.mock('../server/config.js', () => ({
  reconstructPermissionFlags: (c: string) => c,
  // vi.fn (not a plain arrow) so tests can assert what model/effort it was
  // called with — identity passthrough for the command string.
  applyClaudeLaunchFlags: vi.fn((c: string) => c),
  sanitizeModelId: vi.fn((m: string | null | undefined) => m || undefined),
}));
vi.mock('../server/logger.js', () => ({ default: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { resolveOriginCli, spawnFloatingSession } from '../server/floatingSessionSpawner.js';
import { getSession } from '../server/sessionStore.js';
import { createTerminal } from '../server/sshManager.js';
import { applyClaudeLaunchFlags } from '../server/config.js';

type Origin = Parameters<typeof resolveOriginCli>[0];
const origin = (o: Partial<Origin>): Origin => o as Origin;

describe('resolveOriginCli — popup inherits the parent CLI', () => {
  it('prefers the authoritative cliSource over everything else', () => {
    expect(resolveOriginCli(origin({ cliSource: 'codex' }))).toBe('codex');
    expect(resolveOriginCli(origin({ cliSource: 'claude' }))).toBe('claude');
  });

  it('cliSource wins even when the command/model would say otherwise', () => {
    // The real-world bug: sshCommand defaults to "claude" but cli_source is codex.
    expect(
      resolveOriginCli(origin({ cliSource: 'codex', sshCommand: 'claude', model: 'gpt-5' })),
    ).toBe('codex');
  });

  it('is case-insensitive on cliSource', () => {
    expect(resolveOriginCli(origin({ cliSource: 'Codex' }))).toBe('codex');
    expect(resolveOriginCli(origin({ cliSource: 'CODEX' }))).toBe('codex');
  });

  it('falls back to the launch command when cliSource is absent', () => {
    expect(resolveOriginCli(origin({ startupCommand: 'codex --yolo' }))).toBe('codex');
    expect(resolveOriginCli(origin({ startupCommand: 'claude' }))).toBe('claude');
    // tolerates a leading path
    expect(resolveOriginCli(origin({ startupCommand: '/usr/local/bin/codex' }))).toBe('codex');
  });

  it('honours the command precedence order startupCommand → sshCommand → sshConfig.command', () => {
    expect(resolveOriginCli(origin({ sshCommand: 'codex' }))).toBe('codex');
    expect(resolveOriginCli(origin({ sshConfig: { username: 'x', workingDir: '~', command: 'codex' } as Origin['sshConfig'] }))).toBe('codex');
  });

  it('an explicit launch command outranks the model id (matches src/lib/cliDetect.ts precedence)', () => {
    // A real codex session carries cliSource, so this only governs the
    // no-cliSource fallback: command is a stronger signal than model.
    expect(resolveOriginCli(origin({ startupCommand: 'codex', model: 'claude-opus-4-8' }))).toBe('codex');
    expect(resolveOriginCli(origin({ startupCommand: 'claude', model: 'gpt-5' }))).toBe('claude');
  });

  it('falls back to the model id when neither cliSource nor command match', () => {
    expect(resolveOriginCli(origin({ model: 'gpt-5-codex' }))).toBe('codex');
    expect(resolveOriginCli(origin({ model: 'claude-opus-4-8' }))).toBe('claude');
    expect(resolveOriginCli(origin({ model: 'o3-mini' }))).toBe('codex');
  });

  it('defaults to claude when nothing is identifiable', () => {
    expect(resolveOriginCli(origin({}))).toBe('claude');
    expect(resolveOriginCli(origin({ cliSource: 'mystery-cli', startupCommand: 'node foo.js' }))).toBe('claude');
  });
});

describe('spawnFloatingSession — quick-settings model/effort override', () => {
  // SelectionPopup's Model/Effort row: args.model/args.effortLevel override the
  // origin session's own model/effort; blank/absent falls back to inheriting
  // them (the pre-existing behavior). Precedence lives at the top of
  // spawnFloatingSession as effectiveModel/effectiveEffort.
  function fakeOrigin(fields: Record<string, unknown> = {}) {
    return {
      sessionId: 'o1',
      cliSource: 'claude',
      model: 'origin-model',
      effortLevel: 'origin-effort',
      projectPath: '/tmp/proj',
      promptHistory: [],
      ...fields,
    };
  }

  beforeEach(() => {
    vi.mocked(getSession).mockReset();
    vi.mocked(createTerminal).mockReset().mockResolvedValue('term-fake-1');
    vi.mocked(applyClaudeLaunchFlags).mockClear();
  });

  it('an override in args wins over the origin session\'s own model/effort', async () => {
    vi.mocked(getSession).mockReturnValue(fakeOrigin());

    await spawnFloatingSession({
      originSessionId: 'o1',
      mode: 'custom',
      customPrompt: 'refactor this',
      selection: 'const x = 1',
      nativeLanguage: 'en',
      learningLanguage: 'en',
      model: 'override-model',
      effortLevel: 'override-effort',
    });

    expect(applyClaudeLaunchFlags).toHaveBeenCalledWith(
      expect.any(String),
      'override-model',
      'override-effort',
    );
  });

  it('blank/absent override inherits the origin session\'s own model/effort (unchanged default)', async () => {
    vi.mocked(getSession).mockReturnValue(fakeOrigin());

    await spawnFloatingSession({
      originSessionId: 'o1',
      mode: 'custom',
      customPrompt: 'refactor this',
      selection: 'const x = 1',
      nativeLanguage: 'en',
      learningLanguage: 'en',
      // model/effortLevel omitted — same as a blank quick-settings row.
    });

    expect(applyClaudeLaunchFlags).toHaveBeenCalledWith(
      expect.any(String),
      'origin-model',
      'origin-effort',
    );
  });

  it('an empty-string override does not shadow the inherited value (falsy, not "chosen blank")', async () => {
    vi.mocked(getSession).mockReturnValue(fakeOrigin());

    await spawnFloatingSession({
      originSessionId: 'o1',
      mode: 'custom',
      customPrompt: 'refactor this',
      selection: 'const x = 1',
      nativeLanguage: 'en',
      learningLanguage: 'en',
      model: '',
      effortLevel: '',
    });

    expect(applyClaudeLaunchFlags).toHaveBeenCalledWith(
      expect.any(String),
      'origin-model',
      'origin-effort',
    );
  });
});
