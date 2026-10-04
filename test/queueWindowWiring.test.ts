// test/queueWindowWiring.test.ts — the queue pop-out spans files that cannot import one another
// (Electron main, the preload bridge, the renderer's typings), so a typo in the IPC channel name
// fails SILENTLY at runtime: the float button does nothing and nothing logs. This pins the pieces
// together at the source-text level, the same drift-guard pattern as test/electronPreloadPath.test.ts.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (rel: string): string => readFileSync(resolve(__dirname, '..', rel), 'utf8');

const main = read('electron/main.ts');
const preload = read('electron/preload.ts');
const typings = read('src/types/electron.d.ts');

const CHANNEL = 'window:open-queue';

/** The body of `function registerQueueWindowHandler() { … }` — up to the next top-level `}`. */
function handlerBody(): string {
  const start = main.indexOf('function registerQueueWindowHandler');
  expect(start, 'registerQueueWindowHandler is defined in electron/main.ts').toBeGreaterThanOrEqual(0);
  const end = main.indexOf('\n}\n', start);
  return main.slice(start, end);
}

describe('queue pop-out wiring (electron main ↔ preload ↔ renderer typings)', () => {
  it('main handles the very channel the preload invokes', () => {
    expect(main).toContain(`ipcMain.handle('${CHANNEL}'`);
    expect(preload).toContain(`openQueueWindow: (opts) => ipcRenderer.invoke('${CHANNEL}', opts)`);
  });

  it('registers the handler at startup (declaration + call)', () => {
    expect(main.match(/registerQueueWindowHandler\(\)/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('opens the standalone queue view, one window per session', () => {
    const body = handlerBody();
    expect(main).toContain('const queuePopoutWindows = new Map<string, BrowserWindow>()');
    expect(body).toContain("popout: 'queue'");
    expect(body).toContain('queuePopoutWindows.get(sessionId)');
    expect(body).toContain('existing.focus()');
  });

  it("keeps its own bounds slot ('queue'), so resizing it never moves another pop-out", () => {
    const body = handlerBody();
    expect(body).toContain("computePopoutBounds('queue')");
    expect(body).toContain("savePopoutBounds('queue'");
  });

  it('shares the window.open policy and the one preload path with every other window', () => {
    const body = handlerBody();
    expect(body).toContain('attachWindowOpenPolicy(w)');
    expect(body).toContain('preload: PRELOAD_PATH,');
  });

  it("loads from the caller's own origin, so dev (Vite on 3332) and packaged (3333) both work", () => {
    // `SERVER_PORT ?? '3333'` was copied from the older pop-out handlers. Under `electron:dev` the main window
    // is served by Vite on 3332 while 3333 serves a possibly stale `dist/client` — a float that loads from there
    // is a different build from the window that opened it. `originPort()` reads the port off the live window,
    // the same source `attachWindowOpenPolicy` uses to decide what is "our own origin".
    const body = handlerBody();
    expect(body).toMatch(/BrowserWindow\.fromWebContents\(\w+\.sender\)/);
    expect(body).toMatch(/originPort\(\s*caller\s*\)/);
    expect(body).toMatch(/loadURL\(`http:\/\/localhost:\$\{port\}\/\?/);
  });

  it('is a locked-down renderer: context isolation on, no node integration, sandboxed', () => {
    // webPreferences is the whole security boundary of the window. Nothing else asserts it for this one.
    const body = handlerBody();
    const prefs = body.slice(body.indexOf('webPreferences: {'));
    expect(prefs.slice(0, prefs.indexOf('}') + 1)).toMatch(
      /contextIsolation: true,\s*nodeIntegration: false,\s*sandbox: true/,
    );
  });

  it('the renderer typings declare the bridge method with the shape the handler reads', () => {
    expect(typings).toContain('openQueueWindow?(opts: { sessionId: string; label?: string }): Promise<{ ok: boolean }>');
  });
});
