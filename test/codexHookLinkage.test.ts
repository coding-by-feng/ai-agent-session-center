/**
 * AASC-59 through the real session store: which Codex hooks reach the card of the dashboard
 * terminal Codex runs in.
 *
 * Codex 0.162+ runs threads on a shared background app-server daemon by default, and the
 * daemon runs the lifecycle hooks: `tty_path: null`, the daemon's pid, and the daemon's own
 * environment — so `agent_terminal_id` is the dashboard terminal that happened to auto-start
 * the daemon (seen live: the daemon carried `term-1791834797692-8xw6r4`, three days stale),
 * or nothing. The card of the terminal the prompt was typed into stayed idle with no prompts.
 *
 * The fix is on the launch side (`codex --no-daemon`, see codexNoDaemon.test.ts): the hooks
 * then come from the TUI in the PTY. These tests pin the matching side of that contract:
 *   - the in-process hook sequence (the shape recorded from Codex 0.162.1 with --no-daemon:
 *     SessionStart only at the first prompt, `source: "startup"`, `transcript_path` = the
 *     rollout) lands on the terminal's card: prompt, tools, turn end;
 *   - daemon-shaped hooks still claim nothing — not by a stale terminal id, not by cwd, not
 *     by a session id that merely shares the 8-character prefix the server log prints
 *     (Codex ids are time-ordered UUIDv7s: sessions started in the same minute share it).
 *
 * Nothing here spawns or signals a process: hook payloads only, invented pids above the OS
 * range, terminateProcessTree mocked, process.kill guarded (known-issues.md).
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
  throw new Error(`codexHookLinkage.test must never signal a real process (pid ${pid}, ${String(signal ?? 'SIGTERM')})`);
}) as typeof process.kill);

vi.useFakeTimers({ now: 1_800_000_000_000 });
const { handleEvent, getAllSessions, getSession, createTerminalSession } = await import('../server/sessionStore.js');

const TUI_PID = 4_100_001; // the codex on the PTY (invented)
const DAEMON_PID = 4_100_002; // Codex's shared app-server daemon (invented)
const DESKTOP_PID = 4_100_003; // the ChatGPT desktop app's own app-server (invented)
const STALE_TERM = 'term-1791834797692-8xw6r4'; // the terminal that auto-started the daemon, long gone

let n = 0;
let TERM = '';
let CWD = '';
let TTY = '';
let THREAD = ''; // the AASC Codex thread id (= its rollout id)
let NEIGHBOUR = ''; // another Codex thread started the same minute: same 8-char prefix

beforeEach(async () => {
  n += 1;
  TERM = `term-aasc59-${n}`;
  CWD = `/tmp/aasc-59-${n}/aasc-phone-e2e`;
  TTY = `/dev/ttys${String(100 + n)}`;
  const hex = n.toString(16).padStart(4, '0');
  THREAD = `01a1431a-6dbc-7fd2-9f87-00175b7a${hex}`;
  NEIGHBOUR = `01a1431a-9e01-7c44-8a10-3b2f0c1d${hex}`;
  mocks.broadcast.mockClear();
  await createTerminalSession(TERM, {
    host: 'localhost',
    workingDir: CWD,
    command: 'codex --dangerously-bypass-approvals-and-sandbox',
  });
});

afterAll(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const rollout = (id: string) => `/Users/u/.codex/sessions/2026/10/16/rollout-2026-10-16T18-06-07-${id}.jsonl`;

const codexHook = (id: string, event: string, extra: Record<string, unknown>) =>
  handleEvent({
    session_id: id,
    hook_event_name: event,
    cli_source: 'codex',
    codex_event: event,
    cwd: CWD,
    transcript_path: rollout(id),
    model: 'gpt-5.5',
    permission_mode: 'bypassPermissions',
    ...extra,
  } as never);

/** A hook run by the TUI itself (`codex --no-daemon`): its child, on the PTY's tty. */
const inProcess = (id: string, event: string, extra: Record<string, unknown> = {}) =>
  codexHook(id, event, { tty_path: TTY, claude_pid: TUI_PID, agent_terminal_id: TERM, ...extra });

/** A hook run by the shared daemon: no tty, the daemon's pid, the daemon's environment. */
const fromDaemon = (id: string, event: string, extra: Record<string, unknown> = {}) =>
  codexHook(id, event, { tty_path: null, claude_pid: DAEMON_PID, agent_terminal_id: STALE_TERM, ...extra });

const cardsOwning = (termId: string) =>
  Object.values(getAllSessions()).filter((s) => s.terminalId === termId || s.lastTerminalId === termId);

/** The turn the phone sent: "write hello.md", one shell call, then done. */
const runTurn = (send: typeof inProcess, id: string) => [
  send(id, 'SessionStart', { source: 'startup' }),
  send(id, 'UserPromptSubmit', { prompt: 'write hello.md with one line', turn_id: `${id}-t1` }),
  send(id, 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'echo hi > hello.md' }, tool_use_id: 'call_1' }),
  send(id, 'PostToolUse', { tool_name: 'Bash', tool_input: { command: 'echo hi > hello.md' }, tool_use_id: 'call_1', tool_response: '' }),
  send(id, 'Stop', { response: 'done', last_assistant_message: 'done' }),
];

describe('Codex hooks run by the TUI in the PTY (codex --no-daemon)', () => {
  it('land on the terminal\'s card: re-keyed to the thread id, prompt, tool and turn end recorded', () => {
    const results = runTurn(inProcess, THREAD);
    expect(results.every((r) => r !== null)).toBe(true);

    const card = getSession(THREAD);
    expect(card?.sessionId).toBe(THREAD);
    expect(card?.terminalId).toBe(TERM);
    expect(card?.promptHistory.map((p) => p.text)).toEqual(['write hello.md with one line']);
    expect(card?.toolUsage.Bash).toBe(1);
    expect(card?.status).toBe('waiting');
    expect(card?.cliSource ?? 'codex').toBe('codex');
    expect(card?.transcriptPath).toBe(rollout(THREAD));

    // One terminal, one card: the placeholder was re-keyed, not duplicated.
    expect(cardsOwning(TERM)).toHaveLength(1);
    expect(Object.keys(getAllSessions())).not.toContain(TERM);
  });

  it('also bind when the UserPromptSubmit reaches the queue before the SessionStart', () => {
    inProcess(THREAD, 'UserPromptSubmit', { prompt: 'first', turn_id: 't1' });
    inProcess(THREAD, 'SessionStart', { source: 'startup' });
    const card = getSession(THREAD);
    expect(card?.terminalId).toBe(TERM);
    expect(card?.promptHistory.map((p) => p.text)).toEqual(['first']);
    expect(cardsOwning(TERM)).toHaveLength(1);
  });
});

describe('Codex hooks run by the shared daemon (what Codex 0.162 does without --no-daemon)', () => {
  it('claim nothing: no card, and the terminal\'s card is left untouched (the matcher never binds by cwd)', () => {
    const before = Object.keys(getAllSessions()).sort();

    const results = runTurn(fromDaemon, THREAD);

    expect(results.every((r) => r === null)).toBe(true);
    expect(getSession(THREAD)).toBeNull();
    expect(Object.keys(getAllSessions()).sort()).toEqual(before);
    const placeholder = getSession(TERM);
    expect(placeholder?.terminalId).toBe(TERM);
    expect(placeholder?.promptHistory).toEqual([]);
  });

  it('claim nothing when the daemon carries no terminal id either', () => {
    const before = Object.keys(getAllSessions()).sort();
    const results = runTurn((id, event, extra = {}) => fromDaemon(id, event, { ...extra, agent_terminal_id: null }), THREAD);
    expect(results.every((r) => r === null)).toBe(true);
    expect(Object.keys(getAllSessions()).sort()).toEqual(before);
  });
});

describe('an unrelated Codex session that shares the 8-character id prefix', () => {
  it('is not captured by the bound AASC card, nor given one of its own', () => {
    runTurn(inProcess, THREAD);
    expect(NEIGHBOUR.slice(0, 8)).toBe(THREAD.slice(0, 8));
    const before = Object.keys(getAllSessions()).sort();

    // The ChatGPT desktop app's Codex, same folder, same minute, its own app-server.
    const results = runTurn(
      (id, event, extra = {}) => codexHook(id, event, { tty_path: null, claude_pid: DESKTOP_PID, agent_terminal_id: null, ...extra }),
      NEIGHBOUR,
    );

    expect(results.every((r) => r === null)).toBe(true);
    expect(getSession(NEIGHBOUR)).toBeNull();
    expect(Object.keys(getAllSessions()).sort()).toEqual(before);
    const card = getSession(THREAD);
    expect(card?.promptHistory).toHaveLength(1);
    expect(card?.toolUsage.Bash).toBe(1);
  });

  it('does not take a still-connecting AASC terminal by its folder (Priority 2/3 need a tty)', () => {
    // Phone one-tap: the terminal is up, Codex is still starting, and a Codex outside AASC
    // (desktop app, or the daemon) starts a thread in the very same folder.
    expect(getSession(TERM)?.status).toBe('connecting');
    const outsider = codexHook(NEIGHBOUR, 'SessionStart', { source: 'startup', tty_path: null, claude_pid: DESKTOP_PID, agent_terminal_id: null });
    expect(outsider).toBeNull();
    expect(getSession(NEIGHBOUR)).toBeNull();
    expect(getSession(TERM)?.terminalId).toBe(TERM);

    // The AASC Codex's own hooks then bind as usual.
    runTurn(inProcess, THREAD);
    expect(cardsOwning(TERM).map((s) => s.sessionId)).toEqual([THREAD]);
  });

  it('cannot take over the AASC terminal through the daemon\'s stale terminal id either', () => {
    runTurn(inProcess, THREAD);
    runTurn(fromDaemon, NEIGHBOUR);
    expect(getSession(NEIGHBOUR)).toBeNull();
    expect(cardsOwning(TERM).map((s) => s.sessionId)).toEqual([THREAD]);
  });
});
