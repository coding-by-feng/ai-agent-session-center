// test/sessionModelIntegrity.test.ts — `session.model` must hold a model id, never
// a launch command.
//
// Regression guard: the connecting→idle auto-transition in createTerminalSession did
//   if (!command.startsWith('claude')) s.model = command;
// which stamped the WHOLE command into the model field for every non-Claude CLI —
// and clobbered a model the caller had just set. Live sessions ended up with
//   model = "/opt/homebrew/lib/node_modules/@openai/codex/…/bin/codex --dangerously-bypass-approvals-and-sandbox"
// which (a) rendered as a 3-line wall of path in the session card's model slot,
// overflowing the 230px left rail, (b) would be re-emitted as an unquoted
// `--model <whole command>` on fork/resume/clone, and (c) is silently DROPPED by
// buildSnapshot's `^[a-zA-Z0-9._-]+$` filter, losing the user's pinned model on
// workspace restore. The `startsWith('claude')` guard was also path-blind, so
// `/usr/local/bin/claude` got its model overwritten too.
import { describe, it, beforeEach, expect, vi } from 'vitest';
import { extractModelFromCommand } from '../server/config.js';

vi.mock('../server/db.js', () => ({
  upsertSession: vi.fn(),
  updateSessionTitle: vi.fn(),
  updateSessionSummary: vi.fn(),
  updateSessionRemark: vi.fn(),
  updateSessionArchived: vi.fn(),
  migrateSessionId: vi.fn(),
  getPromptsForSession: vi.fn(() => []),
  insertFullPrompt: vi.fn(),
}));

const { createTerminalSession, getSession } = await import('../server/sessionStore.js');

const CODEX_PATH_CMD =
  '/opt/homebrew/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex --dangerously-bypass-approvals-and-sandbox';

describe('extractModelFromCommand', () => {
  it('pulls the model id out of a --model flag', () => {
    expect(extractModelFromCommand('codex --model gpt-5.5 --yolo')).toBe('gpt-5.5');
    expect(extractModelFromCommand('claude --model claude-opus-5')).toBe('claude-opus-5');
  });

  it('accepts --model=<id> and the -m short form', () => {
    expect(extractModelFromCommand('codex --model=gpt-5.5')).toBe('gpt-5.5');
    expect(extractModelFromCommand('codex -m gpt-5.5')).toBe('gpt-5.5');
    expect(extractModelFromCommand('codex -m=gpt-5.5')).toBe('gpt-5.5');
  });

  it('unwraps a quoted value', () => {
    expect(extractModelFromCommand(`codex --model 'gpt-5.5'`)).toBe('gpt-5.5');
    expect(extractModelFromCommand('codex --model "gpt-5.5"')).toBe('gpt-5.5');
  });

  it('returns empty when the command carries no model flag', () => {
    expect(extractModelFromCommand(CODEX_PATH_CMD)).toBe('');
    expect(extractModelFromCommand('codex --dangerously-bypass-approvals-and-sandbox')).toBe('');
    expect(extractModelFromCommand('claude')).toBe('');
    expect(extractModelFromCommand('')).toBe('');
  });

  it('never returns a path or a following flag', () => {
    // The value must fail the safe-id charset rather than be handed on to an
    // unquoted --model flag.
    expect(extractModelFromCommand('codex --model /opt/homebrew/bin/codex')).toBe('');
    // `--model --yolo` means no model was supplied.
    expect(extractModelFromCommand('codex --model --yolo')).toBe('');
  });

  it('recovers a bracket-contaminated id per the sanitizeModelId contract', () => {
    expect(extractModelFromCommand('claude --model claude-opus-4-8[1m]')).toBe('claude-opus-4-8');
  });
});

describe('createTerminalSession — connecting→idle must not corrupt model', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  const settle = async () => {
    // Auto-idle fires at 3s (non-Claude/Codex) or 30s (Claude/Codex).
    await vi.advanceTimersByTimeAsync(31_000);
  };

  it('keeps the model the caller supplied for a Codex session', async () => {
    await createTerminalSession('model-int-1', {
      host: 'localhost',
      workingDir: '/tmp/model-integrity',
      command: CODEX_PATH_CMD,
      model: 'gpt-5.5',
    });
    await settle();
    expect(getSession('model-int-1')?.model).toBe('gpt-5.5');
  });

  it('never stores the launch command as the model', async () => {
    await createTerminalSession('model-int-2', {
      host: 'localhost',
      workingDir: '/tmp/model-integrity',
      command: CODEX_PATH_CMD,
    });
    await settle();
    const model = getSession('model-int-2')?.model ?? '';
    expect(model).not.toContain('/');
    expect(model).not.toContain(' ');
    expect(model).toBe('');
  });

  it('recovers a real model id from the command when the caller gave none', async () => {
    await createTerminalSession('model-int-3', {
      host: 'localhost',
      workingDir: '/tmp/model-integrity',
      command: 'codex --model gpt-5.5 --dangerously-bypass-approvals-and-sandbox',
    });
    await settle();
    expect(getSession('model-int-3')?.model).toBe('gpt-5.5');
  });

  it('does not overwrite the model for a path-qualified claude command', async () => {
    // `startsWith('claude')` missed this, so an absolute-path Claude launch was
    // treated as "some other CLI" and had its model replaced by the command.
    await createTerminalSession('model-int-4', {
      host: 'localhost',
      workingDir: '/tmp/model-integrity',
      command: '/usr/local/bin/claude --dangerously-skip-permissions',
      model: 'claude-opus-5',
    });
    await settle();
    expect(getSession('model-int-4')?.model).toBe('claude-opus-5');
  });
});
