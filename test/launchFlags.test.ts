import { describe, it, expect } from 'vitest';
import {
  applyClaudeLaunchFlags,
  appendSessionName,
  sanitizeModelId,
  sanitizeModelInCommand,
} from '../server/config.js';

describe('applyClaudeLaunchFlags', () => {
  const base = 'claude --dangerously-skip-permissions';

  it('attaches --model when a model is given', () => {
    expect(applyClaudeLaunchFlags(base, 'opus', undefined)).toBe(
      'claude --model opus --dangerously-skip-permissions',
    );
  });

  it('attaches a standard --effort level', () => {
    expect(applyClaudeLaunchFlags(base, undefined, 'high')).toBe(
      'claude --effort high --dangerously-skip-permissions',
    );
  });

  it('attaches both --model and --effort together', () => {
    expect(applyClaudeLaunchFlags(base, 'opus', 'max')).toBe(
      'claude --model opus --effort max --dangerously-skip-permissions',
    );
  });

  it('maps ultracode to --effort xhigh (the valid base level)', () => {
    expect(applyClaudeLaunchFlags(base, 'opus', 'ultracode')).toBe(
      'claude --model opus --effort xhigh --dangerously-skip-permissions',
    );
  });

  it('keeps the session name when flags are applied', () => {
    const withName = appendSessionName(base, 'AASC');
    expect(applyClaudeLaunchFlags(withName, 'opus', 'ultracode')).toBe(
      'claude --model opus --effort xhigh --dangerously-skip-permissions -n "AASC"',
    );
  });

  it('does not duplicate flags already present in the command', () => {
    const cmd = 'claude --model sonnet --effort low';
    expect(applyClaudeLaunchFlags(cmd, 'opus', 'high')).toBe(cmd);
  });

  it('attaches a Codex model before subcommands and ignores Claude effort', () => {
    expect(applyClaudeLaunchFlags('codex resume --last', 'gpt-newest', 'ultracode')).toBe(
      'codex --model gpt-newest resume --last',
    );
  });

  it('supports path-qualified Codex commands', () => {
    expect(applyClaudeLaunchFlags('/opt/homebrew/bin/codex --search', 'gpt-fast', undefined)).toBe(
      '/opt/homebrew/bin/codex --model gpt-fast --search',
    );
  });

  it('does not override an existing Codex --model or -m flag', () => {
    expect(applyClaudeLaunchFlags('codex --model pinned', 'gpt-newest', undefined)).toBe(
      'codex --model pinned',
    );
    expect(applyClaudeLaunchFlags('codex -m pinned', 'gpt-newest', undefined)).toBe(
      'codex -m pinned',
    );
  });

  it('leaves unsupported CLI commands untouched', () => {
    expect(applyClaudeLaunchFlags('aider', 'gpt-newest', 'ultracode')).toBe('aider');
  });

  it('returns the command unchanged when no model/effort given', () => {
    expect(applyClaudeLaunchFlags(base, undefined, undefined)).toBe(base);
  });

  // Regression: a model contaminated with a stripped ANSI bold escape ("[1m]")
  // — e.g. inherited by a fork/popup from an older session — must not leak the
  // shell-glob token `[1m]` into the unquoted `--model` flag (zsh: "no matches
  // found: claude-opus-4-8[1m]" → the popup fails to launch).
  it('recovers a model contaminated with a stripped ANSI bold escape ([1m])', () => {
    expect(applyClaudeLaunchFlags(base, 'claude-opus-4-8[1m]', 'high')).toBe(
      'claude --model claude-opus-4-8 --effort high --dangerously-skip-permissions',
    );
  });

  it('strips a real ANSI escape wrapping the model id', () => {
    expect(applyClaudeLaunchFlags(base, '\x1b[1mclaude-opus-4-8\x1b[0m', undefined)).toBe(
      'claude --model claude-opus-4-8 --dangerously-skip-permissions',
    );
  });

  it('takes the first token when the model carries a trailing newline/space', () => {
    expect(applyClaudeLaunchFlags(base, 'claude-opus-4-8\n', undefined)).toBe(
      'claude --model claude-opus-4-8 --dangerously-skip-permissions',
    );
  });

  it('drops the --model flag entirely when nothing safe remains', () => {
    expect(applyClaudeLaunchFlags(base, '[1m]', 'high')).toBe(
      'claude --effort high --dangerously-skip-permissions',
    );
  });

  // Regression (clone/resume/fork): the contaminated model is baked into the
  // reused startupCommand's existing `--model` token, not the model argument.
  // applyClaudeLaunchFlags previously skipped (a --model was already present) and
  // passed the broken `claude-opus-4-8[1m]` straight to the shell.
  it('cleans a contaminated --model already present in the command', () => {
    expect(
      applyClaudeLaunchFlags('claude --model claude-opus-4-8[1m] --dangerously-skip-permissions', null, null),
    ).toBe('claude --model claude-opus-4-8 --dangerously-skip-permissions');
  });

  it('cleans the baked-in --model on a clone command (with -n title)', () => {
    expect(
      applyClaudeLaunchFlags('claude --model claude-opus-4-8[1m] -n "Clone of KTS"', undefined, undefined),
    ).toBe('claude --model claude-opus-4-8 -n "Clone of KTS"');
  });

  it('recovers via the model argument when the baked-in --model is unrecoverable', () => {
    expect(applyClaudeLaunchFlags('claude --model [1m] --foo', 'opus', undefined)).toBe(
      'claude --model opus --foo',
    );
  });
});

describe('applyClaudeLaunchFlags — replace (resume / fork / clone)', () => {
  // The stored startup command is the live CLI's `ps` args, so it still carries the
  // flags the session was LAUNCHED with; a resume must relaunch with the latest ones.
  it('replaces a baked Claude --model and --effort with the session\'s current values', () => {
    const baked = "claude --model claude-opus-4-8 --effort medium -n 'API work'";
    expect(applyClaudeLaunchFlags(baked, 'claude-opus-5-5', 'high', { replace: true })).toBe(
      "claude --model claude-opus-5-5 --effort high -n 'API work'",
    );
    expect(applyClaudeLaunchFlags('claude --model=sonnet --effort=low', 'opus', 'max', { replace: true })).toBe(
      'claude --model opus --effort max',
    );
  });

  it('keeps a baked model it has no replacement for', () => {
    expect(applyClaudeLaunchFlags('claude --model sonnet --effort low', undefined, 'high', { replace: true })).toBe(
      'claude --effort high --model sonnet',
    );
  });

  it('REVIEW: drops a baked effort when the session has none — the model\'s own saved level applies', () => {
    expect(applyClaudeLaunchFlags('claude --model sonnet --effort max', 'claude-haiku-5-5', undefined, { replace: true })).toBe(
      'claude --model claude-haiku-5-5',
    );
    expect(applyClaudeLaunchFlags(`codex --model gpt-6-astra -c 'model_reasoning_effort="low"'`, 'gpt-6-astra', undefined, { replace: true }))
      .toBe('codex --model gpt-6-astra');
  });

  it('REVIEW: strips a double-quoted, escaped config override whole, and never eats a following flag', () => {
    expect(applyClaudeLaunchFlags('codex -c "model_reasoning_effort=\\"low\\"" --search', undefined, 'high', { replace: true }))
      .toBe(`codex -c 'model_reasoning_effort="high"' --search`);
    expect(applyClaudeLaunchFlags('codex --model --yolo', 'gpt-6-astra', undefined, { replace: true }))
      .toBe('codex --model gpt-6-astra --yolo');
    expect(applyClaudeLaunchFlags('claude --effort --verbose', undefined, 'high', { replace: true }))
      .toBe('claude --effort high --verbose');
  });

  it('replaces a Codex --model / -m and passes the effort as a config override', () => {
    expect(applyClaudeLaunchFlags('codex -m gpt-old --search', 'gpt-6-astra', 'high', { replace: true })).toBe(
      `codex --model gpt-6-astra -c 'model_reasoning_effort="high"' --search`,
    );
    expect(applyClaudeLaunchFlags(
      `codex --model gpt-old -c 'model_reasoning_effort="low"'`, 'gpt-6-astra', 'xhigh', { replace: true },
    )).toBe(`codex --model gpt-6-astra -c 'model_reasoning_effort="xhigh"'`);
  });

  it('without replace, existing flags still win (a launch command typed by the user)', () => {
    expect(applyClaudeLaunchFlags('claude --model sonnet', 'opus', undefined)).toBe('claude --model sonnet');
    expect(applyClaudeLaunchFlags(`codex -c model_reasoning_effort=low`, undefined, 'high')).toBe(
      'codex -c model_reasoning_effort=low',
    );
  });

  it('gives Codex an effort only for a level Codex has', () => {
    expect(applyClaudeLaunchFlags('codex', undefined, 'medium')).toBe(`codex -c 'model_reasoning_effort="medium"'`);
    expect(applyClaudeLaunchFlags('codex', undefined, 'max')).toBe('codex');
  });
});

describe('sanitizeModelInCommand', () => {
  it('rewrites a contaminated --model token in place', () => {
    expect(sanitizeModelInCommand('claude --model claude-opus-4-8[1m] -n "x"')).toBe(
      'claude --model claude-opus-4-8 -n "x"',
    );
  });

  it('leaves a clean --model untouched', () => {
    expect(sanitizeModelInCommand('claude --model opus --effort high')).toBe(
      'claude --model opus --effort high',
    );
  });

  it('drops the --model flag when nothing safe remains', () => {
    expect(sanitizeModelInCommand('claude --model [1m]')).toBe('claude');
  });

  it('handles --model=value form', () => {
    expect(sanitizeModelInCommand('claude --model=claude-opus-4-8[1m]')).toBe(
      'claude --model claude-opus-4-8',
    );
  });

  it('leaves commands without --model untouched', () => {
    expect(sanitizeModelInCommand('claude --dangerously-skip-permissions')).toBe(
      'claude --dangerously-skip-permissions',
    );
  });
});

describe('sanitizeModelId', () => {
  it('passes clean aliases and full ids through unchanged', () => {
    expect(sanitizeModelId('opus')).toBe('opus');
    expect(sanitizeModelId('claude-opus-4-8')).toBe('claude-opus-4-8');
    expect(sanitizeModelId('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5-20251001');
  });

  it('strips stripped-ANSI leftovers and real escapes', () => {
    expect(sanitizeModelId('claude-opus-4-8[1m]')).toBe('claude-opus-4-8');
    expect(sanitizeModelId('claude-opus-4-6[1m]')).toBe('claude-opus-4-6');
    expect(sanitizeModelId('\x1b[1mclaude-sonnet-4-6\x1b[0m')).toBe('claude-sonnet-4-6');
    expect(sanitizeModelId('claude-opus-4-8[1;32m]')).toBe('claude-opus-4-8');
  });

  it('returns empty for null/empty/unrecoverable input', () => {
    expect(sanitizeModelId(null)).toBe('');
    expect(sanitizeModelId(undefined)).toBe('');
    expect(sanitizeModelId('')).toBe('');
    expect(sanitizeModelId('[1m]')).toBe('');
    expect(sanitizeModelId('  ')).toBe('');
  });
});
