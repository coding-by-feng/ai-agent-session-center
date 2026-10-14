// pushChannels.test.ts — AASC-19: Android channels and iOS presentation.
import { describe, it, expect } from 'vitest';
import { ANDROID_CHANNELS, androidChannelFor, IOS_CATEGORIES, iosPresentation, interruptionLevel, iosCategoryId } from './pushChannels';
import { parsePush, GENERIC_TEXT, type PushKind } from './pushPayload';

/** aasc-backend src/services/push/payload.ts FCM_CHANNELS: the channel_id each kind is sent with. */
const BACKEND_FCM_CHANNELS: Record<PushKind, string> = {
  approval: 'approval', input: 'input', finished: 'finished', interrupted: 'interrupted', test: 'finished',
};

const KINDS: PushKind[] = ['approval', 'input', 'finished', 'interrupted', 'test'];

describe('Android channels', () => {
  it('creates exactly the channels the backend sends to', () => {
    expect(ANDROID_CHANNELS.map((c) => c.id).sort()).toEqual([...new Set(Object.values(BACKEND_FCM_CHANNELS))].sort());
    for (const kind of KINDS) expect(androidChannelFor(kind)).toBe(BACKEND_FCM_CHANNELS[kind]);
  });

  it('makes approval, input and interrupted high importance, finished default (the plan and AASC-19)', () => {
    const importance = Object.fromEntries(ANDROID_CHANNELS.map((c) => [c.id, c.importance]));
    expect(importance).toEqual({ approval: 4, input: 4, finished: 3, interrupted: 4 });
  });

  it('hides content on the lock screen and names every channel', () => {
    for (const c of ANDROID_CHANNELS) {
      expect(c.visibility).toBe(0);
      expect(c.name.length).toBeGreaterThan(0);
      expect(c.description.length).toBeGreaterThan(0);
    }
  });
});

describe('iOS presentation', () => {
  it('is time-sensitive for approval and input only (the backend rule)', () => {
    expect(KINDS.map((k) => [k, interruptionLevel(k)])).toEqual([
      ['approval', 'time-sensitive'], ['input', 'time-sensitive'],
      ['finished', 'active'], ['interrupted', 'active'], ['test', 'active'],
    ]);
  });

  it('groups by the thread the payload names, falling back to the session', () => {
    const arrival = parsePush({ data: { aps: { 'thread-id': 'sess-9' }, aasc: { v: 1, kind: 'input', sessionRef: 'sess-9' } } })!;
    expect(iosPresentation(arrival)).toEqual({ threadIdentifier: 'sess-9', interruptionLevel: 'time-sensitive', categoryIdentifier: 'AASC_INPUT' });
  });

  it('has one action-less category per kind whose hidden preview is generic', () => {
    expect(IOS_CATEGORIES.map((c) => c.identifier)).toEqual(KINDS.map(iosCategoryId));
    for (const [i, kind] of KINDS.entries()) {
      expect(IOS_CATEGORIES[i].hiddenPreviewsBodyPlaceholder).toBe(GENERIC_TEXT[kind]);
      expect(IOS_CATEGORIES[i].actions).toEqual([]);
    }
  });
});
