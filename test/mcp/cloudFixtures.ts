// test/mcp/cloudFixtures.ts — what the cloud tool tests (tools.cloud, tools.cloudProjects) share: a connection, the
// headers a bound read must carry, and the routes of a connected Mac.
import type { InternalResponse } from '../../server/mcp/client.js';
import type { Answer } from './toolHarness.js';
import { envelope } from './toolHarness.js';

export const ACCOUNT = '0b1f6d5e-3c1a-4a52-8c8e-2f6a4f0f9a11';
export const DEVICE = '7a9c1e44-0d2b-4f6a-9b7e-5c3d2a1b0f99';
export const PROJECT_ID = '3f2b8c1d-6a4e-4d7f-8b2a-9e1c0d5f7a63';
export const RESOURCE_ID = 'c4d5e6f7-1a2b-4c3d-8e9f-0a1b2c3d4e5f';
export const BACKEND = 'https://api.example.test';

export const CONNECTION = { backendOrigin: BACKEND, accountId: ACCOUNT, deviceId: DEVICE, deviceName: 'Studio Mac', generation: 3 };

/** The headers a bound cloud read must send, as the dashboard's own client sends them. */
export const CLOUD_HEADERS = {
  'x-aasc-cloud-backend': BACKEND,
  'x-aasc-cloud-account': ACCOUNT,
  'x-aasc-cloud-generation': '3',
};

/** The headers the notes and alias routes read instead. */
export const NOTES_HEADERS = {
  'x-aasc-notes-backend': BACKEND,
  'x-aasc-notes-account': ACCOUNT,
  'x-aasc-notes-generation': '3',
};

export const STATUS_PATH = 'GET /resources/cloud/status';

/** The status route of a Mac that is connected. */
export const connectedStatus: Answer = envelope({ connection: CONNECTION, state: 'connected', lastError: null });

/** The status route of a Mac that is not signed in to AASC Cloud. */
export const disconnectedStatus: Answer = envelope({ connection: null, state: 'disconnected', lastError: null });

/** The call every bound cloud read makes first, to learn the connection it must name. */
export const statusCall = { method: 'GET', path: '/resources/cloud/status' };

/** A second account on the same backend (P6): what a reconnect as someone else, or another sign-in, looks like. */
export const ACCOUNT_B = '5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b';
export const CONNECTION_B = { ...CONNECTION, accountId: ACCOUNT_B, accountEmail: 'other@example.test', generation: 4 };

/** The headers a call made as account B carries. */
export const CLOUD_HEADERS_B = {
  'x-aasc-cloud-backend': BACKEND,
  'x-aasc-cloud-account': ACCOUNT_B,
  'x-aasc-cloud-generation': '4',
};

/**
 * A failed cloud call as the loopback client reports it: the cloud routers answer `{ success: false, error: { code,
 * message } }`, an object the client cannot read a message from, so its own `error` says only `HTTP <status>`.
 */
export const cloudFail = (status: number, code: string, message: string): InternalResponse<unknown> => ({
  ok: false,
  status,
  data: { success: false, error: { code, message } },
  error: `HTTP ${status}`,
});
