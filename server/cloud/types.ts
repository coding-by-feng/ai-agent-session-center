import type { CloudConnection, CloudStatus } from '../../src/types/cloud.js';
export type { CloudConnection, CloudStatus };
export interface SecretStore {
  set(key: string, value: string): Promise<void>;
  get(key: string): Promise<string | null>;
  remove(key: string): Promise<void>;
}
/** Structural Electron boundary: server code never imports Electron. */
export interface SecretEncryption {
  isAvailable(): boolean;
  encrypt(value: string): Buffer;
  decrypt(value: Buffer): string;
}
export interface ActiveCloudConnection {
  connection: CloudConnection;
  token: string;
  secretRef: string;
}
export type CloudBinaryConsumer = (body: ReadableStream<Uint8Array>) => Promise<void>;
export interface CloudClient {
  /** GET a binary body (resource package files) and hand it to `consume`; same allow-list as request. */
  stream?(servicePath: string, consume: CloudBinaryConsumer, signal?: AbortSignal): Promise<void>;
  request<T>(method: string, servicePath: string, body?: unknown, signal?: AbortSignal): Promise<T>;
}
export interface CloudConnector {
  client: CloudClient;
  status(): CloudStatus;
  connectCloud(input: {
    backendUrl: string;
    pairingCode: string;
    deviceName: string;
  }): Promise<CloudConnection>;
  recheckCloud(): Promise<CloudStatus>;
  disconnectCloud(): Promise<void>;
  revokeDevice(): Promise<void>;
  /** Stop requests/workers at process shutdown without forgetting the saved connection. */
  stop(): Promise<void>;
  /** Future sync workers must register teardown here; identity transitions stop them. */
  onStop(worker: () => void): () => void;
}
export class CloudError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 502,
    /** Validated resource conflict details (version_conflict / version_in_use) only. */
    readonly details?: import('../../src/types/cloudResources.js').ResourceErrorDetails,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}
