// test/pushWiring.test.ts — AASC-16: the broadcast hook the push notifier rides on, and approvalSource.
import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeAll } from 'vitest';

vi.mock('../server/db.js', () => ({
  upsertSession: vi.fn(), updateSessionTitle: vi.fn(), updateSessionSummary: vi.fn(), updateSessionRemark: vi.fn(),
  updateSessionArchived: vi.fn(), migrateSessionId: vi.fn(), getPromptsForSession: vi.fn(() => []),
  insertFullPrompt: vi.fn(), getRecentSessions: vi.fn(() => []), getSessionById: vi.fn(() => null),
  deleteSession: vi.fn(), default: {},
}));

class FakeSocket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  sent: string[] = [];
  send = vi.fn((raw: string) => { this.sent.push(raw); });
  ping = vi.fn();
  terminate = vi.fn();
  close = vi.fn();
}

let ws: typeof import('../server/wsManager.js');
let store: typeof import('../server/sessionStore.js');
beforeAll(async () => {
  ws = await import('../server/wsManager.js');
  store = await import('../server/sessionStore.js');
});

describe('onBroadcast', () => {
  it('sees every broadcast after clients do, and a throwing listener breaks nothing', () => {
    const socket = new FakeSocket();
    ws.handleConnection(socket as never, { clientId: 'wiring-1', label: 'desk', address: '127.0.0.1', isLocal: true });
    socket.sent.length = 0;
    const seen: string[] = [];
    const offBad = ws.onBroadcast(() => { throw new Error('listener bug'); });
    const offGood = ws.onBroadcast((data) => { seen.push(data.type); });
    ws.broadcast({ type: 'hook_stats_test', value: 1 });
    expect(seen).toEqual(['hook_stats_test']);
    expect(socket.sent.some((m) => m.includes('hook_stats_test'))).toBe(true);
    offBad();
    offGood();
    ws.broadcast({ type: 'after_unsubscribe' });
    expect(seen).toEqual(['hook_stats_test']);
    socket.emit('close');
  });
});

describe('approvalSource', () => {
  it('is set to permission_request by a PermissionRequest hook', async () => {
    const id = 'push-wiring-perm';
    await store.createTerminalSession(id, { host: 'localhost', workingDir: '/tmp/push-wiring', command: 'claude' });
    await store.handleEvent({ session_id: id, hook_event_name: 'SessionStart', cwd: '/tmp/push-wiring' } as never);
    await store.handleEvent({ session_id: id, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: '/tmp/push-wiring' } as never);
    const result = await store.handleEvent({ session_id: id, hook_event_name: 'PermissionRequest', tool_name: 'Bash', cwd: '/tmp/push-wiring' } as never);
    const s = result?.session ?? store.getSession(id);
    expect(s?.status).toBe('approval');
    expect(s?.approvalSource).toBe('permission_request');
  });
});
