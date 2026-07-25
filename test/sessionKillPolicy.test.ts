import { describe, expect, it } from 'vitest';
import { findLiveCodexPidPeers } from '../server/sessionKillPolicy.js';
import type { Session } from '../src/types/session.js';

function session(sessionId: string, overrides: Partial<Session> = {}): Session {
  return {
    sessionId,
    projectPath: '/project',
    projectName: 'project',
    title: sessionId,
    status: 'waiting',
    animationState: 'idle',
    emote: null,
    startedAt: 1,
    lastActivityAt: 1,
    endedAt: null,
    currentPrompt: '',
    promptHistory: [],
    toolUsage: {},
    totalToolCalls: 0,
    toolLog: [],
    responseLog: [],
    events: [],
    cachedPid: 80949,
    cliSource: 'codex',
    ...overrides,
  } as Session;
}

describe('findLiveCodexPidPeers', () => {
  it('finds live sibling threads sharing the selected Codex host PID', () => {
    const target = session('thread-a');
    const peer = session('thread-b');
    const ended = session('thread-ended', { status: 'ended' });
    const otherPid = session('thread-other', { cachedPid: 123 });

    expect(findLiveCodexPidPeers(target, [target, peer, ended, otherPid], 80949))
      .toEqual([peer]);
  });

  it('does not apply Codex shared-host policy to Claude sessions', () => {
    const target = session('claude-a', { cliSource: 'claude', sshCommand: 'claude' });
    const peer = session('codex-b');

    expect(findLiveCodexPidPeers(target, [target, peer], 80949)).toEqual([]);
  });

  it('recognizes an absolute Codex launch path when cliSource is absent', () => {
    const target = session('thread-a', {
      cliSource: undefined,
      startupCommand: '/opt/codex/bin/codex --full-auto',
    });
    const peer = session('thread-b');

    expect(findLiveCodexPidPeers(target, [target, peer], 80949)).toEqual([peer]);
  });
});
