// Oct 29 2026: a saved project's ♥ and tags live beside its record in AASC Cloud
// (`/v1/projects/meta`). The relay pages the list, reads an older backend as "unavailable",
// and sends each change as one normalized operation with a fresh mutation id.
import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createProjectMeta } from '../server/cloud/projectMeta.js';
import { CloudError, type CloudConnector } from '../server/cloud/types.js';

const binding = { backendOrigin: 'https://cloud.example', accountId: randomUUID(), generation: 1 };
const projectId = randomUUID();
const meta = (over: object = {}) => ({
  projectId,
  version: 1,
  favorite: false,
  tags: [] as string[],
  ...over,
});

function fakeCloud(answer: (method: string, path: string, body?: unknown) => unknown) {
  let current = { ...binding };
  const request = vi.fn(async (method: string, path: string, body?: unknown) =>
    answer(method, path, body),
  );
  const cloud = {
    status: () => ({ state: 'connected', connection: current, lastError: null }),
    onStop: () => () => {},
    client: { request },
  } as unknown as CloudConnector;
  return {
    cloud,
    request,
    switchAccount() {
      current = { ...current, accountId: randomUUID() };
    },
  };
}

describe('project meta list', () => {
  it('pages through the cloud list with limit 100', async () => {
    const second = randomUUID();
    const f = fakeCloud((_m, path) =>
      path.includes('cursor=')
        ? { items: [meta({ projectId: second, favorite: true })], nextCursor: null }
        : { items: [meta({ tags: ['work'] })], nextCursor: projectId },
    );
    const list = await createProjectMeta(f.cloud).list(binding);
    expect(list).toEqual({
      available: true,
      items: [meta({ tags: ['work'] }), meta({ projectId: second, favorite: true })],
    });
    expect(f.request.mock.calls.map((c) => c[1])).toEqual([
      '/v1/projects/meta?limit=100',
      `/v1/projects/meta?limit=100&cursor=${projectId}`,
    ]);
  });

  it('reads an AASC Cloud without the meta routes as unavailable, not as an error', async () => {
    const f = fakeCloud(() => {
      throw new CloudError('not_found', 'Cloud resource was not found.', 404);
    });
    expect(await createProjectMeta(f.cloud).list(binding)).toEqual({ available: false, items: [] });
  });

  it('refuses a cursor that repeats and any other failure', async () => {
    const loop = fakeCloud(() => ({ items: [], nextCursor: projectId }));
    await expect(createProjectMeta(loop.cloud).list(binding)).rejects.toMatchObject({
      code: 'invalid_response',
    });
    const down = fakeCloud(() => {
      throw new CloudError('offline', 'Cloud is offline.', 503);
    });
    await expect(createProjectMeta(down.cloud).list(binding)).rejects.toMatchObject({
      code: 'offline',
    });
  });

  it('never answers for another account', async () => {
    const f = fakeCloud(() => ({ items: [meta()], nextCursor: null }));
    f.switchAccount();
    await expect(createProjectMeta(f.cloud).list(binding)).rejects.toMatchObject({
      code: 'connection_changed',
    });
    expect(f.request).not.toHaveBeenCalled();
  });
});

describe('project meta change', () => {
  it('sends one operation: normalized, sorted, unique tags and a fresh mutation id', async () => {
    const f = fakeCloud((_m, _p, body) => meta({ version: 2, tags: ['ops', 'work-stuff'] }));
    const answer = await createProjectMeta(f.cloud).change(
      projectId,
      { addTags: ['  Work Stuff ', 'OPS', 'ops'] },
      binding,
    );
    expect(answer).toEqual(meta({ version: 2, tags: ['ops', 'work-stuff'] }));
    const [method, path, body] = f.request.mock.calls[0];
    expect([method, path]).toEqual(['POST', `/v1/projects/${projectId}/meta`]);
    expect(body).toEqual({ mutationId: expect.any(String), addTags: ['ops', 'work-stuff'] });
  });

  it('sends only the fields that change', async () => {
    const f = fakeCloud(() => meta({ favorite: true }));
    await createProjectMeta(f.cloud).change(projectId, { favorite: true }, binding);
    expect(f.request.mock.calls[0][2]).toEqual({ mutationId: expect.any(String), favorite: true });
  });

  it('refuses an empty change, a tag with nothing left, and one tag both added and removed', async () => {
    const f = fakeCloud(() => meta());
    const service = createProjectMeta(f.cloud);
    await expect(service.change(projectId, {}, binding)).rejects.toThrow();
    await expect(service.change(projectId, { addTags: ['!!!'] }, binding)).rejects.toMatchObject({
      code: 'invalid_request',
    });
    await expect(
      service.change(projectId, { addTags: ['Work'], removeTags: ['work'] }, binding),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(
      service.change(projectId, { favorite: true, path: '/etc' }, binding),
    ).rejects.toThrow();
    expect(f.request).not.toHaveBeenCalled();
  });

  it('refuses an acknowledgment for another project', async () => {
    const f = fakeCloud(() => meta({ projectId: randomUUID() }));
    await expect(
      createProjectMeta(f.cloud).change(projectId, { favorite: true }, binding),
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('refuses a project id that is not a UUID before any request', async () => {
    const f = fakeCloud(() => meta());
    await expect(
      createProjectMeta(f.cloud).change('../../v1/devices', { favorite: true }, binding),
    ).rejects.toThrow();
    expect(f.request).not.toHaveBeenCalled();
  });
});
