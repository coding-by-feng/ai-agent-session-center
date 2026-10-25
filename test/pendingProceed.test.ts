/**
 * `Session.pendingProceedAt` through the real session store (Oct 23 2026): set when a turn ends
 * with an answer that asks the user to reply "proceed", kept through auto-idle (the reminder is
 * for a session that has sat there for hours), cleared by the next prompt, a later answer that
 * does not ask, a new or ended session. A resumed session (an app restart) reads its transcript.
 * Fake timers: auto-idle is minutes away.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ws = vi.hoisted(() => ({ broadcast: vi.fn() }));

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

// No process scans against the real `ps` while the fake clock runs.
vi.mock('../server/processMonitor.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../server/processMonitor.js')>();
  return { ...mod, startMonitoring: vi.fn(), stopMonitoring: vi.fn(), startExternalDiscovery: vi.fn() };
});

/** A real-time pause: the fake clock below must not move while a file read lands. */
const realSleep = ((t) => (ms: number) => new Promise<void>((r) => t(r, ms)))(globalThis.setTimeout);
vi.useFakeTimers({ now: 1_800_000_000_000 });
const { handleEvent, getSession, getAllSessions } = await import('../server/sessionStore.js');
const { processHookEvent } = await import('../server/hookProcessor.js');

const MIN = 60_000;
const ASK = 'Here is the plan.\n\nReply **proceed** to build with these recommendations, or answer 1–4.';
const DONE = 'Built and verified. Nothing else needs you.';

const dir = mkdtempSync(join(tmpdir(), 'aasc-proceed-'));
afterAll(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

let n = 0;
function hook(id: string, event: string, extra: Record<string, unknown> = {}): void {
  handleEvent({
    session_id: id,
    hook_event_name: event,
    cwd: `/tmp/proceed-${id}`,
    tty_path: `/dev/ttys8${String(n).padStart(2, '0')}`,
    cli_source: 'claude',
    ...extra,
  } as never);
}
function newSession(extra: Record<string, unknown> = {}): string {
  n += 1;
  const id = `pp-${n}`;
  hook(id, 'SessionStart', extra);
  return id;
}
function finishedTurn(id: string, answer: string, extra: Record<string, unknown> = {}): void {
  hook(id, 'UserPromptSubmit', { prompt: 'plan it' });
  hook(id, 'Stop', { last_assistant_message: answer, ...extra });
}
const pending = (id: string) => getSession(id)?.pendingProceedAt ?? null;
/** The transcript is read from disk: real time, and slow when the machine is busy. */
const READ = { timeout: 5000, interval: 20 };
/**
 * Wait until the transcript reads issued so far have landed: a control session whose read
 * starts after them must come out set. Lets a "stays clear" test see the read it is about.
 */
async function readsSettled(): Promise<void> {
  const control = newSession({ source: 'resume', transcript_path: transcript(`control-${n}`, ASK) });
  await vi.waitFor(() => expect(pending(control)).toBeTypeOf('number'), READ);
}

function transcript(name: string, lastAnswer: string, after: object[] = []): string {
  const file = join(dir, `${name}.jsonl`);
  const lines = [
    { type: 'user', message: { role: 'user', content: 'plan it' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: lastAnswer }] } },
    ...after,
  ];
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

beforeEach(async () => {
  // Let a broadcast batch an earlier test left on the fake clock go out (it imports wsManager
  // lazily), so it cannot swallow or delay this test's updates.
  await vi.advanceTimersByTimeAsync(100);
  await vi.dynamicImportSettled();
  ws.broadcast.mockClear();
});

describe('pendingProceedAt', () => {
  it('is set when the answer asks for proceed, and the snapshot a client loads carries it', () => {
    const id = newSession();
    finishedTurn(id, ASK);
    expect(getSession(id)?.status).toBe('waiting');
    expect(pending(id)).toBeTypeOf('number');
    // Hook events are broadcast by hookProcessor with the whole session; a reload reads this.
    expect(getAllSessions()[id].pendingProceedAt).toBeTypeOf('number');
  });

  it('is not set for an answer that asks nothing', () => {
    const id = newSession();
    finishedTurn(id, DONE);
    expect(pending(id)).toBeNull();
  });

  it('reads the end of a long answer, not the 2000-character excerpt the store keeps', () => {
    const id = newSession();
    finishedTurn(id, 'Detail line.\n'.repeat(400) + 'Reply **proceed** to build it.');
    expect(pending(id)).toBeTypeOf('number');
  });

  it('survives auto-idle: the session can sit for hours and still owe a reply', async () => {
    const id = newSession();
    finishedTurn(id, ASK);
    await vi.advanceTimersByTimeAsync(5 * MIN + 15_000);
    expect(getSession(id)?.status).toBe('idle');
    expect(pending(id)).toBeTypeOf('number');
  });

  it('clears on the next prompt, from any device', () => {
    const id = newSession();
    finishedTurn(id, ASK);
    hook(id, 'UserPromptSubmit', { prompt: 'proceed' });
    expect(pending(id)).toBeNull();
  });

  it('clears when a later answer no longer asks', () => {
    const id = newSession();
    finishedTurn(id, ASK);
    finishedTurn(id, DONE);
    expect(pending(id)).toBeNull();
  });

  it('clears when the session ends, or a new conversation starts', () => {
    const a = newSession();
    finishedTurn(a, ASK);
    hook(a, 'SessionEnd', { reason: 'exit' });
    expect(pending(a)).toBeNull();

    const b = newSession();
    finishedTurn(b, ASK);
    hook(b, 'SessionStart', { source: 'clear' });
    expect(pending(b)).toBeNull();
  });

  it('a resumed session (an app restart) reads its transcript: still owed → set, and clients are told', async () => {
    const id = newSession({ source: 'resume', transcript_path: transcript('resumed-ask', ASK) });
    await vi.waitFor(() => expect(pending(id)).toBeTypeOf('number'), READ);
    // No hook follows this read, so the store sends the update itself.
    await vi.waitFor(() => {
      const sent = ws.broadcast.mock.calls
        .map(([m]) => m as { type?: string; session?: { sessionId?: string; pendingProceedAt?: number | null } })
        .filter((m) => m.type === 'session_update' && m.session?.sessionId === id);
      expect(sent.some((m) => typeof m.session?.pendingProceedAt === 'number')).toBe(true);
    }, READ);
  });

  it('a resumed session whose last answer was already answered stays clear', async () => {
    const answered = transcript('resumed-answered', ASK, [{ type: 'user', message: { role: 'user', content: 'proceed' } }]);
    const id = newSession({ source: 'resume', transcript_path: answered });
    await readsSettled();
    expect(pending(id)).toBeNull();
  });

  it('a Stop without the answer text falls back to the transcript', async () => {
    const id = newSession();
    hook(id, 'UserPromptSubmit', { prompt: 'plan it' });
    hook(id, 'Stop', { transcript_path: transcript('no-text', ASK) });
    await vi.waitFor(() => expect(pending(id)).toBeTypeOf('number'), READ);
  });

  it('a prompt typed while the transcript is read wins over the late read', async () => {
    const id = newSession();
    hook(id, 'UserPromptSubmit', { prompt: 'plan it' });
    hook(id, 'Stop', { transcript_path: transcript('race', ASK) });
    hook(id, 'UserPromptSubmit', { prompt: 'proceed' }); // before the read lands
    await readsSettled();
    expect(pending(id)).toBeNull();
  });

  it('a resumed card through the real hook path keeps its P on every client (the held hook update must not undo it)', async () => {
    n += 1;
    const id = `pp-${n}`;
    processHookEvent({
      session_id: id, hook_event_name: 'SessionStart', source: 'resume', cwd: `/tmp/proceed-${id}`,
      tty_path: `/dev/ttys8${String(n).padStart(2, '0')}`, cli_source: 'claude', transcript_path: transcript('held', ASK),
    } as never);
    for (let i = 0; i < 200 && !pending(id); i++) await realSleep(5); // the read lands; the 250 ms hold has not fired
    expect(pending(id)).toBeTypeOf('number');
    await vi.advanceTimersByTimeAsync(400); // the store's own update, then the held hook update
    await vi.dynamicImportSettled();
    const updates = ws.broadcast.mock.calls
      .map(([m]) => m as { type?: string; session?: { sessionId?: string; pendingProceedAt?: number | null } })
      .filter((m) => m.type === 'session_update' && m.session?.sessionId === id);
    expect(updates.length).toBeGreaterThan(0);
    expect(updates[updates.length - 1].session?.pendingProceedAt).toBeTypeOf('number');
  });

  it('a resume or a /compact keeps the P it had: only a new conversation clears it (Codex has no transcript to re-read)', () => {
    const codex = newSession({ cli_source: 'codex' });
    hook(codex, 'UserPromptSubmit', { prompt: 'plan it', cli_source: 'codex' });
    hook(codex, 'Stop', { response: ASK, cli_source: 'codex' });
    hook(codex, 'SessionStart', { source: 'resume', cli_source: 'codex' });
    expect(pending(codex)).toBeTypeOf('number');

    const claude = newSession();
    finishedTurn(claude, ASK);
    hook(claude, 'SessionStart', { source: 'compact' });
    expect(pending(claude)).toBeTypeOf('number');
    hook(claude, 'SessionStart', { source: 'startup' });
    expect(pending(claude)).toBeNull();
  });

  it('a Stop without text retries the read: the answer can reach the file after the hook', async () => {
    const id = newSession();
    hook(id, 'UserPromptSubmit', { prompt: 'plan it' });
    const file = join(dir, 'late.jsonl');
    writeFileSync(file, JSON.stringify({ type: 'user', message: { role: 'user', content: 'plan it' } }) + '\n');
    hook(id, 'Stop', { transcript_path: file });
    await vi.advanceTimersByTimeAsync(160); // first read: no answer yet
    await realSleep(30);
    expect(pending(id)).toBeNull();
    writeFileSync(file, [
      { type: 'user', message: { role: 'user', content: 'plan it' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: ASK }] } },
    ].map((l) => JSON.stringify(l)).join('\n') + '\n');
    await vi.advanceTimersByTimeAsync(500); // second read at 600 ms
    await vi.waitFor(() => expect(pending(id)).toBeTypeOf('number'), READ);
  });

  it('works for Codex, whose hook sends the answer as `response`', () => {
    const id = newSession({ cli_source: 'codex' });
    hook(id, 'UserPromptSubmit', { prompt: 'plan it', cli_source: 'codex' });
    hook(id, 'Stop', { response: ASK, cli_source: 'codex' });
    expect(pending(id)).toBeTypeOf('number');
  });
});
