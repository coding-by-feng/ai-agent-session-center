// test/mcp/storedCommand.test.ts — a central's launch flags never stay in a stored command.
//
// The hook records `ps -p $PPID -o args=` as a session's startupCommand, and a resume, clone or fork
// replays it. ps prints the arguments the shell built, joined by spaces, so a central's flag shows its
// JSON bare, with `${AASC_MCP_TOKEN}` in it. Typed raw into a live shell that holds the token (resume of
// a card whose terminal is still open writes straight to the PTY, past every launch hook), the shell
// expands the placeholder: the token lands in argv, where `ps` shows it to every process, and the
// mangled JSON stops the CLI starting. So a stored command is cleaned where it comes in:
//   - the hook's capture (sessionStore), and
//   - the startupCommand a workspace restore sends to POST /api/terminals (apiRouter),
// and the line the resume route builds (buildResumeCommand) is cleaned again on the way out, so what is
// typed never depends on what was stored.
//
// The session title is untrusted and `ps` prints it, unquoted, ahead of the flag. A title that holds
// shell syntax (`Central (main)`, `Kason's boss`, `R&D`, `a;b`, a trailing backslash …) must not hide the
// flag from the strip, so every case here is run for each of AWKWARD_TITLES.
//
// No process is real: node-pty is a recording stand-in, createTerminal is replaced on the route test,
// and the database is stubbed. The one thing run for real is `/bin/sh` printing the words it built, to
// get the exact rendering `ps` gives and to check what a shell does with a replayed command.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalConfig } from '../../src/types/terminal.js';
import { appendSessionName } from '../../server/config.js';
import { applyCentralLaunch, claudeMcpConfigJson, MCP_TOKEN_ENV } from '../../server/mcp/launch.js';
import { AWKWARD_TITLES, PORT, psRendering } from './launchFixtures.js';

vi.mock('node-pty', async () => (await import('./fakePty.js')).nodePtyModule);

// db.ts opens better-sqlite3 at module scope; stub it so this suite runs under any Node ABI.
vi.mock('../../server/db.js', () => ({
  upsertSession: vi.fn(),
  updateSessionTitle: vi.fn(),
  updateSessionSummary: vi.fn(),
  updateSessionRemark: vi.fn(),
  updateSessionArchived: vi.fn(),
  migrateSessionId: vi.fn(),
  getPromptsForSession: vi.fn(() => []),
  insertFullPrompt: vi.fn(),
  getRecentSessions: vi.fn(() => []),
  getSessionById: vi.fn(() => null),
  deleteSession: vi.fn(),
  default: {},
}));

const log = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  debugJson: vi.fn(),
  isDebug: false,
}));
vi.mock('../../server/logger.js', () => ({ default: log }));

const mocks = vi.hoisted(() => ({ createTerminal: vi.fn() }));
vi.mock('../../server/sshManager.js', async () => {
  const actual = await vi.importActual<typeof import('../../server/sshManager.js')>(
    '../../server/sshManager.js',
  );
  return { ...actual, createTerminal: mocks.createTerminal };
});

/** Anything in a stored command that names the flag, the server or the variable. */
const NAMES_US = /mcp-config|mcp_servers\.aasc|AASC_MCP_TOKEN/;

const FAKE_TOKEN = 'aasc_mcp_FAKE_TOKEN_THAT_MUST_NOT_REACH_ARGV';

/** The line a central's Claude is launched with when its session is called `title` (what the modals type). */
const centralClaudeLine = (title: string): string =>
  applyCentralLaunch(appendSessionName('claude --dangerously-skip-permissions', title), {
    port: PORT,
  });

/** A resume needs a UUID-shaped session id; one per case keeps the cards apart. */
const uuidFor = (n: number): string =>
  `0a1b2c3d-4e5f-4a6b-8c7d-${(0x9e0f1a2b3c00 + n).toString(16)}`;

/** One case per awkward session title, numbered so each gets its own session. */
const TITLE_CASES = AWKWARD_TITLES.map((title, n) => ({ title, n }));

/**
 * What a real shell makes of a line typed into a terminal that holds a (fake) token in its environment:
 * each `claude` replaced by `printf`, so what comes back is the arguments the CLI would have been given.
 */
function argvTypedWithToken(line: string): string {
  return execFileSync(
    '/bin/sh',
    ['-c', line.replace(/(^|\|\| )claude\b/g, "$1printf '[%s]\\n' claude")],
    { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', [MCP_TOKEN_ENV]: FAKE_TOKEN } },
  );
}

const CLAUDE_LAUNCH = 'claude --dangerously-skip-permissions -n "Boss"';
const CODEX_LAUNCH = "codex --yolo resume 'abc'";
/** What each launch looks like in `ps`, and what should be stored for it. */
const CASES = [
  {
    name: 'claude',
    launch: CLAUDE_LAUNCH,
    stored: 'claude --dangerously-skip-permissions -n Boss',
  },
  { name: 'codex', launch: CODEX_LAUNCH, stored: 'codex --yolo resume abc' },
] as const;

describe.skipIf(process.platform === 'win32')('the hook capture (sessionStore)', () => {
  it.each(CASES)(
    'a ps-form startup command is stored clean ($name)',
    async ({ launch, stored, name }) => {
      const { handleEvent, getSession } = await import('../../server/sessionStore.js');
      const ps = psRendering(applyCentralLaunch(launch, { port: PORT }));
      expect(ps).toMatch(NAMES_US); // what the hook is handed does carry the flags

      const result = handleEvent({
        hook_event_name: 'SessionStart',
        session_id: `ps-capture-${name}`,
        cwd: `/tmp/ps-capture-${name}`,
        tty_path: '/dev/ttys001',
        startup_command: ps,
      } as never);

      expect(result?.session.startupCommand).toBe(stored);
      expect(getSession(`ps-capture-${name}`)?.startupCommand).toBe(stored);
      expect(result?.session.startupCommand).not.toMatch(NAMES_US);
    },
  );

  it('a stored command that never carried the flags is kept exactly as before', async () => {
    const { handleEvent } = await import('../../server/sessionStore.js');

    const result = handleEvent({
      hook_event_name: 'SessionStart',
      session_id: 'ps-capture-plain',
      cwd: '/tmp/ps-capture-plain',
      tty_path: '/dev/ttys002',
      startup_command: 'claude --model opus --dangerously-skip-permissions -n My title',
    } as never);

    expect(result?.session.startupCommand).toBe(
      'claude --model opus --dangerously-skip-permissions -n My title',
    );
  });

  it("replaying a central's stored command into a shell that holds its token puts no token in argv", async () => {
    // The resume route types its line straight into the live PTY when the card's terminal is still open.
    const { handleEvent, getSession } = await import('../../server/sessionStore.js');
    const { buildResumeCommand } = await import('../../server/apiRouter.js');
    const ps = psRendering(applyCentralLaunch(CLAUDE_LAUNCH, { port: PORT }));
    const sessionId = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
    handleEvent({
      hook_event_name: 'SessionStart',
      session_id: sessionId,
      cwd: '/tmp/ps-capture-replay',
      tty_path: '/dev/ttys003',
      startup_command: ps,
    } as never);

    const replay = buildResumeCommand(getSession(sessionId)!, sessionId);

    const printed = argvTypedWithToken(replay);
    expect(printed).toContain('[--resume]');
    expect(printed).not.toContain(FAKE_TOKEN);
    // and the line itself names neither the flag nor the variable
    expect(replay).toContain(`--resume '${sessionId}'`);
    expect(replay).not.toMatch(NAMES_US);
  });

  describe('whatever the session is called', () => {
    // The title is ahead of the flag in the ps text, unquoted, and it is untrusted: a name with
    // `( ) ; & |` or a quote that never closes must not hide the flag from the strip. If it did, the
    // flag would be stored, replayed raw into the central's shell and expand the token into argv.
    it.each(TITLE_CASES)(
      'a ps-form startup command is stored clean and replays without the token ($title)',
      async ({ title, n }) => {
        const { handleEvent, getSession } = await import('../../server/sessionStore.js');
        const { buildResumeCommand } = await import('../../server/apiRouter.js');
        const sessionId = uuidFor(100 + n);
        const ps = psRendering(centralClaudeLine(title));
        expect(ps).toContain(`-n ${title} --mcp-config {`);

        handleEvent({
          hook_event_name: 'SessionStart',
          session_id: sessionId,
          cwd: `/tmp/ps-capture-title-${n}`,
          tty_path: `/dev/ttys1${n.toString().padStart(2, '0')}`,
          startup_command: ps,
        } as never);

        const session = getSession(sessionId)!;
        expect(session.startupCommand).toBe(`claude --dangerously-skip-permissions -n ${title}`);
        expect(session.startupCommand).not.toMatch(NAMES_US);
        const replay = buildResumeCommand(session, sessionId);
        expect(replay).not.toMatch(NAMES_US);
        const printed = argvTypedWithToken(replay);
        expect(printed).toContain('[--resume]');
        expect(printed).not.toContain(FAKE_TOKEN);
      },
    );
  });

  it('a Codex ps-form startup command with the binary as a path is stored clean', async () => {
    // ps shows Codex by the full path of its native binary, which is not the bare `codex` the word reading wants
    const { handleEvent, getSession } = await import('../../server/sessionStore.js');
    const codexPath = '/opt/homebrew/lib/node_modules/@openai/codex/vendor/codex';
    const ps = psRendering(applyCentralLaunch("codex --yolo resume 'abc'", { port: PORT })).replace(
      /^codex/,
      codexPath,
    );
    expect(ps).toMatch(NAMES_US);

    handleEvent({
      hook_event_name: 'SessionStart',
      session_id: 'ps-capture-codex-path',
      cwd: '/tmp/ps-capture-codex-path',
      tty_path: '/dev/ttys004',
      startup_command: ps,
    } as never);

    expect(getSession('ps-capture-codex-path')?.startupCommand).toBe(
      `${codexPath} --yolo resume abc`,
    );
  });
});

describe.skipIf(process.platform === 'win32')('buildResumeCommand (apiRouter)', () => {
  // Defense in depth: the resume route types this line straight into a live shell, so it must come
  // out clean even if the stored command it was built from did not.
  it.each(TITLE_CASES)(
    'never returns a central flag, even from a dirty stored command ($title)',
    async ({ title, n }) => {
      const { buildResumeCommand } = await import('../../server/apiRouter.js');
      const sessionId = uuidFor(200 + n);
      const dirty = psRendering(centralClaudeLine(title)); // as ps printed it: the flag still on it

      const replay = buildResumeCommand(
        { startupCommand: dirty, title, permissionMode: null },
        sessionId,
      );

      expect(replay).not.toMatch(NAMES_US);
      expect(replay).toContain(`--resume '${sessionId}'`);
      const printed = argvTypedWithToken(replay);
      expect(printed).not.toContain(FAKE_TOKEN);
      expect(printed).toContain('[--resume]');
      expect(printed).toContain(`[${title}]`); // the name still arrives, as one argument
    },
  );

  it('never returns a Codex override either, from a stored command whose binary is a path', async () => {
    const { buildResumeCommand } = await import('../../server/apiRouter.js');
    const sessionId = uuidFor(300);
    const dirty = psRendering(applyCentralLaunch('codex --yolo', { port: PORT })).replace(
      /^codex/,
      '/opt/homebrew/lib/node_modules/@openai/codex/vendor/codex',
    );

    const replay = buildResumeCommand({ startupCommand: dirty, permissionMode: null }, sessionId);

    expect(replay).toBe(`codex --yolo resume '${sessionId}' || codex --yolo`);
  });

  it('strips the stored command before rewriting it, so no rewrite can cut a flag from its value', async () => {
    // `--fork-session` takes the word after it with it when the resume line is rebuilt. Followed by our
    // flag, that word is `--mcp-config`, and its bare JSON would be left behind as a positional the strip
    // on the way out can no longer recognise: `${AASC_MCP_TOKEN}` typed into the central's shell.
    const { buildResumeCommand } = await import('../../server/apiRouter.js');
    const sessionId = uuidFor(302);
    const dirty = `claude --resume abc --fork-session --mcp-config ${claudeMcpConfigJson(PORT)}`;

    const replay = buildResumeCommand({ startupCommand: dirty, permissionMode: null }, sessionId);

    expect(replay).not.toMatch(NAMES_US);
    expect(replay).toContain(`--resume '${sessionId}'`);
    expect(argvTypedWithToken(replay)).not.toContain(FAKE_TOKEN);
  });

  it('returns a command that never had the flags exactly as it did before', async () => {
    const { buildResumeCommand } = await import('../../server/apiRouter.js');
    const sessionId = uuidFor(301);

    const replay = buildResumeCommand(
      {
        startupCommand: `claude --dangerously-skip-permissions --mcp-config ./mine.json`,
        permissionMode: null,
      },
      sessionId,
    );

    expect(replay).toBe(
      `claude --dangerously-skip-permissions --mcp-config ./mine.json --resume '${sessionId}' || claude --dangerously-skip-permissions --mcp-config ./mine.json`,
    );
  });
});

describe.skipIf(process.platform === 'win32')(
  'the startupCommand of POST /api/terminals (apiRouter)',
  () => {
    let server: Server;
    let baseUrl = '';
    let scratch = '';

    beforeAll(async () => {
      scratch = mkdtempSync(join(tmpdir(), 'stored-command-'));
      const app = express();
      app.use(express.json());
      const { default: apiRouter } = await import('../../server/apiRouter.js');
      app.use('/api', apiRouter);
      server = createServer(app);
      await new Promise<void>((resolveStart) => server.listen(0, '127.0.0.1', resolveStart));
      const addr = server.address();
      if (addr && typeof addr === 'object') baseUrl = `http://127.0.0.1:${addr.port}`;
    });

    afterAll(async () => {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      rmSync(scratch, { recursive: true, force: true });
    });

    beforeEach(() => {
      mocks.createTerminal.mockReset();
    });

    async function postTerminal(body: Record<string, unknown>) {
      const res = await fetch(`${baseUrl}/api/terminals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ forceNew: true, workingDir: scratch, ...body }),
      });
      return { status: res.status, json: (await res.json()) as Record<string, unknown> };
    }

    it.each(CASES)(
      'a ps-form startupCommand is stored clean, on the terminal and on its card ($name)',
      async ({ launch, stored, name }) => {
        const terminalId = `term-stored-clean-${name}`;
        mocks.createTerminal.mockResolvedValue(terminalId);
        const ps = psRendering(applyCentralLaunch(launch, { port: PORT }));

        // the shape a workspace restore sends for a command it keeps raw: command '' plus startupCommand
        const { status, json } = await postTerminal({ command: '', startupCommand: ps });

        expect(status).toBe(200);
        expect(json.ok).toBe(true);
        const config = mocks.createTerminal.mock.calls[0][0] as TerminalConfig;
        expect(config.startupCommand).toBe(stored);
        const { getSession } = await import('../../server/sessionStore.js');
        const card = getSession(terminalId);
        expect(card?.startupCommand).toBe(stored);
        // the card's own copies of the command (a relaunch reads them too) are clean as well
        expect(card?.sshCommand).not.toMatch(NAMES_US);
        expect(card?.sshConfig?.command).not.toMatch(NAMES_US);
        expect(JSON.stringify(mocks.createTerminal.mock.calls)).not.toMatch(NAMES_US);
      },
    );

    it.each(TITLE_CASES)(
      'a ps-form startupCommand is stored clean whatever the session is called ($title)',
      async ({ title, n }) => {
        const terminalId = `term-stored-title-${n}`;
        mocks.createTerminal.mockResolvedValue(terminalId);
        const ps = psRendering(centralClaudeLine(title));

        const { status } = await postTerminal({ command: '', startupCommand: ps });

        expect(status).toBe(200);
        const stored = `claude --dangerously-skip-permissions -n ${title}`;
        const config = mocks.createTerminal.mock.calls[0][0] as TerminalConfig;
        expect(config.startupCommand).toBe(stored);
        const { getSession } = await import('../../server/sessionStore.js');
        const card = getSession(terminalId);
        expect(card?.startupCommand).toBe(stored);
        expect(card?.sshCommand).not.toMatch(NAMES_US);
        expect(card?.sshConfig?.command).not.toMatch(NAMES_US);
      },
    );

    it('a ps-form Codex startupCommand with the binary as a path is stored clean', async () => {
      mocks.createTerminal.mockResolvedValue('term-stored-codex-path');
      const codexPath = '/opt/homebrew/lib/node_modules/@openai/codex/vendor/codex';
      const ps = psRendering(
        applyCentralLaunch("codex --yolo resume 'abc'", { port: PORT }),
      ).replace(/^codex/, codexPath);

      const { status } = await postTerminal({ command: '', startupCommand: ps });

      expect(status).toBe(200);
      const config = mocks.createTerminal.mock.calls[0][0] as TerminalConfig;
      expect(config.startupCommand).toBe(`${codexPath} --yolo resume abc`);
    });

    it('a workspace resume rebuilt from such a startupCommand carries no flag either', async () => {
      mocks.createTerminal.mockResolvedValue('term-stored-clean-resume');
      const ps = psRendering(applyCentralLaunch(CLAUDE_LAUNCH, { port: PORT }));

      const { status } = await postTerminal({
        command: 'claude',
        startupCommand: ps,
        resumeSessionId: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
      });

      expect(status).toBe(200);
      const config = mocks.createTerminal.mock.calls[0][0] as TerminalConfig;
      expect(config.startupCommand).not.toMatch(NAMES_US);
    });
  },
);
