import { describe, expect, it } from 'vitest';
import { lastCliFor, otherCli, quickCreateRows } from './quickCreate';

const RECENT = ['/Users/me/Documents/sms-ops', '/Users/me/Documents/claude/agent-manager/', '/Users/me/site'];

describe('quickCreateRows', () => {
  it('lists the open session’s project first, then the recent folders once each', () => {
    const rows = quickCreateRows('/Users/me/Documents/claude/agent-manager', RECENT, '');
    expect(rows.map((r) => [r.name, r.current])).toEqual([['agent-manager', true], ['sms-ops', false], ['site', false]]);
  });

  it('keeps the rows whose path has every typed word, in any case and order', () => {
    expect(quickCreateRows(null, RECENT, 'OPS sms').map((r) => r.name)).toEqual(['sms-ops']);
    expect(quickCreateRows('/Users/me/site', RECENT, 'claude').map((r) => r.name)).toEqual(['agent-manager']);
    expect(quickCreateRows(null, RECENT, 'nothing-here')).toEqual([]);
  });

  it('stops at the limit', () => {
    const many = Array.from({ length: 30 }, (_, i) => `/p/project-${i}`);
    expect(quickCreateRows('/p/current', many, '', 5)).toHaveLength(5);
  });

  it('skips empty entries', () => {
    expect(quickCreateRows('', ['', '/a/b'], '').map((r) => r.dir)).toEqual(['/a/b']);
  });
});

describe('lastCliFor', () => {
  it('is the agent used last in that folder, else Claude', () => {
    const configs = { '/a': { command: 'codex --no-daemon' }, '/b': { command: 'claude' }, '/c': { command: 'bash' } };
    expect(lastCliFor('/a', configs)).toBe('codex');
    expect(lastCliFor('/b', configs)).toBe('claude');
    expect(lastCliFor('/c', configs)).toBe('claude');
    expect(lastCliFor('/unknown', configs)).toBe('claude');
    expect(lastCliFor('/a', null)).toBe('claude');
  });

  it('names the other agent', () => {
    expect(otherCli('claude')).toBe('codex');
    expect(otherCli('codex')).toBe('claude');
  });
});
