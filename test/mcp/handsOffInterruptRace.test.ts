/**
 * The hands-off switch against the transcript check that follows every Stop (Ruling 61, FW-C's concern 2).
 *
 * After a Stop the store reads the transcript's tail 150 ms and 600 ms later for Claude Code's interruption marker
 * (scheduleInterruptCheck), and a hit holds the prompt queue (`userCancelledAt`). That check, and the turn counter
 * that makes it moot once a new turn starts, hold the card OBJECT the Stop saw. A flip that swapped the card for a
 * new object inside that window left the check writing to the old one: the live card never got its Esc hold (the
 * queue could send into a turn the person stopped), and the old object's copy went out without the flag.
 *
 * Real timers and real transcript files, as in userCancelQueueHold.test.ts (fake timers can't see through the file
 * reads). Only the database and the socket manager's broadcast are stand-ins; process.kill is guarded.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mocks = vi.hoisted(() => ({ broadcast: vi.fn() }));

vi.mock('../../server/db.js', () => ({
  upsertSession: vi.fn(),
  updateSessionTitle: vi.fn(),
  updateSessionSummary: vi.fn(),
  updateSessionRemark: vi.fn(),
  updateSessionArchived: vi.fn(),
  migrateSessionId: vi.fn(),
  getPromptsForSession: vi.fn(() => []),
  insertFullPrompt: vi.fn(),
}));

vi.mock('../../server/wsManager.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/wsManager.js')>();
  return { ...mod, broadcast: mocks.broadcast };
});

const realProcessKill = process.kill.bind(process);
vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
  if (signal === 0) return realProcessKill(pid, 0);
  throw new Error(`handsOffInterruptRace.test must never signal a real process (pid ${pid}, ${String(signal ?? 'SIGTERM')})`);
}) as typeof process.kill);

const { handleEvent: rawHandleEvent, getSession, setSessionHandsOff } = await import('../../server/sessionStore.js');
const { EVENT_TYPES } = await import('../../server/constants.js');

const dir = mkdtempSync(join(tmpdir(), 'aasc-handsoff-cancel-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const handleEvent = (payload: Record<string, unknown>) =>
  rawHandleEvent({ tty_path: '/dev/ttys041', cwd: '/tmp/handsoff-cancel', ...payload } as never);

const MARKER = (promptId: string) =>
  JSON.stringify({
    type: 'user',
    promptId,
    interruptedMessageId: 'msg_011CezSAuxTJKSogXqdBsHa6',
    message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] },
  });

/** One turn's transcript; `interrupted` appends Claude Code's marker. */
function transcript(id: string, promptId: string, interrupted: boolean): string {
  const file = join(dir, `${id}.jsonl`);
  const lines = [
    JSON.stringify({ type: 'user', promptId, message: { role: 'user', content: 'do the thing' } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: '' }] } }),
  ];
  if (interrupted) lines.push(MARKER(promptId));
  writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

function runningTurn(id: string, promptId: string): void {
  handleEvent({ session_id: id, hook_event_name: EVENT_TYPES.SESSION_START });
  handleEvent({ session_id: id, hook_event_name: EVENT_TYPES.USER_PROMPT_SUBMIT, prompt: 'do the thing', prompt_id: promptId });
}

const stop = (id: string, file: string, promptId: string) =>
  handleEvent({ session_id: id, hook_event_name: EVENT_TYPES.STOP, transcript_path: file, prompt_id: promptId });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Past both reads (150 ms + 600 ms) and the 20 ms batch. */
const afterChecks = () => sleep(900);

type Update = { type: string; session?: { sessionId: string; handsOff?: boolean; userCancelledAt?: number | null; status?: string } };
const updatesFor = (sessionId: string): Update[] =>
  mocks.broadcast.mock.calls
    .map(([message]) => message as Update)
    .filter((m) => m.type === 'session_update' && m.session?.sessionId === sessionId);

describe('a hands-off flip inside the transcript check after a Stop', () => {
  it('a flip before the first read: the live card gets the Esc hold and keeps the flag', async () => {
    runningTurn('hoc-1', 'p1');
    stop('hoc-1', transcript('hoc-1', 'p1', true), 'p1');
    setSessionHandsOff('hoc-1', true); // inside the 150 ms before the first read
    mocks.broadcast.mockClear();

    await afterChecks();

    const live = getSession('hoc-1');
    expect(live?.userCancelledAt).toBeTypeOf('number');
    expect(live?.handsOff).toBe(true);
    const last = updatesFor('hoc-1').at(-1);
    expect(last?.session?.userCancelledAt).toBeTypeOf('number');
    expect(last?.session?.handsOff).toBe(true);
    expect(updatesFor('hoc-1').every((u) => u.session?.handsOff === true)).toBe(true);
  });

  it('a flip between the two reads (a slow marker write): same', async () => {
    runningTurn('hoc-2', 'p2');
    const file = transcript('hoc-2', 'p2', false);
    stop('hoc-2', file, 'p2');
    await sleep(300); // past the first read, which found nothing
    setSessionHandsOff('hoc-2', true);
    appendFileSync(file, MARKER('p2') + '\n'); // the marker lands before the second read
    mocks.broadcast.mockClear();

    await afterChecks();

    expect(getSession('hoc-2')?.userCancelledAt).toBeTypeOf('number');
    expect(getSession('hoc-2')?.handsOff).toBe(true);
    expect(updatesFor('hoc-2').every((u) => u.session?.handsOff === true)).toBe(true);
  });

  it('a flip, then the person types again: the check is moot and no stale copy goes out', async () => {
    runningTurn('hoc-3', 'p3');
    stop('hoc-3', transcript('hoc-3', 'p3', true), 'p3');
    setSessionHandsOff('hoc-3', true);
    await sleep(40); // the flip's own update (copied while the turn was stopped) goes out; still before the first read
    mocks.broadcast.mockClear();
    handleEvent({ session_id: 'hoc-3', hook_event_name: EVENT_TYPES.USER_PROMPT_SUBMIT, prompt: 'next', prompt_id: 'p3b' });

    await afterChecks();

    expect(getSession('hoc-3')?.userCancelledAt ?? null).toBeNull();
    expect(getSession('hoc-3')?.status).toBe('prompting');
    // Nothing the check sent may roll the windows back to the stopped turn or drop the flag.
    for (const u of updatesFor('hoc-3')) {
      expect(u.session?.handsOff).toBe(true);
      expect(u.session?.status).not.toBe('waiting');
    }
  });
});
