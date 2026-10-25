// test/mcp/indexWiring.test.ts — how server/index.ts wires the central-session MCP server in: where /mcp is
// mounted and with what, when the port is recorded, that both lifecycle feeds are watched, that shutdown
// closes the MCP sessions, and that the headless respawn treats a central's card like every relaunch. The
// server is never started; its source is read, as test/cloudPaths.test.ts and test/cloudShutdown.test.ts do.
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

async function indexSource() {
  const source = await readFile(new URL('../../server/index.ts', import.meta.url), 'utf8');
  const at = (needle: string, from = 0): number => {
    const i = source.indexOf(needle, from);
    expect(i, needle).toBeGreaterThan(0);
    return i;
  };
  /** The text of one function, from its declaration to the next declaration at the same indent. */
  const body = (declaration: string): string => {
    const start = at(declaration);
    const end = source.indexOf('\n  function ', start + declaration.length);
    return source.slice(start, end === -1 ? undefined : end);
  };
  return { source, at, body };
}

describe('server/index.ts wiring', () => {
  it('mounts /mcp behind the JSON parser, ahead of /api, the static files and the SPA fallback', async () => {
    const { at } = await indexSource();
    const mount = at("app.use('/mcp', mcpRouter, mcpErrorHandler)");

    expect(at("app.use(express.json({ limit: '50mb' }))")).toBeLessThan(mount);
    expect(mount).toBeLessThan(at("app.use('/api', authMiddleware"));
    expect(mount).toBeLessThan(at('app.use(express.static(clientDir))'));
    expect(mount).toBeLessThan(at("app.get('/{*splat}'"));
  });

  it('builds the router only when the feature is on, and mounts it only then', async () => {
    const { source, at } = await indexSource();
    const built = at('const mcpRouter = isMcpEnabled()');
    const mount = at("app.use('/mcp', mcpRouter, mcpErrorHandler)");

    expect(built).toBeLessThan(mount);
    expect(source.slice(built, mount)).toContain(': null;');
    expect(source.slice(mount - 'if (mcpRouter) '.length, mount)).toBe('if (mcpRouter) ');
  });

  it("gives the router the rooms mirror and each central's own /api client", async () => {
    const { source, at } = await indexSource();
    const built = at('const mcpRouter = isMcpEnabled()');
    const deps = source.slice(built, at("app.use('/mcp', mcpRouter, mcpErrorHandler)"));

    expect(deps).toContain('rooms: currentRooms,');
    expect(deps).not.toMatch(/rooms: \(\) => \[\]/);
    expect(deps).toContain('client: centralClient,');
    expect(source).toMatch(
      /import apiRouter, \{[^}]*\bcurrentRooms\b[^}]*\} from '\.\/apiRouter\.js';/,
    );
  });

  it('records the port as soon as it is known, before anything can start a terminal', async () => {
    const { source, at } = await indexSource();
    const port = at('const PORT = port ?? resolvePort(args, config);');
    const record = at('recordMcpPort(PORT);');

    expect(port).toBeLessThan(record);
    expect(source.slice(port, record)).not.toContain('createTerminal(');
    expect(record).toBeLessThan(at('async function respawnSshTerminals'));
    expect(record).toBeLessThan(at('server.listen(PORT'));
    // Never the throwing setter: a port that is no TCP port must not stop the server starting.
    expect(source).not.toContain('setMcpPort(');
  });

  it('watches central lifecycles on both feeds before the server listens', async () => {
    const { at } = await indexSource();
    expect(at('watchCentralLifecycle(centrals, onBroadcast, onTerminalExit)')).toBeLessThan(
      at('server.listen(PORT'),
    );
  });

  it('closes the MCP sessions on shutdown, before it waits for the HTTP server', async () => {
    const { body } = await indexSource();
    const shutdown = body('function gracefulShutdown');
    const close = shutdown.indexOf('const mcpClosed = mcpRouter?.close();');

    expect(close).toBeGreaterThan(0);
    expect(close).toBeLessThan(shutdown.indexOf('const httpClosed'));
    expect(shutdown).toContain(
      'Promise.allSettled([cloudStopped, jobsClosed, httpClosed, mcpClosed])',
    );
  });

  it("relaunches a central's card in the headless respawn as every relaunch does", async () => {
    const { body } = await indexSource();
    const respawn = body('async function respawnSshTerminals');

    expect(respawn).toContain('spawnRespawnTerminal(');
    expect(respawn).toContain('discardCentralTerminal(');
    expect(respawn).not.toContain('await createTerminal(newConfig, null)');
    // The line it types is built before the spawn, so the central is minted for the CLI it launches.
    // Both needles must be found: an index of -1 would sort before anything and pass for nothing.
    const built = respawn.indexOf('let resumeCmd');
    const spawned = respawn.indexOf('spawnRespawnTerminal(');
    expect(built, 'let resumeCmd').toBeGreaterThan(0);
    expect(spawned, 'spawnRespawnTerminal(').toBeGreaterThan(0);
    expect(built).toBeLessThan(spawned);
  });
});
