/**
 * PINNED drag (Nov 18 2026): the server keeps each pinned card's place (`pinOrder`). A new pin
 * goes to the end, unpinning gives up the place, a drag renumbers, a restore keeps its slot.
 * No real process is touched: db, broadcast and the process monitor are mocked, and
 * process.kill throws on anything but signal 0 (see .claude/rules/known-issues.md).
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

const mocks = vi.hoisted(() => ({ broadcast: vi.fn(), terminateProcessTree: vi.fn() }));

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
  return { ...mod, broadcast: mocks.broadcast };
});

vi.mock('../server/processMonitor.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../server/processMonitor.js')>();
  return {
    ...mod,
    startMonitoring: vi.fn(),
    stopMonitoring: vi.fn(),
    startExternalDiscovery: vi.fn(),
    terminateProcessTree: mocks.terminateProcessTree,
  };
});

const realProcessKill = process.kill.bind(process);
vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
  if (signal === 0) return realProcessKill(pid, 0);
  throw new Error(`pinOrderStore.test must never signal a real process (pid ${pid}, ${String(signal ?? 'SIGTERM')})`);
}) as typeof process.kill);

const { getSession, createTerminalSession, setSessionPinned, setPinnedOrder } =
  await import('../server/sessionStore.js');

let n = 0;
async function cards(count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    n += 1;
    const id = `term-pin-order-${n}`;
    await createTerminalSession(id, { host: 'localhost', workingDir: `/tmp/pin-order-${n}`, command: 'claude' });
    ids.push(id);
  }
  return ids;
}
const place = (id: string) => getSession(id)?.pinOrder;

beforeEach(() => { mocks.broadcast.mockClear(); });
afterAll(() => { vi.restoreAllMocks(); });

describe('server pinOrder', () => {
  it('puts each new pin after the others, and unpinning clears the place', async () => {
    const [a, b, c] = await cards(3);
    setSessionPinned(a, true);
    setSessionPinned(b, true);
    setSessionPinned(c, true);
    expect(place(a)!).toBeLessThan(place(b)!);
    expect(place(b)!).toBeLessThan(place(c)!);
    setSessionPinned(b, false);
    expect(place(b)).toBeUndefined();
    setSessionPinned(b, true);
    expect(place(b)!).toBeGreaterThan(place(c)!);
  });

  it('a drag renumbers the pinned cards and broadcasts the ones that moved', async () => {
    const [a, b, c] = await cards(3);
    [a, b, c].forEach((id) => setSessionPinned(id, true));
    mocks.broadcast.mockClear();
    expect(setPinnedOrder([c, a, b])).toBeGreaterThan(0);
    expect([place(c), place(a), place(b)]).toEqual([1, 2, 3]);
    // broadcastSessionUpdate debounces (~20 ms) before it sends.
    await vi.waitFor(() => expect(mocks.broadcast.mock.calls.some(([msg]) =>
      (msg as { session?: { sessionId?: string; pinOrder?: number } })?.session?.sessionId === c
        && (msg as { session?: { pinOrder?: number } }).session?.pinOrder === 1)).toBe(true));
    mocks.broadcast.mockClear();
    expect(setPinnedOrder([c, a, b])).toBe(0);
  });

  it('a device that sees only some pins reorders those, and the hidden ones keep their places', async () => {
    const [a, hidden, b] = await cards(3);
    [a, hidden, b].forEach((id) => setSessionPinned(id, true));
    const before = place(hidden);
    const visible = (id: string) => id !== hidden;
    expect(setPinnedOrder([b, a], visible)).toBeGreaterThan(0);
    expect(place(b)!).toBeLessThan(place(a)!);
    expect(place(hidden)).toBe(before);
  });

  it('a pinned card restored with its place keeps it', async () => {
    n += 1;
    const id = `term-pin-order-${n}`;
    await createTerminalSession(id, { host: 'localhost', workingDir: `/tmp/pin-order-${n}`, command: 'claude', pinned: true, pinOrder: 7 });
    expect(getSession(id)?.pinned).toBe(true);
    expect(place(id)).toBe(7);
  });
});
