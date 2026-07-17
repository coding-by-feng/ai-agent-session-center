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

  it('leaves non-claude commands untouched', () => {
    expect(applyClaudeLaunchFlags('codex resume', 'opus', 'ultracode')).toBe('codex resume');
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
