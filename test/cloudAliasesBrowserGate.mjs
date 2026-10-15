/** Disposable fixture only: no AASC startup/hooks, CLI sessions, credentials or live BE. */
import { createServer as createVite } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import express from 'express';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, realpath, rm, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createCloudAliases } from '../server/cloud/aliases.ts';
import { createCloudAliasesRouter } from '../server/cloud/aliasRouter.ts';
import { createNotesRouter } from '../server/cloud/notesRouter.ts';
import { isLocalResourceRequest, isSameOriginWrite } from '../server/resourceRouter.ts';
import { CloudError } from '../server/cloud/types.ts';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const home = await realpath(await mkdtemp(join(tmpdir(), 'aasc-alias-browser-')));
await mkdir(join(home, '.claude'));
const identity = {
  backendOrigin: 'https://fixture.invalid',
  accountId: '11111111-1111-4111-8111-111111111111',
  generation: 1,
};
let record = {
  key: 'claude:browser-fixture',
  value: { fav: false, tags: [], abbr: 'bf', cli: true },
  version: 1,
  deleted: false,
  tagDots: [],
};
let connection = { ...identity, deviceId: identity.accountId, deviceName: 'disposable' },
  offline = false;
let directCalls = 0;
const stops = new Set();
const cloud = {
  status: () => ({ connection, state: offline ? 'offline' : 'connected', lastError: null }),
  onStop(fn) {
    stops.add(fn);
    return () => stops.delete(fn);
  },
  client: {
    async request(method, path, body) {
      if (offline) throw new CloudError('offline', 'Fixture offline', 503);
      if (method === 'GET') return { records: [record], cursor: 'fixture', hasMore: false };
      return {
        results: body.ops.map((op) => {
          record = {
            ...record,
            value: { ...record.value, ...op.set },
            version: record.version + 1,
          };
          if (!record.value.cli) delete record.value.cli;
          return { mutationId: op.mutationId, record };
        }),
      };
    },
  },
};
const resource = {
  id: 'fixture',
  type: 'skill',
  agent: 'claude',
  scope: 'global',
  origin: 'user',
  format: 'markdown',
  name: 'browser-fixture',
  path: '~/.claude/skills/browser-fixture',
  fileCount: 1,
  bytes: 1,
  mtimeMs: 0,
  repo: { status: 'not-tracked' },
  variantIds: [],
  findingCodes: [],
};
let localResources = [resource];
const service = await createCloudAliases({
  cloud,
  home,
  directory: join(home, 'private'),
  catalog: () => ({ state: 'ready', resources: localResources }),
});
const app = express();
app.use(express.json());
app.use('/api/cloud/skill-notes', createNotesRouter(cloud));
app.use('/api/resources', (req, res, next) =>
  isLocalResourceRequest(req) ? next() : res.status(404).end(),
);
app.use(
  '/api/resources/cloud/aliases',
  createCloudAliasesRouter(async () => service, isSameOriginWrite),
);
app.use('/api/resources/aliases', (_req, res) => {
  directCalls++;
  res.status(500).end();
});
const server = createServer(app);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const api = `http://127.0.0.1:${server.address().port}`;
const vite = await createVite({
  root,
  configFile: false,
  cacheDir: join(home, 'vite-cache'),
  optimizeDeps: { entries: ['test/fixtures/notes-browser.tsx'] },
  plugins: [
    react({ exclude: /vite-cache/ }),
    {
      name: 'aliases-fixture',
      configureServer(s) {
        s.middlewares.use((req, res, next) => {
          if (req.url !== '/alias-test') return next();
          res.setHeader('content-type', 'text/html');
          res.end(
            '<html><head><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>(type)=>type;window.__vite_plugin_react_preamble_installed__=true;</script></head><body><div id="root"></div><script type="module" src="/test/fixtures/notes-browser.tsx"></script></body></html>',
          );
        });
      },
    },
  ],
  resolve: { alias: { '@': join(root, 'src') } },
  server: {
    host: '127.0.0.1',
    port: 0,
    cors: false,
    proxy: { '/api': { target: api, changeOrigin: true } },
  },
});
let browser;
const present = async (p) => {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
};
try {
  await vite.listen();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}/alias-test`);
  await page.waitForFunction(() => window.notesHarness?.store.getState().ready);
  await page.evaluate(async () => {
    await window.notesHarness.connect();
    const s = window.notesHarness.store.getState();
    const review = await s.previewImport();
    await s.useCloudNotes('separate', review);
  });
  const aliasFile = join(home, '.claude/commands/bf.md');
  await page.getByRole('checkbox', { name: 'Install cloud aliases on this device' }).click();
  await page.waitForFunction(
    () => document.querySelector('[aria-label="Install cloud aliases on this device"]').checked,
  );
  assert.equal(await present(aliasFile), false);
  await page.getByRole('button', { name: 'Review alias for this device' }).click();
  await page.getByText('~/.claude/commands/bf.md', { exact: true }).waitFor();
  assert.equal(await present(aliasFile), false);
  await page.screenshot({ path: '/tmp/aasc-task9-alias-review.png', fullPage: true });
  await page.getByRole('button', { name: 'Apply reviewed alias' }).click();
  await page.getByText(/Local result: installed/).waitFor();
  assert.match(await readFile(aliasFile, 'utf8'), /aasc-alias:v1/);
  await page.getByRole('checkbox', { name: /Use this abbreviation as a CLI command on my devices/ }).uncheck();
  await page.evaluate(async () => {
    await window.notesHarness.store.getState().flush();
    await window.notesHarness.store.getState().refresh();
  });
  assert.equal(await present(aliasFile), true);
  await page.getByRole('button', { name: 'Review alias for this device' }).click();
  await page.getByRole('button', { name: 'Apply reviewed alias' }).click();
  await page.waitForFunction(
    () => !document.querySelector('[aria-label="Alias installation review"]'),
  );
  assert.equal(await present(aliasFile), false);
  // I5: pending rr is not acknowledged rv; review must disclose rv even without the target.
  record = { ...record, value: { ...record.value, abbr: 'rv', cli: true }, version: record.version + 1 };
  await page.evaluate(() => window.notesHarness.store.getState().refresh());
  await service.preview([record.key], identity); // Seed the fixture's server-owned acknowledged offline snapshot.
  await page.getByRole('textbox', { name: 'Abbreviation', exact: true }).fill('rr');
  offline = true;
  await page.getByRole('button', { name: 'Save abbreviation', exact: true }).click();
  await page.evaluate(() => window.notesHarness.store.getState().flush());
  assert.equal(record.value.abbr, 'rv');
  localResources = [];
  await page.getByRole('button', { name: 'Review alias for this device' }).click();
  const disclosure = page.locator('[aria-label="Saved cloud alias to approve"]');
  await disclosure.getByText('rv', { exact: true }).waitFor();
  await disclosure.getByText('browser-fixture', { exact: true }).waitFor();
  await disclosure.getByText('CLI command requested: yes', { exact: true }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: 'Abbreviation', exact: true }).inputValue(), 'rr');
  assert.equal(await present(join(home, '.claude/commands/rv.md')), false);
  await page.screenshot({ path: '/tmp/aasc-task9-fix1-alias-review.png', fullPage: true });
  await page.getByRole('button', { name: 'Apply reviewed alias' }).click();
  await page.getByText(/Local result: needs-resource/).waitFor();
  localResources = [resource];
  const retried = await service.retryAcknowledgedTarget(record.key);
  assert.equal(retried[0].state, 'installed');
  assert.match(await readFile(join(home, '.claude/commands/rv.md'), 'utf8'), /aasc-alias:v1/);
  assert.equal(await present(join(home, '.claude/commands/rr.md')), false);
  offline = false;
  connection = { ...connection, accountId: '22222222-2222-4222-8222-222222222222', generation: 2 };
  for (const f of stops) f();
  await page.evaluate(() => window.notesHarness.connect());
  assert.equal(
    await page.getByRole('button', { name: 'Review alias for this device' }).isDisabled(),
    true,
  );
  assert.equal(directCalls, 0);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      pass: true,
      explicitReviewBeforeWrite: true,
      desireAndLocalResultSeparate: true,
      markerSafeRemoval: true,
      missingTargetAcknowledgedDisclosure: { optimistic: 'rr', saved: 'rv', laterInstalled: 'rv' },
      accountChangeBlocksReview: true,
      noDirectCloudAliasWriter: true,
      runtimeErrors: errors.length,
      screenshot: '/tmp/aasc-task9-fix1-alias-review.png',
    }),
  );
} finally {
  await browser?.close();
  await vite.close();
  await new Promise((r) => server.close(r));
  await rm(home, { recursive: true, force: true });
}
