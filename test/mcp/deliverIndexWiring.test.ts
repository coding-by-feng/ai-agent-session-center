// test/mcp/deliverIndexWiring.test.ts — how server/index.ts turns P2 on in the running app: the one runtime
// (`createServerDeliver`) is built when central sessions are on, handed to the /mcp router as `deliver` (without
// it every write tool answers UNAVAILABLE) and to the dashboard's router (the activity log, the tasks, the two
// feeds), the hands-off route gets the session store's `setSessionHandsOff`, and shutdown stops both. The server
// is never started; its source is read, as test/mcp/indexWiring.test.ts does.
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

async function indexSource() {
  const source = await readFile(new URL('../../server/index.ts', import.meta.url), 'utf8');
  const at = (needle: string, from = 0): number => {
    const i = source.indexOf(needle, from);
    expect(i, needle).toBeGreaterThan(0);
    return i;
  };
  /** The text of a call's argument object: from its opening line to the first `});` after it. */
  const callBody = (opening: string): string => {
    const start = at(opening);
    return source.slice(start, source.indexOf('});', start));
  };
  /** The text of one function, from its declaration to the next declaration at the same indent. */
  const body = (declaration: string): string => {
    const start = at(declaration);
    const end = source.indexOf('\n  function ', start + declaration.length);
    return source.slice(start, end === -1 ? undefined : end);
  };
  return { source, at, callBody, body };
}

describe('server/index.ts wiring of P2 (deliver)', () => {
  it('imports the production runtime and the hands-off store function', async () => {
    const { source } = await indexSource();

    expect(source).toContain("import { createServerDeliver } from './mcp/deliverWiring.js';");
    expect(source).toMatch(/import \{[^}]*\bsetSessionHandsOff\b[^}]*\} from '\.\/sessionStore\.js';/);
  });

  it('builds the runtime only when central sessions are on, from the registry and each central’s own client', async () => {
    const { source, at } = await indexSource();
    const built = at('const mcpDeliver = isMcpEnabled()');
    const line = source.slice(built, source.indexOf(';', built));

    // P4: and the Mac's room list, for the re-router's contexts.
    expect(line).toContain('createServerDeliver(centrals, centralClient, { rooms: currentRooms })');
    expect(line).toContain(': null');
  });

  it('builds it before the /mcp router that is handed it', async () => {
    const { at } = await indexSource();

    expect(at('const mcpDeliver = isMcpEnabled()')).toBeLessThan(at('const mcpRouter = isMcpEnabled()'));
  });

  it('hands it to the /mcp router as `deliver` (until it does, every write tool answers UNAVAILABLE)', async () => {
    const { callBody } = await indexSource();
    const deps = callBody('? createMcpRouter({');

    expect(deps).toContain('deliver: mcpDeliver');
    // It is left out, not passed as null, when the runtime is not there.
    expect(deps).toMatch(/\.\.\.\(mcpDeliver \? \{ deliver: mcpDeliver \} : \{\}\)/);
  });

  it('hands it to the dashboard’s router, with the session store’s hands-off setter (that refreshes the held hook update, Ruling 55)', async () => {
    const { callBody } = await indexSource();
    const deps = callBody('const centralsRouter = createCentralsRouter({');

    expect(deps).toMatch(/\.\.\.\(mcpDeliver \? \{ deliver: mcpDeliver \} : \{\}\)/);
    // Not the bare store function: a hook update held in the throttle would put the old flag back (handsOffWiring.test.ts).
    expect(deps).toContain('setHandsOff: createHandsOffSetter(setSessionHandsOff, refreshPendingSessionUpdate)');
    // The earlier wiring of the centrals feed is untouched.
    expect(deps).toContain('registry: centrals,');
    expect(deps).toContain('broadcastByLocality,');
  });

  it('builds the runtime before the dashboard’s router that reads it', async () => {
    const { at } = await indexSource();

    expect(at('const mcpDeliver = isMcpEnabled()')).toBeLessThan(
      at('const centralsRouter = createCentralsRouter({'),
    );
  });

  it('stops the dashboard feeds and the runtime on shutdown, before it waits for the HTTP server', async () => {
    const { body } = await indexSource();
    const shutdown = body('function gracefulShutdown');
    const feeds = shutdown.indexOf('centralsRouter.close();');
    const runtime = shutdown.indexOf('mcpDeliver?.close();');
    const http = shutdown.indexOf('const httpClosed');

    expect(feeds).toBeGreaterThan(0);
    expect(runtime).toBeGreaterThan(0);
    expect(feeds).toBeLessThan(http);
    expect(runtime).toBeLessThan(http);
    // The /mcp sessions are told to end first: they may be mid-write when the runtime stops.
    expect(shutdown.indexOf('const mcpClosed = mcpRouter?.close();')).toBeLessThan(runtime);
  });

  it('never lets a failure to stop the runtime keep the server from stopping', async () => {
    const { body } = await indexSource();
    const shutdown = body('function gracefulShutdown');
    const runtime = shutdown.indexOf('mcpDeliver?.close();');
    const around = shutdown.slice(Math.max(0, runtime - 60), runtime + 80);

    expect(around).toMatch(/try \{[^}]*mcpDeliver\?\.close\(\);[^}]*\} catch/);
  });
});
