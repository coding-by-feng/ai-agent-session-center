/** Explicit external source dependency, isolated synthetic storage; never import either entrypoint. */
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
export const backendRoot = process.env.AASC_TEST_BE_ROOT;
export async function backendFixture() {
  if (!backendRoot) throw Error('AASC_TEST_BE_ROOT required');
  const load = (path: string) =>
    import(/* @vite-ignore */ pathToFileURL(join(backendRoot, path)).href);
  const [
    { openCoreStore },
    { createComposition },
    { createBeApp },
    { createDeviceService },
    schemas,
    backup,
  ] = await Promise.all([
    load('src/core/store.ts'),
    load('src/composition.ts'),
    load('src/core/app.ts'),
    load('src/core/devices.ts'),
    load('src/contracts/v1.ts'),
    load('src/core/backup.ts'),
  ]);
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'aasc-final-backend-')));
  const store = openCoreStore({ dataDir: join(dir, 'live') }),
    ownerId = store.bootstrapOwner(Date.now()),
    composition = createComposition(store);
  const app = createBeApp({ store, ...composition, now: Date.now, allowLoopbackHttp: true });
  await app.locals.servicesReady;
  const server = await new Promise<import('node:http').Server>((r) => {
    const s = app.listen(0, '127.0.0.1', () => r(s));
  });
  const origin = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  const devices = createDeviceService({ store, now: Date.now });
  const issued = await devices.issuePairingCode({
    ownerId,
    scopes: ['resources:read', 'projects:read', 'notes:read', 'notes:write'],
  });
  const paired = await devices.pairDevice({
    code: issued.code,
    name: 'Synthetic final regression',
  });
  return {
    dir,
    store,
    ownerId,
    composition,
    origin,
    token: paired.token,
    schemas,
    backup,
    load,
    openCoreStore,
    async close() {
      await new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      });
      store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
