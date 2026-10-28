import { describe, it, expect, beforeEach } from 'vitest';
import {
  LAUNCH_PERMISSION_KEY,
  commandForMode,
  lastPermissionMode,
  permissionModes,
  rememberPermissionMode,
} from './launchPermission';

describe('launchPermission', () => {
  beforeEach(() => localStorage.clear());

  it('starts every list with the plain command, which is what the buttons ran before', () => {
    expect(commandForMode('claude', permissionModes('claude')[0].id)).toBe('claude');
    expect(commandForMode('codex', permissionModes('codex')[0].id)).toBe('codex');
  });

  it("builds Claude's modes from its own flags", () => {
    expect(commandForMode('claude', 'acceptEdits')).toBe('claude --permission-mode acceptEdits');
    expect(commandForMode('claude', 'plan')).toBe('claude --permission-mode plan');
    expect(commandForMode('claude', 'auto')).toBe('claude --permission-mode auto');
    expect(commandForMode('claude', 'bypass')).toBe('claude --dangerously-skip-permissions');
  });

  it("builds Codex's bypass from its own flag", () => {
    expect(commandForMode('codex', 'bypass')).toBe('codex --dangerously-bypass-approvals-and-sandbox');
  });

  it('falls back to the plain command for a mode the CLI does not have', () => {
    expect(commandForMode('codex', 'plan')).toBe('codex');
  });

  it('is Default until a mode has been picked', () => {
    expect(lastPermissionMode('claude')).toBe('default');
    expect(lastPermissionMode('codex')).toBe('default');
  });

  it('remembers the last pick per CLI, so one never leaks into the other', () => {
    rememberPermissionMode('claude', 'bypass');
    expect(lastPermissionMode('claude')).toBe('bypass');
    expect(lastPermissionMode('codex')).toBe('default');
    rememberPermissionMode('claude', 'plan');
    expect(lastPermissionMode('claude')).toBe('plan');
  });

  it('ignores a stored mode that the CLI no longer offers', () => {
    localStorage.setItem(LAUNCH_PERMISSION_KEY, JSON.stringify({ codex: 'plan', claude: 'nonsense' }));
    expect(lastPermissionMode('codex')).toBe('default');
    expect(lastPermissionMode('claude')).toBe('default');
  });

  it('survives storage that is not JSON', () => {
    localStorage.setItem(LAUNCH_PERMISSION_KEY, '{oops');
    expect(lastPermissionMode('claude')).toBe('default');
    rememberPermissionMode('claude', 'auto');
    expect(lastPermissionMode('claude')).toBe('auto');
  });
});
