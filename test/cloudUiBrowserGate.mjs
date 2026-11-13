/**
 * Synthetic UI acceptance for RESOURCES (Nov 13 2026: Library · Projects · Machines, the Library's
 * Checks view and the ☁ Cloud account dialog; AASC-63 Projects). Cloud sync's UI (AASC-62: the sync
 * list, cloud state on Library rows, Save to cloud, the bulk bar) was removed, and this gate checks
 * an old link to it lands on the Library with no sync reads. No server/index.ts, hooks, real resources, Git, backend or
 * user browser: the real React views run against fixture APIs. Explicit-only:
 * `node test/cloudUiBrowserGate.mjs`. Screenshots: test-screenshots/aasc-62-63/ (three themes,
 * desktop and 390 px).
 */
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = await mkdtemp(join(tmpdir(), 'aasc-cloud-ui-'));
const shots = join(root, 'test-screenshots/aasc-62-63');
await mkdir(shots, { recursive: true });

const account = randomUUID();
const connection = {
  backendOrigin: 'https://fixture.invalid',
  accountId: account,
  generation: 1,
  deviceId: randomUUID(),
  deviceName: 'Fixture Mac',
  accountEmail: 'you@example.com',
};
const rid = () => randomUUID();
const item = (name, fields) => ({
  resourceId: rid(),
  catalogId: null,
  name,
  agent: 'claude',
  kind: 'skill',
  scope: 'global',
  state: 'synced',
  cloudVersion: 1,
  syncedVersion: 1,
  memory: false,
  ...fields,
});
const initialSyncItems = [
  item('tdd-workflow', { state: 'conflict', cloudVersion: 4, syncedVersion: 3 }),
  item('commit', { kind: 'command', state: 'local-changed', cloudVersion: 2, syncedVersion: 2 }),
  item('code-review', { catalogId: 'local-review', state: 'cloud-newer', cloudVersion: 3, syncedVersion: 2 }),
  item('deploy-checklist', { state: 'cloud-only', syncedVersion: null }),
  item('notes', { agent: 'codex', kind: 'memory', memory: true, state: 'local-changed' }),
  item('frontend-rules', { kind: 'rule', state: 'blocked', reason: 'Something else is already at this location on this device.' }),
  item('api-design', {}),
  item('security-review', { cloudVersion: 5, syncedVersion: 5 }),
];
let syncItems = initialSyncItems;
const repo = (owner, name, branch = 'main') => ({
  provider: 'github',
  owner,
  name,
  url: `https://github.com/${owner}/${name}`,
  branch,
});
const projects = [
  { id: rid(), version: 1, name: 'agent-manager', repository: repo('kason', 'agent-manager'), description: '', resources: [], deleted: false },
  { id: rid(), version: 1, name: 'exmouth-erp', repository: repo('kason', 'exmouth-erp', 'develop'), description: '', resources: [], deleted: false },
  { id: rid(), version: 1, name: 'second-brain', repository: repo('kason', 'second-brain'), description: '', resources: [], deleted: false },
];
const local = {
  [projects[0].id]: { state: 'ahead', branch: 'main', openUrl: '/project-browser?path=%2FUsers%2Fyou%2Fcode%2Fagent-manager', localProjectId: 'agent-manager-1', path: '/Users/you/code/agent-manager', ahead: 2, behind: 0, account: 'kason-work' },
  [projects[1].id]: { state: 'missing', branch: null, openUrl: null, localProjectId: null, path: null, ahead: null, behind: null, account: null },
  [projects[2].id]: { state: 'ready', branch: 'main', openUrl: '/project-browser?path=%2FUsers%2Fyou%2Fsecond-brain', localProjectId: 'second-brain-1', path: '/Users/you/second-brain', ahead: 0, behind: 3, account: null },
};
const summary = { id: 'local-workflow', type: 'skill', agent: 'claude', scope: 'global', name: 'Test workflow', description: 'Reusable testing instructions', origin: 'user', format: 'markdown', path: '~/.claude/skills/test-workflow', fileCount: 1, bytes: 240, mtimeMs: Date.now(), hash: 'a'.repeat(64), repo: { status: 'not-tracked' }, variantIds: [], findingCodes: [] };
const review = { ...summary, id: 'local-review', name: 'code-review', description: 'Review a change before it ships', path: '~/.claude/skills/code-review' };
const catalog = { state: 'ready', scannedAt: Date.now(), roots: { claude: '~/.claude', codex: '~/.codex', shared: '~/.agents', repo: null }, projects: [{ id: 'local-project', name: 'agent-manager', path: '~/code/agent-manager', exists: true, evidence: [], counts: {} }], resources: [summary, review, { ...summary, id: 'blocked', name: 'Local settings', type: 'settings' }], findings: [], coverage: [] };
const remoteView = { tailscale: { state: 'connected', address: '100.101.102.103', account: null, tailnet: null, dnsName: null, canOpenApp: true }, publish: { state: 'published', tailnet: '100.101.102.103', port: 3334, at: Date.now() }, phones: [], port: 3334 };
const manifest = { resourceId: rid(), agent: 'claude', kind: 'skill', name: 'Test workflow', scope: 'global', projectId: null, files: [{ path: 'test-workflow/SKILL.md', sha256: 'a'.repeat(64), bytes: 240, mode: 420 }], dependencies: [] };
const jobs = new Map(), calls = [], errors = [];
const newJob = (kind, steps = [{ id: 'step', label: 'Fixture step', state: 'complete' }]) => {
  const job = { id: rid(), kind, state: 'queued', steps: steps.map((s) => ({ ...s, state: 'pending' })) };
  jobs.set(job.id, { job, done: { ...job, state: 'complete', steps } });
  return job;
};

const vite = await createServer({
  root,
  configFile: false,
  cacheDir: join(tmp, 'vite'),
  optimizeDeps: { entries: ['test/fixtures/cloud-ui-browser.tsx'] },
  resolve: { alias: { '@': join(root, 'src') } },
  plugins: [
    react({ exclude: /\/vite\/deps\// }),
    {
      name: 'cloud-ui-fixture',
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          const u = new URL(req.url, 'http://fixture.local');
          if (u.pathname === '/resources' || u.pathname === '/project-browser') {
            res.setHeader('Content-Type', 'text/html');
            res.end('<html><head><meta name="viewport" content="width=device-width, initial-scale=1"><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>(type)=>type;window.__vite_plugin_react_preamble_installed__=true;</script></head><body><div id="root"></div><script type="module" src="/test/fixtures/cloud-ui-browser.tsx"></script></body></html>');
            return;
          }
          if (!u.pathname.startsWith('/api/')) return next();
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
          calls.push({ path: u.pathname, method: req.method, body });
          res.setHeader('content-type', 'application/json');
          const send = (data) => res.end(JSON.stringify({ success: true, data }));
          const fail = (code, message, status = 409) => {
            res.statusCode = status;
            res.end(JSON.stringify({ success: false, error: { code, message } }));
          };
          if (u.pathname === '/api/resources') return send(catalog);
          if (u.pathname === '/api/resources/cloud/skill-notes/status') return send({ connection: { backendOrigin: connection.backendOrigin, accountId: account, generation: 1 }, state: 'connected' });
          if (u.pathname === '/api/resources/cloud/skill-notes') return send({ records: [], cursor: 'fixture', hasMore: false });
          const p = u.pathname.replace('/api/resources/cloud', '');
          if (p === '/status') return send({ connection, state: 'connected', lastError: null });
          if (p === '/defaults') return send({ backendUrl: 'https://api.aasc.work', deviceName: 'Fixture Mac' });
          if (p === '/remote-access') return send(remoteView);
          if (u.pathname.startsWith('/api/resources/item/')) return send({ summary: u.pathname.endsWith('local-review') ? review : summary, body: '# Fixture\n\nA fixture skill.', findings: [] });
          if (!p.startsWith('/jobs/') && req.headers['x-aasc-cloud-account'] !== account) return fail('connection_changed', 'Review the current account.');
          if (p === '/sync-status') return send({ items: syncItems, waiting: syncItems.filter((i) => ['local-changed', 'cloud-newer', 'cloud-only', 'conflict'].includes(i.state)).length });
          if (p === '/sync-control') {
            syncItems = syncItems.map((i) => (i.resourceId !== body.resourceId ? i : { ...i, state: body.action === 'stop' ? 'stopped' : 'synced' }));
            if (body.action === 'remove') syncItems = syncItems.filter((i) => i.resourceId !== body.resourceId);
            return send({ resourceId: body.resourceId, action: body.action, ...(body.action === 'remove' ? { removedVersions: 1 } : {}) });
          }
          if (p === '/sync-now') {
            const publish = newJob('publish', [{ id: 'a', label: 'commit', state: 'complete' }, { id: 'b', label: 'tdd-workflow', state: 'complete' }]);
            const install = newJob('install', [{ id: 'c', label: 'code-review', state: 'complete', receiptId: rid() }, { id: 'd', label: 'deploy-checklist', state: 'complete' }]);
            syncItems = syncItems.map((i) => (['blocked'].includes(i.state) || (i.memory && !body.memory?.includes(i.resourceId)) ? i : { ...i, state: 'synced', syncedVersion: i.cloudVersion }));
            return send({ jobs: [publish, install], skipped: syncItems.filter((i) => i.state === 'blocked').map((i) => ({ resourceId: i.resourceId, name: i.name, reason: i.reason })) });
          }
          if (p === '/publish-plans') return send({ id: rid(), items: [{ catalogId: summary.id, manifest, sourceDigest: 'a'.repeat(64), baseVersion: null }], blocked: [{ catalogId: 'blocked', reason: 'This resource needs a dedicated credential-free adapter.' }] });
          if (/^\/publish-plans\/[^/]+\/run$/.test(p)) return send(newJob('publish'));
          if (p === '/downloads') return send(newJob('download', [{ id: 'zip', label: 'Prepare portable ZIP', state: 'complete' }]));
          if (/^\/downloads\/[^/]+\/file$/.test(p)) {
            res.setHeader('content-type', 'application/zip');
            res.end('fixture portable ZIP payload');
            return;
          }
          if (/^\/jobs\/[^/]+$/.test(p)) return send(jobs.get(p.split('/')[2])?.done);
          if (p === '/projects' && req.method === 'GET') return send({ items: projects, nextCursor: null });
          if (p === '/projects' && req.method === 'POST') {
            projects.push(body.value);
            local[body.value.id] = { ...local[projects[2].id], state: 'ready', behind: 0, path: body.localPath ?? null };
            return send(body.value);
          }
          if (p === '/projects/github-accounts') return send({ installed: true, accounts: [{ login: 'kason', active: true, ok: true }, { login: 'kason-work', active: false, ok: true }] });
          if (p === '/projects/candidates') return send({ items: [{ path: '/Users/you/code/agent-manager', repository: repo('kason', 'agent-manager'), projectId: projects[0].id }, { path: '/Users/you/code/kason-tools', repository: repo('kason', 'kason-tools'), projectId: null }] });
          const m = /^\/projects\/([^/]+)\/(local|check|account|push|pull|get|remove)$/.exec(p);
          if (m) {
            const [, id, action] = m;
            if (action === 'local') return send(local[id]);
            if (action === 'check') return send(local[id]);
            if (action === 'account') {
              local[id] = { ...local[id], account: body.login };
              return send(local[id]);
            }
            if (action === 'remove') return send({ ...projects.find((x) => x.id === id), version: 2, deleted: true });
            const kind = { push: 'push-project', pull: 'pull-project', get: 'get-project' }[action];
            return send(newJob(kind, [{ id: 'git', label: 'Git', state: 'complete' }]));
          }
          return fail('fixture_unhandled', p, 404);
        });
      },
    },
  ],
  server: { host: '127.0.0.1', port: 0, strictPort: true, cors: false },
});

// html and body are overflow-x: hidden, so the root never reports a sideways overflow; body's own
// scrollWidth still does (and scrollIntoView can still move it).
const noOverflow = (page) =>
  page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) <= innerWidth);
let browser;
try {
  await vite.listen();
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1365, height: 1050 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  // Nov 13 2026: Library · Projects · Machines. Health is the Library's Checks view (`checks=1`) and
  // Connection the ☁ Cloud account dialog (`account=1`); Cloud sync (AASC-62's UI) was removed.
  const VIEW = { library: '', projects: 'section=projects', machines: 'section=machines', checks: 'checks=1', account: 'account=1' };
  const TAB = { library: /^Library/, projects: /^Projects/, machines: /^Machines/, checks: /^Library/, account: /^Library/ };
  const open = async (view, theme = 'windows-xp') => {
    await page.goto(`${origin}/resources?${VIEW[view]}&theme=${theme}`);
    await page.getByRole('tab', { name: TAB[view] }).waitFor();
  };

  // An old Cloud sync link lands on the Library, and nothing reads the sync list any more.
  await page.goto(`${origin}/resources?section=cloud&cloudTab=resources&theme=windows-xp`);
  assert.equal(await page.getByRole('tab', { name: /^Library/ }).getAttribute('aria-selected'), 'true');
  await page.getByText('Test workflow').first().waitFor();
  assert.equal(await page.getByRole('tab', { name: /^Cloud sync/ }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Select', exact: true }).count(), 0);
  assert.equal(await page.getByRole('img', { name: /^Cloud:/ }).count(), 0);
  assert.ok(!calls.some((c) => /\/(sync-status|sync-now|sync-control|publish-plans)(\/|$)/.test(c.path)), 'something still reads Cloud sync');

  // The Filters menu sits at the right end of the bar: it must stay inside the window.
  for (const [width, height] of [[1365, 1050], [390, 844]]) {
    await page.setViewportSize({ width, height });
    await open('library');
    await page.getByRole('button', { name: /^More filters/ }).click();
    const menu = page.getByRole('menu', { name: 'More filters' });
    await menu.waitFor();
    const box = await menu.boundingBox();
    assert.ok(box && box.x >= 0 && box.x + box.width <= width, `Filters menu leaves the window at ${width}px`);
    await page.screenshot({ animations: 'disabled', path: join(shots, `library-filters-menu-${width}.png`) });
    await page.keyboard.press('Escape');
  }
  await page.setViewportSize({ width: 1365, height: 1050 });

  // Projects: accounts, rows by state, Save from a folder, Clone, Push, account choice.
  await open('projects');
  await page.getByText('2 commits to push').waitFor();
  await page.getByText('Not on this device').waitFor();
  await page.getByText('3 behind GitHub').waitFor();
  await page.screenshot({ animations: 'disabled', fullPage: true, path: join(shots, 'projects-xp-desktop.png') });
  const am = page.getByRole('listitem').filter({ hasText: 'agent-manager' });
  await am.getByRole('button', { name: 'Push' }).click();
  await page.waitForTimeout(300);
  assert.ok(calls.some((c) => c.path.endsWith('/push')));
  await am.getByLabel('GitHub account').selectOption('kason');
  await page.waitForTimeout(300);
  assert.ok(calls.some((c) => c.path.endsWith('/account') && c.body.login === 'kason'));
  await page.getByRole('listitem').filter({ hasText: 'exmouth-erp' }).getByRole('button', { name: 'Clone' }).click();
  const clone = page.getByRole('dialog');
  assert.equal(await clone.getByLabel('Into this folder').inputValue(), '/Users/you/code');
  assert.equal(await clone.getByLabel('Folder name').inputValue(), 'exmouth-erp');
  await page.screenshot({ animations: 'disabled', path: join(shots, 'clone-dialog-xp.png') });
  await clone.getByRole('button', { name: 'Clone' }).click();
  await clone.waitFor({ state: 'detached' });
  assert.deepEqual(calls.find((c) => c.path.endsWith('/get')).body, { parentPath: '/Users/you/code', directoryName: 'exmouth-erp' });
  // Oct 26 2026: a checklist; an already-saved repository is ticked, locked and marked Saved.
  await page.getByRole('button', { name: 'Save projects' }).click();
  const save = page.getByRole('dialog');
  const savedBox = save.getByRole('checkbox', { name: /agent-manager/ });
  await savedBox.waitFor();
  assert.equal(await savedBox.isChecked(), true);
  assert.equal(await savedBox.isDisabled(), true);
  await page.screenshot({ animations: 'disabled', path: join(shots, 'save-project-xp.png') });
  await save.getByRole('checkbox', { name: /kason-tools/ }).check();
  await save.getByRole('button', { name: 'Save 1 to cloud' }).click();
  await save.waitFor({ state: 'detached' });
  const created = calls.find((c) => c.path.endsWith('/projects') && c.method === 'POST');
  assert.equal(created.body.localPath, '/Users/you/code/kason-tools');
  assert.equal(created.body.value.name, 'kason-tools');
  await page.getByText('kason-tools', { exact: true }).waitFor();

  // Every theme family, desktop and phone width: each tab, Checks and the account dialog;
  // nothing may scroll sideways.
  const READY = { library: 'Test workflow', projects: 'Saved projects', machines: 'Tailscale on this Mac', checks: 'Add folder', account: 'Device connection' };
  for (const [theme, label] of [['', 'default'], ['light', 'light'], ['windows-xp', 'xp']]) {
    for (const [width, height] of [[1365, 1050], [390, 844]]) {
      await page.setViewportSize({ width, height });
      for (const view of ['library', 'checks', 'projects', 'machines', 'account']) {
        await open(view, theme);
        await page.getByText(READY[view]).first().waitFor();
        await page.waitForTimeout(250);
        assert.ok(await noOverflow(page), `${view} ${label} ${width}px scrolls sideways`);
        await page.screenshot({ animations: 'disabled', fullPage: true, path: join(shots, `${view}-${label}-${width}.png`) });
      }
    }
  }
  assert.equal(errors.length, 0, errors.join('\n'));
  const report = { pass: true, runtimeErrors: errors, requests: calls.length, screenshots: shots, scope: 'Real React views against synthetic fixture APIs; no backend, Git, GitHub CLI or filesystem exercised.' };
  await writeFile(join(shots, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) {
  // Leave a picture of the moment it failed beside the screenshots.
  await browser?.contexts()[0]?.pages()[0]?.screenshot({ path: join(shots, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await browser?.close();
  await vite.close();
  await rm(tmp, { recursive: true, force: true });
}
