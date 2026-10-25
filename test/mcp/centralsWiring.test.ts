// test/mcp/centralsWiring.test.ts — how server/index.ts wires the centrals feed in: GET /api/mcp/centrals sits
// in the /api stack behind authMiddleware (and the phone profile), and the router is handed the socket
// manager's own `broadcastByLocality`, which http.ts calls with null for every remote device. The server is
// never started; its source is read, as test/mcp/indexWiring.test.ts does.
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

async function indexSource() {
  const source = await readFile(new URL('../../server/index.ts', import.meta.url), 'utf8');
  const at = (needle: string, from = 0): number => {
    const i = source.indexOf(needle, from);
    expect(i, needle).toBeGreaterThan(0);
    return i;
  };
  return { source, at };
}

describe('server/index.ts wiring of the centrals router', () => {
  it('mounts it in the /api stack, behind authMiddleware and the phone profile, ahead of apiRouter', async () => {
    const { source } = await indexSource();
    const line = /app\.use\('\/api', (authMiddleware[^\n]*apiRouter)\);/.exec(source)?.[1];

    expect(line, 'the /api stack line').toBeDefined();
    const stack = (line as string).split(',').map((part) => part.trim());
    expect(stack).toContain('centralsRouter');
    expect(stack.indexOf('authMiddleware')).toBe(0);
    expect(stack.indexOf('centralsRouter')).toBeGreaterThan(stack.indexOf('phoneProfile'));
    expect(stack.indexOf('centralsRouter')).toBeLessThan(stack.indexOf('apiRouter'));
  });

  it('hands the router the real registry, the live sessions and the socket manager\'s broadcastByLocality', async () => {
    const { source, at } = await indexSource();
    const built = at('const centralsRouter = createCentralsRouter({');
    const deps = source.slice(built, source.indexOf('});', built));

    expect(deps).toContain('registry: centrals,');
    expect(deps).toContain('sessions: () => Object.values(getAllSessions()),');
    expect(deps).toContain('broadcastByLocality,');
    expect(source).toMatch(/import \{[^}]*\bbroadcastByLocality\b[^}]*\} from '\.\/wsManager\.js';/);
    expect(source).toContain("import { createCentralsRouter } from './mcp/http.js';");
  });

  it('builds it before the /api stack that mounts it', async () => {
    const { at } = await indexSource();

    expect(at('const centralsRouter = createCentralsRouter({')).toBeLessThan(
      at("app.use('/api', authMiddleware"),
    );
  });
});
