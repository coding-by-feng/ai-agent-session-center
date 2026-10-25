// cloudSyncStates.test.ts — one vocabulary for the sync states (Oct 23 2026), so the Library glyph,
// the detail button and the Cloud sync list agree.
import { describe, expect, it } from 'vitest';
import { SYNC_STATES } from '@/types/cloudResources';
import {
  MOVING_STATES,
  SYNC_STATE_INFO,
  canSaveToCloud,
  syncGroup,
  syncVersionText,
} from './cloudSyncStates';

describe('sync states', () => {
  it('names every state the server can send', () => {
    for (const state of SYNC_STATES) expect(SYNC_STATE_INFO[state].label).toMatch(/\S/);
  });

  it('files what needs a person under Needs you: a choice, a memory OK, a resource that cannot sync', () => {
    expect(syncGroup({ state: 'conflict', memory: false })).toBe('needs-you');
    expect(syncGroup({ state: 'blocked', memory: false })).toBe('needs-you');
    expect(syncGroup({ state: 'local-changed', memory: true })).toBe('needs-you');
    expect(syncGroup({ state: 'local-changed', memory: false })).toBe('waiting');
    expect(syncGroup({ state: 'cloud-only', memory: false })).toBe('waiting');
    expect(syncGroup({ state: 'synced', memory: true })).toBe('synced');
    expect(syncGroup({ state: 'stopped', memory: false })).toBe('stopped');
    expect(syncGroup({ state: 'removed', memory: false })).toBe('removed');
  });

  it('never counts a stopped or removed resource as one Sync now moves', () => {
    expect(MOVING_STATES).not.toContain('stopped');
    expect(MOVING_STATES).not.toContain('removed');
  });

  it('says where the versions stand', () => {
    expect(syncVersionText({ state: 'local-changed', cloudVersion: 2, syncedVersion: 2 })).toBe(
      'cloud has v2',
    );
    expect(syncVersionText({ state: 'cloud-newer', cloudVersion: 4, syncedVersion: 3 })).toBe(
      'v3 here · v4 in cloud',
    );
    expect(syncVersionText({ state: 'removed', cloudVersion: null, syncedVersion: 3 })).toBe(
      'was v3',
    );
    expect(syncVersionText({ state: 'synced', cloudVersion: 5, syncedVersion: 5 })).toBe('v5');
  });

  it('offers Save to cloud only for user-owned resources of the types the cloud carries', () => {
    expect(canSaveToCloud({ type: 'skill', origin: 'user' })).toBe(true);
    expect(canSaveToCloud({ type: 'memory', origin: 'user' })).toBe(true);
    expect(canSaveToCloud({ type: 'hook', origin: 'user' })).toBe(false);
    expect(canSaveToCloud({ type: 'skill', origin: 'plugin' })).toBe(false);
    expect(canSaveToCloud({ type: 'skill', origin: 'user', linkTarget: '/elsewhere' })).toBe(false);
  });
});
