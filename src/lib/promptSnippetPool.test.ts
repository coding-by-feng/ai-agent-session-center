import { describe, it, expect } from 'vitest';
import { poolRecentPrompts, RECENT_LIMIT, type RecentPromptSource } from './promptSnippetPool';

function source(
  sessionLabel: string,
  ...entries: Array<[text: string, timestamp: number]>
): RecentPromptSource {
  return { sessionLabel, promptHistory: entries.map(([text, timestamp]) => ({ text, timestamp })) };
}

describe('poolRecentPrompts', () => {
  it('returns an empty list for no sources', () => {
    expect(poolRecentPrompts([])).toEqual([]);
  });

  it('pools prompts from every session, newest first', () => {
    const rows = poolRecentPrompts([
      source('agent-manager', ['fix the queue', 100]),
      source('thesis', ['bump the intro', 300]),
      source('kason-tools', ['scrape temu', 200]),
    ]);
    expect(rows.map((r) => r.text)).toEqual(['bump the intro', 'scrape temu', 'fix the queue']);
  });

  it('tags each row with the session it came from', () => {
    const rows = poolRecentPrompts([source('thesis', ['bump the intro', 300])]);
    expect(rows[0].sessionLabel).toBe('thesis');
  });

  // The reason dedupe exists: pooling across sessions means a common prompt
  // like /compact appears in many histories, and without this the list is
  // mostly duplicates of the same few commands.
  it('dedupes identical text across sessions', () => {
    const rows = poolRecentPrompts([
      source('agent-manager', ['/compact', 100]),
      source('thesis', ['/compact', 200]),
      source('kason-tools', ['/compact', 150]),
    ]);
    expect(rows).toHaveLength(1);
  });

  it('keeps the NEWEST occurrence, so the breadcrumb names the latest session', () => {
    const rows = poolRecentPrompts([
      source('agent-manager', ['/compact', 100]),
      source('thesis', ['/compact', 900]),
      source('kason-tools', ['/compact', 150]),
    ]);
    expect(rows[0]).toEqual({ text: '/compact', timestamp: 900, sessionLabel: 'thesis' });
  });

  it('dedupes within a single session too', () => {
    const rows = poolRecentPrompts([
      source('agent-manager', ['/compact', 100], ['/compact', 400], ['other', 200]),
    ]);
    expect(rows.map((r) => r.text)).toEqual(['/compact', 'other']);
    expect(rows[0].timestamp).toBe(400);
  });

  it('trims text and dedupes across whitespace differences', () => {
    const rows = poolRecentPrompts([
      source('a', ['  /compact  ', 100]),
      source('b', ['/compact', 200]),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe('/compact');
  });

  it('drops blank and whitespace-only entries', () => {
    const rows = poolRecentPrompts([source('a', ['', 100], ['   \n ', 200], ['real', 300])]);
    expect(rows.map((r) => r.text)).toEqual(['real']);
  });

  it('caps the list at the requested limit, keeping the newest', () => {
    const entries: Array<[string, number]> = Array.from({ length: 10 }, (_, i) => [
      `prompt ${i}`,
      i * 10,
    ]);
    const rows = poolRecentPrompts([source('a', ...entries)], 3);
    expect(rows.map((r) => r.text)).toEqual(['prompt 9', 'prompt 8', 'prompt 7']);
  });

  it('defaults to RECENT_LIMIT rows', () => {
    const entries: Array<[string, number]> = Array.from(
      { length: RECENT_LIMIT + 15 },
      (_, i) => [`prompt ${i}`, i],
    );
    expect(poolRecentPrompts([source('a', ...entries)])).toHaveLength(RECENT_LIMIT);
  });

  it('returns an empty list for a non-positive limit rather than throwing', () => {
    expect(poolRecentPrompts([source('a', ['x', 1])], 0)).toEqual([]);
    expect(poolRecentPrompts([source('a', ['x', 1])], -5)).toEqual([]);
  });

  it('tolerates a session with no prompt history', () => {
    expect(poolRecentPrompts([source('empty')])).toEqual([]);
  });
});
