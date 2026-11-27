// test/adminKeepAwake.test.ts — `aasc-server keep-awake [off|busy|always|status]` (Nov 27 2026): a headless
// server's switch for staying awake, which setup asks first and no screen there can change later.
import { describe, it, expect, vi } from 'vitest';
import { runKeepAwake } from '../cli/server/keepAwake.js';
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
  const code = await runKeepAwake({ client: fake.client, args, json, out: (l) => lines.push(l) });
  return { code, lines, calls: fake.calls };
};

const answer = (mode: string, awake: boolean): AdminResponse => ({ status: 200, body: { success: true, data: { mode, awake, saved: true } } });

describe('aasc-server keep-awake', () => {
  it('reports the mode with no argument or `status`', async () => {
    for (const args of [[], ['status']]) {
      const { code, lines } = await run(args, { 'GET /api/config/keep-awake': answer('busy', false) });
      expect(code).toBe(EXIT.OK);
      expect(lines.join('\n')).toMatch(/Keep awake: while an agent is busy/);
      expect(lines.join('\n')).toMatch(/Not holding it awake now/);
    }
  });

  it('sets each mode with POST and says what it does now', async () => {
    const always = await run(['always'], { 'POST /api/config/keep-awake': answer('always', true) });
    expect(always.code).toBe(EXIT.OK);
    expect(always.calls).toEqual([{ method: 'POST', path: '/api/config/keep-awake', body: { mode: 'always' } }]);
    expect(always.lines.join('\n')).toMatch(/always: awake for as long as the server runs[\s\S]*Holding this box awake now/);
    const off = await run(['off'], { 'POST /api/config/keep-awake': answer('off', false) });
    expect(off.calls[0].body).toEqual({ mode: 'off' });
  });

  it('says so when it should hold but the helper stopped (review, Nov 27 2026)', async () => {
    const dead: AdminResponse = { status: 200, body: { success: true, data: { mode: 'always', awake: true, holding: false, saved: true } } };
    const { lines } = await run([], { 'GET /api/config/keep-awake': dead });
    expect(lines.join('\n')).toMatch(/Should be holding this box awake, but the keep-awake helper stopped/);
    expect(lines.join('\n')).not.toMatch(/Holding this box awake now/);
    const json = await run([], { 'GET /api/config/keep-awake': dead }, true);
    expect(JSON.parse(json.lines.join('\n'))).toEqual({ mode: 'always', awake: true, holding: false });
  });

  it('prints JSON with --json', async () => {
    const { lines } = await run([], { 'GET /api/config/keep-awake': answer('always', true) }, true);
    expect(JSON.parse(lines.join('\n'))).toEqual({ mode: 'always', awake: true, holding: true });
  });

  it('rejects anything else as a usage error, without asking the server', async () => {
    const { code, lines, calls } = await run(['on'], {});
    expect(code).toBe(EXIT.USAGE);
    expect(calls).toEqual([]);
    expect(lines.join('\n')).toMatch(/keep-awake off\|busy\|always\|status/);
  });

  it("passes the server's refusal on, and an answer it can't read fails", async () => {
    const refused = await run(['always'], { 'POST /api/config/keep-awake': { status: 500, body: { error: 'Couldn’t save the setting.' } } });
    expect(refused.code).toBe(EXIT.FAILED);
    expect(refused.lines.join('\n')).toMatch(/save the setting/);
    const old = await run([], { 'GET /api/config/keep-awake': { status: 200, body: { success: true, data: { enabled: true } } } });
    expect(old.code).toBe(EXIT.FAILED);
  });
});
