// test/mcp/routerOwned.test.ts — auto routing never reuses a session that is another central's own worker (Ruling
// P4-56): that worker is spoken for. The caller's own worker is still a candidate. Explicit delegation by id is not
// the router's business and stays allowed through the rails. The registry is a stand-in: nothing reaches a process.
import { describe, expect, it, vi } from 'vitest';
import { A, AGENT, B, GLOBAL, go, reuseOf, routeDeps, worker } from './routerFixtures.js';

vi.mock('../../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

const OTHER = 'central-2';
/** A owns the better card by score (recent, little context); the registry says who opened which terminal. */
const better = { lastActivityAt: Date.now() };
const ownerOf = (owners: Record<string, string>) => (s: { terminalId?: string | null }) => owners[s.terminalId ?? ''] ?? null;

describe('auto routing and another central’s own worker (Ruling P4-56)', () => {
  it('auto routing does not reuse another central’s own worker', async () => {
    const sessions = [worker(A, AGENT, { ...better, status: 'idle' }), worker(B, AGENT)];
    const r = await go({ central: GLOBAL, sessions }, {}, routeDeps({ ownerOf: ownerOf({ [`t-${A}`]: OTHER }) })).result;

    expect(reuseOf(r)).toBe(B);
    expect(r.runnersUp).toEqual([expect.objectContaining({ sessionId: A, skipped: 'another central’s own worker' })]);
  });

  it('the caller’s own worker is still reused', async () => {
    const sessions = [worker(A, AGENT, { ...better, status: 'idle' }), worker(B, AGENT)];
    const r = await go({ central: GLOBAL, sessions }, {}, routeDeps({ ownerOf: ownerOf({ [`t-${A}`]: GLOBAL.centralId }) })).result;

    expect(reuseOf(r)).toBe(A);
  });
});
