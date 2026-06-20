import { describe, it, expect } from 'vitest';
import { applyClaudeLaunchFlags, appendSessionName } from '../server/config.js';

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
});
