// test/adminShareDefault.test.ts — `aasc-server share-default [on|off|status]`: the headless owner's
// switch for sessions started on the box itself (over ssh), which no screen there can share.
import { describe, it, expect, vi } from 'vitest';
import { runShareDefault } from '../cli/server/shareDefault.js';
import { EXIT, type AdminClient, type AdminResponse } from '../cli/server/http.js';

function fakeClient(responses: Record<string, AdminResponse>) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const client: AdminClient = {
    request: vi.fn(async (method, path, body) => {
      calls.push({ method, path, body });
      return responses[`${method} ${path}`] ?? { status: 404, body: {} };
    }),
  };
  return { client, calls };
}

const run = async (args: string[], responses: Record<string, AdminResponse>, json = false) => {
  const lines: string[] = [];
  const fake = fakeClient(responses);
  const code = await runShareDefault({ client: fake.client, args, json, out: (l) => lines.push(l) });
  return { code, lines, calls: fake.calls };
};

describe('aasc-server share-default', () => {
  it('reports the setting with no argument or `status`', async () => {
    for (const args of [[], ['status']]) {
      const { code, lines } = await run(args, { 'GET /api/sharing-default': { status: 200, body: { ok: true, shareNewSessions: false } } });
      expect(code).toBe(EXIT.OK);
      expect(lines.join('\n')).toMatch(/Share new sessions: off/);
    }
  });

  it('prints JSON with --json', async () => {
    const { lines } = await run([], { 'GET /api/sharing-default': { status: 200, body: { ok: true, shareNewSessions: true } } }, true);
    expect(JSON.parse(lines.join('\n'))).toEqual({ shareNewSessions: true });
  });

  it('turns it on and off with PUT', async () => {
    const on = await run(['on'], { 'PUT /api/sharing-default': { status: 200, body: { ok: true, shareNewSessions: true } } });
    expect(on.code).toBe(EXIT.OK);
    expect(on.calls).toEqual([{ method: 'PUT', path: '/api/sharing-default', body: { shareNewSessions: true } }]);
    expect(on.lines.join('\n')).toMatch(/Share new sessions: on/);
    // On covers sessions that appear from now; it says so, so nobody waits for an old one to show.
    expect(on.lines.join('\n')).toMatch(/already running/i);

    const off = await run(['off'], { 'PUT /api/sharing-default': { status: 200, body: { ok: true, shareNewSessions: false } } });
    expect(off.calls[0].body).toEqual({ shareNewSessions: false });
    expect(off.lines.join('\n')).toMatch(/Share new sessions: off/);
  });

  it('rejects anything else as a usage error, without asking the server', async () => {
    const { code, lines, calls } = await run(['maybe'], {});
    expect(code).toBe(EXIT.USAGE);
    expect(calls).toEqual([]);
    expect(lines.join('\n')).toMatch(/share-default on\|off\|status/);
  });

  it("passes the server's refusal on", async () => {
    const { code, lines } = await run(['on'], { 'PUT /api/sharing-default': { status: 500, body: { error: 'Could not save the setting' } } });
    expect(code).toBe(EXIT.FAILED);
    expect(lines.join('\n')).toMatch(/Could not save the setting/);
  });
});
