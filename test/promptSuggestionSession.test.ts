// test/promptSuggestionSession.test.ts — a Claude session's suggested next prompt on the card
// (Oct 26 2026): a Stop watches its terminal, a found suggestion lands on `session.promptSuggestion`,
// and typing or the session moving on takes it away. The screen reading is promptSuggestionCapture's.
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

// The restart snapshot is written under APP_USER_DATA: a folder of this file's own, never the real one.
const dataDir = await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const previous = process.env.APP_USER_DATA;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aasc-prompt-suggestion-'));
  process.env.APP_USER_DATA = dir;
  return { dir, previous };
});

const hooks = vi.hoisted(() => ({
  onSuggestion: null as null | ((terminalId: string, suggestion: { text: string; at: number } | null) => void),
  watched: [] as string[],
}));

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

vi.mock('../server/sshManager.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../server/sshManager.js')>();
  return {
    ...mod,
    registerTerminalSuggestionCallback: (cb: typeof hooks.onSuggestion) => { hooks.onSuggestion = cb; },
    watchTerminalForSuggestion: (terminalId: string) => { hooks.watched.push(terminalId); },
  };
});

import { handleEvent as rawHandleEvent, getSession, linkTerminalToSession, saveSnapshot } from '../server/sessionStore.js';
import { toArchivedSession } from '../server/sessionTrim.js';
import { EVENT_TYPES } from '../server/constants.js';

const handleEvent = (payload: Record<string, unknown>) =>
  rawHandleEvent({ tty_path: '/dev/ttys002', cwd: '/tmp/suggest-test', ...payload } as never);

/** A session that ran one turn in terminal `term-<id>` and has just stopped. */
function stopped(id: string, extra: Record<string, unknown> = {}): void {
  handleEvent({ session_id: id, hook_event_name: EVENT_TYPES.SESSION_START, ...extra });
  linkTerminalToSession(id, `term-${id}`);
  handleEvent({ session_id: id, hook_event_name: EVENT_TYPES.USER_PROMPT_SUBMIT, prompt: 'list files' });
  handleEvent({ session_id: id, hook_event_name: EVENT_TYPES.STOP, last_assistant_message: 'Done.' });
}
const suggest = (id: string, text = 'ls -la') => hooks.onSuggestion!(`term-${id}`, { text, at: 1 });

describe('prompt suggestion on the session', () => {
  beforeEach(() => { hooks.watched.length = 0; });
  afterAll(() => {
    if (dataDir.previous === undefined) delete process.env.APP_USER_DATA;
    else process.env.APP_USER_DATA = dataDir.previous;
    rmSync(dataDir.dir, { recursive: true, force: true });
  });

  it('a Claude Stop watches the terminal, and a found suggestion lands on the session', () => {
    stopped('ps-1');
    expect(hooks.watched).toEqual(['term-ps-1']);
    suggest('ps-1');
    expect(getSession('ps-1')?.promptSuggestion).toEqual({ text: 'ls -la', at: 1 });
  });

  it('typing into the terminal takes it away', () => {
    stopped('ps-2');
    suggest('ps-2');
    hooks.onSuggestion!('term-ps-2', null);
    expect(getSession('ps-2')?.promptSuggestion ?? null).toBeNull();
  });

  it.each([
    ['UserPromptSubmit', { hook_event_name: EVENT_TYPES.USER_PROMPT_SUBMIT, prompt: 'next' }],
    ['PreToolUse', { hook_event_name: EVENT_TYPES.PRE_TOOL_USE, tool_name: 'Read' }],
    ['SessionStart (/clear)', { hook_event_name: EVENT_TYPES.SESSION_START }],
  ])('%s takes it away', (_name, event) => {
    const id = `ps-3-${_name.length}`;
    stopped(id);
    suggest(id);
    handleEvent({ session_id: id, ...event });
    expect(getSession(id)?.promptSuggestion ?? null).toBeNull();
  });

  it('the next Stop drops the old one before watching again', () => {
    stopped('ps-4');
    suggest('ps-4', 'old idea');
    handleEvent({ session_id: 'ps-4', hook_event_name: EVENT_TYPES.STOP, last_assistant_message: 'Again.' });
    expect(getSession('ps-4')?.promptSuggestion ?? null).toBeNull();
    expect(hooks.watched).toEqual(['term-ps-4', 'term-ps-4']);
  });

  it('a suggestion that arrives after the session started working again is ignored', () => {
    stopped('ps-5');
    handleEvent({ session_id: 'ps-5', hook_event_name: EVENT_TYPES.USER_PROMPT_SUBMIT, prompt: 'go on' });
    suggest('ps-5');
    expect(getSession('ps-5')?.promptSuggestion ?? null).toBeNull();
  });

  it('stays live-only: never in the restart snapshot or an archive (it describes that screen, now)', () => {
    stopped('ps-7');
    suggest('ps-7');
    saveSnapshot();
    const raw = readFileSync(join(dataDir.dir, 'data', 'sessions-snapshot.json'), 'utf8');
    const snap = JSON.parse(raw) as { sessions: Record<string, Record<string, unknown>> };
    expect(snap.sessions['ps-7']).toBeDefined();
    expect('promptSuggestion' in snap.sessions['ps-7']).toBe(false);
    expect('promptSuggestion' in toArchivedSession(getSession('ps-7')!)).toBe(false);
    expect(getSession('ps-7')?.promptSuggestion?.text).toBe('ls -la');
  });

  it('never watches a Codex session (its CLI has no suggestion)', () => {
    stopped('ps-6', { startup_command: 'codex --full-auto' });
    expect(hooks.watched).toEqual([]);
  });
});
