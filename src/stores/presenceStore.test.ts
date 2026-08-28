// presenceStore.test.ts — the client mirror of the server's control rules.
//
// `canControlSession` is not just cosmetic: `useGlobalQueueScheduler` gates on
// it, and that scheduler ticks once a second on EVERY connected client. Get it
// wrong in the permissive direction and two devices each fire the same queued
// prompt into one PTY (and each burn an auto-resume attempt from a budget sized
// for one). Get it wrong in the restrictive direction and a solo user's queue
// silently stops firing — the worse failure, because nothing errors.
//
// `canWriteWorkspace` guards the shared snapshot, which carries the ROOM LAYOUT
// from each client's own localStorage; a wrong `true` there lets a phone
// overwrite the desktop's rooms with an empty set.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/deviceIdentity', () => ({
  getClientId: () => 'me',
  getClientLabel: () => 'Test Device',
}));

import {
  usePresenceStore,
  canControlSession,
  controllerOf,
  isSpectator,
  canWriteWorkspace,
  otherDevices,
  controlledCount,
} from './presenceStore';
import type { ControlHolderView, DevicePresence } from '@/types';

function device(clientId: string, isLocal = false): DevicePresence {
  return {
    clientId,
    label: `Device ${clientId}`,
    address: isLocal ? '127.0.0.1' : '192.168.1.5',
    isLocal,
    connections: 1,
    connectedAt: 1000,
    lastSeenAt: 1000,
  };
}

function holder(sessionId: string, clientId: string, online = true): ControlHolderView {
  return {
    sessionId,
    clientId,
    label: `Device ${clientId}`,
    since: 1000,
    lastActivityAt: 1000,
    online,
  };
}

function apply(opts: {
  devices?: DevicePresence[];
  controllers?: ControlHolderView[];
  restoreOwner?: string | null;
  workspaceWriter?: string | null;
}): void {
  usePresenceStore.getState().applyPresence({
    devices: opts.devices ?? [],
    controllers: opts.controllers ?? [],
    restoreOwner: opts.restoreOwner ?? null,
    workspaceWriter: opts.workspaceWriter ?? null,
  });
}

beforeEach(() => {
  usePresenceStore.setState({
    devices: [],
    controllers: new Map(),
    restoreOwner: null,
    workspaceWriter: null,
    pendingRequests: new Map(),
    lastDenial: null,
  });
});

describe('canControlSession', () => {
  it('allows an unclaimed session — a brand-new session must be usable at once', () => {
    expect(canControlSession('s1')).toBe(true);
  });

  it('allows a session we hold', () => {
    apply({ controllers: [holder('s1', 'me')] });
    expect(canControlSession('s1')).toBe(true);
  });

  it('refuses a session another ONLINE device holds', () => {
    apply({ controllers: [holder('s1', 'phone')] });
    expect(canControlSession('s1')).toBe(false);
  });

  // Closing the laptop must hand its sessions to the phone with no timer and no
  // cleanup pass — the holder simply stops counting once it is offline.
  it('allows a session whose holder has gone offline', () => {
    apply({ controllers: [holder('s1', 'phone', false)] });
    expect(canControlSession('s1')).toBe(true);
  });

  it('is unaffected by other sessions being held', () => {
    apply({ controllers: [holder('s1', 'phone'), holder('s2', 'me')] });
    expect(canControlSession('s1')).toBe(false);
    expect(canControlSession('s2')).toBe(true);
    expect(canControlSession('s3')).toBe(true);
  });
});

describe('controllerOf / isSpectator', () => {
  it('reports an online holder', () => {
    apply({ controllers: [holder('s1', 'phone')] });
    expect(controllerOf('s1')?.clientId).toBe('phone');
    expect(isSpectator('s1')).toBe(true);
  });

  it('treats an offline holder as no holder', () => {
    apply({ controllers: [holder('s1', 'phone', false)] });
    expect(controllerOf('s1')).toBeNull();
    expect(isSpectator('s1')).toBe(false);
  });

  it('we are never a spectator on our own session', () => {
    apply({ controllers: [holder('s1', 'me')] });
    expect(isSpectator('s1')).toBe(false);
  });
});

describe('canWriteWorkspace', () => {
  it('permits saving when the writer is unknown, so a solo client is never blocked', () => {
    expect(canWriteWorkspace()).toBe(true);
  });

  it('permits saving when we are the writer', () => {
    apply({ workspaceWriter: 'me' });
    expect(canWriteWorkspace()).toBe(true);
  });

  it('blocks saving when another device is the writer', () => {
    apply({ workspaceWriter: 'desktop' });
    expect(canWriteWorkspace()).toBe(false);
  });
});

describe('device helpers', () => {
  it('otherDevices excludes this one', () => {
    apply({ devices: [device('me', true), device('phone')] });
    expect(otherDevices().map((d) => d.clientId)).toEqual(['phone']);
  });

  it('controlledCount counts only online holds by that device', () => {
    apply({
      controllers: [
        holder('s1', 'me'),
        holder('s2', 'me'),
        holder('s3', 'me', false),
        holder('s4', 'phone'),
      ],
    });
    expect(controlledCount('me')).toBe(2);
    expect(controlledCount('phone')).toBe(1);
  });
});

describe('pending hand-over requests', () => {
  it('adds and clears by session', () => {
    const store = usePresenceStore.getState();
    store.addRequest({ sessionId: 's1', fromClientId: 'phone', fromLabel: 'iPhone', at: 5 });
    expect(usePresenceStore.getState().pendingRequests.get('s1')?.fromLabel).toBe('iPhone');

    usePresenceStore.getState().clearRequest('s1');
    expect(usePresenceStore.getState().pendingRequests.has('s1')).toBe(false);
  });

  it('clearing an absent request leaves state identical (no needless re-render)', () => {
    const before = usePresenceStore.getState().pendingRequests;
    usePresenceStore.getState().clearRequest('nope');
    expect(usePresenceStore.getState().pendingRequests).toBe(before);
  });
});

describe('applyPresence', () => {
  it('replaces state wholesale — the server is the source of truth', () => {
    apply({ devices: [device('a')], controllers: [holder('s1', 'a')], workspaceWriter: 'a' });
    apply({ devices: [device('b')], controllers: [], workspaceWriter: 'b' });

    const s = usePresenceStore.getState();
    expect(s.devices.map((d) => d.clientId)).toEqual(['b']);
    expect(s.controllers.size).toBe(0);
    expect(s.workspaceWriter).toBe('b');
  });
});
