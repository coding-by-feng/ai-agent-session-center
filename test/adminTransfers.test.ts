// test/adminTransfers.test.ts — `aasc-server transfers` (Nov 27 2026): Project Transfer on a box with no
// screen. The command runs against a fake admin client; the routes it calls run on the real router.
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runTransfers, type TransfersDeps } from '../cli/server/transfers.js';
import { EXIT, type AdminClient } from '../cli/server/http.js';
import { createAllowList, createMovedLog } from '../server/projectTransfer/records.js';
import { createProjectTransferRouter } from '../server/projectTransfer/router.js';
import type { Receiver } from '../server/projectTransfer/receiver.js';
import type { Sender } from '../server/projectTransfer/sender.js';

const NOW = 1_800_000_000_000;
const REQ = {
  id: '6f1c2a10-1c2a-4f57-9a55-0d3c7c1e2a10', computerId: 'comp-1', computerLabel: 'MacBook\u001b[2J Pro',
  projectName: 'app', destination: '~/code/app', files: 12, bytes: 3 * 1024 * 1024, requestedAt: NOW - 120_000,
};

function fake(answers: Record<string, { status: number; body: unknown }>) {
  const calls: string[] = [];
  const client: AdminClient = {
    async request(method, path) {
      calls.push(`${method} ${path}`);
      return answers[`${method} ${path}`] ?? { status: 404, body: { success: false, error: 'Not found' } };
    },
  };
  return { client, calls };
}

function run(client: AdminClient, args: string[], json = false) {
  const lines: string[] = [];
  const deps: TransfersDeps = { client, args, json, out: (l) => lines.push(l), now: () => NOW };
  return runTransfers(deps).then((code) => ({ code, text: lines.join('\n') }));
}

const ok = (data: unknown) => ({ status: 200, body: { success: true, data } });

describe('aasc-server transfers', () => {
  it('lists waiting transfers and allowed computers, control characters stripped', async () => {
    const { client } = fake({
      'GET /api/project-transfer/requests': ok([REQ]),
      'GET /api/project-transfer/allowed': ok([{ computerId: 'comp-2abcdef9', label: 'Studio', allowedAt: NOW - 86_400_000 }]),
    });
    const { code, text } = await run(client, []);
    expect(code).toBe(EXIT.OK);
    expect(text).toMatch(/6f1c2a10 {2}MacBook\[2J Pro → ~\/code\/app {2}12 files · 3\.0 MB {2}2 min ago/);
    expect(text).not.toContain('\u001b');
    expect(text).toMatch(/comp-2ab {2}Studio/);
  });

  it('allows a waiting transfer by an ID prefix', async () => {
    const { client, calls } = fake({
      'GET /api/project-transfer/requests': ok([REQ]),
      [`POST /api/project-transfer/requests/${REQ.id}/allow`]: ok({ state: 'receiving' }),
    });
    const { code, text } = await run(client, ['allow', '6f1c']);
    expect(code).toBe(EXIT.OK);
    expect(calls).toContain(`POST /api/project-transfer/requests/${REQ.id}/allow`);
    expect(text).toMatch(/^Allowed\./);
  });

  it('refuses an unknown or ambiguous prefix without calling allow', async () => {
    const { client, calls } = fake({ 'GET /api/project-transfer/requests': ok([REQ, { ...REQ, id: `${REQ.id.slice(0, 4)}ffff-0000-4000-8000-000000000000` }]) });
    expect((await run(client, ['decline', '6f1c'])).text).toMatch(/2 waiting transfers/);
    expect((await run(client, ['decline', 'zz'])).code).toBe(EXIT.FAILED);
    expect(calls.some((c) => c.startsWith('POST'))).toBe(false);
  });

  it('forgets an allowed computer', async () => {
    const { client, calls } = fake({
      'GET /api/project-transfer/allowed': ok([{ computerId: 'comp-2abcdef9', label: 'Studio', allowedAt: NOW }]),
      'DELETE /api/project-transfer/allowed/comp-2abcdef9': ok(null),
    });
    const { code, text } = await run(client, ['forget', 'comp-2']);
    expect(code).toBe(EXIT.OK);
    expect(calls).toContain('DELETE /api/project-transfer/allowed/comp-2abcdef9');
    expect(text).toMatch(/Studio must ask for Allow again/);
  });

  it('says so on a server without Project Transfer, and rejects bad usage', async () => {
    const { client } = fake({});
    expect(await run(client, [])).toMatchObject({ code: EXIT.FAILED, text: expect.stringMatching(/no Project Transfer/) });
    expect((await run(client, ['frobnicate'])).code).toBe(EXIT.USAGE);
    expect((await run(client, ['allow', 'a', 'b'])).code).toBe(EXIT.USAGE);
  });
});

describe('the allowed-computer routes', () => {
  let dir: string;
  let server: Server;
  let origin: string;
  let local: boolean;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pt-allowed-'));
    local = true;
    const allowList = createAllowList(dir);
    allowList.allow('comp-1', 'Studio', NOW);
    const app = express();
    app.use(express.json());
    app.use('/api/project-transfer', createProjectTransferRouter({
      sender: {} as Sender, receiver: {} as Receiver, moved: createMovedLog(dir),
      isLocal: () => local, computerOf: () => null, secureChannel: () => false, allowed: allowList,
    }));
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/project-transfer`;
  });
  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });

  it('lists and forgets, on this computer only', async () => {
    expect((await (await fetch(`${origin}/allowed`)).json()).data).toEqual([{ computerId: 'comp-1', label: 'Studio', allowedAt: NOW }]);
    expect((await fetch(`${origin}/allowed/comp-9`, { method: 'DELETE' })).status).toBe(404);
    expect((await fetch(`${origin}/allowed/comp-1`, { method: 'DELETE' })).status).toBe(200);
    expect(createAllowList(dir).isAllowed('comp-1')).toBe(false);
    local = false;
    expect((await fetch(`${origin}/allowed`)).status).toBe(404);
  });
});
