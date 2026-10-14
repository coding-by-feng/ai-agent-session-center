/** Public metadata only. Device tokens never cross the local server boundary. */
export interface CloudConnection {
  backendOrigin: string;
  accountId: string;
  deviceId: string;
  deviceName: string;
  generation: number;
}
export interface CloudStatus {
  connection: CloudConnection | null;
  state: 'disconnected' | 'connected' | 'offline' | 'revoked';
  lastError: string | null;
}
