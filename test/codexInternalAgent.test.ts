// Codex's background Memory Writing Agent fires hooks from the user's Codex process
// (same pid, tty and terminal id) with cwd $CODEX_HOME/memories. Taken as a resume, it
// re-keyed the user's card to itself, the real turn's Stop was lost and the queue
// never auto-sent (Oct 19 and Oct 22 2026).
import { describe, it, expect, afterEach } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isCodexInternalAgentHook } from '../server/codexInternalAgent.js';

const saved = process.env.CODEX_HOME;
afterEach(() => {
  if (saved === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = saved;
});

describe('isCodexInternalAgentHook', () => {
  it('matches a hook from ~/.codex/memories', () => {
    delete process.env.CODEX_HOME;
    expect(isCodexInternalAgentHook({ cwd: join(homedir(), '.codex', 'memories') })).toBe(true);
    expect(isCodexInternalAgentHook({ cwd: join(homedir(), '.codex', 'memories', 'phase2') })).toBe(true);
    expect(isCodexInternalAgentHook({ cwd: `${join(homedir(), '.codex', 'memories')}/` })).toBe(true);
  });

  it('follows CODEX_HOME', () => {
    process.env.CODEX_HOME = '/tmp/alt-codex';
    expect(isCodexInternalAgentHook({ cwd: '/tmp/alt-codex/memories' })).toBe(true);
    expect(isCodexInternalAgentHook({ cwd: join(homedir(), '.codex', 'memories') })).toBe(false);
  });

  it('leaves every real project alone', () => {
    delete process.env.CODEX_HOME;
    for (const cwd of [
      join(homedir(), 'Documents', 'valux'),
      join(homedir(), '.codex'),
      join(homedir(), '.codex', 'memories-old'),
      join(homedir(), 'Documents', 'memories'),
      undefined,
      '',
    ]) {
      expect(isCodexInternalAgentHook({ cwd })).toBe(false);
    }
  });
});
