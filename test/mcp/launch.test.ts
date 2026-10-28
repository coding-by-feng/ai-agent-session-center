// test/mcp/launch.test.ts — how a central's launch line points its CLI at /mcp (server/mcp/launch.ts):
// the flags, putting them on a line and taking them off, and which launches carry them. What a central's
// terminal is given by sshManager is in centralTerminal.test.ts.
//
// What must hold:
//   - Claude gets `--mcp-config '<json>'` at the END of each command's words (the option is variadic, so
//     it must not be able to take a word that follows it) and Codex five `-c` overrides right after the
//     binary, on EVERY command of the line, once; a line that is not a claude/codex launch is left alone;
//   - the token is NEVER on a command line or in a log: the flags only name the variable it travels in
//     (Claude expands `${AASC_MCP_TOKEN}` itself, Codex reads `bearer_token_env_var`), so the shell must
//     not expand it;
//   - a stored command that already carries the flags (the hook records the live CLI's `ps` args) has
//     them replaced, or removed;
//   - a launch that cannot be wired (no port, the off switch, a remote host, a central the registry no
//     longer holds) gets nothing, and says why.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { centrals, createCentralRegistry } from '../../server/mcp/centrals.js';
import {
  MCP_TOKEN_ENV,
  __resetLaunchWarningsForTest,
  applyCentralLaunch,
  centralWiringFor,
  claudeMcpConfigJson,
  codexMcpFlags,
  stripCentralLaunch,
} from '../../server/mcp/launch.js';
import { __resetMcpPortForTest, setMcpPort } from '../../server/mcp/runtime.js';
import { appendSessionName } from '../../server/config.js';
import { config } from '../../server/serverConfig.js';
import { globalInput, makeMarker } from './centralFixtures.js';
import {
  AWKWARD_TITLES,
  CLAUDE_FLAG,
  CLAUDE_JSON,
  CODEX_FLAGS,
  PORT,
  claude,
  codex,
  psRendering,
} from './launchFixtures.js';

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

const apply = (line: string, port = PORT) => applyCentralLaunch(line, { port });

/** The mcp-tagged warnings logged so far (the shell-ready fallback warns under 'pty' as well). */
const mcpWarnings = (): unknown[][] => log.warn.mock.calls.filter(([tag]) => tag === 'mcp');

describe('claudeMcpConfigJson', () => {
  it('is the aasc server over HTTP at the loopback port, with the token left as a variable', () => {
    expect(claudeMcpConfigJson(PORT)).toBe(CLAUDE_JSON);
  });

  it('the JSON keeps ${AASC_MCP_TOKEN} literal and names the port', () => {
    const parsed = JSON.parse(claudeMcpConfigJson(4455));

    expect(parsed.mcpServers.aasc.url).toBe('http://127.0.0.1:4455/mcp');
    expect(parsed.mcpServers.aasc.type).toBe('http');
    expect(parsed.mcpServers.aasc.headers.Authorization).toBe('Bearer ${AASC_MCP_TOKEN}');
    expect(Object.keys(parsed.mcpServers)).toEqual(['aasc']);
  });

  it('is safe inside single quotes: no single quote in it', () => {
    expect(claudeMcpConfigJson(PORT)).not.toContain("'");
  });

  it('refuses a port that is not one, so nothing odd is typed into a shell', () => {
    for (const bad of [0, -3, 65536, 3333.5, Number.NaN, "3333'; rm -rf ~; '"]) {
      expect(() => claudeMcpConfigJson(bad as number)).toThrow(RangeError);
    }
  });
});

describe('codexMcpFlags', () => {
  it('is one -c override per setting: url, the variable that holds the token, two timeouts, the approval mode', () => {
    expect(codexMcpFlags(PORT)).toEqual(CODEX_FLAGS);
  });

  it('names the port, and the variable rather than a token', () => {
    const flags = codexMcpFlags(4455).join(' ');

    expect(flags).toContain('http://127.0.0.1:4455/mcp');
    expect(flags).toContain(`bearer_token_env_var="${MCP_TOKEN_ENV}"`);
    expect(MCP_TOKEN_ENV).toBe('AASC_MCP_TOKEN');
  });

  it('refuses a port that is not one', () => {
    for (const bad of [0, 70000, 1.5, Number.NaN]) {
      expect(() => codexMcpFlags(bad)).toThrow(RangeError);
    }
  });
});

describe('applyCentralLaunch', () => {
  it('claude gets one --mcp-config at the end of its command', () => {
    expect(apply('claude --model opus')).toBe(`claude --model opus --mcp-config '${CLAUDE_JSON}'`);
    expect(apply('claude')).toBe(claude());
    expect(apply('claude --dangerously-skip-permissions -n "My title"')).toBe(
      claude(' --dangerously-skip-permissions -n "My title"'),
    );
  });

  it('a positional prompt after claude is not swallowed', () => {
    // --mcp-config takes any number of values (`claude --help`: <configs...>), so a plain word after it
    // would be read as one more config. The flag goes after every word the command has.
    const line = apply("claude 'fix the bug' --model opus");

    expect(line).toBe(claude(" 'fix the bug' --model opus"));
    expect(line.indexOf("'fix the bug'")).toBeLessThan(line.indexOf('--mcp-config'));
    expect(apply("claude -n t 'do it' || claude")).toBe(
      `${claude(" -n t 'do it'")} || ${claude()}`,
    );
  });

  it.each(AWKWARD_TITLES)('goes after a quoted session title that is %j, once', (title) => {
    // the title is typed double-quoted (appendSessionName), so its shell syntax is only text
    const base = appendSessionName('claude --dangerously-skip-permissions', title);

    const once = apply(base);

    expect(once).toBe(`${base}${CLAUDE_FLAG}`);
    expect(apply(once)).toBe(once);
    expect(stripCentralLaunch(once)).toBe(base);
  });

  it('goes before a bare --, after which every word is a positional', () => {
    expect(apply("claude -n t -- 'a prompt'")).toBe(`claude -n t${CLAUDE_FLAG} -- 'a prompt'`);
    expect(apply("claude -- 'a prompt'")).toBe(`claude${CLAUDE_FLAG} -- 'a prompt'`);
  });

  it('codex gets the -c flags', () => {
    expect(apply('codex --dangerously-bypass-approvals-and-sandbox')).toBe(
      codex(' --dangerously-bypass-approvals-and-sandbox'),
    );
    expect(apply('codex')).toBe(codex());
  });

  it('puts the codex flags at the root, before a resume subcommand', () => {
    expect(apply("codex resume 'abc'")).toBe(codex(" resume 'abc'"));
  });

  it('both commands of a resume line get flags', () => {
    expect(apply("claude --resume 'x' || claude")).toBe(
      `${claude(" --resume 'x'")} || ${claude()}`,
    );
    expect(apply("codex resume 'x' || codex --yolo")).toBe(
      `${codex(" resume 'x'")} || ${codex(' --yolo')}`,
    );
  });

  it('covers a command after cd / export prefixes, and keeps the typed carriage return', () => {
    expect(apply("cd '/work/app' && claude --x\r")).toBe(`cd '/work/app' && ${claude(' --x')}\r`);
    expect(apply('cd /w;claude')).toBe(`cd /w;${claude()}`);
    expect(apply('claude\r')).toBe(`${claude()}\r`);
  });

  it('never reads a claude or codex inside quotes as a command (a title is untrusted text)', () => {
    expect(apply('claude -n "x || claude y"')).toBe(claude(' -n "x || claude y"'));
    expect(apply("claude -n 'a; codex b'")).toBe(claude(" -n 'a; codex b'"));
    expect(apply('echo "claude" \'codex\'')).toBe('echo "claude" \'codex\'');
  });

  it('a plain shell line is unchanged', () => {
    for (const line of [
      '',
      'bash',
      'cd /work && npm run dev',
      'echo claude',
      'claude-code --x',
      'codex-helper',
      'npx claude',
      '/usr/local/bin/claude --x', // not matched by the other launch-line builders either
      'FOO=1 claude',
      'aider',
    ]) {
      expect(apply(line)).toBe(line);
    }
  });

  it('idempotent', () => {
    for (const line of [
      'claude',
      'claude --model opus -n "t"',
      "claude --resume 'x' || claude",
      "codex resume 'x' || codex --yolo\r",
      "cd '/w' && claude --x\r",
      'bash',
    ]) {
      const once = apply(line);
      expect(apply(once)).toBe(once);
    }
  });

  it('token is never in the launch line', () => {
    const { token } = createCentralRegistry().mint(globalInput());

    const lines = [
      apply('claude --model opus'),
      apply("codex resume 'x' || codex"),
      apply("claude --resume 'x' || claude"),
    ];

    for (const line of lines) expect(line).not.toContain(token);
    // the only mention of the variable is its name: a placeholder Claude expands, a name Codex reads
    expect(lines[0]).toContain('${AASC_MCP_TOKEN}');
    expect(lines[1]).toContain('bearer_token_env_var="AASC_MCP_TOKEN"');
    expect(lines[0].match(/AASC_MCP_TOKEN/g)).toHaveLength(1);
  });

  it('keeps another --mcp-config or -c the person gave, and adds its own', () => {
    expect(apply('claude --mcp-config ./mine.json --model opus')).toBe(
      claude(' --mcp-config ./mine.json --model opus'),
    );
    expect(apply('codex -c \'model="o3"\' --yolo')).toBe(codex(' -c \'model="o3"\' --yolo'));
  });

  it('replaces flags a stored command already carries instead of doubling them (the hook stores ps args)', () => {
    // `ps -o args=` shows the argv the shell built: the quotes are gone, the variable name is not.
    const claudePs = `claude --mcp-config ${claudeMcpConfigJson(4000)} --model opus`;
    const codexPs =
      'codex -c mcp_servers.aasc.url="http://127.0.0.1:4000/mcp" ' +
      '-c mcp_servers.aasc.bearer_token_env_var="AASC_MCP_TOKEN" ' +
      '-c mcp_servers.aasc.tool_timeout_sec=120 -c mcp_servers.aasc.startup_timeout_sec=20 --yolo';

    expect(apply(claudePs)).toBe(claude(' --model opus'));
    expect(apply(codexPs)).toBe(codex(' --yolo'));
    // the port moved (AASC restarted on another one): the typed flag names the current one
    expect(apply(claude(' --model opus'), 4001)).toContain('http://127.0.0.1:4001/mcp');
    expect(apply(claude(' --model opus'), 4001)).not.toContain('3333');
  });

  it('moves a stored flag to the end of its command, where a fresh one goes', () => {
    const stored = `claude --mcp-config ${claudeMcpConfigJson(4000)} --model opus -n t`;

    expect(apply(stored)).toBe(claude(' --model opus -n t'));
  });

  it('replaces the flags on both halves of a stored fallback line', () => {
    const stored = `claude --mcp-config ${claudeMcpConfigJson(4000)} --x || claude --mcp-config ${claudeMcpConfigJson(4000)} --x`;

    expect(apply(stored)).toBe(`${claude(' --x')} || ${claude(' --x')}`);
  });

  describe.skipIf(process.platform === 'win32')('through a real shell', () => {
    // `printf` stands in for the CLI so what is checked is the shell's own word splitting and expansion.
    const FAKE_TOKEN = 'aasc_mcp_FAKE_TOKEN_THAT_MUST_NOT_REACH_ARGV';
    const argvOf = (line: string, binary: 'claude' | 'codex'): string[] =>
      execFileSync('/bin/sh', ['-c', line.replace(new RegExp(`^${binary}`), "printf '[%s]\\n'")], {
        encoding: 'utf8',
        env: { PATH: '/usr/bin:/bin', [MCP_TOKEN_ENV]: FAKE_TOKEN },
      })
        .trimEnd()
        .split('\n');

    it('hands claude one config argument with the variable unexpanded, so the token stays out of argv', () => {
      const argv = argvOf(apply('claude --model opus -n "a title"'), 'claude');

      expect(argv).toEqual([
        '[--model]',
        '[opus]',
        '[-n]',
        '[a title]',
        '[--mcp-config]',
        `[${CLAUDE_JSON}]`,
      ]);
      expect(argv.join('')).not.toContain(FAKE_TOKEN);
      expect(JSON.parse(argv[5].slice(1, -1)).mcpServers.aasc.headers.Authorization).toBe(
        'Bearer ${AASC_MCP_TOKEN}',
      );
    });

    it('leaves a prompt word ahead of the config, where it cannot be taken for one', () => {
      expect(argvOf(apply("claude 'fix the bug'"), 'claude')).toEqual([
        '[fix the bug]',
        '[--mcp-config]',
        `[${CLAUDE_JSON}]`,
      ]);
    });

    it('hands codex each override as one argument, with the TOML string quotes intact', () => {
      const argv = argvOf(apply('codex --yolo'), 'codex');

      expect(argv).toEqual([
        '[-c]',
        '[mcp_servers.aasc.url="http://127.0.0.1:3333/mcp"]',
        '[-c]',
        '[mcp_servers.aasc.bearer_token_env_var="AASC_MCP_TOKEN"]',
        '[-c]',
        '[mcp_servers.aasc.tool_timeout_sec=120]',
        '[-c]',
        '[mcp_servers.aasc.startup_timeout_sec=20]',
        '[-c]',
        '[mcp_servers.aasc.default_tools_approval_mode="approve"]',
        '[--yolo]',
      ]);
      expect(argv.join('')).not.toContain(FAKE_TOKEN);
    });
  });
});

describe('stripCentralLaunch', () => {
  it('removes the typed form from both CLIs and from every command on the line', () => {
    expect(stripCentralLaunch(claude(' --model opus'))).toBe('claude --model opus');
    expect(stripCentralLaunch(codex(" resume 'x'"))).toBe("codex resume 'x'");
    expect(stripCentralLaunch(`${claude(" --resume 'x'")} || ${claude()}`)).toBe(
      "claude --resume 'x' || claude",
    );
  });

  it('removes the form ps shows, whatever port it names', () => {
    expect(
      stripCentralLaunch(`claude --mcp-config ${claudeMcpConfigJson(4000)} --model opus`),
    ).toBe('claude --model opus');
    expect(
      stripCentralLaunch(
        'codex -c mcp_servers.aasc.url="http://127.0.0.1:4000/mcp" -c mcp_servers.aasc.tool_timeout_sec=120 --yolo',
      ),
    ).toBe('codex --yolo');
  });

  describe.skipIf(process.platform === 'win32')('the form ps prints', () => {
    // The hook records `ps -p $PPID -o args=` as a session's startupCommand. ps joins the arguments the
    // shell built with single spaces: the single quotes are gone, the JSON and the TOML strings keep their
    // double quotes, and a title with a space is two words. `psRendering` asks a real shell for exactly that.
    const NAMES_US = /mcp-config|mcp_servers\.aasc|AASC_MCP_TOKEN/;

    it('is removed in full from a Claude launch', () => {
      const ps = psRendering(apply('claude --dangerously-skip-permissions -n "My title"'));
      expect(ps).toBe(
        `claude --dangerously-skip-permissions -n My title --mcp-config ${claudeMcpConfigJson(PORT)}`,
      );

      const stored = stripCentralLaunch(ps);

      expect(stored).toBe('claude --dangerously-skip-permissions -n My title');
      expect(stored).not.toMatch(NAMES_US);
    });

    it('is removed in full from a Codex launch', () => {
      const ps = psRendering(apply("codex --yolo resume 'abc'"));
      expect(ps).toContain('-c mcp_servers.aasc.url="http://127.0.0.1:3333/mcp" ');

      const stored = stripCentralLaunch(ps);

      expect(stored).toBe('codex --yolo resume abc');
      expect(stored).not.toMatch(NAMES_US);
    });

    it.each(AWKWARD_TITLES)('is removed in full when the session title is %j', (title) => {
      // The title (`-n "<title>"`, from appendSessionName) comes ahead of the flag, and ps prints it
      // unquoted: whatever shell syntax it holds must not hide the flag from the strip.
      const ps = psRendering(
        apply(appendSessionName('claude --dangerously-skip-permissions', title)),
      );
      expect(ps).toContain(`-n ${title} --mcp-config {`);

      const stored = stripCentralLaunch(ps);

      expect(stored).toBe(`claude --dangerously-skip-permissions -n ${title}`);
      expect(stored).not.toMatch(NAMES_US);
      expect(stripCentralLaunch(stored)).toBe(stored);
    });

    it('is removed in full from a Codex launch whose binary is a path, as ps prints a Codex', () => {
      // Codex's wrapper starts the native binary by its full path, and that is what the hook records
      const codexPath = '/opt/homebrew/lib/node_modules/@openai/codex/vendor/codex';
      const ps = psRendering(apply("codex --yolo resume 'abc'")).replace(/^codex/, codexPath);
      expect(ps).toContain('-c mcp_servers.aasc.url=');

      const stored = stripCentralLaunch(ps);

      expect(stored).toBe(`${codexPath} --yolo resume abc`);
      expect(stored).not.toMatch(NAMES_US);
    });

    it('is removed in full from both halves of a fallback line, wherever the flag sits', () => {
      const ps = `${psRendering(apply("claude --resume 'x'"))} || ${psRendering(apply('claude -n t'))}`;

      expect(stripCentralLaunch(ps)).toBe('claude --resume x || claude -n t');
    });
  });

  describe('our exact flag, found without reading the line as shell words', () => {
    // `simpleCommands` reads quotes and the separators `( ) ; & |`, so a title that holds them (ps prints
    // it unquoted) can hide a flag that follows from the word-based strip. The flag is found as text.
    const claudeForms = (port: number): string[] => {
      const json = claudeMcpConfigJson(port);
      return [
        `--mcp-config '${json}'`, // as typed
        `--mcp-config ${json}`, // as ps prints it
        `--mcp-config ${json.replaceAll('"', '')}`, // ps, with the JSON's own quotes gone as well
        `--mcp-config='${json}'`, // the = form, quoted
        `--mcp-config=${json}`, // the = form, bare
      ];
    };

    it('removes it in every form it can take, behind a title that breaks the word reading', () => {
      for (const flag of claudeForms(4455)) {
        expect(stripCentralLaunch(`claude -n Central (main) ${flag}`)).toBe(
          'claude -n Central (main)',
        );
        expect(stripCentralLaunch(`claude -n Kason's boss ${flag}`)).toBe("claude -n Kason's boss");
        expect(stripCentralLaunch(`claude -n a;b ${flag}\r`)).toBe('claude -n a;b\r');
        expect(stripCentralLaunch(`claude ${flag} --model opus`)).toBe('claude --model opus');
      }
    });

    it('matches any port, and only a port: digits, not a word', () => {
      for (const port of [1, 80, 3333, 65535]) {
        expect(stripCentralLaunch(`claude -n a (b) ${claudeForms(port)[1]}`)).toBe(
          'claude -n a (b)',
        );
      }
      // the title hides the flag from the word reading, so only the text match is in play here
      const notAPort = claudeMcpConfigJson(3333).replace('3333', 'abcd');
      expect(stripCentralLaunch(`claude -n a (b) --mcp-config ${notAPort}`)).toBe(
        `claude -n a (b) --mcp-config ${notAPort}`,
      );
    });

    it('removes the Codex overrides too, behind anything, on any binary', () => {
      const overrides = psRendering(apply('codex --yolo')).slice('codex '.length);

      expect(stripCentralLaunch(`/usr/bin/codex ${overrides}`)).toBe('/usr/bin/codex --yolo');
      expect(stripCentralLaunch(`echo (x) ${overrides}`)).toBe('echo (x) --yolo');
    });

    it('strips a stored Codex line from before the approval mode: the four old overrides, typed and as ps prints them', () => {
      const old = codexMcpFlags(PORT).filter((f) => !f.includes('default_tools_approval_mode'));
      expect(old).toHaveLength(4);
      const typed = old.join(' ');
      const ps = typed.replaceAll("'", '');
      const codexPath = '/opt/homebrew/lib/node_modules/@openai/codex/vendor/codex';

      expect(stripCentralLaunch(`codex ${typed} --yolo`)).toBe('codex --yolo');
      expect(stripCentralLaunch(`codex ${ps} resume abc`)).toBe('codex resume abc');
      expect(stripCentralLaunch(`${codexPath} ${ps} --yolo`)).toBe(`${codexPath} --yolo`);
      expect(stripCentralLaunch(`echo (x) ${ps} --yolo`)).toBe('echo (x) --yolo');
      expect(stripCentralLaunch(`codex ${ps} --yolo`)).not.toMatch(/mcp_servers\.aasc|AASC_MCP_TOKEN/);
    });

    it('launch.ts says the strip removes the five Codex overrides', () => {
      const text = readFileSync(join(__dirname, '..', '..', 'server', 'mcp', 'launch.ts'), 'utf8');

      expect(codexMcpFlags(PORT)).toHaveLength(5);
      expect(text).toContain('the five Codex overrides');
      expect(text).not.toMatch(/\bfour Codex overrides\b/);
      // Ruling P6-38: the approval mode covers the cloud toolset's writes with no card too, and says so.
      expect(text).toContain('P6-38: it covers every AASC tool');
    });

    it('is idempotent', () => {
      for (const title of AWKWARD_TITLES) {
        const once = stripCentralLaunch(`claude -n ${title} ${claudeForms(3333)[1]}`);
        expect(stripCentralLaunch(once)).toBe(once);
      }
    });

    it('leaves a command without our flag exactly as it is, whatever its title', () => {
      const otherServer =
        '{"mcpServers":{"other":{"type":"http","url":"http://127.0.0.1:3333/mcp"}}}';
      const lookalike =
        '{"mcpServers":{"aasc":{"type":"http","url":"https://elsewhere.example/mcp","headers":{"Authorization":"Bearer ${ELSEWHERE_TOKEN}"}}}}';
      const lines = [
        ...AWKWARD_TITLES.map((title) => `claude --dangerously-skip-permissions -n ${title}`),
        // a person's own config, pointing at another server (even one on this port, or named like ours)
        `claude -n Central (main) --mcp-config '${otherServer}'`,
        `claude -n Kason's boss --mcp-config ${otherServer}`,
        `claude -n a;b --mcp-config=${lookalike}`,
        'claude -n R&D --mcp-config ./mine.json --model opus',
        'claude --mcp-config https://mcp.example/config.json',
        // another server on this port, written like ours (but with its own name and token variable)
        `claude -n x --mcp-config ${claudeMcpConfigJson(3333).replace('"aasc"', '"mine"').replace('AASC_MCP_TOKEN', 'MINE_TOKEN')}`,
        'codex -c \'mcp_servers.other.url="http://x"\' --yolo',
        '/usr/bin/codex -c mcp_servers.other.url=http://x --yolo',
      ];

      for (const line of lines) expect(stripCentralLaunch(line)).toBe(line);
    });
  });

  it('undoes applyCentralLaunch and leaves no stray whitespace', () => {
    for (const line of [
      'claude',
      'claude --model opus -n "t"',
      "claude --resume 'x' || claude",
      "codex resume 'x' || codex --yolo\r",
      "cd '/w' && claude --x\r",
      'bash',
    ]) {
      expect(stripCentralLaunch(apply(line))).toBe(line);
    }
  });

  it("leaves the person's own --mcp-config and -c alone", () => {
    for (const line of [
      'claude --mcp-config ./mine.json --model opus',
      `claude --mcp-config '{"mcpServers":{"other":{"type":"http","url":"http://x"}}}'`,
      'codex -c \'model="o3"\' --yolo',
      'codex -c mcp_servers.other.url=http://x',
      'bash',
      '',
    ]) {
      expect(stripCentralLaunch(line)).toBe(line);
    }
  });
});

describe('centralWiringFor', () => {
  // A terminal about to be spawned: is the central's recorded terminal still a live one?
  const NOTHING_LIVE = { isTerminalLive: () => false };

  beforeEach(() => {
    log.warn.mockClear();
    __resetLaunchWarningsForTest();
    setMcpPort(PORT);
  });

  afterEach(() => {
    for (const record of centrals.list()) centrals.revoke(record.centralId);
    __resetMcpPortForTest();
    config.mcp = { enabled: true }; // central sessions are off by default since Oct 28 2026
  });

  it('is the port and the token for a local launch of a central the registry holds', () => {
    const record = centrals.mint(globalInput());

    expect(centralWiringFor(makeMarker(record.centralId), 'local', NOTHING_LIVE)).toEqual({
      port: PORT,
      token: record.token,
    });
  });

  it('is nothing for a launch that is not a central', () => {
    expect(centralWiringFor(undefined, 'local', NOTHING_LIVE)).toBeNull();
    expect(mcpWarnings()).toEqual([]);
  });

  it('reads a null marker as no marker, as it does an undefined one', () => {
    // a config that went through JSON (a snapshot, a request body) says `central: null`, not nothing
    expect(() => centralWiringFor(null, 'local', NOTHING_LIVE)).not.toThrow();
    expect(centralWiringFor(null, 'local', NOTHING_LIVE)).toBeNull();
    expect(centralWiringFor(null, 'local', { terminalId: 'term-1' })).toBeNull();
    expect(mcpWarnings()).toEqual([]);
  });

  it('is nothing when the off switch is off, and says nothing about it', () => {
    const record = centrals.mint(globalInput());
    config.mcp = { enabled: false };

    expect(centralWiringFor(makeMarker(record.centralId), 'local', NOTHING_LIVE)).toBeNull();
    expect(mcpWarnings()).toEqual([]);
  });

  it('is nothing for a remote host, which gets neither flags nor token', () => {
    const record = centrals.mint(globalInput());

    expect(centralWiringFor(makeMarker(record.centralId), 'remote', NOTHING_LIVE)).toBeNull();
    expect(mcpWarnings()).toEqual([['mcp', expect.stringContaining('remote')]]);
  });

  it('is nothing for a tmux launch: a tmux server would keep the token for every later tmux session', () => {
    const record = centrals.mint(globalInput());

    expect(centralWiringFor(makeMarker(record.centralId), 'tmux', NOTHING_LIVE)).toBeNull();
    expect(
      centralWiringFor(makeMarker(record.centralId), 'tmux', { terminalId: 'term-1' }),
    ).toBeNull();
    expect(mcpWarnings()).toHaveLength(2);
    expect(mcpWarnings()[0]).toEqual(['mcp', expect.stringContaining('tmux')]);
  });

  it('is nothing for a central the registry does not hold, and names it', () => {
    expect(centralWiringFor(makeMarker('c-gone'), 'local', NOTHING_LIVE)).toBeNull();
    expect(mcpWarnings()).toEqual([['mcp', expect.stringContaining('c-gone')]]);
  });

  it('is nothing while the server has not said which port it listens on, and warns once', () => {
    __resetMcpPortForTest();
    const record = centrals.mint(globalInput());
    const marker = makeMarker(record.centralId);

    expect(centralWiringFor(marker, 'local', NOTHING_LIVE)).toBeNull();
    expect(centralWiringFor(marker, 'local', NOTHING_LIVE)).toBeNull();
    expect(centralWiringFor(marker, 'local', NOTHING_LIVE)).toBeNull();

    expect(mcpWarnings()).toEqual([['mcp', expect.stringMatching(/port/i)]]);
  });

  describe('a line typed into an existing terminal', () => {
    it('also needs the central to be attached to that very terminal', () => {
      const record = centrals.mint(globalInput());
      const marker = makeMarker(record.centralId);

      expect(centralWiringFor(marker, 'local', { terminalId: 'term-1' })).toBeNull(); // nothing attached yet
      centrals.attachTerminal(record.centralId, 'term-1');
      expect(centralWiringFor(marker, 'local', { terminalId: 'term-1' })).toEqual({
        port: PORT,
        token: record.token,
      });
      expect(centralWiringFor(marker, 'local', { terminalId: 'term-2' })).toBeNull(); // another terminal's line
    });
  });

  describe('a terminal about to be spawned', () => {
    // The token goes into that terminal's environment. A central whose record is attached to a
    // different LIVE terminal already has it there: a second PTY must not get a copy.
    it('is wired while the central has no terminal', () => {
      const record = centrals.mint(globalInput());

      expect(
        centralWiringFor(makeMarker(record.centralId), 'local', { isTerminalLive: () => true }),
      ).not.toBeNull();
    });

    it('is nothing when the central is attached to another terminal that is still alive', () => {
      const record = centrals.mint(globalInput());
      centrals.attachTerminal(record.centralId, 'term-1');
      const isTerminalLive = vi.fn((id: string) => id === 'term-1');

      expect(
        centralWiringFor(makeMarker(record.centralId), 'local', { isTerminalLive }),
      ).toBeNull();

      expect(isTerminalLive).toHaveBeenCalledWith('term-1');
      expect(mcpWarnings()).toEqual([['mcp', expect.stringContaining('term-1')]]);
      expect(JSON.stringify(mcpWarnings())).not.toContain(record.token);
    });

    it('is wired when the terminal the central is attached to no longer exists', () => {
      const record = centrals.mint(globalInput());
      centrals.attachTerminal(record.centralId, 'term-gone');

      expect(centralWiringFor(makeMarker(record.centralId), 'local', NOTHING_LIVE)).toEqual({
        port: PORT,
        token: record.token,
      });
      expect(mcpWarnings()).toEqual([]);
    });
  });

  it('never puts a token in a log line', () => {
    const record = centrals.mint(globalInput());
    centrals.attachTerminal(record.centralId, 'term-1');

    centralWiringFor(makeMarker(record.centralId), 'remote', NOTHING_LIVE);
    centralWiringFor(makeMarker(record.centralId), 'tmux', NOTHING_LIVE);
    centralWiringFor(makeMarker('c-gone'), 'local', NOTHING_LIVE);
    centralWiringFor(makeMarker(record.centralId), 'local', { isTerminalLive: () => true });
    centralWiringFor(makeMarker(record.centralId), 'local', { terminalId: 'term-2' });
    __resetMcpPortForTest();
    centralWiringFor(makeMarker(record.centralId), 'local', { terminalId: 'term-1' });

    expect(mcpWarnings().length).toBeGreaterThanOrEqual(6);
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain(record.token);
  });
});

describe('stripCentralLaunch on a line that has none of ours', () => {
  // Every flag either pass removes names the token variable or an `aasc` key, so a line with neither
  // is handed back as it came, without the text pass, whose pattern costs time quadratic in a run of
  // blanks (a stored command is the hook's capture, of any length).
  it('hands it back at once, however long its runs of blanks', () => {
    const line = `claude${' '.repeat(60_000)}--model opus${'\t'.repeat(20_000)}x`;
    const started = performance.now();
    expect(stripCentralLaunch(line)).toBe(line);
    expect(performance.now() - started).toBeLessThan(250);
  });

  it('still strips a line that names the token variable or an aasc key', () => {
    expect(stripCentralLaunch(`claude${' '.repeat(50)}--model opus${CLAUDE_FLAG}`)).toBe(
      `claude${' '.repeat(50)}--model opus`,
    );
    expect(stripCentralLaunch(codex(' --yolo'))).toBe('codex --yolo');
  });
});
