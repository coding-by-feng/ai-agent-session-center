import { afterEach, expect, it } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mountHostedUi } from '../server/hostedUi.js';

let server: Server;
let dir: string;
afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
  if (dir) rmSync(dir, { recursive: true, force: true });
});
it('serves both edition entries and deep links with isolated assets and the same API', async () => {
  dir = mkdtempSync(join(tmpdir(), 'aasc-editions-'));
  for (const edition of ['lite', 'full']) {
    mkdirSync(join(dir, edition, 'assets'), { recursive: true });
    writeFileSync(
      join(dir, edition, 'index.html'),
      `<html><head></head><body>${edition}</body></html>`,
    );
    writeFileSync(join(dir, edition, 'assets', 'entry.js'), `// ${edition}`);
  }
  const app = express();
  mountHostedUi(app, { root: dir, websiteOrigin: 'https://xclaude.dev' });
  app.get('/api/example', (_req, res) => res.json({ runtime: 'one' }));
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  for (const edition of ['lite', 'full']) {
    const response = await fetch(`${base}/ui/${edition}/history`);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain(`<body>${edition}</body>`);
    expect(html).toContain(`name="aasc-ui-base" content="/ui/${edition}"`);
    expect(html).toContain('name="aasc-hosted-parent" content="https://xclaude.dev"');
    expect(await (await fetch(`${base}/ui/${edition}/assets/entry.js`)).text()).toBe(
      `// ${edition}`,
    );
    expect((await fetch(`${base}/ui/${edition}/assets/missing.js`)).status).toBe(404);
  }
  expect((await fetch(`${base}/ui/invalid/`)).status).toBe(404);
  expect(await (await fetch(`${base}/api/example`)).json()).toEqual({ runtime: 'one' });
  rmSync(join(dir, 'full', 'index.html'));
  expect((await fetch(`${base}/ui/full/`)).status).toBe(503);
});
