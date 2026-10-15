/** Run directly with node. Never reads the ordinary Playwright config or starts AASC. */
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const profile = await mkdtemp(join(tmpdir(), 'aasc-notes-browser-'));
let online = false,
  requests = 0,
  accepted = 0;
const records = new Map(),
  receipts = new Map();
const connection = {
  backendOrigin: 'https://fixture.invalid',
  accountId: '00000000-0000-4000-8000-000000000001',
  generation: 1,
};
const vite = await createServer({
  root,
  configFile: false,
  cacheDir: join(profile, 'vite-cache'),
  optimizeDeps: { entries: ['test/fixtures/notes-browser.tsx'] },
  plugins: [
    react({ exclude: /vite-cache/ }),
    {
      name: 'notes-fixture',
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (req.url === '/notes-test') {
            res.setHeader('Content-Type', 'text/html');
            res.end(
              '<html><head><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>(type)=>type;window.__vite_plugin_react_preamble_installed__=true;</script></head><body><div id="root"></div><script type="module" src="/test/fixtures/notes-browser.tsx"></script></body></html>',
            );
            return;
          }
          if (!req.url?.startsWith('/api/cloud/skill-notes')) return next();
          requests++;
          res.setHeader('Content-Type', 'application/json');
          const send = (data) => res.end(JSON.stringify({ success: true, data }));
          if (req.url.endsWith('/status'))
            return send({ connection, state: online ? 'connected' : 'offline' });
          if (!online) {
            res.statusCode = 503;
            res.end(
              JSON.stringify({
                success: false,
                error: { code: 'offline', message: 'fixture offline' },
              }),
            );
            return;
          }
          if (req.headers['x-aasc-notes-account'] !== connection.accountId) {
            res.statusCode = 409;
            res.end(JSON.stringify({ success: false, error: { code: 'connection_changed' } }));
            return;
          }
          if (req.method === 'GET')
            return send({
              records: [...records.values()],
              cursor: 'fixture-cursor',
              hasMore: false,
            });
          const chunks = [];
          for await (const c of req) chunks.push(c);
          const body = JSON.parse(Buffer.concat(chunks));
          const results = [];
          for (const op of body.ops) {
            if (receipts.has(op.mutationId)) {
              results.push(receipts.get(op.mutationId));
              continue;
            }
            const old = records.get(op.key),
              value = { ...(old?.value ?? { fav: false, tags: [] }), ...op.set };
            if (value.abbr === null) delete value.abbr;
            if (!value.cli) delete value.cli;
            const dots = new Map((old?.tagDots ?? []).map((t) => [t.tag, [...t.dots]]));
            for (const { tag, dot } of op.addTags ?? [])
              dots.set(tag, [...(dots.get(tag) ?? []), dot]);
            for (const [tag, ds] of dots) {
              const left = ds.filter((d) => !op.removeTagDots?.includes(d));
              if (left.length) dots.set(tag, left);
              else dots.delete(tag);
            }
            value.tags = [...dots.keys()].sort();
            const record = {
              key: op.key,
              value,
              version: (old?.version ?? 0) + 1,
              deleted: false,
              tagDots: [...dots].map(([tag, dots]) => ({ tag, dots })),
            };
            records.set(op.key, record);
            const result = { mutationId: op.mutationId, record };
            receipts.set(op.mutationId, result);
            results.push(result);
            accepted++;
          }
          send({ results });
        });
      },
    },
  ],
  resolve: { alias: { '@': resolve(root, 'src') } },
  server: { host: '127.0.0.1', port: 0, strictPort: false, cors: false },
  logLevel: 'error',
});
let context;
try {
  await vite.listen();
  const url = `http://127.0.0.1:${vite.httpServer.address().port}/notes-test`;
  const errors = [];
  const observedPages = new WeakSet();
  const watchPage = (page) => {
    if (observedPages.has(page)) return;
    observedPages.add(page);
    page.on('pageerror', (error) => errors.push(String(error)));
  };
  const open = async () => {
    context = await chromium.launchPersistentContext(profile, { headless: true });
    context.on('page', watchPage);
    for (const page of context.pages()) watchPage(page);
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(url);
    await page.waitForFunction(() => window.notesHarness);
    await page.evaluate(() => window.notesHarness.store.getState().flush());
    return page;
  };
  let page = await open();
  await page.getByRole('button', { name: 'Favourite browser-fixture', exact: true }).click();
  await page.getByLabel('Add a tag', { exact: true }).fill('offline');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByRole('textbox', { name: 'Abbreviation', exact: true }).fill('bf');
  await page.getByRole('button', { name: 'Save abbreviation' }).click();
  await page.evaluate(() => window.notesHarness.store.getState().flush());
  assert.equal(requests, 0);
  assert.equal(await page.getByTestId('library').textContent(), 'Library filter matches');
  assert.equal(await page.getByTestId('autocomplete').textContent(), 'browser-fixture');
  const second = await context.newPage();
  await second.goto(url);
  await second.waitForFunction(() => window.notesHarness?.store.getState().sync.durable);
  await page.getByLabel('Add a tag', { exact: true }).fill('two-tabs');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await second.waitForFunction(() =>
    window.notesHarness.store.getState().notes['claude:browser-fixture']?.tags.includes('two-tabs'),
  );
  await second.close();
  await context.close();
  page = await open();
  assert.equal(await page.getByTestId('library').textContent(), 'Library filter matches');
  assert.equal(await page.getByTestId('autocomplete').textContent(), 'browser-fixture');
  assert.equal(requests, 0);
  online = true;
  await page.evaluate(() => window.notesHarness.connect());
  assert.equal(await page.evaluate(() => window.notesHarness.store.getState().identity), null);
  await page.evaluate(async () => {
    const s = window.notesHarness.store.getState(),
      review = await s.previewImport();
    if (review.localRecords !== 1 || review.cloudRecords !== 0) throw new Error('review counts');
    await s.useCloudNotes('import', review);
  });
  assert.equal(records.get('claude:browser-fixture').value.abbr, 'bf');
  assert.equal(records.get('claude:browser-fixture').value.cli, undefined);
  online = false;
  await page.getByLabel('Add a tag', { exact: true }).fill('after-connect-offline');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.evaluate(() => window.notesHarness.store.getState().flush());
  await page.waitForFunction(() => window.notesHarness.store.getState().sync.state === 'offline');
  const before = accepted;
  await context.close();
  page = await open();
  assert.equal(await page.evaluate(() => window.notesHarness.store.getState().sync.pending), 1);
  assert.equal(
    await page.evaluate(() =>
      window.notesHarness.store
        .getState()
        .notes['claude:browser-fixture'].tags.includes('after-connect-offline'),
    ),
    true,
  );
  online = true;
  await page.evaluate(() => window.notesHarness.connect());
  await page.waitForFunction(() => window.notesHarness.store.getState().sync.pending === 0);
  assert.equal(accepted, before + 1);
  assert.equal(
    records.get('claude:browser-fixture').value.tags.includes('after-connect-offline'),
    true,
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        pass: true,
        offlineEditBrowserCloseReopen: true,
        libraryFilter: true,
        autocomplete: true,
        twoTabs: true,
        explicitImport: true,
        boundOfflineReopenReconnect: true,
        acceptedUniqueMutations: accepted,
        profile: 'disposable, removed',
      },
      null,
      2,
    ),
  );
} finally {
  await context?.close();
  await vite.close();
  await rm(profile, { recursive: true, force: true });
}
