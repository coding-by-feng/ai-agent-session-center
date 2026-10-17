// useControlBaton.test.ts — which side of the control baton this device is on.
import { describe, it, expect } from 'vitest';
import { controlBatonMode } from './useControlBaton';
import type { ControlHolderView } from '@/types';

const holder = (clientId: string, online = true): ControlHolderView => ({
  sessionId: 's1', clientId, label: clientId, since: 1, lastActivityAt: 1, online,
});
const request = { sessionId: 's1', fromClientId: 'desk', fromLabel: 'MacBook', at: 1 };

describe('controlBatonMode', () => {
  it('is solo with one device, whoever holds it', () => {
    expect(controlBatonMode(1, holder('desk'), undefined, 'phone')).toBe('solo');
  });
  it('is free when nobody holds it, or the holder went offline', () => {
    expect(controlBatonMode(2, undefined, undefined, 'phone')).toBe('free');
    expect(controlBatonMode(2, holder('desk', false), undefined, 'phone')).toBe('free');
  });
  // Oct 2026, by request: every device drives directly, so nobody watches and nobody asks.
  it('is never spectator: another device that drove last leaves this one free', () => {
    expect(controlBatonMode(2, holder('desk'), undefined, 'phone')).toBe('free');
  });
  it('is driver when this device acted last (asked only for an old client\'s request)', () => {
    expect(controlBatonMode(2, holder('phone'), undefined, 'phone')).toBe('driver');
    expect(controlBatonMode(2, holder('phone'), request, 'phone')).toBe('asked');
  });
});
