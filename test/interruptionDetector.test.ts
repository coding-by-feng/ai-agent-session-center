import { describe, it, expect, beforeEach } from 'vitest';
import {
  matchFault,
  scanChunk,
  clearFaultState,
  resetFaultStates,
} from '../server/interruptionDetector.js';

/** The exact banner Claude Code printed in the reported incident. */
const BANNER_529 =
  'API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment. If it persists, check';

describe('matchFault', () => {
  it('classifies the real 529 Overloaded banner as an api_error', () => {
    const m = matchFault(`\n⏺ ${BANNER_529}\nhttps://status.claude.com.\n`);
    expect(m?.kind).toBe('api_error');
    expect(m?.line).toContain('529');
  });

  it('matches through ANSI colour codes', () => {
    const m = matchFault('\x1b[33m● API Error: 500 Internal Server Error\x1b[0m\n');
    expect(m?.kind).toBe('api_error');
  });

  it('classifies rate limiting ahead of the generic api_error shape', () => {
    expect(matchFault('API Error: 429 Too Many Requests')?.kind).toBe('rate_limit');
    expect(matchFault('You have hit your usage limit reached for this hour')?.kind).toBe(
      'rate_limit',
    );
  });

  it('classifies connection failures as network', () => {
    expect(matchFault('Connection error. Retrying...')?.kind).toBe('network');
    expect(matchFault('  fetch failed  ')?.kind).toBe('network');
    expect(matchFault('read ECONNRESET')?.kind).toBe('network');
  });

  it('returns null for ordinary output', () => {
    expect(matchFault('✓ 42 tests passed\n$ ')).toBeNull();
    expect(matchFault('')).toBeNull();
    expect(matchFault(null)).toBeNull();
  });

  it('ignores a long prose line that merely mentions an error code', () => {
    const prose =
      'The retry helper in src/net/client.ts wraps every outbound call so that a transient ' +
      'API Error: 529 from the upstream provider is retried with exponential backoff and jitter, ' +
      'instead of surfacing the raw failure to the caller directly.';
    expect(prose.length).toBeGreaterThan(200);
    expect(matchFault(prose)).toBeNull();
  });

  it('returns the most recent banner when a chunk holds several', () => {
    const m = matchFault('API Error: 500 oops\nsome work\nConnection error\n');
    expect(m?.kind).toBe('network');
  });
});

describe('scanChunk', () => {
  beforeEach(() => resetFaultStates());

  it('reports a fault exactly once — the redraw of the same banner is silent', () => {
    expect(scanChunk('t1', `⏺ ${BANNER_529}\n`, 1000)?.kind).toBe('api_error');
    // TUI repaints the same screen a moment later.
    expect(scanChunk('t1', `⏺ ${BANNER_529}\n`, 2000)).toBeNull();
    expect(scanChunk('t1', `⏺ ${BANNER_529}\n`, 30_000)).toBeNull();
  });

  it('does not re-fire from carried-over text once the dedupe window lapses', () => {
    expect(scanChunk('t1', `⏺ ${BANNER_529}\n`, 1000)?.kind).toBe('api_error');
    // Unrelated output long after the banner: the carry was dropped on report,
    // so there is nothing left to re-match even though dedupe has expired.
    expect(scanChunk('t1', 'npm test\n', 200_000)).toBeNull();
  });

  it('matches a banner split across two PTY reads', () => {
    expect(scanChunk('t1', 'API Err', 1000)).toBeNull();
    expect(scanChunk('t1', 'or: 529 Overloaded\n', 1001)?.kind).toBe('api_error');
  });

  it('reports a genuinely new fault after the dedupe window', () => {
    expect(scanChunk('t1', 'Connection error\n', 1000)?.kind).toBe('network');
    expect(scanChunk('t1', 'Connection error\n', 1000 + 61_000)?.kind).toBe('network');
  });

  it('reports a different banner immediately, without waiting out the dedupe', () => {
    expect(scanChunk('t1', 'Connection error\n', 1000)?.kind).toBe('network');
    expect(scanChunk('t1', `${BANNER_529}\n`, 1500)?.kind).toBe('api_error');
  });

  it('keeps per-terminal state isolated', () => {
    expect(scanChunk('t1', 'fetch failed\n', 1000)?.kind).toBe('network');
    expect(scanChunk('t2', 'fetch failed\n', 1000)?.kind).toBe('network');
  });

  it('forgets state on clearFaultState so a reused id starts clean', () => {
    expect(scanChunk('t1', 'fetch failed\n', 1000)?.kind).toBe('network');
    clearFaultState('t1');
    expect(scanChunk('t1', 'fetch failed\n', 1200)?.kind).toBe('network');
  });

  it('ignores empty chunks', () => {
    expect(scanChunk('t1', '', 1000)).toBeNull();
  });
});
