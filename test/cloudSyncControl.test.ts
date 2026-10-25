// The routes "Stop syncing" and "Remove from cloud" need (Oct 23 2026): the one backend DELETE this
// Mac may send for resources, and the strict request body of POST /sync-control.
import { describe, expect, it } from 'vitest';
import { allowedCloudRoute } from '../server/cloud/client.js';
import { SyncControlRequestSchema, SyncRequestSchema } from '../src/types/cloudResources.js';

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

describe('the cloud route allow-list for removing a resource', () => {
  it('allows DELETE of one exact resource version, and nothing wider', () => {
    expect(allowedCloudRoute('DELETE', `/v1/resources/${ID}/versions/3`)).toBe(true);
    expect(allowedCloudRoute('DELETE', `/v1/resources/${ID}`)).toBe(false);
    expect(allowedCloudRoute('DELETE', `/v1/resources/${ID}/versions/0`)).toBe(false);
    expect(allowedCloudRoute('DELETE', `/v1/resources/${ID}/versions/3/files/${'a'.repeat(64)}`)).toBe(false);
    expect(allowedCloudRoute('DELETE', '/v1/resources/not-a-uuid/versions/3')).toBe(false);
    expect(allowedCloudRoute('POST', `/v1/resources/${ID}/versions/3`)).toBe(false);
  });
});

describe('POST /sync-control and Sync now bodies', () => {
  it('takes one resource and one of stop, resume or remove', () => {
    for (const action of ['stop', 'resume', 'remove'])
      expect(SyncControlRequestSchema.parse({ resourceId: ID, action })).toEqual({ resourceId: ID, action });
    expect(() => SyncControlRequestSchema.parse({ resourceId: ID, action: 'delete' })).toThrow();
    expect(() => SyncControlRequestSchema.parse({ resourceId: 'x', action: 'stop' })).toThrow();
    expect(() => SyncControlRequestSchema.parse({ resourceId: ID, action: 'stop', extra: 1 })).toThrow();
  });

  it('Sync now accepts `only`, a list of cloud ids', () => {
    expect(SyncRequestSchema.parse({ only: [ID] })).toEqual({ only: [ID] });
    expect(() => SyncRequestSchema.parse({ only: ['x'] })).toThrow();
  });
});
