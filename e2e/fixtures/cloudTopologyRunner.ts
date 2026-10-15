/** Fixture-owned composition. Never import server/index.ts or BE's process entrypoint. */
import express from 'express';
import { createServer as createViteServer } from 'vite';
import react from '@vitejs/plugin-react';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createCloudConnection } from '../../server/cloud/connection.js';
import { createFileSecretStore } from '../../server/cloud/secretStore.js';
import { createResourceCatalog } from '../../server/resourceCatalog.js';
import { globalRootPaths } from '../../server/resourceRoots.js';
import { createResourceJobs } from '../../server/cloud/resourceJobs.js';
import { createProjectJobs } from '../../server/cloud/projectJobs.js';
import { createGitOperations } from '../../server/cloud/git.js';
import { createCloudAliases } from '../../server/cloud/aliases.js';
import { createCloudAliasesRouter } from '../../server/cloud/aliasRouter.js';
import { createResourceJobsRouter } from '../../server/cloud/resourceRouter.js';
import { createProjectRouter } from '../../server/cloud/projectRouter.js';
import { createCloudRouter, cloudJsonParser } from '../../server/cloud/router.js';
import { createNotesRouter } from '../../server/cloud/notesRouter.js';
import {
  createResourceRouter,
  isLocalResourceRequest,
  isSameOriginWrite,
} from '../../server/resourceRouter.js';
import { authMiddleware } from '../../server/authManager.js';
import { closeDb } from '../../server/db.js';
const root = process.env.AASC_CLOUD_FIXTURE_ROOT!,
  beRoot = process.env.AASC_TEST_BE_ROOT!;
if (!root || !beRoot || process.env.HOME !== root || process.env.SSH_AUTH_SOCK)
  throw Error('Unsafe fixture environment');
const load = (p: string) => import(pathToFileURL(join(beRoot, 'src', p)).href);
const [{ openCoreStore }, { createBeApp }, { createComposition }, { createDeviceService }] =
  await Promise.all([
    load('core/store.ts'),
    load('core/app.ts'),
    load('composition.ts'),
    load('core/devices.ts'),
  ]);
const store = openCoreStore({ dataDir: join(root, 'be') });
const ownerId = store.bootstrapOwner(Date.now()),
  devices = createDeviceService({ store, now: Date.now });
const composition = createComposition(store);
const beApp = createBeApp({ ...composition, store, now: Date.now, allowLoopbackHttp: true });
await beApp.locals.servicesReady;
const listen = (app: any) =>
  new Promise<any>((r) => {
    const s = app.listen(0, '127.0.0.1', () => r(s));
  });
let be = await listen(beApp),
  bePort = be.address().port;
const beUrl = `http://127.0.0.1:${bePort}`;
const close = (s: any) =>
  new Promise<void>((r, j) => {
    s.close((e: any) => (e ? j(e) : r()));
    s.closeIdleConnections?.();
  });
const gitEnv = {
  PATH: '/usr/bin:/bin',
  HOME: root,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Acceptance',
  GIT_AUTHOR_EMAIL: 'acceptance@example.invalid',
  GIT_COMMITTER_NAME: 'Acceptance',
  GIT_COMMITTER_EMAIL: 'acceptance@example.invalid',
  GIT_TERMINAL_PROMPT: '0',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('/usr/bin/git', args, {
    cwd,
    env: gitEnv,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
const seed = join(root, 'seed'),
  bare = join(root, 'remote.git');
await mkdir(seed);
git(seed, 'init', '-b', 'main');
await writeFile(join(seed, 'README.md'), 'fixture repository\n');
git(seed, 'add', '.');
git(seed, 'commit', '-m', 'initial');
git(root, 'clone', '--bare', seed, bare);
git(seed, 'remote', 'add', 'origin', bare);
const clients: any = {};
const traffic: any[] = [];
const scopes = [
  'resources:read',
  'resources:write',
  'projects:read',
  'projects:write',
  'notes:read',
  'notes:write',
  'devices:manage',
];
for (const name of ['a', 'b']) {
  const home = join(root, name, 'home'),
    data = join(root, name, 'data');
  await mkdir(home, { recursive: true, mode: 0o700 });
  await mkdir(data, { recursive: true, mode: 0o700 });
  const env = {
    HOME: home,
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    CODEX_HOME: join(home, '.codex'),
  };
  await mkdir(join(home, '.claude', 'skills'), { recursive: true });
  await mkdir(join(home, '.codex'), { recursive: true });
  if (name === 'a') {
    await mkdir(join(home, '.claude/skills/acceptance'));
    await writeFile(
      join(home, '.claude/skills/acceptance/SKILL.md'),
      '---\nname: acceptance\ndescription: Synthetic acceptance resource\n---\n# Acceptance\nPortable original bytes.\n',
    );
  }
  const c: any = { home, data, env, fault: null };
  clients[name] = c;
  const connectionOptions: Parameters<typeof createCloudConnection>[0] = {
    directory: join(data, 'cloud'),
    secrets: createFileSecretStore(join(data, 'secrets')),
    timeoutMs: 3000,
    fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.origin !== beUrl) throw Error('Fixture refused non-BE network');
      traffic.push({ device: name, path: url.pathname, method: init?.method ?? 'GET' });
      if (c.fault === 'before-put' && init?.method === 'PUT') {
        c.fault = null;
        await close(be);
        be = null;
        throw new TypeError('Fixture backend disappeared');
      }
      if (c.fault === 'health-outage' && url.pathname === '/v1/health') {
        c.fault = null;
        return new Response('{}', { status: 503 });
      }
      const response = await fetch(input, init);
      if (c.fault === 'after-commit' && url.pathname.endsWith('/commit')) {
        c.fault = null;
        await response.arrayBuffer();
        throw new TypeError('Fixture lost committed response');
      }
      return response;
    },
  };
  c.connectionOptions = connectionOptions;
  c.cloud = await createCloudConnection(connectionOptions);
  const issued = await devices.issuePairingCode({ ownerId, scopes });
  c.binding = await c.cloud.connectCloud({
    backendUrl: beUrl,
    pairingCode: issued.code,
    deviceName: 'Synthetic ' + name,
  });
  c.catalog = createResourceCatalog({
    home,
    env,
    sessionProjectPaths: () => [],
    trashDir: join(data, 'trash'),
  });
  c.catalog.getOrStartCatalog();
  await c.catalog.whenIdle();
  c.aliases = await createCloudAliases({
    cloud: c.cloud,
    home,
    directory: join(data, 'aliases'),
    catalog: () => c.catalog.getOrStartCatalog(),
  });
  c.jobs = await createResourceJobs({
    cloud: c.cloud,
    catalog: c.catalog,
    roots: globalRootPaths(env, home),
    directory: join(data, 'jobs'),
    getCloudAliases: async () => c.aliases,
  });
  c.git = await createGitOperations({
    directory: join(data, 'git'),
    testTransport: { barePath: bare, env: gitEnv },
  });
  c.projects = await createProjectJobs({
    cloud: c.cloud,
    resources: c.jobs,
    git: c.git,
    activeProjectPaths: () => [],
  });
  const app = express();
  app.use(['/api/resources/cloud', '/api/cloud/skill-notes'], cloudJsonParser());
  app.use(express.json({ limit: '50mb' }));
  app.use('/api/cloud/skill-notes', authMiddleware, createNotesRouter(c.cloud));
  app.use('/api/resources', authMiddleware, (req, res, next) =>
    isLocalResourceRequest(req)
      ? next()
      : res.status(404).json({ success: false, error: 'Not found' }),
  );
  app.get('/api/resources', (_req, res) =>
    res.json({ success: true, data: c.catalog.getOrStartCatalog() }),
  );
  app.post('/api/resources/scan', (_req, res) =>
    res.json({ success: true, data: c.catalog.startScan([]) }),
  );
  app.use(
    '/api/resources/cloud/aliases',
    createCloudAliasesRouter(async () => c.aliases, isSameOriginWrite),
  );
  app.use(
    '/api/resources/cloud',
    createProjectRouter(async () => c.projects, isSameOriginWrite),
    createResourceJobsRouter(async () => c.jobs, isSameOriginWrite),
    createCloudRouter(c.cloud, isSameOriginWrite),
  );
  // Actual unavailable-prefix implementation, no retired service construction.
  app.use(
    '/api/resources',
    createResourceRouter({
      home,
      env,
      sessionProjectPaths: () => [],
      trashDir: join(data, 'trash'),
    }),
  );
  c.http = await listen(app);
  const apiUrl = `http://127.0.0.1:${c.http.address().port}`;
  const cwd = resolve('.');
  c.vite = await createViteServer({
    root: cwd,
    configFile: false,
    cacheDir: join(data, 'vite'),
    optimizeDeps: { entries: ['e2e/fixtures/cloud-resources-browser.tsx'] },
    resolve: { alias: { '@': join(cwd, 'src') } },
    plugins: [
      react(),
      {
        name: 'real-cloud-fixture-entry',
        configureServer(s) {
          s.middlewares.use((req, res, next) => {
            if (!req.url?.startsWith('/resources') && !req.url?.startsWith('/project-browser'))
              return next();
            res.setHeader('content-type', 'text/html');
            res.end(
              '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>(type)=>type;window.__vite_plugin_react_preamble_installed__=true;</script></head><body><div id="root"></div><script type="module" src="/e2e/fixtures/cloud-resources-browser.tsx"></script></body></html>',
            );
          });
        },
      },
    ],
    server: {
      host: '127.0.0.1',
      port: 0,
      strictPort: true,
      cors: false,
      proxy: { '/api': { target: apiUrl, changeOrigin: true } },
    },
  });
  await new Promise<void>((r) => c.vite.httpServer!.listen(0, '127.0.0.1', r));
  c.url = `http://127.0.0.1:${c.vite.httpServer.address().port}`;
}
let stopping: Promise<void> | undefined;
async function stop() {
  return (stopping ??= (async () => {
    for (const c of Object.values(clients) as any[]) {
      await c.vite?.close();
      await c.cloud?.stop();
      await c.projects?.close();
      await c.jobs?.close();
      await close(c.http);
    }
    if (be) await close(be);
    store.close();
    closeDb();
  })());
}
process.once('SIGTERM', () => {
  void stop().finally(() => process.exit(0));
});
process.once('disconnect', () => {
  void stop().finally(() => process.exit(0));
});
process.on('message', async (m: any) => {
  try {
    let value: any;
    const d = m.data ?? {},
      c = clients[d.device ?? 'a'];
    switch (m.action) {
      case 'stop':
        await stop();
        process.send?.({ id: m.id, value: true });
        process.disconnect?.();
        return;
      case 'reload-cloud': {
        await c.cloud.stop();
        const reloaded = await createCloudConnection(c.connectionOptions);
        // Preserve the injected object reference held by the fixture routers/services.
        Object.assign(c.cloud, reloaded);
        value = c.cloud.status();
        break;
      }
      case 'fault':
        c.fault = d.kind;
        value = true;
        break;
      case 'resume-be':
        if (!be)
          be = await new Promise((r) => {
            const s = beApp.listen(bePort, '127.0.0.1', () => r(s));
          });
        value = true;
        break;
      case 'traffic':
        value = traffic;
        break;
      case 'read':
        value = await readFile(join(c.home, d.path), 'utf8');
        break;
      case 'write': {
        const p = join(c.home, d.path);
        if (!p.startsWith(c.home + '/')) throw Error('fixture path escape');
        await mkdir(resolve(p, '..'), { recursive: true });
        await writeFile(p, d.bytes);
        c.catalog.startScan([]);
        await c.catalog.whenIdle();
        value = true;
        break;
      }
      case 'git': {
        const p = d.directory === 'seed' ? seed : join(c.home, d.directory);
        if (p !== seed && !p.startsWith(c.home + '/')) throw Error('fixture Git escape');
        value = git(p, ...d.args);
        break;
      }
      case 'stat': {
        const s = await stat(join(c.home, d.path));
        value = { ino: s.ino, mode: s.mode };
        break;
      }
      case 'revoke':
        await devices.revokeDevice(ownerId, c.binding.deviceId);
        value = true;
        break;
      case 'foreign-read': {
        const ctx = { ownerId: randomUUID(), deviceId: randomUUID(), scopes };
        try {
          if (d.kind === 'notes') {
            const { createSkillNotesService } = await load('services/skillNotes/store.ts');
            value = await createSkillNotesService({ store }).notes.pullNotes(ctx, null, 100);
          } else {
            const { createResourceService } = await load('services/resources/store.ts');
            value = await createResourceService({ store }).resources.getResourceVersion(
              ctx,
              d.id,
              1,
            );
          }
          value = { status: 200, data: value };
        } catch (e: any) {
          if (typeof e.status !== 'number' || typeof e.code !== 'string') throw e;
          value = { status: e.status, code: e.code };
        }
        break;
      }
      case 'be-request': {
        const owner = ownerId;
        const code = await devices.issuePairingCode({ ownerId: owner, scopes });
        const paired = await devices.pairDevice({ code: code.code, name: 'Contract probe' });
        const r = await fetch(beUrl + d.path, {
          method: d.method ?? 'GET',
          headers: { authorization: `Bearer ${paired.token}`, 'content-type': 'application/json' },
          ...(d.body ? { body: JSON.stringify(d.body) } : {}),
        });
        value = { status: r.status, body: await r.json() };
        break;
      }
      default:
        throw Error('Unknown fixture control');
    }
    process.send?.({ id: m.id, value });
  } catch (e) {
    process.send?.({ id: m.id, error: String(e instanceof Error ? e.stack : e) });
  }
});
process.send?.({
  ready: {
    beUrl,
    aUrl: clients.a.url,
    bUrl: clients.b.url,
    a: { home: clients.a.home, binding: clients.a.binding },
    b: { home: clients.b.home, binding: clients.b.binding },
  },
});
