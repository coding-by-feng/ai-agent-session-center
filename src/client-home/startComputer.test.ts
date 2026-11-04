import { describe, it, expect } from 'vitest';
import type { RemoteComputer } from '@/types/electron';
import { pickStartComputer } from './startComputer';

const computer = (id: string, status: RemoteComputer['status']) => ({ id, name: id, status }) as RemoteComputer;

describe('which computer a Client opens on launch', () => {
  it('opens the last one', () => {
    expect(pickStartComputer([computer('a', 'active'), computer('b', 'active')], 'b')?.id).toBe('b');
  });

  it('opens the only one, without a last', () => {
    expect(pickStartComputer([computer('a', 'active')], null)?.id).toBe('a');
  });

  it('asks when there are several and no last', () => {
    expect(pickStartComputer([computer('a', 'active'), computer('b', 'active')], null)).toBeNull();
  });

  it('asks when the last one is gone and several remain', () => {
    expect(pickStartComputer([computer('a', 'active'), computer('b', 'active')], 'gone')).toBeNull();
  });

  it.each(['pending', 'revoked'] as const)('never opens a %s computer', (status) => {
    expect(pickStartComputer([computer('a', status)], 'a')).toBeNull();
    expect(pickStartComputer([computer('a', status)], null)).toBeNull();
  });

  it('skips a last computer that was revoked for the only active one', () => {
    expect(pickStartComputer([computer('a', 'revoked'), computer('b', 'active')], 'a')?.id).toBe('b');
  });

  it('asks when nothing is paired', () => {
    expect(pickStartComputer([], null)).toBeNull();
  });
});
