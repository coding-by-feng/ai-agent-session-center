// test/presenceCliRole.test.ts — a terminal client is never the workspace writer (D10).
//
// The workspace writer is the one device that saves the shared snapshot and fires the prompt queue,
// loops and auto-resume (presenceManager.ts). `aasc` connects with `role=cli` (or the header
// `X-AASC-Role: cli`): an `--ssh` client is local and would beat every remote dashboard, and a long
// `aasc watch` is the oldest connection and would beat every newer one. Either way the real
// dashboards would stop firing the queue and saving the workspace.
//
// The role can only take privilege away. These tests pin both halves: a CLI is skipped, and a
// dashboard on its own behaves exactly as before.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

import {
  registerClient,
  unregisterClient,
  getWorkspaceWriter,
  canWriteWorkspace,
  claimWorkspaceRestore,
  presenceSnapshot,
  _resetForTests,
} from '../server/presenceManager.js';
import { clientRoleOf } from '../server/clientRole.js';

let clock = 1_000;
beforeEach(() => {
  clock = 1_000;
  _resetForTests(() => clock);
});

function connect(clientId: string, opts: { isLocal: boolean; cli?: boolean }): void {
  registerClient({ clientId, label: clientId, address: opts.isLocal ? '127.0.0.1' : '100.64.0.9', isLocal: opts.isLocal, cli: opts.cli });
  clock += 10;
}

describe('getWorkspaceWriter with CLI clients', () => {
  it('skips a local CLI (aasc --ssh) and keeps the remote dashboard as writer', () => {
    connect('phone-dash', { isLocal: false });
    connect('aasc-ssh', { isLocal: true, cli: true });
    expect(getWorkspaceWriter()).toBe('phone-dash');
  });

  it('skips the oldest connection when it is a CLI (a long aasc watch)', () => {
    connect('aasc-watch', { isLocal: false, cli: true });
    connect('browser', { isLocal: false });
    expect(getWorkspaceWriter()).toBe('browser');
  });

  it('is null when only CLI clients are connected: nobody fires the queue', () => {
    connect('aasc-1', { isLocal: true, cli: true });
    connect('aasc-2', { isLocal: false, cli: true });
    expect(getWorkspaceWriter()).toBeNull();
  });

  it('never lets a CLI save the workspace, even when no dashboard is connected', () => {
    connect('aasc', { isLocal: true, cli: true });
    expect(canWriteWorkspace('aasc')).toBe(false);
    connect('dash', { isLocal: true });
    expect(canWriteWorkspace('aasc')).toBe(false);
    expect(canWriteWorkspace('dash')).toBe(true);
  });

  it('keeps a dashboard the writer while a CLI shares its id', () => {
    connect('shared-id', { isLocal: true });
    connect('shared-id', { isLocal: true, cli: true });
    expect(getWorkspaceWriter()).toBe('shared-id');
    expect(canWriteWorkspace('shared-id')).toBe(true);
    // The CLI socket closes: still a dashboard.
    unregisterClient('shared-id', { cli: true });
    expect(getWorkspaceWriter()).toBe('shared-id');
  });

  it('drops the device as a candidate once only CLI connections are left', () => {
    connect('shared-id', { isLocal: true });
    connect('shared-id', { isLocal: true, cli: true });
    unregisterClient('shared-id', { cli: false });
    expect(getWorkspaceWriter()).toBeNull();
    expect(canWriteWorkspace('shared-id')).toBe(false);
    // A dashboard connects again under the id: a candidate again.
    connect('shared-id', { isLocal: true });
    expect(getWorkspaceWriter()).toBe('shared-id');
  });

  it('refuses a CLI the workspace restore claim, so the first dashboard still restores', () => {
    connect('aasc', { isLocal: true, cli: true });
    expect(claimWorkspaceRestore({ clientId: 'aasc', label: 'aasc', liveSessionCount: 0 })).toMatchObject({ granted: false });
    connect('dash', { isLocal: true });
    expect(claimWorkspaceRestore({ clientId: 'dash', label: 'dash', liveSessionCount: 0 })).toMatchObject({ granted: true });
  });

  it('marks CLI devices in the presence snapshot', () => {
    connect('aasc', { isLocal: true, cli: true });
    connect('dash', { isLocal: true });
    const byId = Object.fromEntries(presenceSnapshot().devices.map((d) => [d.clientId, d]));
    expect(byId.aasc.cli).toBe(true);
    expect(byId.dash.cli).toBe(false);
  });
});

describe('a dashboard on its own is unchanged', () => {
  it('local beats remote, then the oldest wins', () => {
    connect('phone', { isLocal: false });
    connect('mac-1', { isLocal: true });
    connect('mac-2', { isLocal: true });
    expect(getWorkspaceWriter()).toBe('mac-1');
  });

  it('an unregistered HTTP caller may still save when nobody is connected', () => {
    expect(canWriteWorkspace('')).toBe(true);
  });
});

describe('clientRoleOf', () => {
  it('reads role=cli from the upgrade URL or X-AASC-Role from the headers', () => {
    expect(clientRoleOf({ url: '/?clientId=a&role=cli', headers: {} })).toBe('cli');
    expect(clientRoleOf({ url: '/', headers: { 'x-aasc-role': 'cli' } })).toBe('cli');
    expect(clientRoleOf({ url: '/', headers: { 'x-aasc-role': 'CLI' } })).toBe('cli');
  });

  it('treats anything else as a dashboard', () => {
    expect(clientRoleOf({ url: '/?clientId=a', headers: {} })).toBe('dashboard');
    expect(clientRoleOf({ url: '/?role=admin', headers: { 'x-aasc-role': 'writer' } })).toBe('dashboard');
    expect(clientRoleOf({ url: 'http://[bad', headers: {} })).toBe('dashboard');
    expect(clientRoleOf({})).toBe('dashboard');
  });
});
