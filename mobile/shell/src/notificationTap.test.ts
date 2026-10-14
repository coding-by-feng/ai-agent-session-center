// notificationTap.test.ts — AASC-19: a tap lands on the right Mac, session and tab.
import { describe, it, expect, vi } from 'vitest';
import {
  openFromTap, tapServerOrder, tabForKind, deepLinkPath, rememberOwners, ownerOf, SESSION_GONE_MESSAGE,
  type TapDeps, type TapHints,
} from './notificationTap';
import { parsePush, type PushArrival } from './pushPayload';
import type { PairedServer } from './connectionPlan';
import type { SessionResult } from './pairingClient';
import type { SessionsResult } from './sessions';
import { parseSessionDeepLink } from '../../../src/lib/deepLink';

const MAC_A: PairedServer = { id: 'mac-a', name: 'Studio', port: 3333, lan: '192.168.1.20', tailnet: '100.101.102.103', lanAllowed: true };
const MAC_B: PairedServer = { id: 'mac-b', name: 'Laptop', port: 4444, lan: null, tailnet: '100.64.0.9', lanAllowed: false };
const NO_HINTS: TapHints = { lastServerId: null, sessionOwners: [] };

function tap(kind: string, sessionRef = 'sess-1', mac?: string): PushArrival {
  return parsePush({ data: { v: '1', kind, sessionRef, ...(mac ? { mac } : {}) } })!;
}

function listing(...ids: string[]): SessionsResult {
  return { status: 'ok', sessions: ids.map((sessionId) => ({ sessionId, status: 'approval', title: 'T', lastActivityAt: 0, startedAt: 0, muted: false, hasInterruption: false })) };
}

function deps(over: Partial<TapDeps> & { reachable?: string[]; lists?: Record<string, SessionsResult>; signIns?: Record<string, SessionResult> } = {}): TapDeps & { signIn: ReturnType<typeof vi.fn>; listSessions: ReturnType<typeof vi.fn> } {
  const reachable = over.reachable ?? ['100.101.102.103', '100.64.0.9'];
  return {
    servers: over.servers ?? [MAC_A],
    hints: over.hints ?? NO_HINTS,
    probe: over.probe ?? (async (origin: string) => reachable.some((host) => origin.includes(host))),
    signIn: vi.fn(async (server: PairedServer) => over.signIns?.[server.id] ?? { status: 'ok', token: 'sess' }),
    listSessions: vi.fn(async (server: PairedServer) => over.lists?.[server.id] ?? listing('sess-1')),
  };
}

describe('tab and path', () => {
  it('opens the terminal for approval and input, the conversation for finished and interrupted', () => {
    expect(['approval', 'input', 'finished', 'interrupted', 'test'].map((k) => tabForKind(k as never))).toEqual(['terminal', 'terminal', 'conversation', 'conversation', null]);
  });

  it('builds exactly the deep link the Mac UI parses', () => {
    const path = deepLinkPath('sess-1', 'conversation');
    expect(path).toBe('/?session=sess-1&tab=conversation');
    expect(parseSessionDeepLink(path.slice(1))).toEqual({ sessionId: 'sess-1', tab: 'conversation' });
  });
});

describe('which Mac', () => {
  it('trusts a Mac named by the payload and never guesses another', () => {
    expect(tapServerOrder(tap('approval', 'sess-1', 'mac-b'), [MAC_A, MAC_B], NO_HINTS)).toEqual([MAC_B]);
  });

  it('prefers where the session was last seen, then the last Mac used', () => {
    expect(tapServerOrder(tap('approval'), [MAC_A, MAC_B], { lastServerId: 'mac-a', sessionOwners: [['sess-1', 'mac-b']] })).toEqual([MAC_B, MAC_A]);
    expect(tapServerOrder(tap('approval'), [MAC_A, MAC_B], { lastServerId: 'mac-b', sessionOwners: [] })).toEqual([MAC_B, MAC_A]);
    expect(tapServerOrder(tap('approval'), [], NO_HINTS)).toEqual([]);
  });

  it('ignores a hint for a Mac that is no longer paired', () => {
    expect(tapServerOrder(tap('approval'), [MAC_A], { lastServerId: 'gone', sessionOwners: [['sess-1', 'gone']] })).toEqual([MAC_A]);
  });

  it('records which Mac each session lives on, newest last and bounded', () => {
    const owners = rememberOwners([['old', 'mac-a'], ['sess-1', 'mac-a']], 'mac-b', ['sess-1', 'sess-2', 'sess-2']);
    expect(owners).toEqual([['old', 'mac-a'], ['sess-1', 'mac-b'], ['sess-2', 'mac-b']]);
    expect(ownerOf(owners, 'sess-1')).toBe('mac-b');
    expect(ownerOf(owners, 'nope')).toBeNull();
    // A Mac's list replaces what was recorded for it: sessions that ended disappear.
    expect(rememberOwners(owners, 'mac-b', ['sess-3'])).toEqual([['old', 'mac-a'], ['sess-3', 'mac-b']]);
    // Numeric-looking ids keep their order (an object would sort them first).
    const numeric = rememberOwners(rememberOwners([], 'mac-a', ['z']), 'mac-b', ['123']);
    expect(numeric.map(([ref]) => ref)).toEqual(['z', '123']);
    const many = rememberOwners([], 'mac-a', Array.from({ length: 600 }, (_, i) => `s${i}`));
    expect(many).toHaveLength(500);
    expect(ownerOf(many, 's599')).toBe('mac-a');
    expect(ownerOf(many, 's0')).toBeNull();
  });
});

describe('openFromTap', () => {
  it('opens the session on the first path that answers (LAN when allowed)', async () => {
    const d = deps({ reachable: ['192.168.1.20', '100.101.102.103'] });
    expect(await openFromTap(tap('approval'), d)).toEqual({
      action: 'navigate', serverId: 'mac-a', url: 'http://192.168.1.20:3333/?session=sess-1&tab=terminal', message: null,
    });
  });

  it('uses Tailscale when the home network is not reachable', async () => {
    const out = await openFromTap(tap('finished'), deps({ reachable: ['100.101.102.103'] }));
    expect(out).toMatchObject({ url: 'http://100.101.102.103:3333/?session=sess-1&tab=conversation' });
  });

  it('lands on LIVE with a message when the session is gone or no longer shared', async () => {
    const out = await openFromTap(tap('approval'), deps({ lists: { 'mac-a': listing('other') } }));
    expect(out).toEqual({ action: 'navigate', serverId: 'mac-a', url: 'http://100.101.102.103:3333/', message: SESSION_GONE_MESSAGE });
  });

  it('tries the next Mac when it had only guessed', async () => {
    const d = deps({ servers: [MAC_A, MAC_B], lists: { 'mac-a': listing('other'), 'mac-b': listing('sess-1') } });
    expect(await openFromTap(tap('input'), d)).toMatchObject({ serverId: 'mac-b', url: 'http://100.64.0.9:4444/?session=sess-1&tab=terminal' });
  });

  it("doesn't call a session gone when the Mac that may have it couldn't be checked", async () => {
    const offline = deps({ servers: [MAC_A, MAC_B], reachable: ['100.101.102.103'], lists: { 'mac-a': listing('other') } });
    expect(await openFromTap(tap('approval'), offline)).toEqual({
      action: 'navigate', serverId: 'mac-a', url: 'http://100.101.102.103:3333/',
      message: "That session isn't on Studio, and Laptop couldn't be reached, so it couldn't be checked.",
    });
    const pending = deps({ servers: [MAC_A, MAC_B], lists: { 'mac-a': listing('other') }, signIns: { 'mac-b': { status: 'pending' } } });
    expect(await openFromTap(tap('approval'), pending)).toMatchObject({
      action: 'navigate',
      message: "That session isn't on Studio, and Laptop is waiting for you to approve this phone, so it couldn't be checked.",
    });
  });

  it('says the Mac is gone when nothing is paired', async () => {
    expect(await openFromTap(tap('approval'), deps({ servers: [] }))).toMatchObject({ action: 'shell', screen: 'home', retry: false });
  });

  it('offers a retry when no Mac answers', async () => {
    const d = deps({ reachable: [] });
    expect(await openFromTap(tap('approval'), d)).toEqual({ action: 'shell', screen: 'offline', message: "Can't reach Studio. Check Tailscale or your home network.", retry: true });
    expect(d.signIn).not.toHaveBeenCalled();
  });

  it('sends a pending phone to the approval screen and a revoked one to pairing', async () => {
    expect(await openFromTap(tap('approval'), deps({ signIns: { 'mac-a': { status: 'pending' } } }))).toMatchObject({ screen: 'approve-wait', retry: true });
    expect(await openFromTap(tap('approval'), deps({ signIns: { 'mac-a': { status: 'revoked' } } }))).toMatchObject({ screen: 'pair', retry: false });
  });

  it('still deep-links when the list call fails: the Mac UI ignores an id it cannot see', async () => {
    const out = await openFromTap(tap('approval'), deps({ lists: { 'mac-a': { status: 'error', message: 'x' } } }));
    expect(out).toMatchObject({ action: 'navigate', url: 'http://100.101.102.103:3333/?session=sess-1&tab=terminal' });
  });

  it('opens LIVE for a test notification without listing sessions', async () => {
    const d = deps();
    expect(await openFromTap(tap('test'), d)).toEqual({ action: 'navigate', serverId: 'mac-a', url: 'http://100.101.102.103:3333/', message: null });
    expect(d.listSessions).not.toHaveBeenCalled();
  });
});
