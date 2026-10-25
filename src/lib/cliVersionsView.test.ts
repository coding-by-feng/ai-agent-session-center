import { describe, it, expect } from 'vitest';
import type { CliVersionInfo } from '@/types/cliVersions';
import { describeCli, formatElapsed, logToggleLabel } from './cliVersionsView';
import { isCliVersionInfo } from './cliVersionsApi';

const info = (over: Partial<CliVersionInfo> = {}): CliVersionInfo => ({
  cli: 'codex', installed: '0.163.0', latest: '0.164.0', updateAvailable: true, checkedAt: 1, update: { state: 'idle' }, ...over,
});

describe('describeCli', () => {
  it('offers an update when npm has a newer version', () => {
    expect(describeCli(info(), null)).toEqual({ name: 'Codex', status: '0.163.0 · 0.164.0 available', tone: 'available', buttonLabel: 'Update', disabledReason: undefined });
  });

  it('says up to date, and disables Update, when it is the newest', () => {
    const v = describeCli(info({ latest: '0.163.0', updateAvailable: false }), null);
    expect(v).toMatchObject({ status: '0.163.0 · up to date', tone: 'ok', disabledReason: 'Already the newest version.' });
  });

  it('still lets you try when npm could not be reached', () => {
    const v = describeCli(info({ latest: null, updateAvailable: false }), null);
    expect(v.disabledReason).toBeUndefined();
    expect(v.status).toMatch(/couldn’t check/);
  });

  it('shows a running update and blocks the other CLI', () => {
    const running = info({ update: { state: 'updating', from: '0.163.0' } });
    expect(describeCli(running, 'codex')).toMatchObject({ status: 'Updating from 0.163.0…', tone: 'busy', buttonLabel: 'Updating…' });
    expect(describeCli(info({ cli: 'claude' }), 'codex').disabledReason).toMatch(/Codex is updating/);
  });

  it('reports success with the restart note, failure with its reason (retry allowed)', () => {
    const done = describeCli(info({ installed: '0.164.0', updateAvailable: false, update: { state: 'updated', from: '0.163.0', to: '0.164.0' } }), null);
    expect(done.status).toMatch(/^Updated 0\.163\.0 → 0\.164\.0\. New sessions use it; restart running ones/);
    const failed = describeCli(info({ update: { state: 'failed', error: 'npm ERR! code EACCES' } }), null);
    expect(failed).toMatchObject({ status: 'Update failed: npm ERR! code EACCES', tone: 'error', disabledReason: undefined });
  });

  it('explains a channel that has nothing newer than npm’s latest', () => {
    const v = describeCli(info({ cli: 'claude', installed: '2.1.300', latest: '2.1.310', update: { state: 'current', from: '2.1.300', to: '2.1.300' } }), null);
    expect(v.status).toMatch(/newest on its release channel \(npm has 2\.1\.310\)/);
    expect(v.disabledReason).toBeDefined();
  });

  it('cannot update a CLI that is not installed', () => {
    const v = describeCli(info({ installed: null, updateAvailable: false }), null);
    expect(v).toMatchObject({ status: 'Not found on this Mac' });
    expect(v.disabledReason).toMatch(/isn’t installed/);
  });
});

describe('isCliVersionInfo', () => {
  it('takes a well-formed info and refuses anything else', () => {
    expect(isCliVersionInfo(info())).toBe(true);
    expect(isCliVersionInfo({ ...info(), cli: 'gemini' })).toBe(false);
    expect(isCliVersionInfo({ ...info(), update: { state: 'weird' } })).toBe(false);
    expect(isCliVersionInfo({ ...info(), installed: 3 })).toBe(false);
    expect(isCliVersionInfo(null)).toBe(false);
  });
});

describe('update log text', () => {
  it('formats a duration as minutes and seconds', () => {
    expect(formatElapsed(42_400)).toBe('0:42');
    expect(formatElapsed(245_000)).toBe('4:05');
    expect(formatElapsed(-5)).toBe('0:00');
  });
  it('labels the finished log’s toggle', () => {
    expect(logToggleLabel(12, 48_000, false)).toBe('Show log (12 lines · took 0:48)');
    expect(logToggleLabel(1, null, false)).toBe('Show log (1 line)');
    expect(logToggleLabel(3, 1_000, true)).toBe('Hide log');
  });
  it('accepts a status with a log and rejects one whose log is malformed', () => {
    expect(isCliVersionInfo(info({ update: { state: 'updating', startedAt: 5, log: ['a', 'b'] } }))).toBe(true);
    expect(isCliVersionInfo(info({ update: { state: 'updating', log: [1] as unknown as string[] } }))).toBe(false);
    expect(isCliVersionInfo(info({ update: { state: 'updating', startedAt: '5' as unknown as number } }))).toBe(false);
  });
});
