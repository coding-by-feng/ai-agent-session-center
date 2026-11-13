import { test, expect, ok, api, job } from './fixtures/cloudTopology';
const base = '/api/resources/cloud';
// Nov 13 2026: Cloud sync's UI (AASC-62: save from the Library, the sync list, Keep mine / Use
// cloud's, Activity restore) was removed, and with it this test's second half. Its server routes
// stay until step 2, so the publish test below still covers them. The pages open on the ☁ Cloud
// account dialog (`account=1`), whose status bar this test drives.
test('a saved connection that reloads offline recovers with Refresh connection, reading only /v1/health', async ({
  topology: t,
  a,
  b,
}) => {
  const errors: string[] = [];
  a.on('pageerror', (e) => errors.push(e.message));
  b.on('pageerror', (e) => errors.push(e.message));
  expect(t.a.home).not.toBe(t.b.home);
  expect(t.a.binding.deviceId).not.toBe(t.b.binding.deviceId);
  // Saved connector reload while the browser still uses local notes must have a usable health action.
  expect((await t.control('reload-cloud', { device: 'a' })).state).toBe('offline');
  const trafficBefore = (await t.control('traffic')).length;
  await a.reload();
  await expect(a.getByText(/Cloud · offline/)).toBeVisible();
  expect(
    await a.evaluate(() => (window as any).cloudAcceptanceNotes.getState().identity),
  ).toBeNull();
  await a.getByRole('button', { name: 'Refresh connection', exact: true }).click();
  await expect(a.getByText(/Cloud · connected/)).toBeVisible();
  await t.control('fault', { device: 'a', kind: 'health-outage' });
  await a.getByRole('button', { name: 'Refresh connection', exact: true }).click();
  await expect(a.getByText(/Cloud · offline/)).toBeVisible();
  await a.getByRole('button', { name: 'Refresh connection', exact: true }).click();
  await expect(a.getByText(/Cloud · connected/)).toBeVisible();
  const recoveryTraffic = (await t.control('traffic'))
    .slice(trafficBefore)
    .filter((r: any) => r.device === 'a');
  expect(recoveryTraffic.filter((r: any) => r.path === '/v1/health')).toHaveLength(3);
  expect(recoveryTraffic.every((r: any) => r.method === 'GET')).toBe(true);
  expect(recoveryTraffic.some((r: any) => r.path.startsWith('/v1/skill-notes'))).toBe(false);
  expect(errors).toEqual([]);
});
test('lost commit response replays one immutable receipt; disappearing BE upload retries after restart; revoked device cannot publish', async ({
  topology: t,
}) => {
  const plan = await ok(t, 'a', base + '/publish-plans', {
    selection: [{ scope: 'global', type: 'skill', include: true }],
  });
  await t.control('fault', { kind: 'after-commit' });
  const j = await job(t, 'a', (await ok(t, 'a', base + `/publish-plans/${plan.id}/run`, {})).id);
  expect(j.state).toBe('failed');
  const retry = await job(t, 'a', (await ok(t, 'a', base + `/jobs/${j.id}/retry`, {})).id);
  expect(retry.state).toBe('complete');
  const calls = await t.control('traffic');
  expect(calls.filter((x: any) => x.path === '/v1/resources/uploads')).toHaveLength(1);
  expect(calls.filter((x: any) => x.path.endsWith('/commit'))).toHaveLength(2);
  const before = (await ok(t, 'b', base + '/resources')).items[0];
  expect(before.version).toBe(1);
  await t.control('write', {
    path: '.claude/skills/acceptance/SKILL.md',
    bytes: '# Acceptance\nUpdated portable bytes\n',
  });
  const p2 = await ok(t, 'a', base + '/publish-plans', {
    selection: [{ scope: 'global', type: 'skill', include: true }],
  });
  await t.control('fault', { kind: 'before-put' });
  const failed = await job(t, 'a', (await ok(t, 'a', base + `/publish-plans/${p2.id}/run`, {})).id);
  expect(failed.state).toBe('failed');
  expect((await ok(t, 'a', base + '/status')).state).toBe('offline');
  await t.control('resume-be');
  expect(
    (await job(t, 'a', (await ok(t, 'a', base + `/jobs/${failed.id}/retry`, {})).id)).state,
  ).toBe('complete');
  expect((await ok(t, 'b', base + '/resources')).items[0].version).toBe(2);
  await t.control('revoke', { device: 'b' });
  expect((await api(t, 'b', base + '/resources')).error.code).toBe('revoked');
  expect((await ok(t, 'b', base + '/status')).state).toBe('revoked');
});
test('retired endpoint probes are unavailable and never dispatch any cloud or Git work', async ({
  topology: t,
}) => {
  const before = await t.control('traffic');
  const head = await t.control('git', { directory: 'seed', args: ['rev-parse', 'HEAD'] });
  for (const prefix of ['transfers', 'sync'])
    for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
      const r = await api(
        t,
        'a',
        `/api/resources/${prefix}/tasks/deadbeef/run`,
        method === 'GET' ? undefined : {},
        method,
      );
      expect(r).toMatchObject({ status: 404, success: false, error: 'Not found' });
    }
  expect(await t.control('traffic')).toEqual(before);
  expect(await t.control('git', { directory: 'seed', args: ['rev-parse', 'HEAD'] })).toBe(head);
});
