// test/mcp/centralTerminal.test.ts — what sshManager gives a central's terminal: the flags on the line
// createTerminal auto-launches and on the line writeWhenReady types for a deferred launch (resume,
// restore, restart), and the token in the PTY's environment. The flags themselves are in launch.test.ts.
//
// What must hold:
//   - the token is NEVER on a command line, in an argument list or in a log: it is in the PTY's
//     environment as AASC_MCP_TOKEN, and nothing else is added to the environment;
//   - the flags are typed, never stored, and sit on EVERY launch path, whatever wraps the command (the
//     status-line tap);
//   - the token is in ONE PTY: never a second terminal of the same central, never a tmux launch (a tmux
//     server keeps what it was started with for every later session), never a PTY that merely inherits
//     it from a server that was started inside a central's shell;
//   - the central's record learns its terminal before the launch promise settles;
//   - a launch that cannot be wired (no port, the off switch, a remote host, a central the registry no
//     longer holds) still starts, without flags and without a token, and never types a stored central's
//     flags that name a token it was not given;
//   - no PTY and no agent process is real: node-pty is a recording stand-in, and the Codex capability
//     probe (which would run `codex --help`) is stubbed.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalConfig } from '../../src/types/terminal.js';
import { appendSessionName } from '../../server/config.js';
import { centrals } from '../../server/mcp/centrals.js';
import {
  MCP_TOKEN_ENV,
  __resetLaunchWarningsForTest,
  claudeMcpConfigJson,
} from '../../server/mcp/launch.js';
import { __resetMcpPortForTest, setMcpPort } from '../../server/mcp/runtime.js';
import { ToolError } from '../../server/mcp/types.js';
import { config } from '../../server/serverConfig.js';
import {
  attachToTmuxPane,
  closeTerminal,
  createTerminal,
  getTerminals,
  writeWhenReady,
} from '../../server/sshManager.js';
import { globalInput, makeMarker, roomInput } from './centralFixtures.js';
import { lastPty, resetFakePtys, spawned } from './fakePty.js';
import { AWKWARD_TITLES, CLAUDE_FLAG, CLAUDE_JSON, PORT, claude, codex } from './launchFixtures.js';

vi.mock('node-pty', async () => (await import('./fakePty.js')).nodePtyModule);

// The logger appends to a file on disk; the wiring logs what it refuses, and a log line must never
// carry a token.
const log = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  debugJson: vi.fn(),
  isDebug: false,
}));
vi.mock('../../server/logger.js', () => ({ default: log }));

// closeTerminal reaps the shell's children by pid. The fake PTYs have invented pids, but nothing in
// this file may reach a process at all.
vi.mock('../../server/processMonitor.js', async () => {
  const actual = await vi.importActual<typeof import('../../server/processMonitor.js')>(
    '../../server/processMonitor.js',
  );
  return {
    ...actual,
    listChildPids: vi.fn(() => []),
    terminateProcessTree: vi.fn(async () => true),
    reapPtyChildren: vi.fn(),
  };
});

// A Codex launch line asks whether the installed Codex takes --no-daemon, which would run
// `codex --help`. Answer "unknown": the line is typed as built and no process starts.
vi.mock('../../server/codexNoDaemon.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/codexNoDaemon.js')>();
  return { ...mod, codexNoDaemonSupport: vi.fn(async () => 'unknown' as const) };
});

/** The mcp-tagged warnings logged so far (the shell-ready fallback warns under 'pty' as well). */
const mcpWarnings = (): unknown[][] => log.warn.mock.calls.filter(([tag]) => tag === 'mcp');

describe.skipIf(process.platform === 'win32')(
  "what a central's terminal is given (sshManager)",
  () => {
    let home: string;
    let previousHome: string | undefined;

    // createTerminal types its launch line once the shell is "ready": a prompt, or a fallback timer
    // (2 s local, 10 s over ssh). Fake timers let the fallback fire at once.
    const settle = () => vi.advanceTimersByTimeAsync(10_500);

    const localConfig = (over: Partial<TerminalConfig> = {}): TerminalConfig => ({
      host: 'localhost',
      port: 22,
      username: 'tester',
      authMethod: 'key',
      workingDir: '/tmp',
      command: 'claude --dangerously-skip-permissions',
      sessionTitle: 'T',
      ...over,
    });
    /** What a launch of `localConfig()` types when nothing is added to it. */
    const PLAIN_LINE = 'claude --dangerously-skip-permissions -n "T"';
    const deferredConfig = (over: Partial<TerminalConfig> = {}) =>
      localConfig({ command: '', deferredLaunch: true, ...over });

    /** A global central the registry holds, and the config of the terminal that will run it. */
    const mintGlobal = () => {
      const record = centrals.mint(globalInput());
      return { record, central: makeMarker(record.centralId) };
    };

    beforeEach(() => {
      resetFakePtys();
      log.info.mockClear();
      log.warn.mockClear();
      __resetLaunchWarningsForTest();
      setMcpPort(PORT);
      // No status-line tap unless a test installs one: the real home folder may have the script.
      process.env.AASC_DISABLE_STATUSLINE_TAP = '1';
      home = mkdtempSync(join(tmpdir(), 'aasc-central-home-'));
      previousHome = process.env.HOME;
      vi.useFakeTimers();
    });

    afterEach(() => {
      for (const terminal of getTerminals()) closeTerminal(terminal.terminalId);
      for (const record of centrals.list()) centrals.revoke(record.centralId);
      vi.clearAllTimers();
      vi.useRealTimers();
      __resetMcpPortForTest();
      delete config.mcp;
      delete process.env.AASC_DISABLE_STATUSLINE_TAP;
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(home, { recursive: true, force: true });
    });

    describe('auto-launch (createTerminal)', () => {
      it.each(AWKWARD_TITLES)(
        'types the flag after a session title that is %j, whatever shell syntax it holds',
        async (title) => {
          const { record, central } = mintGlobal();

          await createTerminal(localConfig({ central, sessionTitle: title }), null);
          await settle();

          const base = appendSessionName('claude --dangerously-skip-permissions', title);
          expect(lastPty().typed).toEqual([`${base}${CLAUDE_FLAG}\r`]);
          expect(lastPty().env[MCP_TOKEN_ENV]).toBe(record.token);
        },
      );

      it('createTerminal puts the token in env only', async () => {
        const { record, central } = mintGlobal();

        await createTerminal(localConfig({ central, sessionTitle: 'Boss' }), null);
        await settle();

        const pty = lastPty();
        expect(pty.env[MCP_TOKEN_ENV]).toBe(record.token);
        expect(pty.typed).toEqual([`${claude(' --dangerously-skip-permissions -n "Boss"')}\r`]);
        // nowhere a command line or an argument list can show it
        expect(pty.typed.join('')).not.toContain(record.token);
        expect(JSON.stringify([pty.file, pty.args])).not.toContain(record.token);
        expect(JSON.stringify([log.info.mock.calls, log.warn.mock.calls])).not.toContain(
          record.token,
        );
      });

      it('adds the token and nothing else to the environment', async () => {
        await createTerminal(localConfig(), null);
        const plain = lastPty();
        const { central } = mintGlobal();

        await createTerminal(localConfig({ central }), null);

        expect(Object.keys(lastPty().env).sort()).toEqual(
          [...Object.keys(plain.env), MCP_TOKEN_ENV].sort(),
        );
        expect(plain.env[MCP_TOKEN_ENV]).toBeUndefined();
      });

      it('starts a Codex central with the -c overrides, and the token in env', async () => {
        const { record, central } = mintGlobal();

        await createTerminal(localConfig({ central, command: 'codex --yolo' }), null);
        await settle();

        expect(lastPty().env[MCP_TOKEN_ENV]).toBe(record.token);
        expect(lastPty().typed).toEqual([`${codex(' --yolo')}\r`]);
      });

      it('records the terminal on the central at once, before the launch promise settles', async () => {
        const { record, central } = mintGlobal();

        const launching = createTerminal(localConfig({ central }), null);

        // no await yet: there must be no moment when the central runs with no terminal to watch
        expect(centrals.byId(record.centralId)?.terminalId).toEqual(
          expect.stringMatching(/^term-/),
        );
        const terminalId = await launching;
        expect(centrals.byId(record.centralId)?.terminalId).toBe(terminalId);
        expect(centrals.byTerminal(terminalId)?.centralId).toBe(record.centralId);
      });

      it('kills the PTY and refuses the launch when the central cannot be attached', async () => {
        const { central } = mintGlobal();
        const attach = vi.spyOn(centrals, 'attachTerminal').mockImplementationOnce(() => {
          throw new ToolError('INVALID', 'Terminal already belongs to another central');
        });
        try {
          await expect(createTerminal(localConfig({ central }), null)).rejects.toThrow(
            /another central/,
          );

          expect(lastPty().kill).toHaveBeenCalledTimes(1);
          expect(getTerminals()).toEqual([]);
          await settle();
          expect(lastPty().typed).toEqual([]);
        } finally {
          attach.mockRestore();
        }
      });

      it('keeps the flags out of the command the terminal (and the caller) keep', async () => {
        const { central } = mintGlobal();
        const cfg = localConfig({ central });

        const id = await createTerminal(cfg, null);
        await settle();

        expect(lastPty().typed[0]).toContain('--mcp-config'); // it WAS typed...
        expect(getTerminals().find((t) => t.terminalId === id)?.command).toBe(
          'claude --dangerously-skip-permissions',
        );
        expect(cfg.command).toBe('claude --dangerously-skip-permissions');
      });

      it('composes with the status-line tap: one of each flag, both survive a shell', async () => {
        delete process.env.AASC_DISABLE_STATUSLINE_TAP;
        process.env.HOME = home;
        mkdirSync(join(home, '.claude', 'hooks'), { recursive: true });
        writeFileSync(join(home, '.claude', 'hooks', 'dashboard-statusline.sh'), '#!/bin/bash\n');
        const { central } = mintGlobal();

        await createTerminal(localConfig({ central }), null);
        await settle();

        const line = lastPty().typed[0].replace(/\r$/, '');
        expect(line.match(/--mcp-config/g)).toHaveLength(1);
        expect(line.match(/--settings/g)).toHaveLength(1);
        const argv = execFileSync('/bin/sh', ['-c', line.replace(/^claude/, "printf '[%s]\\n'")], {
          encoding: 'utf8',
          env: { PATH: '/usr/bin:/bin' },
        })
          .trimEnd()
          .split('\n');
        expect(argv).toContain(`[${CLAUDE_JSON}]`);
        expect(argv).toContain('[--dangerously-skip-permissions]');
      });

      it('never wires a tmux launch: a tmux server would keep the token for every later tmux session', async () => {
        const { record, central } = mintGlobal();

        await createTerminal(localConfig({ central, useTmux: true }), null);
        await settle();

        const pty = lastPty();
        expect(pty.env[MCP_TOKEN_ENV]).toBeUndefined();
        expect(pty.typed).toHaveLength(1);
        expect(pty.typed[0]).toMatch(/^tmux new-session -s /);
        expect(pty.typed[0]).not.toContain('--mcp-config');
        expect(centrals.byId(record.centralId)?.terminalId).toBeNull();
        expect(mcpWarnings()).toEqual([['mcp', expect.stringContaining('tmux')]]);
      });

      it('does not wire an attach to a tmux session either', async () => {
        const { record, central } = mintGlobal();

        await createTerminal(localConfig({ central, tmuxSession: 'work' }), null);
        await settle();

        expect(lastPty().env[MCP_TOKEN_ENV]).toBeUndefined();
        expect(lastPty().typed).toEqual(["tmux attach -t 'work'\r"]);
        expect(centrals.byId(record.centralId)?.terminalId).toBeNull();
      });

      it('launches a plain terminal exactly as before', async () => {
        await createTerminal(localConfig(), null);
        await settle();

        expect(lastPty().typed).toEqual([`${PLAIN_LINE}\r`]);
        expect(lastPty().env[MCP_TOKEN_ENV]).toBeUndefined();
        expect(mcpWarnings()).toEqual([]);
      });

      it('drops central flags from a stored command when the terminal is not a wired central', async () => {
        // a clone or fork of a central is built from its stored `ps` args, which still hold the flags
        // (a stored Claude command cannot get this far: its JSON fails createTerminal's validation)
        const stored =
          'codex -c mcp_servers.aasc.url="http://127.0.0.1:4000/mcp" ' +
          '-c mcp_servers.aasc.bearer_token_env_var="AASC_MCP_TOKEN" --yolo';

        await createTerminal(localConfig({ command: stored }), null);
        await settle();

        expect(lastPty().typed).toEqual(['codex --yolo\r']);
      });

      it('gives a remote host neither flags nor token, and leaves the central unattached', async () => {
        const { record, central } = mintGlobal();

        await createTerminal(
          localConfig({ central, host: 'build.example.com', workingDir: '/srv' }),
          null,
        );
        await settle();

        expect(lastPty().env[MCP_TOKEN_ENV]).toBeUndefined();
        expect(lastPty().typed).toHaveLength(1);
        expect(lastPty().typed[0]).not.toContain('--mcp-config');
        expect(centrals.byId(record.centralId)?.terminalId).toBeNull();
      });

      it('launches without flags or token when the off switch is off', async () => {
        const { record, central } = mintGlobal();
        config.mcp = { enabled: false };

        await createTerminal(localConfig({ central }), null);
        await settle();

        expect(lastPty().env[MCP_TOKEN_ENV]).toBeUndefined();
        expect(lastPty().typed).toEqual([`${PLAIN_LINE}\r`]);
        expect(centrals.byId(record.centralId)?.terminalId).toBeNull();
      });

      it('launches without flags or token, and warns once, while the port is unknown', async () => {
        __resetMcpPortForTest();
        const { record, central } = mintGlobal();

        await createTerminal(localConfig({ central }), null);
        await createTerminal(localConfig({ central: undefined }), null);
        await settle();

        expect(spawned).toHaveLength(2);
        expect(spawned[0].env[MCP_TOKEN_ENV]).toBeUndefined();
        expect(spawned[0].typed).toEqual([`${PLAIN_LINE}\r`]);
        expect(centrals.byId(record.centralId)?.terminalId).toBeNull();
        expect(mcpWarnings()).toHaveLength(1);
      });

      it('launches without flags or token when the registry no longer holds the central', async () => {
        await createTerminal(localConfig({ central: makeMarker('c-gone') }), null);
        await settle();

        expect(lastPty().env[MCP_TOKEN_ENV]).toBeUndefined();
        expect(lastPty().typed).toEqual([`${PLAIN_LINE}\r`]);
        expect(mcpWarnings()).toEqual([['mcp', expect.stringContaining('c-gone')]]);
      });

      it('does not wire a second terminal for a central that already has a live one: the token is in one PTY only', async () => {
        const { record, central } = mintGlobal();
        const first = await createTerminal(localConfig({ central }), null);

        await createTerminal(localConfig({ central }), null);
        await settle();

        expect(spawned[0].env[MCP_TOKEN_ENV]).toBe(record.token);
        expect(spawned[1].env[MCP_TOKEN_ENV]).toBeUndefined();
        expect(spawned[1].typed).toEqual([`${PLAIN_LINE}\r`]);
        expect(centrals.byId(record.centralId)?.terminalId).toBe(first);
        expect(mcpWarnings()).toEqual([['mcp', expect.stringContaining(first)]]);
        expect(JSON.stringify(log.warn.mock.calls)).not.toContain(record.token);
      });

      it('wires a replacement once the terminal the central was recorded on is gone', async () => {
        const { record, central } = mintGlobal();
        const first = await createTerminal(localConfig({ central }), null);
        closeTerminal(first); // nothing watches the lifecycle in this test: the record still names it

        const second = await createTerminal(localConfig({ central }), null);

        expect(lastPty().env[MCP_TOKEN_ENV]).toBe(record.token);
        expect(centrals.byId(record.centralId)?.terminalId).toBe(second);
        expect(mcpWarnings()).toEqual([]);
      });

      it('wires the replacement of a restart: the central is minted again, so the old terminal no longer holds it', async () => {
        const { record, central } = mintGlobal();
        await createTerminal(localConfig({ central }), null); // the old terminal, still alive
        const again = centrals.mint(globalInput({ centralId: record.centralId }));

        const replacement = await createTerminal(localConfig({ central }), null);

        expect(again.token).not.toBe(record.token);
        expect(spawned[0].env[MCP_TOKEN_ENV]).toBe(record.token); // stale now: the registry forgot it
        expect(spawned[1].env[MCP_TOKEN_ENV]).toBe(again.token);
        expect(centrals.byId(record.centralId)?.terminalId).toBe(replacement);
      });

      it('launches a config that says `central: null` as the ordinary terminal it is', async () => {
        // a config that went through JSON (a snapshot, a request body) says null where it has no central
        await createTerminal(localConfig({ central: null as unknown as undefined }), null);
        await settle();

        expect(lastPty().typed).toEqual([`${PLAIN_LINE}\r`]);
        expect(lastPty().env[MCP_TOKEN_ENV]).toBeUndefined();
        expect(mcpWarnings()).toEqual([]);
      });

      it('wires a room central the same way', async () => {
        const record = centrals.mint(roomInput('room-1'));

        await createTerminal(
          localConfig({
            central: { centralId: record.centralId, kind: 'room', scopeRef: 'room-1' },
          }),
          null,
        );

        expect(lastPty().env[MCP_TOKEN_ENV]).toBe(record.token);
        expect(centrals.byId(record.centralId)?.terminalId).not.toBeNull();
      });
    });

    describe('a token the server itself inherited', () => {
      // The server started from inside a central's shell (the dev loop for this very repo) has the
      // token in its own environment. It is that central's, not any PTY's the server spawns.
      const INHERITED = 'aasc_mcp_INHERITED_FROM_A_CENTRALS_SHELL';
      beforeEach(() => {
        process.env[MCP_TOKEN_ENV] = INHERITED;
      });
      afterEach(() => {
        delete process.env[MCP_TOKEN_ENV];
      });

      it('is not handed to a terminal that is not a central', async () => {
        await createTerminal(localConfig(), null);
        await createTerminal(deferredConfig(), null);
        await createTerminal(localConfig({ central: makeMarker('c-gone') }), null);

        expect(spawned).toHaveLength(3);
        for (const pty of spawned) expect(pty.env[MCP_TOKEN_ENV]).toBeUndefined();
      });

      it("is replaced, in a central's terminal, by that central's own token", async () => {
        const { record, central } = mintGlobal();

        await createTerminal(localConfig({ central }), null);

        expect(lastPty().env[MCP_TOKEN_ENV]).toBe(record.token);
        expect(record.token).not.toBe(INHERITED);
      });

      it('is not handed to a terminal that could not be wired either (tmux, remote host, MCP off)', async () => {
        const { central } = mintGlobal();
        await createTerminal(localConfig({ central, useTmux: true }), null);
        await createTerminal(localConfig({ central, host: 'build.example.com' }), null);
        config.mcp = { enabled: false };
        await createTerminal(localConfig({ central }), null);

        expect(spawned).toHaveLength(3);
        for (const pty of spawned) expect(pty.env[MCP_TOKEN_ENV]).toBeUndefined();
      });

      it('is not handed to a tmux pane terminal', async () => {
        await attachToTmuxPane('%5', null);

        expect(spawned).toHaveLength(1);
        expect(spawned[0].env[MCP_TOKEN_ENV]).toBeUndefined();
      });
    });

    describe('deferred launch (writeWhenReady) — resume, restore, restart', () => {
      const resumeLine = `claude --model opus -n "t" --resume 'abc' || claude --model opus -n "t"\r`;

      it("types the flags into BOTH halves of a central's resume line, and no token", async () => {
        const { record, central } = mintGlobal();
        const id = await createTerminal(deferredConfig({ central }), null);

        const written = writeWhenReady(id, resumeLine);
        await settle();

        expect(await written).toBe(true);
        expect(lastPty().env[MCP_TOKEN_ENV]).toBe(record.token);
        expect(lastPty().typed).toEqual([
          `${claude(' --model opus -n "t" --resume \'abc\'')} || ${claude(' --model opus -n "t"')}\r`,
        ]);
        expect(lastPty().typed.join('')).not.toContain(record.token);
      });

      it("types the codex overrides into a central's codex resume line", async () => {
        const { central } = mintGlobal();
        const id = await createTerminal(deferredConfig({ central }), null);

        const written = writeWhenReady(id, "codex --yolo resume 'abc' || codex --yolo\r");
        await settle();
        await written;

        expect(lastPty().typed).toEqual([
          `${codex(" --yolo resume 'abc'")} || ${codex(' --yolo')}\r`,
        ]);
      });

      it('replaces the flags a stored command carries (a restart relaunches from `ps` args)', async () => {
        const { central } = mintGlobal();
        const id = await createTerminal(deferredConfig({ central }), null);
        const stored = `claude --mcp-config ${claudeMcpConfigJson(4000)} --model opus --resume 'abc'\r`;

        const written = writeWhenReady(id, stored);
        await settle();
        await written;

        expect(lastPty().typed).toEqual([`${claude(" --model opus --resume 'abc'")}\r`]);
      });

      it("leaves a non-central terminal's line alone", async () => {
        const id = await createTerminal(deferredConfig(), null);

        const written = writeWhenReady(id, resumeLine);
        await settle();
        await written;

        expect(lastPty().typed).toEqual([resumeLine]);
      });

      it('drops the flags a stored command carries when the terminal is not a wired central', async () => {
        // a clone of a central: its stored command is the live CLI's `ps` args, quotes gone
        const id = await createTerminal(deferredConfig(), null);
        const stored = `claude --mcp-config ${claudeMcpConfigJson(4000)} --model opus --resume 'abc' || claude --model opus\r`;

        const written = writeWhenReady(id, stored);
        await settle();
        await written;

        expect(lastPty().typed).toEqual([
          `claude --model opus --resume 'abc' || claude --model opus\r`,
        ]);
      });

      it('drops them too when MCP has been switched off since the central was saved', async () => {
        const { central } = mintGlobal();
        config.mcp = { enabled: false };
        const id = await createTerminal(deferredConfig({ central }), null);
        const stored = `claude --mcp-config ${claudeMcpConfigJson(4000)} --resume 'abc'\r`;

        const written = writeWhenReady(id, stored);
        await settle();
        await written;

        expect(lastPty().typed).toEqual([`claude --resume 'abc'\r`]);
      });

      it('leaves a line alone once its central is gone, rather than name a token that no longer works', async () => {
        const { record, central } = mintGlobal();
        const id = await createTerminal(deferredConfig({ central }), null);
        centrals.revoke(record.centralId);

        const written = writeWhenReady(id, resumeLine);
        await settle();
        await written;

        expect(lastPty().typed).toEqual([resumeLine]);
      });

      it('leaves a line alone when the central has moved on to another terminal', async () => {
        const { record, central } = mintGlobal();
        const first = await createTerminal(deferredConfig({ central }), null);
        // a relaunch mints the central again; the replacement terminal takes it over
        centrals.mint(globalInput({ centralId: record.centralId }));
        await createTerminal(deferredConfig({ central }), null);

        const written = writeWhenReady(first, resumeLine);
        await settle();
        await written;

        expect(spawned[0].typed).toEqual([resumeLine]);
      });

      it('leaves the line of a terminal whose config says `central: null` alone', async () => {
        const id = await createTerminal(
          deferredConfig({ central: null as unknown as undefined }),
          null,
        );

        const written = writeWhenReady(id, resumeLine);
        await settle();

        expect(await written).toBe(true);
        expect(lastPty().typed).toEqual([resumeLine]);
        expect(mcpWarnings()).toEqual([]);
      });

      it("leaves a tmux terminal's line alone", async () => {
        const { central } = mintGlobal();
        const id = await createTerminal(deferredConfig({ central, useTmux: true }), null);

        const written = writeWhenReady(id, resumeLine);
        await settle();
        await written;

        expect(lastPty().typed).toEqual([resumeLine]);
        expect(lastPty().env[MCP_TOKEN_ENV]).toBeUndefined();
      });

      it("leaves a remote terminal's line alone", async () => {
        const { central } = mintGlobal();
        const id = await createTerminal(
          deferredConfig({ central, host: 'build.example.com' }),
          null,
        );

        const written = writeWhenReady(id, resumeLine);
        await settle();
        await written;

        expect(lastPty().typed).toEqual([resumeLine]);
      });
    });
  },
);
