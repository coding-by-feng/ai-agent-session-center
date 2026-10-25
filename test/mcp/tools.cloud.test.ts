// test/mcp/tools.cloud.test.ts — the cloud toolset's P1 reads about the connection and the account's sync
// (server/mcp/tools/cloud.ts): cloud_status, cloud_notes_status, cloud_sync_status, cloud_aliases_status and
// remote_access_get. The projects and the account's resources are in tools.cloudProjects.test.ts.
//
// Most cloud routes want the account and connection a caller reviewed, named in headers. A tool learns them from
// `GET /resources/cloud/status` and sends them on, exactly as the dashboard does. Some routes exist only in newer
// builds of AASC: there the tool answers UNAVAILABLE, not a failure. Nothing here depends on the central’s scope:
// the cloud belongs to the Mac.
import { describe, expect, it, vi } from 'vitest';
import {
  ACCOUNT, BACKEND, CLOUD_HEADERS, CONNECTION, NOTES_HEADERS, cloudFail, connectedStatus, disconnectedStatus, statusCall,
} from './cloudFixtures.js';
import { blocksIn, deepFreeze, everything, expectFenced, HOSTILE, outsideFences } from './readFixtures.js';
import { dataOf, envelope, fail, makeCentral, makeCtx, makeSession, ok, run, runRefused } from './toolHarness.js';

vi.mock('../../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

const STATUS = 'GET /resources/cloud/status';

describe('cloud_status', () => {
  it('calls GET /resources/cloud/status, which needs no headers', async () => {
    const { ctx, client } = makeCtx({ routes: { [STATUS]: connectedStatus } });

    await run('cloud_status', {}, ctx);

    expect(client.calls).toEqual([statusCall]);
  });

  it('describes a connection: where, which account and device, and the generation', async () => {
    const { ctx } = makeCtx({ routes: { [STATUS]: connectedStatus } });

    const data = await dataOf<{ state: string; connected: boolean; connection: Record<string, unknown> | null; lastError: string | null }>('cloud_status', {}, ctx);

    expect(data).toMatchObject({ state: 'connected', connected: true, lastError: null });
    expect(data.connection).toEqual({ ...CONNECTION, accountEmail: null });
  });

  it('says so when this Mac is not connected, which is a state and not an error', async () => {
    const { ctx } = makeCtx({ routes: { [STATUS]: disconnectedStatus } });

    const result = await run('cloud_status', {}, ctx);

    expect(result.data).toMatchObject({ state: 'disconnected', connected: false, connection: null });
    expect(result.summary).toMatch(/not connected/i);
  });

  it('does not call an offline or revoked connection connected, and names the Google address when there is one', async () => {
    const offline = makeCtx({ routes: { [STATUS]: envelope({ connection: { ...CONNECTION, accountEmail: 'me@example.test' }, state: 'offline', lastError: null }) } });
    const revoked = makeCtx({ routes: { [STATUS]: envelope({ connection: CONNECTION, state: 'revoked', lastError: null }) } });

    const first = await dataOf<{ connected: boolean; connection: { accountEmail: string | null } }>('cloud_status', {}, offline.ctx);
    const second = await dataOf<{ connected: boolean; state: string }>('cloud_status', {}, revoked.ctx);

    expect(first).toMatchObject({ connected: false, connection: { accountEmail: 'me@example.test' } });
    expect(second).toMatchObject({ connected: false, state: 'revoked' });
  });

  it('fences the last error in the data and keeps the whole connection in one block in the text', async () => {
    const { ctx } = makeCtx({ routes: { [STATUS]: envelope({ connection: { ...CONNECTION, deviceName: HOSTILE }, state: 'offline', lastError: HOSTILE }) } });

    const result = await run('cloud_status', {}, ctx);

    expectFenced((result.data as { lastError: string }).lastError, 'cloud-error', 'aasc');
    expect(blocksIn(result.summary)).toBe(1);
    expect(outsideFences(result.summary)).not.toMatch(/SYSTEM|rm -rf|Ignore all/);
  });

  it('answers UNAVAILABLE where AASC runs without a cloud connector (the app’s page answers the route)', async () => {
    const { ctx } = makeCtx({ routes: { [STATUS]: ok(null) } });

    const err = await runRefused('cloud_status', {}, ctx);

    expect(err.code).toBe('UNAVAILABLE');
    expect(err.message).toMatch(/AASC Cloud/);
  });

  it('changes nothing it reads', async () => {
    const frozen = deepFreeze(JSON.parse(JSON.stringify({ success: true, data: { connection: CONNECTION, state: 'connected', lastError: null } })));
    const { ctx } = makeCtx({ routes: { [STATUS]: ok(frozen) } });

    await expect(run('cloud_status', {}, ctx)).resolves.toBeDefined();
  });
});

describe('cloud_notes_status', () => {
  const path = 'GET /resources/cloud/skill-notes/status';

  it('calls GET /resources/cloud/skill-notes/status', async () => {
    const { ctx, client } = makeCtx({ routes: { [path]: envelope({ connection: { backendOrigin: BACKEND, accountId: ACCOUNT, generation: 3 }, state: 'connected' }) } });

    await run('cloud_notes_status', {}, ctx);

    expect(client.calls).toEqual([{ method: 'GET', path: '/resources/cloud/skill-notes/status' }]);
  });

  it('says whether notes can sync and as which account, or that nothing is connected', async () => {
    const on = makeCtx({ routes: { [path]: envelope({ connection: { backendOrigin: BACKEND, accountId: ACCOUNT, generation: 3 }, state: 'connected' }) } });
    const off = makeCtx({ routes: { [path]: envelope({ connection: null, state: 'disconnected' }) } });

    expect(await dataOf('cloud_notes_status', {}, on.ctx)).toEqual({
      state: 'connected', connected: true, connection: { backendOrigin: BACKEND, accountId: ACCOUNT, generation: 3 },
    });
    const none = await run('cloud_notes_status', {}, off.ctx);
    expect(none.data).toEqual({ state: 'disconnected', connected: false, connection: null });
    expect(none.summary).toMatch(/not connected/i);
  });

  it('answers UNAVAILABLE where AASC has no cloud connector, and turns a failure into its refusal', async () => {
    const missing = makeCtx({ routes: { [path]: ok(null) } });
    const down = makeCtx({ routes: { [path]: fail(500, 'boom') } });

    expect((await runRefused('cloud_notes_status', {}, missing.ctx)).code).toBe('UNAVAILABLE');
    expect((await runRefused('cloud_notes_status', {}, down.ctx)).code).toBe('UPSTREAM');
  });
});

interface SyncData {
  waiting: number; total: number; counts: Record<string, number>; count: number; shown: number; nextCursor: string | null;
  items: Array<{ resourceId: string; catalogId: string | null; name: string; agent: string; kind: string; scope: string; state: string; cloudVersion: number | null; syncedVersion: number | null; memory: boolean; reason: string | null }>;
}

describe('cloud_sync_status', () => {
  const item = (id: string, name: string, state: string, over: Record<string, unknown> = {}) => ({
    resourceId: id, catalogId: `cat-${name}`, name, agent: 'claude', kind: 'skill', scope: 'global', state, cloudVersion: 4, syncedVersion: 4, memory: false, ...over,
  });
  const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444'];
  const items = [
    item(ids[0], 'brainstorming', 'synced'),
    item(ids[1], 'deploy', 'local-changed', { syncedVersion: 3 }),
    item(ids[2], 'notes', 'blocked', { memory: true, reason: 'Memory needs your OK first.' }),
    item(ids[3], 'shared-tool', 'cloud-only', { catalogId: null, syncedVersion: null }),
  ];
  const routes = { [STATUS]: connectedStatus, 'GET /resources/cloud/sync-status': envelope({ items, waiting: 2 }) };

  it('learns the connection first, then asks for the sync list as that account', async () => {
    const { ctx, client } = makeCtx({ routes });

    await run('cloud_sync_status', {}, ctx);

    expect(client.calls).toEqual([statusCall, { method: 'GET', path: '/resources/cloud/sync-status', headers: CLOUD_HEADERS }]);
  });

  it('counts the list by state and says how many Sync now would move', async () => {
    const { ctx } = makeCtx({ routes });

    const data = await dataOf<SyncData>('cloud_sync_status', {}, ctx);

    expect(data).toMatchObject({ waiting: 2, total: 4, count: 4, shown: 4, nextCursor: null });
    expect(data.counts).toEqual({ synced: 1, 'local-changed': 1, blocked: 1, 'cloud-only': 1 });
    expect(data.items[1]).toEqual({
      resourceId: ids[1], catalogId: 'cat-deploy', name: 'deploy', agent: 'claude', kind: 'skill', scope: 'global', state: 'local-changed',
      cloudVersion: 4, syncedVersion: 3, memory: false, reason: null,
    });
    expect(data.items[3]).toMatchObject({ catalogId: null, syncedVersion: null });
  });

  it('fences the reason a resource cannot sync, as text the server wrote', async () => {
    const { ctx } = makeCtx({ routes });

    const { items: rows } = await dataOf<SyncData>('cloud_sync_status', {}, ctx);

    expectFenced(rows[2].reason, 'sync-reason', `cloud-resource:${ids[2]}`);
    expect(rows[2].reason).toContain('Memory needs your OK first.');
  });

  it('filters by state, and shows 100 to a page by default (up to 200)', async () => {
    const many = Array.from({ length: 150 }, (_, i) => item(`aaaaaaaa-aaaa-4aaa-8aaa-${i.toString().padStart(12, '0')}`, `r${i}`, i % 3 === 0 ? 'synced' : 'cloud-only'));
    const { ctx } = makeCtx({ routes: { [STATUS]: connectedStatus, 'GET /resources/cloud/sync-status': envelope({ items: many, waiting: 0 }) } });

    const first = await dataOf<SyncData>('cloud_sync_status', {}, ctx);
    const rest = await dataOf<SyncData>('cloud_sync_status', { cursor: first.nextCursor ?? '' }, ctx);
    const synced = await dataOf<SyncData>('cloud_sync_status', { state: 'synced' }, ctx);

    expect(first).toMatchObject({ total: 150, count: 150, shown: 100, nextCursor: '100' });
    expect(rest).toMatchObject({ shown: 50, nextCursor: null });
    expect(synced).toMatchObject({ total: 150, count: 50, shown: 50 });
    await expect(run('cloud_sync_status', { limit: 201 }, ctx)).rejects.toThrow(/limit/);
    await expect(run('cloud_sync_status', { state: 'imaginary' }, ctx)).rejects.toThrow(/state/);
  });

  it('keeps hostile text inside fences, and puts the rows in one block', async () => {
    const evil = [item(ids[0], HOSTILE, 'blocked', { reason: HOSTILE })];
    const { ctx } = makeCtx({ routes: { [STATUS]: connectedStatus, 'GET /resources/cloud/sync-status': envelope({ items: evil, waiting: 0 }) } });

    const result = await run('cloud_sync_status', {}, ctx);

    expect(blocksIn(result.summary)).toBe(1);
    expect(outsideFences(result.summary)).not.toMatch(/SYSTEM|rm -rf|Ignore all/);
  });

  it('says so when this Mac is not connected, without asking for the list', async () => {
    const { ctx, client } = makeCtx({ routes: { [STATUS]: disconnectedStatus, 'GET /resources/cloud/sync-status': envelope({ items: [], waiting: 0 }) } });

    const err = await runRefused('cloud_sync_status', {}, ctx);

    expect(err.code).toBe('UNAVAILABLE');
    expect(err.message).toMatch(/not connected/i);
    expect(client.calls).toEqual([statusCall]);
  });

  it('answers UNAVAILABLE, not a failure, where this build of AASC has no sync list (415, 404 or the app’s page)', async () => {
    for (const answer of [cloudFail(415, 'invalid_request', 'Content-Type must be application/json'), fail(404, 'Not found'), ok(null)]) {
      const { ctx } = makeCtx({ routes: { [STATUS]: connectedStatus, 'GET /resources/cloud/sync-status': answer } });

      const err = await runRefused('cloud_sync_status', {}, ctx);

      expect(err.code).toBe('UNAVAILABLE');
      expect(err.message).toMatch(/no cloud sync list/i);
    }
  });

  it('turns the cloud’s own refusals into words a central can act on', async () => {
    const changed = makeCtx({ routes: { [STATUS]: connectedStatus, 'GET /resources/cloud/sync-status': cloudFail(409, 'connection_changed', 'The cloud connection changed. Refresh and review this action again.') } });
    const revoked = makeCtx({ routes: { [STATUS]: connectedStatus, 'GET /resources/cloud/sync-status': cloudFail(401, 'revoked', 'Cloud authentication is no longer valid.') } });
    const limited = makeCtx({ routes: { [STATUS]: connectedStatus, 'GET /resources/cloud/sync-status': cloudFail(429, 'rate_limited', 'Cloud requests are temporarily limited.') } });
    const offline = makeCtx({ routes: { [STATUS]: connectedStatus, 'GET /resources/cloud/sync-status': cloudFail(503, 'offline', 'Cloud is offline.') } });
    const broken = makeCtx({ routes: { [STATUS]: connectedStatus, 'GET /resources/cloud/sync-status': cloudFail(500, 'cloud_error', 'Cloud action failed.') } });

    const first = await runRefused('cloud_sync_status', {}, changed.ctx);
    expect(first.code).toBe('UNAVAILABLE');
    expect(first.message).toContain('The cloud connection changed');
    expect(first.hint).toMatch(/cloud_status/);
    expect((await runRefused('cloud_sync_status', {}, revoked.ctx)).code).toBe('UNAVAILABLE');
    expect((await runRefused('cloud_sync_status', {}, limited.ctx)).code).toBe('UNAVAILABLE');
    const down = await runRefused('cloud_sync_status', {}, offline.ctx);
    expect(down.code).toBe('UNAVAILABLE');
    expect(down.message).toContain('Cloud is offline.');
    const gateway = makeCtx({ routes: { [STATUS]: connectedStatus, 'GET /resources/cloud/sync-status': cloudFail(502, 'backend_error', 'The cloud request failed.') } });
    expect((await runRefused('cloud_sync_status', {}, gateway.ctx)).code).toBe('UNAVAILABLE');
    expect((await runRefused('cloud_sync_status', {}, broken.ctx)).code).toBe('UPSTREAM');
  });

  it('words a bad request as invalid, and reads a connection with no account or a bad generation as no connection at all', async () => {
    const bad = makeCtx({ routes: { [STATUS]: connectedStatus, 'GET /resources/cloud/sync-status': cloudFail(400, 'invalid_request', 'Invalid cloud resource request.') } });
    const partial = makeCtx({ routes: { [STATUS]: envelope({ connection: { backendOrigin: BACKEND, generation: 3 }, state: 'connected', lastError: null }), 'GET /resources/cloud/sync-status': envelope({ items: [], waiting: 0 }) } });
    const negative = makeCtx({ routes: { [STATUS]: envelope({ connection: { ...CONNECTION, generation: -1 }, state: 'connected', lastError: null }), 'GET /resources/cloud/sync-status': envelope({ items: [], waiting: 0 }) } });

    expect((await runRefused('cloud_sync_status', {}, bad.ctx)).code).toBe('INVALID');
    expect((await runRefused('cloud_sync_status', {}, partial.ctx)).message).toMatch(/not connected/i);
    expect((await runRefused('cloud_sync_status', {}, negative.ctx)).message).toMatch(/not connected/i);
    expect((await dataOf<{ connected: boolean }>('cloud_status', {}, makeCtx({ routes: { [STATUS]: envelope({ connection: { backendOrigin: BACKEND, generation: 3 }, state: 'connected' }) } }).ctx)).connected).toBe(false);
  });

  it('is open to every central that has the toolset', async () => {
    const { ctx } = makeCtx({ central: makeCentral('room', 'r1'), sessions: [makeSession('s1')], routes });

    expect((await dataOf<SyncData>('cloud_sync_status', {}, ctx)).total).toBe(4);
  });
});

interface AliasData {
  enabled: boolean; cached: boolean; connected: boolean; keys: number; counts: Record<string, number>;
  statuses: Array<{ key: string; state: string; message: string | null }>;
}

describe('cloud_aliases_status', () => {
  const path = 'POST /resources/cloud/aliases/status';
  const device = { enabled: true, connection: { backendOrigin: BACKEND, accountId: ACCOUNT, generation: 3 }, cached: false, statuses: [
    { key: 'claude:brainstorming', state: 'installed' },
    { key: 'shared:plugin:tdd', state: 'needs-resource', message: 'Install the skill first.' },
  ] };
  const favorites = ok({
    source: 'cloud',
    entries: [
      { key: 'claude:brainstorming', fav: true, tags: [], abbr: 'bs' },
      { key: 'shared:plugin:tdd', fav: false, tags: ['code'], abbr: 'tdd' },
      { key: 'codex:review', fav: true, tags: [], abbr: null },
    ],
  });

  it('asks as the notes headers name the account, with the keys it was given', async () => {
    const { ctx, client } = makeCtx({ routes: { [STATUS]: connectedStatus, [path]: envelope(device) } });

    await run('cloud_aliases_status', { keys: ['claude:brainstorming', 'shared:plugin:tdd'] }, ctx);

    expect(client.calls).toEqual([statusCall, { method: 'POST', path: '/resources/cloud/aliases/status', body: { keys: ['claude:brainstorming', 'shared:plugin:tdd'] }, headers: NOTES_HEADERS }]);
  });

  it('with no keys, asks about the notes that have an abbreviation, which is where an alias comes from', async () => {
    const { ctx, client } = makeCtx({ routes: { [STATUS]: connectedStatus, 'GET /skill-notes/favorites': favorites, [path]: envelope(device) } });

    await run('cloud_aliases_status', {}, ctx);

    const post = client.calls.find((c) => c.method === 'POST');
    expect(post?.body).toEqual({ keys: ['claude:brainstorming', 'shared:plugin:tdd'] });
    expect(client.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /resources/cloud/status', 'GET /skill-notes/favorites', 'POST /resources/cloud/aliases/status']);
  });

  it('asks about each key once, and about 100 notes at most when it picks them itself', async () => {
    const many = ok({ source: 'cloud', entries: Array.from({ length: 150 }, (_, i) => ({ key: `claude:skill-${i}`, fav: false, tags: [], abbr: `a${i}x` })) });
    const given = makeCtx({ routes: { [STATUS]: connectedStatus, [path]: envelope(device) } });
    const picked = makeCtx({ routes: { [STATUS]: connectedStatus, 'GET /skill-notes/favorites': many, [path]: envelope(device) } });

    await run('cloud_aliases_status', { keys: ['claude:a', 'claude:b', 'claude:a'] }, given.ctx);
    await run('cloud_aliases_status', {}, picked.ctx);

    expect(given.client.calls.find((c) => c.method === 'POST')?.body).toEqual({ keys: ['claude:a', 'claude:b'] });
    expect((picked.client.calls.find((c) => c.method === 'POST')?.body as { keys: string[] }).keys).toHaveLength(100);
  });

  it('says there is nothing to report when no note has an abbreviation, and asks the aliases route nothing', async () => {
    const none = ok({ source: 'cloud', entries: [{ key: 'codex:review', fav: true, tags: [], abbr: null }] });
    const { ctx, client } = makeCtx({ routes: { [STATUS]: connectedStatus, 'GET /skill-notes/favorites': none, [path]: envelope(device) } });

    const result = await run('cloud_aliases_status', {}, ctx);

    expect(result.data).toMatchObject({ keys: 0, statuses: [], enabled: false });
    expect(result.summary).toMatch(/no skill note has an abbreviation/i);
    expect(client.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('reports whether aliases are on for this device, each key’s state, and whether the answer is from the cache', async () => {
    const { ctx } = makeCtx({ routes: { [STATUS]: connectedStatus, [path]: envelope({ ...device, cached: true }) } });

    const data = await dataOf<AliasData>('cloud_aliases_status', { keys: ['claude:brainstorming', 'shared:plugin:tdd'] }, ctx);

    expect(data).toMatchObject({ enabled: true, cached: true, connected: true, keys: 2 });
    expect(data.counts).toEqual({ installed: 1, 'needs-resource': 1 });
    expect(data.statuses.map((s) => [s.key, s.state])).toEqual([['claude:brainstorming', 'installed'], ['shared:plugin:tdd', 'needs-resource']]);
    expect(data.statuses[0].message).toBeNull();
    expectFenced(data.statuses[1].message, 'alias-message');
  });

  it('keeps hostile text inside its fence, and puts the rows in one block', async () => {
    const evil = { ...device, statuses: [{ key: 'claude:x', state: 'conflict', message: HOSTILE }] };
    const { ctx } = makeCtx({ routes: { [STATUS]: connectedStatus, [path]: envelope(evil) } });

    const result = await run('cloud_aliases_status', { keys: ['claude:x'] }, ctx);

    expect(blocksIn(result.summary)).toBe(1);
    expect(outsideFences(result.summary)).not.toMatch(/SYSTEM|rm -rf|Ignore all/);
  });

  it('takes keys as the notes write them, 1 to 100, and refuses the rest', async () => {
    const { ctx } = makeCtx({ routes: { [STATUS]: connectedStatus, [path]: envelope(device) } });

    await expect(run('cloud_aliases_status', { keys: [] }, ctx)).rejects.toThrow(/keys/);
    await expect(run('cloud_aliases_status', { keys: ['no key here'] }, ctx)).rejects.toThrow(/keys/);
    await expect(run('cloud_aliases_status', { keys: Array.from({ length: 101 }, (_, i) => `claude:s${i}`) }, ctx)).rejects.toThrow(/keys/);
  });

  it('says so when this Mac is not connected, and turns the route’s refusals into words', async () => {
    const off = makeCtx({ routes: { [STATUS]: disconnectedStatus, [path]: envelope(device) } });
    const changed = makeCtx({ routes: { [STATUS]: connectedStatus, [path]: cloudFail(409, 'connection_changed', 'The cloud connection changed. Refresh the alias review.') } });

    expect((await runRefused('cloud_aliases_status', { keys: ['claude:a'] }, off.ctx)).message).toMatch(/not connected/i);
    const err = await runRefused('cloud_aliases_status', { keys: ['claude:a'] }, changed.ctx);
    expect(err.code).toBe('UNAVAILABLE');
    expect(err.message).toContain('The cloud connection changed');
  });

  it('changes nothing it reads', async () => {
    const frozen = deepFreeze(JSON.parse(JSON.stringify({ success: true, data: device })));
    const { ctx } = makeCtx({ routes: { [STATUS]: connectedStatus, [path]: ok(frozen) } });

    await expect(run('cloud_aliases_status', { keys: ['claude:brainstorming'] }, ctx)).resolves.toBeDefined();
  });
});

interface RemoteData {
  tailscale: { state: string; address: string | null; account: string | null; tailnet: string | null; dnsName: string | null; canOpenApp: boolean };
  publish: { state: string; tailnet: string | null; port: number; at: number | null };
  port: number;
  phones: Array<{ label: string; platform: string; status: string; hasTailnet: boolean; tailnetSentAt: number | null; lastPath: string | null; lastPathAt: number | null }>;
}

describe('remote_access_get', () => {
  const path = 'GET /resources/cloud/remote-access';
  const view = {
    tailscale: { state: 'connected', address: '100.64.1.2', account: 'me@example.test', tailnet: 'tail1234.ts.net', dnsName: 'studio.tail1234.ts.net', canOpenApp: true },
    publish: { state: 'published', tailnet: '100.64.1.2', port: 3333, at: 1_700_000_000_000 },
    phones: [
      { id: 'device-secret-id', label: 'Kason’s iPhone', platform: 'ios', status: 'active', hasTailnet: true, tailnetSentAt: 1_700_000_100_000, lastPath: 'tailnet', lastPathAt: 1_700_000_200_000 },
      { id: 'other-id', label: 'Pixel', platform: 'android', status: 'pending', hasTailnet: false, tailnetSentAt: null, lastPath: null, lastPathAt: null },
    ],
    port: 3333,
  };

  it('calls GET /resources/cloud/remote-access, which works with no cloud connection and needs no headers', async () => {
    const { ctx, client } = makeCtx({ routes: { [path]: envelope(view) } });

    await run('remote_access_get', {}, ctx);

    expect(client.calls).toEqual([{ method: 'GET', path: '/resources/cloud/remote-access' }]);
  });

  it('describes Tailscale, what this Mac has told the cloud, and how each paired phone reaches it', async () => {
    const { ctx } = makeCtx({ routes: { [path]: envelope(view) } });

    const data = await dataOf<RemoteData>('remote_access_get', {}, ctx);

    expect(data.tailscale).toEqual(view.tailscale);
    expect(data.publish).toEqual(view.publish);
    expect(data.port).toBe(3333);
    expect(data.phones).toEqual([
      { label: 'Kason’s iPhone', platform: 'ios', status: 'active', hasTailnet: true, tailnetSentAt: 1_700_000_100_000, lastPath: 'tailnet', lastPathAt: 1_700_000_200_000 },
      { label: 'Pixel', platform: 'android', status: 'pending', hasTailnet: false, tailnetSentAt: null, lastPath: null, lastPathAt: null },
    ]);
  });

  it('never passes on a phone’s device id', async () => {
    const { ctx } = makeCtx({ routes: { [path]: envelope(view) } });

    const result = await run('remote_access_get', {}, ctx);

    expect(everything(result)).not.toMatch(/device-secret-id|other-id/);
  });

  it('keeps hostile labels inside the block in the text', async () => {
    const evil = { ...view, phones: [{ ...view.phones[0], label: HOSTILE }] };
    const { ctx } = makeCtx({ routes: { [path]: envelope(evil) } });

    const result = await run('remote_access_get', {}, ctx);

    expect(blocksIn(result.summary)).toBe(1);
    expect(outsideFences(result.summary)).not.toMatch(/SYSTEM|rm -rf|Ignore all/);
  });

  it('reads a phone’s platform and last path only when they are ones AASC has, and calls anything else none', async () => {
    const odd = { ...view, phones: [{ ...view.phones[0], platform: 'palm', lastPath: 'carrier-pigeon', status: '<b>pending</b>' }] };
    const { ctx } = makeCtx({ routes: { [path]: envelope(odd) } });

    const data = await dataOf<RemoteData>('remote_access_get', {}, ctx);

    expect(data.phones[0]).toMatchObject({ platform: '', lastPath: null, status: '_b_pending__b_' });
  });

  it('reads a Mac with no Tailscale and no phones', async () => {
    const bare = { tailscale: { state: 'not-installed', address: null, account: null, tailnet: null, dnsName: null, canOpenApp: false }, publish: { state: 'no-tailscale', tailnet: null, port: 3333, at: null }, phones: [], port: 3333 };
    const { ctx } = makeCtx({ routes: { [path]: envelope(bare) } });

    const result = await run('remote_access_get', {}, ctx);

    expect(result.data).toMatchObject({ tailscale: { state: 'not-installed' }, phones: [] });
    expect(result.summary).toMatch(/no paired phones/i);
  });

  it('answers UNAVAILABLE, not a failure, where this build of AASC has no remote access page (404, 415 or the app’s page)', async () => {
    for (const answer of [fail(404, 'Not found'), cloudFail(415, 'invalid_request', 'Content-Type must be application/json'), ok(null)]) {
      const { ctx } = makeCtx({ routes: { [path]: answer } });

      const err = await runRefused('remote_access_get', {}, ctx);

      expect(err.code).toBe('UNAVAILABLE');
      expect(err.message).toMatch(/remote access/i);
    }
  });

  it('is open to every central that has the toolset, and changes nothing it reads', async () => {
    const frozen = deepFreeze(JSON.parse(JSON.stringify({ success: true, data: view })));
    const { ctx } = makeCtx({ central: makeCentral('project', '/a/proj'), sessions: [makeSession('s1')], routes: { [path]: ok(frozen) } });

    await expect(run('remote_access_get', {}, ctx)).resolves.toBeDefined();
  });
});
