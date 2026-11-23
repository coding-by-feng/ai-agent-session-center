import { describe, it, expect } from 'vitest';
import { launchersFor, launcherForKind } from './cliLaunchers';

describe('cliLaunchers', () => {
  it('shows Claude and Codex always, OpenCode / Antigravity only once enabled', () => {
    expect(launchersFor(null).map((l) => l.command)).toEqual(['claude', 'codex']);
    expect(launchersFor(['claude']).map((l) => l.command)).toEqual(['claude', 'codex']);
    expect(launchersFor(['claude', 'antigravity', 'opencode']).map((l) => l.command)).toEqual(['claude', 'codex', 'opencode', 'agy']);
  });
  it('finds each agent’s mark by its kind (Antigravity runs as `agy`)', () => {
    expect(launcherForKind('antigravity')?.label).toBe('Antigravity');
    expect(launcherForKind('opencode')?.command).toBe('opencode');
    expect(launcherForKind(null)).toBeUndefined();
  });
});
