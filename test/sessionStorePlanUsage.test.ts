/**
 * The store half of plan usage: what the session store does with the service.
 *
 * Real files, real timers. Codex is the CLI used because its limits are read
 * from `$CODEX_HOME`, which a test can point at a scratch directory; the Claude
 * source reads a fixed directory under /tmp that belongs to the running app.
 * Everything here is CLI-agnostic past the source, so that is no loss.
 */
import { describe, it, expect, vi, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import log from '../server/logger.js';

// Read when the store module is created, so it must be set before the import below.
const codexHome = mkdtempSync(join(tmpdir(), 'aasc-store-usage-'));
process.env.CODEX_HOME = codexHome;

const ws = vi.hoisted(() => ({ broadcast: vi.fn() }));
// Sessions whose CLI detection should blow up, to prove plan usage can never abort hook handling.
const codec = vi.hoisted(() => ({ throwFor: new Set<string>() }));

vi.mock('../server/planUsageCodec.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../server/planUsageCodec.js')>();
  return {
    ...mod,
    planCliOf: (session: Parameters<typeof mod.planCliOf>[0]) => {
      if (codec.throwFor.has(String((session as { sessionId?: unknown }).sessionId))) throw new Error('detector exploded');
      return mod.planCliOf(session);
    },
  };
});

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

vi.mock('../server/wsManager.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../server/wsManager.js')>();
  return { ...mod, broadcast: ws.broadcast };
});

const {
  createTerminalSession,
  getSession,
  getAllSessions,
  getEventSeq,
  handleEvent,
  registerDiscoveredSession,
  startPlanUsage,
  stopPlanUsage,
} = await import('../server/sessionStore.js');
const { planCliOf } = await import('../server/planUsageCodec.js');

const rolloutDir = join(codexHome, 'sessions', '2026', '10', '03');
mkdirSync(rolloutDir, { recursive: true });
const rollout = join(rolloutDir, 'rollout-2026-10-03T21-40-04-aaaa.jsonl');
let writes = 0;

/** The rollout's newest token_count, with a distinct mtime each time so the reader sees a change. */
function reportUsage(pct: number): void {
  writeFileSync(rollout, JSON.stringify({
    timestamp: new Date(Date.now()).toISOString(),
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: null,
      rate_limits: {
        primary: { used_percent: pct, window_minutes: 10080, resets_at: 1_791_581_013 },
        secondary: null,
        plan_type: 'prolite',
        rate_limit_reached_type: null,
      },
    },
  }) + '\n');
  const t = new Date(Date.now() + 1000 * ++writes);
  utimesSync(rollout, t, t);
}

const percentOf = (id: string): number | undefined => getSession(id)?.planUsage?.windows[0].usedPercent;
const codex = (id: string) => createTerminalSession(id, { host: 'localhost', workingDir: '/tmp/plan-usage', command: 'codex' });

afterAll(() => {
  stopPlanUsage();
  rmSync(codexHome, { recursive: true, force: true });
  delete process.env.CODEX_HOME;
});

describe('plan usage in the session store', () => {
  it('puts a CLI’s limits on its live sessions, in the snapshot clients get, and tells clients', async () => {
    reportUsage(26);
    await codex('pu-codex');
    await createTerminalSession('pu-claude', { host: 'localhost', workingDir: '/tmp/plan-usage', command: 'claude' });
    expect(getAllSessions()['pu-codex'].planUsage).toBeUndefined(); // primes the snapshot cache the update must invalidate
    startPlanUsage();

    await vi.waitFor(() => expect(percentOf('pu-codex')).toBe(26), { timeout: 3000 });
    expect(getSession('pu-codex')?.planUsage).toMatchObject({ cli: 'codex', plan: 'prolite' });
    expect(getAllSessions()['pu-codex'].planUsage?.windows[0].usedPercent).toBe(26);

    // Codex's limits are not Claude's.
    expect(getSession('pu-claude')?.planUsage?.cli ?? 'claude').toBe('claude');

    await vi.waitFor(() => expect(ws.broadcast).toHaveBeenCalledWith(expect.objectContaining({
      type: 'session_update',
      session: expect.objectContaining({ sessionId: 'pu-codex', planUsage: expect.objectContaining({ cli: 'codex' }) }),
    })), { timeout: 3000 });
  });

  it('gives a session that appears later the numbers the moment it exists', async () => {
    await codex('pu-codex-late');
    expect(percentOf('pu-codex-late')).toBe(26);
  });

  it('re-reads when a session starts, without waiting for the interval', async () => {
    reportUsage(41);
    handleEvent({
      session_id: 'pu-hook',
      hook_event_name: 'SessionStart',
      cwd: '/tmp/plan-usage-hook',
      tty_path: '/dev/ttys001',
      cli_source: 'codex',
    } as never);
    await vi.waitFor(() => expect(percentOf('pu-codex')).toBe(41), { timeout: 3000 });
    expect(percentOf('pu-codex-late')).toBe(41);
    expect(percentOf('pu-hook')).toBe(41);
  });

  it('leaves an ended session as it was', async () => {
    handleEvent({
      session_id: 'pu-ended',
      hook_event_name: 'SessionStart',
      cwd: '/tmp/plan-usage-ended',
      tty_path: '/dev/ttys002',
      cli_source: 'codex',
    } as never);
    expect(percentOf('pu-ended')).toBe(41);
    handleEvent({
      session_id: 'pu-ended',
      hook_event_name: 'SessionEnd',
      cwd: '/tmp/plan-usage-ended',
      tty_path: '/dev/ttys002',
      cli_source: 'codex',
    } as never);
    expect(getSession('pu-ended')?.status).toBe('ended');

    reportUsage(63);
    handleEvent({ session_id: 'pu-hook', hook_event_name: 'UserPromptSubmit', cwd: '/tmp/plan-usage-hook', tty_path: '/dev/ttys001', cli_source: 'codex' } as never);
    await vi.waitFor(() => expect(percentOf('pu-hook')).toBe(63), { timeout: 3000 });
    expect(percentOf('pu-ended')).toBe(41);
  });

  it('plan usage can never abort hook handling: a throw while attaching leaves the event fully processed', () => {
    // handleEvent mutates the session and THEN has aliasing, baton migration and the replay buffer to do:
    // an exception from the plan-usage attach in the middle would skip all of that for this session.
    codec.throwFor.add('pu-boom');
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    try {
      const before = getEventSeq();
      let result: unknown;
      expect(() => {
        result = handleEvent({
          session_id: 'pu-boom',
          hook_event_name: 'SessionStart',
          cwd: '/tmp/plan-usage-boom',
          tty_path: '/dev/ttys003',
          cli_source: 'codex',
        } as never);
      }).not.toThrow();
      expect(result).toBeTruthy();
      expect(getSession('pu-boom')?.status).toBe('idle'); // the SessionStart itself was handled
      expect(getEventSeq()).toBe(before + 1); // …and its update reached the reconnect-replay buffer
      // Contained, not silent.
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith('plan-usage', expect.stringContaining('detector exploded'));
    } finally {
      codec.throwFor.delete('pu-boom');
      warn.mockRestore();
    }
  });

  it('reports a persistent plan-usage fault once a minute, not once per hook event', () => {
    // attachPlanUsage is on the hot path: a fault that fires on every event must not become a log flood.
    // A fixed date nowhere near the real clock, so the earlier test's warning cannot fall inside the window.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2001-09-09T01:46:40Z'));
    codec.throwFor.add('pu-flood');
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const event = (name: string) => handleEvent({
      session_id: 'pu-flood',
      hook_event_name: name,
      cwd: '/tmp/plan-usage-flood',
      tty_path: '/dev/ttys005',
      cli_source: 'codex',
    } as never);
    try {
      event('SessionStart');
      event('PreToolUse');
      event('PostToolUse');
      expect(warn).toHaveBeenCalledTimes(1);

      vi.setSystemTime(new Date('2001-09-09T01:47:39Z')); // 59 s later
      event('PostToolUse');
      expect(warn).toHaveBeenCalledTimes(1);

      vi.setSystemTime(new Date('2001-09-09T01:47:41Z')); // 61 s after the first report
      event('PostToolUse');
      expect(warn).toHaveBeenCalledTimes(2);

      // A clock stepped back (NTP) must not hold the report off until the old time comes round again.
      vi.setSystemTime(new Date('2001-09-09T00:46:40Z'));
      event('PostToolUse');
      expect(warn).toHaveBeenCalledTimes(3);
    } finally {
      codec.throwFor.delete('pu-flood');
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it('survives a hook whose cli_source is not a string', () => {
    expect(() => handleEvent({
      session_id: 'pu-odd',
      hook_event_name: 'SessionStart',
      cwd: '/tmp/plan-usage-odd',
      tty_path: '/dev/ttys004',
      cli_source: 1,
    } as never)).not.toThrow();
    expect(getSession('pu-odd')).toBeTruthy();
  });

  it('an external card found by the process scan is a Claude session, so it can carry plan usage', () => {
    // The scan only ever surfaces `claude` (isInteractiveClaude), but the minted card had no cliSource, so
    // nothing could say which CLI's plan limits it should show.
    registerDiscoveredSession({ pid: 4242001, tty: 'ttys042', ppid: null, cwd: '/tmp/plan-usage-external', name: null, model: null });
    const card = getSession('external-4242001');
    expect(card?.cliSource).toBe('claude');
    expect(planCliOf(card!)).toBe('claude');
  });
});
