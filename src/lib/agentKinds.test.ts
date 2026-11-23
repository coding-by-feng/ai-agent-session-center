import { describe, it, expect } from 'vitest';
import {
  AGENT_KINDS, agentKindInCommand, agentKindOfCommand, agentLabel, extraAgentResumeLine, isAgentKind, withOpencodeStandalone,
} from './agentKinds';

describe('agentKinds', () => {
  it('lists each agent once, with a unique command and hook source', () => {
    const ids = AGENT_KINDS.map((a) => a.id);
    expect(ids).toEqual(['claude', 'codex', 'opencode', 'antigravity']);
    expect(new Set(AGENT_KINDS.map((a) => a.command)).size).toBe(AGENT_KINDS.length);
    expect(new Set(AGENT_KINDS.map((a) => a.hookSource)).size).toBe(AGENT_KINDS.length);
  });

  it('reads the agent from a launch line’s first word, with or without a directory', () => {
    expect(agentKindOfCommand('claude --resume x')).toBe('claude');
    expect(agentKindOfCommand('/opt/homebrew/bin/opencode -s ses_abc')).toBe('opencode');
    expect(agentKindOfCommand('agy --conversation 1')).toBe('antigravity');
    expect(agentKindOfCommand('  codex')).toBe('codex');
    expect(agentKindOfCommand('zsh')).toBeUndefined();
    expect(agentKindOfCommand('opencodex')).toBeUndefined();
    expect(agentKindOfCommand('')).toBeUndefined();
    expect(agentKindOfCommand(null)).toBeUndefined();
  });

  it('finds an agent named anywhere in a line, as a whole word', () => {
    expect(agentKindInCommand('ssh box opencode')).toBe('opencode');
    expect(agentKindInCommand('cd x && agy')).toBe('antigravity');
    expect(agentKindInCommand('echo agyx')).toBeUndefined();
  });

  it('labels kinds and cli_source strings', () => {
    expect(agentLabel('antigravity')).toBe('Antigravity');
    expect(agentLabel('OpenCode')).toBe('OpenCode');
    expect(agentLabel('shell')).toBeNull();
    expect(agentLabel(undefined)).toBeNull();
    expect(isAgentKind('opencode')).toBe(true);
    expect(isAgentKind('gemini')).toBe(false);
  });

  describe('withOpencodeStandalone', () => {
    it('adds --standalone right after the executable of a TUI line', () => {
      expect(withOpencodeStandalone('opencode')).toBe('opencode --standalone');
      expect(withOpencodeStandalone('opencode -s ses_abc12345')).toBe('opencode --standalone -s ses_abc12345');
      expect(withOpencodeStandalone('/opt/homebrew/bin/opencode ~/app')).toBe('/opt/homebrew/bin/opencode --standalone ~/app');
      expect(withOpencodeStandalone('opencode --auto')).toBe('opencode --standalone --auto');
    });

    it('leaves a line that already picks a server, runs a subcommand, or is not OpenCode', () => {
      for (const line of ['opencode --standalone', 'opencode --server http://x', 'opencode --server=http://x',
        'opencode run hi', 'opencode acp', 'opencode serve --service', 'claude', 'zsh', '']) {
        expect(withOpencodeStandalone(line)).toBe(line);
      }
    });
  });

  describe('extraAgentResumeLine', () => {
    it('reopens a session by id, keeping the stored line’s flags but not its old resume args', () => {
      expect(extraAgentResumeLine('opencode', 'ses_df83e11abffetyKHwFK5Q4KwCR', 'opencode --auto -s ses_old12345'))
        .toBe('opencode --auto -s ses_df83e11abffetyKHwFK5Q4KwCR');
      expect(extraAgentResumeLine('antigravity', 'd291a3f2-c43a-4537-a7e8-3a1033272cef', 'agy --mode auto -c'))
        .toBe('agy --mode auto --conversation d291a3f2-c43a-4537-a7e8-3a1033272cef');
      expect(extraAgentResumeLine('antigravity', 'd291a3f2-c43a-4537-a7e8-3a1033272cef'))
        .toBe('agy --conversation d291a3f2-c43a-4537-a7e8-3a1033272cef');
    });

    it('uses the bare command when the stored line is another agent’s', () => {
      expect(extraAgentResumeLine('opencode', 'ses_abcdefgh123', 'claude --resume x')).toBe('opencode -s ses_abcdefgh123');
    });

    it('refuses an id the agent never issues, so it never reaches a shell', () => {
      expect(extraAgentResumeLine('opencode', 'ses_x; rm -rf ~')).toBeNull();
      expect(extraAgentResumeLine('antigravity', '$(touch /tmp/p)')).toBeNull();
      expect(extraAgentResumeLine('antigravity', 'not-a-uuid')).toBeNull();
    });
  });
});

describe('detectCli / detectAgentKind for the extra agents', async () => {
  const { detectCli, detectAgentKind } = await import('./cliDetect');
  it('keeps Claude/Codex-only behaviour off OpenCode and Antigravity cards, even with Claude-shaped events', () => {
    const events = [{ type: 'SessionStart' }] as never;
    expect(detectCli({ cliSource: 'opencode', events })).toBeNull();
    expect(detectCli({ startupCommand: 'agy --mode auto', events })).toBeNull();
    expect(detectAgentKind({ cliSource: 'opencode' })).toBe('opencode');
    expect(detectAgentKind({ startupCommand: '/opt/homebrew/bin/agy' })).toBe('antigravity');
    expect(detectAgentKind({ cliSource: 'codex' })).toBe('codex');
  });
});
