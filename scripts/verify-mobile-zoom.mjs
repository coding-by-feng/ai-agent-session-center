import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import assert from 'node:assert/strict';
// Run from the repository root after npm run build:hosted.
// Uses compiled UI with synthetic transport; no live customer data.
await mkdir('output/mobile-prompt-zoom', { recursive: true });
const root = resolve('dist/hosted/lite');
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname.replace(/^\/ui\/lite\/?/, '');
  try {
    const file = resolve(root, path || 'index.html');
    if (!file.startsWith(root + '/')) throw Error();
    const body = await readFile(file);
    res.setHeader(
      'Content-Type',
      { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' }[
        extname(file)
      ] || 'application/octet-stream',
    );
    res.end(body);
  } catch {
    res.statusCode = 404;
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  await page.route('**/api/**', async (route) => {
    const p = new URL(route.request().url()).pathname;
    let body = { success: true, data: [] };
    if (p === '/api/auth/status') body = { passwordRequired: false, authenticated: true };
    if (p.includes('/chat'))
      body = {
        success: true,
        data: { entries: [], before: null, after: null, cli: 'claude', hasMore: false },
      };
    if (p === '/api/settings') body = { success: true, data: {} };
    await route.fulfill({ json: body });
  });
  await page.routeWebSocket('**/*', (ws) => {
    ws.send(
      JSON.stringify({
        type: 'snapshot',
        seq: 1,
        sessions: {
          'test-claude': {
            sessionId: 'test-claude',
            title: 'Claude',
            status: 'idle',
            projectName: 'workspace',
            cwd: '/workspace',
            cliSource: 'claude',
            terminalId: 'term-test',
            source: 'ssh',
            events: [],
            promptHistory: [],
            toolLog: [],
            lastActivityAt: Date.now(),
          },
        },
      }),
    );
  });
  page.on('pageerror', (error) => console.log('PAGE_ERROR', error.message));
  await page.goto(base + '/ui/lite/');

  await page.getByText('Ready for a prompt', { exact: true }).waitFor();
  await page.screenshot({ path: 'output/mobile-prompt-zoom/sessions.png' });
  const blockers = await page.getByText('Ready for a prompt', { exact: true }).evaluate((el) => {
    const out = [];
    for (let p = el; p; p = p.parentElement) {
      const t = getComputedStyle(p).touchAction;
      if (t !== 'auto' && t !== 'manipulation' && !t.includes('pinch-zoom'))
        out.push({ class: p.className, t });
    }
    return out;
  });
  assert.deepEqual(blockers, [], 'A session row blocks browser pinch zoom');
  const cdp = await context.newCDPSession(page);
  const scale = () => page.evaluate(() => visualViewport.scale);
  const initial = await scale();
  await cdp.send('Input.synthesizePinchGesture', {
    x: 190,
    y: 220,
    scaleFactor: 1.5,
    relativeSpeed: 400,
    gestureSourceType: 'touch',
  });
  await page.waitForTimeout(250);
  const zoomed = await scale();
  assert(zoomed > initial + 0.1, `pinch did not zoom: ${initial} -> ${zoomed}`);
  await cdp.send('Input.synthesizePinchGesture', {
    x: 190,
    y: 220,
    scaleFactor: 0.5,
    relativeSpeed: 400,
    gestureSourceType: 'touch',
  });
  await page.waitForTimeout(250);
  const restored = await scale();
  assert(restored < zoomed, `pinch did not zoom out: ${zoomed} -> ${restored}`);
  await page.getByText('Ready for a prompt', { exact: true }).click();

  await page.getByText('No messages yet', { exact: true }).waitFor();
  await page.screenshot({ path: 'output/mobile-prompt-zoom/chat.png' });
  const chatInitial = await scale();
  await cdp.send('Input.synthesizePinchGesture', {
    x: 190,
    y: 220,
    scaleFactor: 1.5,
    relativeSpeed: 400,
    gestureSourceType: 'touch',
  });
  await page.waitForTimeout(250);
  const chatZoomed = await scale();
  assert(chatZoomed > chatInitial + 0.1);
  await cdp.send('Input.synthesizePinchGesture', {
    x: 190,
    y: 220,
    scaleFactor: 0.5,
    relativeSpeed: 400,
    gestureSourceType: 'touch',
  });
  await page.waitForTimeout(250);
  const chatRestored = await scale();
  assert(chatRestored < chatZoomed);
  console.log(
    JSON.stringify(
      {
        sessions: { initial, zoomed, restored },
        chat: { initial: chatInitial, zoomed: chatZoomed, restored: chatRestored },
        blockers,
      },
      null,
      2,
    ),
  );
  await context.close();
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
