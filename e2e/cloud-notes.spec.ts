import { test, expect, publish, ok, job } from './fixtures/cloudTopology';
import { readFile } from 'node:fs/promises';
const key = 'claude:acceptance',
  base = '/api/resources/cloud';
async function activate(page: import('@playwright/test').Page) {
  await expect
    .poll(() =>
      page.evaluate(() => Boolean((window as any).cloudAcceptanceNotes?.getState().connection)),
    )
    .toBe(true);
  await page.evaluate(async () => {
    const s = (window as any).cloudAcceptanceNotes.getState();
    await s.flush();
    await s.useCloudNotes('separate', await s.previewImport());
  });
}
async function refresh(page: import('@playwright/test').Page) {
  await page.evaluate(async () => {
    const s = (window as any).cloudAcceptanceNotes.getState();
    await s.flush();
    await s.refresh();
  });
}
test('two independent browser outboxes survive offline reload and converge; acknowledged missing alias installs after its resource', async ({
  topology: t,
  a,
  b,
}) => {
  await activate(a);
  await activate(b);
  // Block only each browser's actual notes HTTP calls; local IndexedDB edits remain real.
  for (const p of [a, b])
    await p.route('**/api/cloud/skill-notes**', (r) => r.abort('internetdisconnected'));
  await a.evaluate(async (k) => {
    const s = (window as any).cloudAcceptanceNotes.getState();
    s.addTag(k, 'from-a');
    s.toggleFav(k);
    await s.flush();
  }, key);
  await b.evaluate(async (k) => {
    const s = (window as any).cloudAcceptanceNotes.getState();
    s.addTag(k, 'from-b');
    await s.flush();
  }, key);
  await a.reload();
  await b.reload();
  for (const [p, tag] of [
    [a, 'from-a'],
    [b, 'from-b'],
  ] as const) {
    await expect
      .poll(() =>
        p.evaluate(
          (k) => (window as any).cloudAcceptanceNotes?.getState().notes[k]?.tags ?? [],
          key,
        ),
      )
      .toContain(tag);
    await p.unroute('**/api/cloud/skill-notes**');
  }
  await a.evaluate(async () => {
    const s = (window as any).cloudAcceptanceNotes.getState();
    await s.setConnection(
      await (await fetch('/api/cloud/skill-notes/status')).json().then((r) => r.data),
    );
  });
  await b.evaluate(async () => {
    const s = (window as any).cloudAcceptanceNotes.getState();
    await s.setConnection(
      await (await fetch('/api/cloud/skill-notes/status')).json().then((r) => r.data),
    );
  });
  await refresh(a);
  await refresh(b);
  await refresh(a);
  for (const p of [a, b])
    expect(
      await p.evaluate((k) => (window as any).cloudAcceptanceNotes.getState().notes[k], key),
    ).toMatchObject({ fav: true, tags: expect.arrayContaining(['from-a', 'from-b']) });
  await a.evaluate(async (k) => {
    const s = (window as any).cloudAcceptanceNotes.getState();
    if (!s.setAbbr(k, 'ac', new Set()).ok) throw Error('Abbreviation rejected');
    s.setCli(k, true);
    await s.flush();
    await s.refresh();
  }, key);
  await ok(t, 'b', base + '/aliases/device', { enabled: true }, undefined, true);
  const review = await ok(t, 'b', base + '/aliases/preview', { keys: [key] }, undefined, true);
  expect(review.intents).toMatchObject([{ key, abbr: 'ac', cli: true }]);
  expect(review.statuses[0].state).toBe('needs-resource');
  expect(
    (
      await ok(
        t,
        'b',
        base + '/aliases/reconcile',
        { keys: [key], reviewId: review.reviewId },
        undefined,
        true,
      )
    )[0].state,
  ).toBe('needs-resource');
  await expect(t.control('read', { device: 'b', path: '.claude/commands/ac.md' })).rejects.toThrow(
    'ENOENT',
  );
  const v = await publish(t),
    plan = await ok(t, 'b', base + '/install-plans', {
      resourceId: v.manifest.resourceId,
      version: 1,
    });
  expect(
    (
      await job(
        t,
        'b',
        (await ok(t, 'b', base + `/install-plans/${plan.id}/run`, { decisions: {} })).id,
      )
    ).state,
  ).toBe('complete');
  expect(
    (await ok(t, 'b', base + '/aliases/status', { keys: [key] }, undefined, true)).statuses[0]
      .state,
  ).toBe('installed');
  expect(await t.control('read', { device: 'b', path: '.claude/commands/ac.md' })).toContain(
    'acceptance',
  );
  await refresh(b);
  const feed = await ok(t, 'b', '/api/cloud/skill-notes', undefined, undefined, true);
  const latest = feed.records
    .filter((r: any) => r.key === key)
    .sort((a: any, b: any) => b.version - a.version)[0];
  expect(latest.value.tags.sort()).toEqual(['from-a', 'from-b']);
});
test('real services preserve immutable notes receipts and owner isolation while both HTTP boundaries reject content', async ({
  topology: t,
}) => {
  const fixture = JSON.parse(
    await readFile(new URL('../test/fixtures/cloud-notes-contracts.json', import.meta.url), 'utf8'),
  );
  const body = { ops: [fixture.mutation] };
  const first = await ok(t, 'a', '/api/cloud/skill-notes/batch', body, undefined, true);
  expect(first.results[0].record).toEqual(fixture.record);
  expect(await ok(t, 'b', '/api/cloud/skill-notes/batch', body, undefined, true)).toEqual(first);
  const repeated = await t.control('be-request', {
    path: '/v1/skill-notes/batch',
    method: 'POST',
    body,
  });
  expect(repeated.body.data).toEqual(first);
  // The BE has one bootstrap owner; probe a foreign service context without bypassing its owner singleton.
  expect(await t.control('foreign-read', { kind: 'notes' })).toMatchObject({
    status: 404,
    code: 'not_found',
  });
  const invalid = { ops: [{ ...fixture.mutation, content: 'not note metadata' }] };
  const { api } = await import('./fixtures/cloudTopology');
  expect((await api(t, 'a', '/api/cloud/skill-notes/batch', invalid, undefined, true)).status).toBe(
    400,
  );
  expect(
    (
      await t.control('be-request', {
        path: '/v1/skill-notes/batch',
        method: 'POST',
        body: invalid,
      })
    ).status,
  ).toBe(400);
  const v = await publish(t);
  expect(
    await t.control('foreign-read', { kind: 'resource', id: v.manifest.resourceId }),
  ).toMatchObject({ status: 404, code: 'not_found' });
  const f = JSON.parse(
    await readFile(
      new URL('../test/fixtures/cloud-resource-contracts.json', import.meta.url),
      'utf8',
    ),
  );
  expect(
    (
      await t.control('be-request', {
        path: '/v1/resources/uploads',
        method: 'POST',
        body: {
          ...f.beginUpload,
          manifest: {
            ...f.beginUpload.manifest,
            files: [{ ...f.beginUpload.manifest.files[0], path: '/absolute/private' }],
          },
        },
      })
    ).status,
  ).toBe(400);
});
