// test/sessionMatcher.crossCli.test.ts — a Claude card and a Codex card started in one folder never swap.
//
// Nov 17 2026: the hosted workspace starts a pinned "Claude" and a pinned "Codex" card in ~/workspace. The
// Codex card's hover peek listed the Claude session's prompts. When a startup hook has no terminal id, the
// workDir link (Priority 2) popped the folder's OLDEST link whatever its agent, so a Codex hook took the
// Claude card and the Claude hook then took the Codex terminal: the cards swapped ids, and the Codex card
// showed Claude's prompts. A direct terminal match (Priority 1) also removed the folder's oldest link, which
// could be the other agent's, leaving the wrong one for the next hook.
//
// Real sshManager + sessionStore; node-pty, the database and process kills are stubbed. No process is touched.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TerminalConfig } from '../src/types/terminal.js';
import type { Session } from '../src/types/session.js';

vi.mock('../server/db.js', () => ({
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
vi.mock('node-pty', () => ({
  default: {
    spawn: vi.fn(() => ({
      pid: 4_242_001,
      onData: () => ({ dispose() {} }),
      onExit: () => ({ dispose() {} }),
      write() {},
      kill() {},
      resize() {},
    })),
  },
}));
vi.mock('../server/processMonitor.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  terminateProcessTree: vi.fn(),
}));

const DIR = '/tmp/aasc-cross-cli-test/workspace';
type Store = typeof import('../server/sessionStore.js');

const settings = (cli: 'claude' | 'codex'): TerminalConfig =>
  ({ host: 'localhost', workingDir: DIR, command: cli, sessionTitle: cli === 'claude' ? 'Claude' : 'Codex' }) as TerminalConfig;

/** Fresh modules, then the hosted pair: Claude's terminal first, Codex's second, both in DIR. */
async function hostedPair(order: Array<'claude' | 'codex'> = ['claude', 'codex']) {
  vi.resetModules();
  const pty = await import('../server/sshManager.js');
  const store = await import('../server/sessionStore.js');
  const terms: Record<string, string> = {};
  for (const cli of order) {
    terms[cli] = await pty.createTerminal(settings(cli), null);
    await store.createTerminalSession(terms[cli], settings(cli));
  }
  return { store, claudeTerm: terms.claude, codexTerm: terms.codex };
}

const claudeHook = (event: string, extra: Record<string, unknown> = {}) =>
  ({ session_id: 'claude-uuid', hook_event_name: event, cwd: DIR, claude_pid: 7_001, tty_path: '/dev/ttys901', ...extra });
const codexHook = (event: string, extra: Record<string, unknown> = {}) =>
  ({ session_id: 'codex-thread', hook_event_name: event, cwd: DIR, cli_source: 'codex', claude_pid: 7_002, tty_path: '/dev/ttys902', ...extra });

function send(store: Store, hook: Record<string, unknown>) {
  store.handleEvent(hook as never);
}

function cardByTitle(store: Store, title: string): Session {
  const card = Object.values(store.getAllSessions() as Record<string, Session>).find((s) => s.title === title);
  if (!card) throw new Error(`no ${title} card`);
  return card;
}
const promptsOf = (card: Session) => card.promptHistory.map((p) => p.text);

describe('a Claude card and a Codex card in one folder', { timeout: 30_000 }, () => {
  beforeEach(() => vi.clearAllMocks());

  it('keep their own ids and prompts when startup hooks carry no terminal id', async () => {
    const { store, claudeTerm, codexTerm } = await hostedPair();
    send(store, codexHook('SessionStart'));
    send(store, claudeHook('SessionStart'));
    send(store, claudeHook('UserPromptSubmit', { prompt: 'a prompt typed into Claude' }));

    const claude = cardByTitle(store, 'Claude');
    const codex = cardByTitle(store, 'Codex');
    expect(claude.sessionId).toBe('claude-uuid');
    expect(claude.terminalId).toBe(claudeTerm);
    expect(promptsOf(claude)).toEqual(['a prompt typed into Claude']);
    expect(codex.sessionId).toBe('codex-thread');
    expect(codex.terminalId).toBe(codexTerm);
    expect(promptsOf(codex)).toEqual([]);
  });

  it('a Codex hook with no terminal id never takes the only (Claude) card in the folder', async () => {
    const { store, claudeTerm } = await hostedPair(['claude']);
    send(store, codexHook('SessionStart'));
    send(store, codexHook('UserPromptSubmit', { prompt: 'a prompt typed into Codex' }));

    const claude = cardByTitle(store, 'Claude');
    expect(claude.sessionId).toBe(claudeTerm);
    expect(promptsOf(claude)).toEqual([]);
  });

  it('a direct terminal match leaves the other agent its own link', async () => {
    // Codex's first hook (its prompt) matches its card by terminal id and used to remove the folder's
    // oldest link: Claude's. Claude's SessionStart with no terminal id then took the Codex terminal.
    const { store, claudeTerm, codexTerm } = await hostedPair();
    send(store, codexHook('UserPromptSubmit', { agent_terminal_id: codexTerm, prompt: 'a prompt typed into Codex' }));
    send(store, claudeHook('SessionStart'));
    send(store, claudeHook('UserPromptSubmit', { prompt: 'a prompt typed into Claude' }));

    const claude = cardByTitle(store, 'Claude');
    const codex = cardByTitle(store, 'Codex');
    expect(claude.sessionId).toBe('claude-uuid');
    expect(claude.terminalId).toBe(claudeTerm);
    expect(promptsOf(claude)).toEqual(['a prompt typed into Claude']);
    expect(codex.sessionId).toBe('codex-thread');
    expect(promptsOf(codex)).toEqual(['a prompt typed into Codex']);
  });

  it('still links each startup to its own card when hooks carry their terminal ids', async () => {
    const { store, claudeTerm, codexTerm } = await hostedPair();
    send(store, claudeHook('SessionStart', { agent_terminal_id: claudeTerm }));
    send(store, claudeHook('UserPromptSubmit', { agent_terminal_id: claudeTerm, prompt: 'a prompt typed into Claude' }));
    send(store, codexHook('UserPromptSubmit', { agent_terminal_id: codexTerm, prompt: 'a prompt typed into Codex' }));

    expect(promptsOf(cardByTitle(store, 'Claude'))).toEqual(['a prompt typed into Claude']);
    expect(promptsOf(cardByTitle(store, 'Codex'))).toEqual(['a prompt typed into Codex']);
  });
});
