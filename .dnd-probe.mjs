import { chromium } from 'playwright';

const CONFIGS = [
  { name: 'A  baseline (all as-shipped)',        q: 'img=1&cls=1&rr=1' },
  { name: 'B  no setDragImage',                  q: 'img=0&cls=1&rr=1' },
  { name: 'C  no .dragging class on dragstart',  q: 'img=1&cls=0&rr=1' },
  { name: 'D  no re-render during dragstart',    q: 'img=1&cls=1&rr=0' },
  { name: 'E  none of the three',                q: 'img=0&cls=0&rr=0' },
];

const browser = await chromium.launch({ headless: false });
const page = await browser.newPage();

for (const cfg of CONFIGS) {
  await page.goto(`http://localhost:8899/matrix.html?${cfg.q}`);
  const src = page.locator('div[data-id="101"] .queueDragHandle');
  const dst = page.locator('div[data-id="103"]');
  const s = await src.boundingBox();
  const d = await dst.boundingBox();

  await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2);
  await page.mouse.down();
  // several intermediate moves — a native drag needs > threshold movement
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(
      s.x + s.width / 2,
      s.y + s.height / 2 + ((d.y + d.height / 2 - (s.y + s.height / 2)) * i) / 8,
      { steps: 4 },
    );
    await page.waitForTimeout(40);
  }
  await page.mouse.up();
  await page.waitForTimeout(150);

  const st = await page.evaluate(() => window.__state());
  const dragovers = st.events.filter((e) => e.startsWith('dragover')).length;
  const moved = st.order.join(',') !== '101,102,103';
  console.log(
    `${cfg.name.padEnd(36)} dragovers=${String(dragovers).padStart(3)}  order=${st.order.join(',')}  ${moved ? '✅ REORDERED' : '❌ NO REORDER'}`,
  );
  console.log(`   events: ${st.events.slice(0, 6).join(' | ')}${st.events.length > 6 ? ' …' : ''}`);
}

await browser.close();
