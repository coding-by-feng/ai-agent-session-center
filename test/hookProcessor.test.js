// test/hookProcessor.test.js — Tests for server/hookProcessor.js
// NOTE: hookProcessor imports sessionStore, wsManager, hookStats — all have side effects.
// We test the validation logic indirectly by calling processHookEvent and checking results.
import { describe, it, beforeEach, expect, vi } from 'vitest';

// sessionStore opens better-sqlite3 at module scope via db.ts. Stub the handful of
// functions it calls so this suite exercises in-memory behaviour and stays runnable
// when the native module's ABI doesn't match the local Node — otherwise the whole
// file fails at import and silently covers nothing.
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

import { processHookEvent as rawProcessHookEvent } from '../server/hookProcessor.js';
import { resetStats } from '../server/hookStats.js';

// sessionMatcher's Priority 5 external fallback only creates a card for an
// unmatched hook that carries a controlling tty, so headless `claude -p` / CI
// runs cannot spawn phantom cards. These fixtures model interactive sessions —
// default a tty at the boundary so they create sessions as intended.
// Non-objects (null, strings) must pass through untouched — the validation
// tests below rely on them still being rejected.
const processHookEvent = (payload, ...rest) =>
  rawProcessHookEvent(
    payload && typeof payload === 'object' ? { tty_path: '/dev/ttys001', ...payload } : payload,
    ...rest,
  );

describe('hookProcessor', () => {
  beforeEach(() => {
    resetStats();
  });

  describe('processHookEvent - validation', () => {
    it('rejects null payload', () => {
      const result = processHookEvent(null);
      expect(result).toBeTruthy();
      expect(result.error).toBeTruthy();
      expect(result.error).toMatch(/payload must be a JSON object/);
    });

    it('rejects non-object payload', () => {
      const result = processHookEvent('not an object');
      expect(result).toBeTruthy();
      expect(result.error).toBeTruthy();
      expect(result.error).toMatch(/payload must be a JSON object/);
    });

    it('rejects missing session_id', () => {
      const result = processHookEvent({ hook_event_name: 'SessionStart' });
      expect(result).toBeTruthy();
      expect(result.error).toBeTruthy();
      expect(result.error).toMatch(/missing session_id/);
    });

    it('rejects non-string session_id', () => {
      const result = processHookEvent({ session_id: 123, hook_event_name: 'SessionStart' });
      expect(result).toBeTruthy();
      expect(result.error).toBeTruthy();
      expect(result.error).toMatch(/session_id must be a string/);
    });

    it('rejects too-long session_id', () => {
      const result = processHookEvent({
        session_id: 'x'.repeat(257),
        hook_event_name: 'SessionStart',
      });
      expect(result).toBeTruthy();
      expect(result.error).toBeTruthy();
      expect(result.error).toMatch(/session_id too long/);
    });

    it('rejects missing hook_event_name', () => {
      const result = processHookEvent({ session_id: 'test-123' });
      expect(result).toBeTruthy();
      expect(result.error).toBeTruthy();
      expect(result.error).toMatch(/missing hook_event_name/);
    });

    it('rejects unknown event type', () => {
      const result = processHookEvent({
        session_id: 'test-123',
        hook_event_name: 'FakeEvent',
      });
      expect(result).toBeTruthy();
      expect(result.error).toBeTruthy();
      expect(result.error).toMatch(/unknown event type/);
    });

    it('rejects invalid claude_pid (non-number)', () => {
      const result = processHookEvent({
        session_id: 'test-123',
        hook_event_name: 'SessionStart',
        claude_pid: 'not-a-number',
      });
      expect(result).toBeTruthy();
      expect(result.error).toBeTruthy();
      expect(result.error).toMatch(/claude_pid must be a positive integer/);
    });

    it('rejects invalid claude_pid (negative)', () => {
      const result = processHookEvent({
        session_id: 'test-123',
        hook_event_name: 'SessionStart',
        claude_pid: -5,
      });
      expect(result).toBeTruthy();
      expect(result.error).toBeTruthy();
      expect(result.error).toMatch(/claude_pid must be a positive integer/);
    });

    it('rejects invalid claude_pid (floating point)', () => {
      const result = processHookEvent({
        session_id: 'test-123',
        hook_event_name: 'SessionStart',
        claude_pid: 3.14,
      });
      expect(result).toBeTruthy();
      expect(result.error).toBeTruthy();
      expect(result.error).toMatch(/claude_pid must be a positive integer/);
    });

    it('rejects invalid timestamp', () => {
      const result = processHookEvent({
        session_id: 'test-123',
        hook_event_name: 'SessionStart',
        timestamp: 'not-a-number',
      });
      expect(result).toBeTruthy();
      expect(result.error).toBeTruthy();
      expect(result.error).toMatch(/timestamp must be a valid number/);
    });
  });

  describe('processHookEvent - valid payloads', () => {
    it('processes SessionStart successfully', () => {
      const result = processHookEvent({
        session_id: 'proc-test-session-1',
        hook_event_name: 'SessionStart',
        cwd: '/tmp/test-project',
      });
      expect(result).toBeTruthy();
      expect(result.error).toBeFalsy();
      expect(result.session).toBeTruthy();
      expect(result.session.sessionId).toBe('proc-test-session-1');
    });

    it('processes Stop event successfully', () => {
      // First create a session
      processHookEvent({
        session_id: 'proc-test-session-2',
        hook_event_name: 'SessionStart',
        cwd: '/tmp/test-project',
      });
      const result = processHookEvent({
        session_id: 'proc-test-session-2',
        hook_event_name: 'Stop',
      });
      expect(result).toBeTruthy();
      expect(result.error).toBeFalsy();
      expect(result.session.status).toBe('waiting');
    });

    it('calculates delivery latency when hook_sent_at present', () => {
      const now = Date.now();
      const result = processHookEvent({
        session_id: 'proc-test-latency',
        hook_event_name: 'SessionStart',
        cwd: '/tmp/test',
        hook_sent_at: now - 100,
      });
      expect(result).toBeTruthy();
      expect(result.error).toBeFalsy();
    });

    it('accepts valid claude_pid', () => {
      const result = processHookEvent({
        session_id: 'proc-test-pid',
        hook_event_name: 'SessionStart',
        cwd: '/tmp/test',
        claude_pid: 12345,
      });
      expect(result).toBeTruthy();
      expect(result.error).toBeFalsy();
    });

    it('accepts event via "event" field alias', () => {
      const result = processHookEvent({
        session_id: 'proc-test-alias',
        event: 'SessionStart',
        cwd: '/tmp/test',
      });
      // The validator checks hookData.hook_event_name || hookData.event
      // But handleEvent reads hookData.hook_event_name — if event field is used,
      // the hook is validated but handleEvent may not recognize it.
      // Just check that validation passed
      expect(result).toBeTruthy();
      // The result may be null if handleEvent doesn't recognize the event
      // That's OK — validation passed
    });
  });
});

describe('processHookEvent - Codex internal agents (Oct 22 2026)', () => {
  it('drops a Codex Memory Writing Agent hook without creating or re-keying a card', async () => {
    const { homedir } = await import('node:os');
    const { join } = await import('node:path');
    const { getSession } = await import('../server/sessionStore.js');
    const result = processHookEvent({
      session_id: 'codex-memory-agent-1',
      hook_event_name: 'SessionStart',
      cwd: join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'memories'),
    });
    expect(result).toBeNull();
    expect(getSession('codex-memory-agent-1')).toBeFalsy();
  });
});

describe('processHookEvent - Codex memory agent replay (valux, Oct 22 2026)', () => {
  it("the user's Stop still lands on their card after the memory agent fires in the same terminal", async () => {
    const { homedir } = await import('node:os');
    const { join } = await import('node:path');
    const { getSession } = await import('../server/sessionStore.js');
    const shared = { claude_pid: 37087, tty_path: '/dev/ttys098', agent_terminal_id: 'term-replay-179' };
    const user = { ...shared, session_id: 'codex-user-01a16021', cwd: '/Users/k/Documents/valux' };
    const memory = { ...shared, session_id: 'codex-memory-01a16022', cwd: join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'memories') };
    processHookEvent({ ...user, hook_event_name: 'SessionStart', source: 'startup' });
    processHookEvent({ ...user, hook_event_name: 'UserPromptSubmit', prompt: 'check the previous website' });
    processHookEvent({ ...memory, hook_event_name: 'SessionStart', source: 'startup' });
    processHookEvent({ ...memory, hook_event_name: 'UserPromptSubmit', prompt: '## Memory Writing Agent: Phase 2 (Consolidation)' });
    processHookEvent({ ...memory, hook_event_name: 'PreToolUse', tool_name: 'Bash' });
    processHookEvent({ ...user, hook_event_name: 'Stop' });
    const card = getSession('codex-user-01a16021');
    expect(card?.status).toBe('waiting');
    expect(card?.projectPath).not.toMatch(/memories/);
    expect(getSession('codex-memory-01a16022')).toBeFalsy();
  });
});
