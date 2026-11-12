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
  /** Live output listeners by terminal (no real PTY here): `paint` feeds them. */
  taps: new Map<string, (chunk: string) => void>(),
  untapped: new Set<(chunk: string) => void>(),
  tap: vi.fn(),
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
  return { ...mod, getForegroundProcess: mocks.foreground, tapTerminalOutput: mocks.tap };
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
const { getSession, createTerminalSession, terminalHeard, deleteSessionFromMemory } = await import('../../server/sessionStore.js');
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
  mocks.taps.clear();
  mocks.untapped.clear();
  mocks.tap.mockReset();
  mocks.tap.mockImplementation((id: string, listener: (chunk: string) => void) => {
    mocks.taps.set(id, listener);
    return () => {
      mocks.untapped.add(listener);
      if (mocks.taps.get(id) === listener) mocks.taps.delete(id);
    };
  });
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

describe('a trusted local Codex leaves connecting once its input has settled (codexReadyWatch)', () => {
  const CODEX_SCREEN = '\x1b[1m>_ OpenAI Codex\x1b[0m (v0.165)\x1b[27;1H\x1b[1m›\x1b[22m \x1b[2mAsk Codex to do anything';
  /** Codex prints to the card's terminal now. */
  const paint = (chunk = CODEX_SCREEN): void => mocks.taps.get(TERM)?.(chunk);
  const launchTrustedCodex = async (): Promise<void> => {
    mocks.codex.text = trusting(DIR);
    mocks.foreground.mockReturnValue('codex');
    await createTerminalSession(TERM, { host: 'localhost', workingDir: DIR, command: 'codex' });
  };

  it('is idle and heard ~1.5 s after its input row went quiet, and the 30 s timer is cleared', async () => {
    await launchTrustedCodex();
    await vi.advanceTimersByTimeAsync(800);
    paint();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(getSession(TERM)?.status).toBe('connecting');
    const timersBefore = vi.getTimerCount();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(getSession(TERM)?.status).toBe('idle');
    expect(getSession(TERM)?.startHeard).toBeUndefined();
    expect(terminalHeard(TERM)).toBe(true);
    expect(broadcastCards(TERM).at(-1)).toMatchObject({ status: 'idle' });
    expect(mocks.log.info).toHaveBeenCalledWith('session', expect.stringContaining(`${TERM} to idle after its Codex input settled`));
    // Its poll and its 30 s timer are both gone, and the tap is released.
    expect(vi.getTimerCount()).toBe(timersBefore - 2);
    expect(mocks.taps.has(TERM)).toBe(false);
  });

  it('waits while Codex is still painting', async () => {
    await launchTrustedCodex();
    for (let i = 0; i < 10; i += 1) {
      paint();
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(getSession(TERM)?.status).toBe('connecting');
    await vi.advanceTimersByTimeAsync(1_600);
    expect(getSession(TERM)?.status).toBe('idle');
  });

  it('keeps the 30 s path with no new output, a Codex menu, an untrusted folder or a shell in front', async () => {
    const cases: Array<[string, () => void, string | null]> = [
      // A restore prefills the replay ring with the old screen; only live output counts.
      ['no new output', () => {}, null],
      ['a menu', () => {}, 'Update available\x1b[5;1H› 1. Update now\x1b[6;1H  2. Skip'],
      ['untrusted', () => { mocks.codex.text = trusting(DIR, 'untrusted'); }, CODEX_SCREEN],
      ['shell in front', () => { mocks.foreground.mockReturnValue('zsh'); }, CODEX_SCREEN],
    ];
    for (const [label, setUp, screen] of cases) {
      n += 1;
      TERM = `term-heard-${n}`;
      mocks.codex.text = trusting(DIR);
      mocks.codex.mtime = n;
      mocks.foreground.mockReturnValue('codex');
      setUp();
      await createTerminalSession(TERM, { host: 'localhost', workingDir: DIR, command: 'codex' });
      if (screen) paint(screen);
      await vi.advanceTimersByTimeAsync(CONNECTING_MS - 1_000);
      expect(getSession(TERM)?.status, label).toBe('connecting');
      await vi.advanceTimersByTimeAsync(1_000);
      expect(getSession(TERM)?.status, label).toBe('idle');
      expect(mocks.taps.has(TERM), label).toBe(false);
    }
  });

  it('never watches a Claude card or a card on another host', async () => {
    mocks.codex.text = trusting(DIR);
    mocks.foreground.mockReturnValue('claude');
    await createTerminalSession(TERM, { host: 'localhost', workingDir: DIR, command: 'claude' });
    n += 1;
    TERM = `term-heard-${n}`;
    mocks.foreground.mockReturnValue('codex');
    await createTerminalSession(TERM, { host: 'build-box', username: 'me', workingDir: DIR, command: 'codex' });
    expect(mocks.tap).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(CONNECTING_MS);
  });

  it('a hook that arrives first ends the watch and keeps the hook\'s state', async () => {
    await launchTrustedCodex();
    paint();
    await processHookEvent({
      session_id: CLI,
      hook_event_name: 'UserPromptSubmit',
      cli_source: 'codex',
      cwd: DIR,
      agent_terminal_id: TERM,
      tty_path: '/dev/ttys051',
      codex_pid: 4_000_100 + n,
    } as never);
    expect(getSession(TERM)?.status).not.toBe('connecting');
    const status = getSession(CLI)?.status ?? getSession(TERM)?.status;
    expect(status).toBe('prompting');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(mocks.taps.has(TERM)).toBe(false);
    expect(mocks.log.info).not.toHaveBeenCalledWith('session', expect.stringContaining(`${TERM} to idle after its Codex input settled`));
    await vi.advanceTimersByTimeAsync(CONNECTING_MS);
  });

  it('a reused terminal id stops the older card\'s watch and the new card gets its own', async () => {
    await launchTrustedCodex();
    const first = mocks.taps.get(TERM);
    await vi.advanceTimersByTimeAsync(10_000);
    // The first card is gone (its id free again) before its 30 s timer fired.
    deleteSessionFromMemory(TERM);
    await createTerminalSession(TERM, { host: 'localhost', workingDir: DIR, command: 'codex' });
    expect(mocks.tap).toHaveBeenCalledTimes(2);
    expect(mocks.taps.get(TERM)).not.toBe(first);
    expect(first && mocks.untapped.has(first)).toBe(true);
    paint();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(getSession(TERM)?.status).toBe('idle');
    expect(mocks.log.info).toHaveBeenCalledWith('session', expect.stringContaining(`${TERM} to idle after its Codex input settled`));
    await vi.advanceTimersByTimeAsync(CONNECTING_MS);
  });
});
