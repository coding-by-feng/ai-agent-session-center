/**
 * Restore pacing (Nov 25 2026): the restore creates pinned sessions first (the server starts their
 * CLIs a few at a time, in that order) and sends each card's saved screen inside its create call,
 * so the ring holds it before the card is announced.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { importSnapshot, restoreLaunchOrder, type SessionSnapshot, type WorkspaceSnapshot } from './workspaceSnapshot';
import { useSessionStore } from '@/stores/sessionStore';
import { useRoomStore } from '@/stores/roomStore';
import { clearLocalStorage } from '../__tests__/setup';

function snap(id: string, overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    originalSessionId: id,
    title: `T-${id}`,
    enableOpsTerminal: false,
    sshConfig: { host: 'localhost', port: 22, username: 'u', workingDir: `/w/${id}`, command: 'claude' },
    projectTabs: null,
    ...overrides,
  };
}

const ok = (body: unknown) => ({ ok: true, status: 200, json: () => Promise.resolve(body) }) as unknown as Response;

describe('restoreLaunchOrder', () => {
  it('puts pinned sessions first, in pin order, and keeps the rest as saved', () => {
    const order = restoreLaunchOrder([
      snap('a'),
      snap('p2', { pinned: true, pinOrder: 2 }),
      snap('b'),
      snap('p1', { pinned: true, pinOrder: 1 }),
      snap('p-none', { pinned: true }),
    ]);
    expect(order.map((s) => s.originalSessionId)).toEqual(['p1', 'p2', 'p-none', 'a', 'b']);
  });
});

describe('importSnapshot pacing', () => {
  beforeEach(() => {
    clearLocalStorage();
    useSessionStore.getState().setSessions(new Map());
    useRoomStore.setState({ rooms: [] });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('creates pinned first, marks each create as a restore, and sends its saved screen with it', async () => {
    const creates: Array<Record<string, unknown>> = [];
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      urls.push(u);
      if (u.includes('/api/sessions/clear-all')) {
        return ok({
          savedOutputs: [
            { key: 'T-a\0/w/a', sessionId: 'aaaa-1', data: btoa('screen of a') },
            { key: 'T-pin\0/w/pin', sessionId: 'pin-1', data: btoa('screen of pin') },
          ],
        });
      }
      if (u.endsWith('/api/terminals')) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        creates.push(body);
        return ok({ ok: true, terminalId: `term-${creates.length}` });
      }
      return ok({ ok: true });
    }));

    const snapshot: WorkspaceSnapshot = {
      version: 1,
      exportedAt: Date.now(),
      sessions: [snap('aaaa-1', { title: 'T-a', sshConfig: { host: 'localhost', port: 22, username: 'u', workingDir: '/w/a', command: 'claude' } }),
        snap('pin-1', { title: 'T-pin', pinned: true, pinOrder: 0, sshConfig: { host: 'localhost', port: 22, username: 'u', workingDir: '/w/pin', command: 'claude' } })],
      rooms: [],
    };
    await importSnapshot(snapshot, { onSessionCreated: () => {}, onComplete: () => {} });

    expect(creates.map((c) => c.originalSessionId)).toEqual(['pin-1', 'aaaa-1']);
    expect(creates.every((c) => c.restoreBatch === true)).toBe(true);
    expect(atob(String(creates[0].prefillOutput))).toBe('screen of pin');
    expect(atob(String(creates[1].prefillOutput))).toBe('screen of a');
    // The screen went in with the create call: no separate prefill that could lose the race to a subscribe.
    expect(urls.some((u) => u.includes('/prefill-output'))).toBe(false);
  });

  it('sends no prefillOutput when nothing was saved for a card', async () => {
    const creates: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/api/sessions/clear-all')) return ok({ savedOutputs: [] });
      if (u.endsWith('/api/terminals')) {
        creates.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return ok({ ok: true, terminalId: 'term-x' });
      }
      return ok({ ok: true });
    }));
    await importSnapshot({ version: 1, exportedAt: Date.now(), sessions: [snap('bbbb-2')], rooms: [] },
      { onSessionCreated: () => {}, onComplete: () => {} });
    expect(creates).toHaveLength(1);
    expect('prefillOutput' in creates[0]).toBe(false);
    expect(creates[0].restoreBatch).toBe(true);
  });
});
