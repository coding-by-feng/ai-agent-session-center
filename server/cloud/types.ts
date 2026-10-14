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
export interface CloudClient {
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
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}
