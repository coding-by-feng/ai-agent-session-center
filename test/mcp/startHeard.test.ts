/**
 * The never-started marker through the real session store and hook pipeline (Rulings P4-35, P4-41, P4-42, P4-44): the
 * connecting timeout that turns a claude/codex card idle with no hook from its terminal marks it `startHeard: false`
 * (its CLI may be showing its folder-trust prompt), and the first hook from that terminal clears it on every card of
 * the terminal (a re-keyed card too) inside handleEvent, before hookProcessor tells the hook's listeners
 * (emitTerminalHook), so a task waiting on that start is sent to a card the prompt route no longer refuses. A Codex
 * card counts as heard at the timeout only in a folder the owner's Codex trusts, with codex in front (Ruling P4-46).
 *
 * Nothing here spawns or signals a process: the store is driven with hook payloads only, every pid is invented (above
 * the OS pid range), terminateProcessTree is mocked and process.kill is guarded (known-issues.md). The Codex trust
 * record is an injected reader: the real ~/.codex/config.toml is never read.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  broadcast: vi.fn(),
  terminateProcessTree: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
  /** The owner's Codex config as the injected reader sees it: null text = unreadable, null mtime = missing. */
  codex: { text: '' as string | null, mtime: 1 as number | null },
  foreground: vi.fn((): string | null => null),
}));

vi.mock('../../server/logger.js', () => ({ default: mocks.log }));

vi.mock('../../server/codexTrust.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/codexTrust.js')>();
  return {
    ...mod,
    createCodexTrust: () =>
      mod.createCodexTrust({
        mtime: () => mocks.codex.mtime,
        read: () => {
          if (mocks.codex.text === null) throw new Error('EACCES');
          return mocks.codex.text;
        },
        // macOS's /tmp is a link to /private/tmp: the record names the real path.
        realpath: (p) => p.replace(/^\/tmp\//, '/private/tmp/'),
      }),
  };
});

vi.mock('../../server/sshManager.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/sshManager.js')>();
  return { ...mod, getForegroundProcess: mocks.foreground };
});

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

vi.mock('../../server/processMonitor.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/processMonitor.js')>();
  return {
    ...mod,
    startMonitoring: vi.fn(),
    stopMonitoring: vi.fn(),
    startExternalDiscovery: vi.fn(),
    terminateProcessTree: mocks.terminateProcessTree,
  };
});

// Second line of defence: any real signal other than the liveness probe (signal 0) fails loudly.
const realProcessKill = process.kill.bind(process);
vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
  if (signal === 0) return realProcessKill(pid, 0);
  throw new Error(`startHeard.test must never signal a real process (pid ${pid}, ${String(signal ?? 'SIGTERM')})`);
}) as typeof process.kill);

// The store starts a 10 s auto-idle interval on import, so the clock has to be fake first.
vi.useFakeTimers({ now: 1_800_000_000_000 });
const { getSession, createTerminalSession, terminalHeard } = await import('../../server/sessionStore.js');
const { processHookEvent } = await import('../../server/hookProcessor.js');
const { onTerminalHook } = await import('../../server/hookSignals.js');

const CONNECTING_MS = 30_000;
let n = 0;
let TERM = '';
let CLI = '';
let DIR = '';

/** A hook from the CLI in TERM, as the dashboard hook script sends it. */
const hookFromTerm = (event: string) =>
  processHookEvent({
    session_id: CLI,
    hook_event_name: event,
    cli_source: 'claude',
    cwd: DIR,
    agent_terminal_id: TERM,
    tty_path: '/dev/ttys051',
    claude_pid: 4_000_100 + n,
  } as never);

/** The SESSION_UPDATE cards broadcast for `id` so far. */
const broadcastCards = (id: string): Array<Record<string, unknown>> =>
  mocks.broadcast.mock.calls
    .map(([msg]) => msg as { type?: string; session?: Record<string, unknown> })
    .filter((msg) => msg.type === 'session_update' && msg.session?.sessionId === id)
    .map((msg) => msg.session as Record<string, unknown>);

beforeEach(() => {
  n += 1;
  TERM = `term-heard-${n}`;
  CLI = `cli-heard-${n}`;
  DIR = `/tmp/aasc-heard-${n}`;
  mocks.broadcast.mockReset();
  mocks.log.error.mockClear();
  mocks.codex.text = '';
  mocks.codex.mtime = n;
  mocks.foreground.mockReset();
  mocks.foreground.mockReturnValue(null);
});

/** The owner's Codex config trusting `folder` (as Codex writes it: the real path). */
const trusting = (folder: string, level = 'trusted'): string =>
  `model = "gpt-5"\n\n[projects."${folder.replace(/^\/tmp\//, '/private/tmp/')}"]\ntrust_level = "${level}"\n`;

afterAll(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the connecting timeout marks a card it turns idle (Ruling P4-35)', () => {
  it('a claude card that sent no hook in 30 s is idle and startHeard false, on the broadcast card too', async () => {
    await createTerminalSession(TERM, { host: 'localhost', workingDir: DIR, command: 'claude' });
    expect(getSession(TERM)?.startHeard).toBeUndefined();
    await vi.advanceTimersByTimeAsync(CONNECTING_MS);
    expect(getSession(TERM)).toMatchObject({ status: 'idle', startHeard: false });
    expect(broadcastCards(TERM).at(-1)).toMatchObject({ status: 'idle', startHeard: false });
  });

  it('a Codex card in a folder Codex does not trust is marked', async () => {
    // Codex 0.163 shows its own "Trust this folder?" prompt there, which AASC never answers.
    const cases: Array<[string, string]> = [
      ['no record', ''],
      ['another folder', trusting('/tmp/somewhere-else')],
      ['untrusted', trusting(DIR, 'untrusted')],
      ['a parent folder', trusting('/tmp')],
    ];
    for (const [label, text] of cases) {
      n += 1;
      TERM = `term-heard-${n}`;
      mocks.codex.text = text;
      mocks.codex.mtime = n;
      mocks.foreground.mockReturnValue('codex');
      await createTerminalSession(TERM, { host: 'localhost', workingDir: DIR, command: 'codex' });
      await vi.advanceTimersByTimeAsync(CONNECTING_MS);
      expect(getSession(TERM), label).toMatchObject({ status: 'idle', startHeard: false });
      expect(terminalHeard(TERM), label).toBe(false);
    }
  });

  it('a Codex card in a folder Codex trusts counts as heard after the timeout', async () => {
    mocks.codex.text = trusting(DIR);
    mocks.foreground.mockReturnValue('codex');
    await createTerminalSession(TERM, { host: 'localhost', workingDir: DIR, command: 'codex --model gpt-5' });
    await vi.advanceTimersByTimeAsync(CONNECTING_MS);
    expect(getSession(TERM)?.status).toBe('idle');
    expect(getSession(TERM)?.startHeard).toBeUndefined();
    expect(mocks.foreground).toHaveBeenCalledWith(TERM);
    // Heard by its trust record (Ruling P4-52): the prompt route and the ledger's start poll take it.
    expect(terminalHeard(TERM)).toBe(true);
  });

  it('a Codex card in a trusted folder is still marked when codex is not in front, or the host is not this Mac', async () => {
    mocks.codex.text = trusting(DIR);
    mocks.foreground.mockReturnValue('zsh');
    await createTerminalSession(TERM, { host: 'localhost', workingDir: DIR, command: 'codex' });
    await vi.advanceTimersByTimeAsync(CONNECTING_MS);
    expect(getSession(TERM)?.startHeard).toBe(false);

    n += 1;
    TERM = `term-heard-${n}`;
    mocks.foreground.mockReturnValue('codex');
    await createTerminalSession(TERM, { host: 'build-box', username: 'me', workingDir: DIR, command: 'codex' });
    await vi.advanceTimersByTimeAsync(CONNECTING_MS);
    expect(getSession(TERM)?.startHeard).toBe(false);
  });

  it('an unreadable Codex config trusts nothing', async () => {
    const cases: Array<[string, () => void]> = [
      ['unreadable', () => { mocks.codex.text = null; }],
      ['missing', () => { mocks.codex.mtime = null; }],
      ['not TOML', () => { mocks.codex.text = `[projects."${DIR}"\ntrust_level = "trusted"`; }],
    ];
    for (const [label, setUp] of cases) {
      n += 1;
      TERM = `term-heard-${n}`;
      mocks.codex.text = trusting(DIR);
      mocks.codex.mtime = n;
      setUp();
      mocks.foreground.mockReturnValue('codex');
      await createTerminalSession(TERM, { host: 'localhost', workingDir: DIR, command: 'codex' });
      await vi.advanceTimersByTimeAsync(CONNECTING_MS);
      expect(getSession(TERM)?.startHeard, label).toBe(false);
    }
  });

  it('a Claude card is unaffected by Codex’s trust record', async () => {
    mocks.codex.text = trusting(DIR);
    mocks.foreground.mockReturnValue('claude');
    await createTerminalSession(TERM, { host: 'localhost', workingDir: DIR, command: 'claude' });
    await vi.advanceTimersByTimeAsync(CONNECTING_MS);
    expect(getSession(TERM)).toMatchObject({ status: 'idle', startHeard: false });
  });

  it('a plain shell (no agent, no hooks ever) is not marked', async () => {
    await createTerminalSession(TERM, { host: 'localhost', workingDir: DIR, command: 'bash' });
    await vi.advanceTimersByTimeAsync(CONNECTING_MS);
    expect(getSession(TERM)?.status).toBe('idle');
    expect(getSession(TERM)?.startHeard).toBeUndefined();
  });

  it('a card whose terminal hooked in time is never marked', async () => {
    await createTerminalSession(TERM, { host: 'localhost', workingDir: DIR, command: 'claude' });
    hookFromTerm('SessionStart');
    await vi.advanceTimersByTimeAsync(CONNECTING_MS);
    expect(getSession(CLI)?.startHeard).toBeUndefined();
  });

  it('the timer’s callback catches and logs: a failed broadcast is no unhandled rejection (Ruling P4-44)', async () => {
    await createTerminalSession(TERM, { host: 'localhost', workingDir: DIR, command: 'claude' });
    mocks.broadcast.mockImplementationOnce(() => {
      throw new Error('the window socket went away');
    });
    await vi.advanceTimersByTimeAsync(CONNECTING_MS);
    expect(mocks.log.error).toHaveBeenCalledTimes(1);
    expect(String(mocks.log.error.mock.calls[0][1])).toMatch(/connecting timeout/i);
  });
});

describe('a hook from another terminal than its card’s (Ruling P4-53)', () => {
  it('hears neither terminal: an adoption by path is not a start', async () => {
    await createTerminalSession(TERM, { host: 'localhost', workingDir: DIR, command: 'claude' });
    const OTHER = `term-other-${n}`;
    const delta = processHookEvent({
      session_id: CLI,
      hook_event_name: 'SessionStart',
      cli_source: 'claude',
      cwd: DIR,
      agent_terminal_id: OTHER,
      tty_path: '/dev/ttys052',
      claude_pid: 4_000_200 + n,
    } as never);
    // Whichever card the matcher gave it, a card on TERM, the hook came from OTHER.
    const card = delta && 'session' in delta ? delta.session : null;
    expect(card?.terminalId).toBe(TERM);
    expect(terminalHeard(TERM)).toBe(false);
    expect(terminalHeard(OTHER)).toBe(false);
  });

  it('a hook from the card’s own terminal hears it', async () => {
    await createTerminalSession(TERM, { host: 'localhost', workingDir: DIR, command: 'claude' });
    hookFromTerm('SessionStart');
    expect(terminalHeard(TERM)).toBe(true);
  });
});

describe('a hook with no terminal id (Ruling P4-59)', () => {
  /** A hook with no agent_terminal_id; `tty` absent is a payload that claims no terminal (Windows). */
  const noIdHook = (tty?: string) =>
    processHookEvent({
      session_id: CLI,
      hook_event_name: 'SessionStart',
      cli_source: 'claude',
      cwd: DIR,
      ...(tty === undefined ? {} : { tty_path: tty }),
      claude_pid: 4_000_300 + n,
    } as never);

  it('an external-tty SessionStart adopting a connecting card hears nothing', async () => {
    // `claude` started in iTerm in the same folder: its hook has a tty of its own and no AASC terminal id. AASC keeps
    // no PTY's tty to tell it is the card's own, so it hears nothing: the card's CLI may still be at its trust prompt.
    await createTerminalSession(TERM, { host: 'localhost', workingDir: DIR, command: 'claude' });
    const delta = noIdHook('/dev/ttys060');
    const card = delta && 'session' in delta ? delta.session : null;
    expect(card?.terminalId).toBe(TERM);
    expect(terminalHeard(TERM)).toBe(false);
  });

  it('one that claims no terminal and no tty still hears the card’s terminal (Windows, as before)', async () => {
    await createTerminalSession(TERM, { host: 'localhost', workingDir: DIR, command: 'claude' });
    const delta = noIdHook();
    const card = delta && 'session' in delta ? delta.session : null;
    expect(card?.terminalId).toBe(TERM);
    expect(terminalHeard(TERM)).toBe(true);
  });
});

describe('the first hook clears the marker before the ledger hears it (Ruling P4-41)', () => {
  it('a listener on the terminal sees the card already cleared, under its new id after the re-key', async () => {
    await createTerminalSession(TERM, { host: 'localhost', workingDir: DIR, command: 'claude' });
    await vi.advanceTimersByTimeAsync(CONNECTING_MS);
    expect(getSession(TERM)?.startHeard).toBe(false);

    const seen: Array<boolean | undefined> = [];
    const stop = onTerminalHook(TERM, (signal) => {
      seen.push(getSession(signal.sessionId)?.startHeard);
    });
    hookFromTerm('SessionStart');
    stop();

    // The card was re-keyed term-* → the CLI's id; the listener read it already cleared.
    expect(seen).toEqual([undefined]);
    expect(getSession(CLI)?.terminalId).toBe(TERM);
    expect(getSession(CLI)?.startHeard).toBeUndefined();
    // The card every window gets (after the 250 ms hook throttle) carries no marker either.
    await vi.advanceTimersByTimeAsync(300);
    const sent = broadcastCards(CLI);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((card) => card.startHeard === undefined)).toBe(true);
  });
});
