// test/shareNewSessions.test.ts — "Share new sessions with my devices" (Oct 2026, by request).
// Off by default; on, every new session starts shared; a choice saved for one session wins.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('../server/db.js', () => ({
  upsertSession: vi.fn(), updateSessionTitle: vi.fn(), updateSessionSummary: vi.fn(), updateSessionRemark: vi.fn(),
  updateSessionArchived: vi.fn(), migrateSessionId: vi.fn(), getPromptsForSession: vi.fn(() => []),
  insertFullPrompt: vi.fn(), getRecentSessions: vi.fn(() => []), getSessionById: vi.fn(() => null),
  deleteSession: vi.fn(), getAllSessionQueues: vi.fn(() => []), default: {},
}));

const dir = mkdtempSync(join(tmpdir(), 'aasc-share-default-'));
process.env.AASC_SHARE_DEFAULT_FILE = join(dir, 'share-default.json');

let mod: typeof import('../server/shareDefault.js');
let store: typeof import('../server/sessionStore.js');

beforeAll(async () => {
  mod = await import('../server/shareDefault.js');
  store = await import('../server/sessionStore.js');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => mod._resetShareNewSessionsForTests());

describe('the share-new-sessions setting', () => {
  it('is off until turned on, and saved to its file', () => {
    expect(mod.isShareNewSessionsOn()).toBe(false);
    mod.setShareNewSessions(true);
    expect(mod.isShareNewSessionsOn()).toBe(true);
    expect(JSON.parse(readFileSync(process.env.AASC_SHARE_DEFAULT_FILE!, 'utf8'))).toEqual({ shareNewSessions: true });
    mod._resetShareNewSessionsForTests();
    expect(mod.isShareNewSessionsOn()).toBe(true); // read back from the file
    mod.setShareNewSessions(false);
    expect(existsSync(process.env.AASC_SHARE_DEFAULT_FILE!)).toBe(true);
    expect(mod.isShareNewSessionsOn()).toBe(false);
  });

  it('gives a session with no saved choice the default, and keeps a saved one', () => {
    mod.setShareNewSessions(false);
    expect(mod.initialRemoteVisible(undefined)).toBeUndefined();
    expect(mod.initialRemoteVisible(true)).toBe(true);
    mod.setShareNewSessions(true);
    expect(mod.initialRemoteVisible(undefined)).toBe(true);
    expect(mod.initialRemoteVisible(null)).toBe(true);
    expect(mod.initialRemoteVisible(false)).toBe(false);
  });
});

describe('new terminal sessions', () => {
  it('start shared while the setting is on, hidden while it is off', async () => {
    mod.setShareNewSessions(false);
    await store.createTerminalSession('sn-off', { host: 'localhost', workingDir: '/tmp/sn/off', command: 'claude' });
    expect(store.getSession('sn-off')?.remoteVisible).not.toBe(true);
    mod.setShareNewSessions(true);
    await store.createTerminalSession('sn-on', { host: 'localhost', workingDir: '/tmp/sn/on', command: 'claude' });
    expect(store.getSession('sn-on')?.remoteVisible).toBe(true);
  });

  it('keep a session hidden that was saved hidden, even while the setting is on', async () => {
    mod.setShareNewSessions(true);
    await store.createTerminalSession('sn-kept-hidden', { host: 'localhost', workingDir: '/tmp/sn/hidden', command: 'claude', remoteVisible: false });
    expect(store.getSession('sn-kept-hidden')?.remoteVisible).toBe(false);
  });
});
