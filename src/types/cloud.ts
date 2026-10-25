/** Public metadata only. Device tokens never cross the local server boundary. */
export interface CloudConnection {
  backendOrigin: string;
  accountId: string;
  deviceId: string;
  deviceName: string;
  generation: number;
  /** The Google address of the account, when this Mac joined it with Google sign-in (AASC-61). */
  accountEmail?: string;
}
/** What the Connection form starts with (GET /api/resources/cloud/defaults). */
export interface CloudDefaults {
  backendUrl: string;
  deviceName: string;
}

export interface CloudStatus {
  connection: CloudConnection | null;
  state: 'disconnected' | 'connected' | 'offline' | 'revoked';
  lastError: string | null;
}
