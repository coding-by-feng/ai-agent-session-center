import { describe, it, expect } from 'vitest';
import { CLAUDE_TUI_ENV_DEFAULTS, withClaudeTuiEnvDefaults } from '../server/config.js';

describe('CLAUDE_TUI_ENV_DEFAULTS', () => {
  it('disables the Claude Code alternate-screen (fullscreen) renderer', () => {
    expect(CLAUDE_TUI_ENV_DEFAULTS).toEqual({
      CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '1',
    });
  });
});

describe('withClaudeTuiEnvDefaults', () => {
  it('adds the default when the key is absent', () => {
    const env = { AGENT_MANAGER_TERMINAL_ID: 'term-1' };
    expect(withClaudeTuiEnvDefaults(env)).toEqual({
      AGENT_MANAGER_TERMINAL_ID: 'term-1',
      CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '1',
    });
  });

  it('respects an explicit user opt-back-in (value "0")', () => {
    const env = { CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '0' };
    expect(withClaudeTuiEnvDefaults(env)).toEqual({
      CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '0',
    });
  });

  it('respects an already-set value even when empty string', () => {
    const env = { CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '' };
    expect(withClaudeTuiEnvDefaults(env)).toEqual({
      CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '',
    });
  });

  it('does not mutate the input env', () => {
    const env = { AGENT_MANAGER_TERMINAL_ID: 'term-2' };
    const result = withClaudeTuiEnvDefaults(env);
    expect(env).toEqual({ AGENT_MANAGER_TERMINAL_ID: 'term-2' });
    expect(result).not.toBe(env);
  });

  it('preserves unrelated keys', () => {
    const env = { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-x' };
    const result = withClaudeTuiEnvDefaults(env);
    expect(result.PATH).toBe('/usr/bin');
    expect(result.ANTHROPIC_API_KEY).toBe('sk-x');
  });
});
