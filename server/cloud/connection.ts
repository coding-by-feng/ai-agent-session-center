import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { createCloudClient, createCloudTransport, normalizeBackendOrigin, isReachableCloudError } from './client.js';
import { readPrivateFile, writePrivateFile } from './secretStore.js';
import { CloudError, type ActiveCloudConnection, type CloudConnector, type CloudConnection, type CloudStatus, type SecretStore } from './types.js';
const nameSchema = z.string().max(128).refine(name => !/[\u0000-\u001f\u007f-\u009f]/u.test(name)).transform(name => name.trim()).pipe(z.string().min(1));
const connectionSchema = z.object({ backendOrigin: z.string(), accountId: z.uuid(), deviceId: z.uuid(), deviceName: nameSchema, generation: z.number().int().positive().safe() }).strict();
const configSchema = z.object({ version: z.literal(1), generation: z.number().int().nonnegative().safe(), connection: connectionSchema.nullable(), secretRef: z.uuid().nullable() }).strict();
const secretSchema = z.object({ version: z.literal(1), secretRef: z.uuid(), connection: connectionSchema, token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();
// Contract v1 is additive: the backend may add fields (device kind, granted scopes) and new
// scope or service names this build does not know yet. Unknown keys are dropped, never fatal.
const scopeNamesSchema = z.array(z.string().max(64)).max(64);
const pairSchema = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/), ownerId: z.uuid(), deviceId: z.uuid(), scopes: scopeNamesSchema.optional() });
const healthSchema = z.object({ status: z.literal('ok'), contractVersion: z.literal(1), ownerId: z.uuid(), deviceId: z.uuid(), services: z.array(z.string().max(64)).max(64).optional(), scopes: scopeNamesSchema.optional() });
const safeError = (error: unknown) => error instanceof CloudError ? error : new CloudError('connection_storage', 'Cloud connection could not be saved. Check private local storage and reconnect.', 503);
export interface CloudConnectionOptions {
  directory: string;
  secrets: SecretStore;
  timeoutMs?: number;
  fetch?: typeof fetch;
}
/** One connector per local server; explicit directories make fixture use independent of hooks/data. */
export async function createCloudConnection(options: CloudConnectionOptions): Promise<CloudConnector> {
  const configPath = join(options.directory, 'connection.json');
  const transport = createCloudTransport(options);
  let active: ActiveCloudConnection | null = null;
  let generation = 0;
  let publishedRef: string | null = null;
  let epoch = 0;
  let transitionEpoch: number | null = null;
  let state: CloudStatus['state'] = 'disconnected';
  let lastError: string | null = null;
  let pending = Promise.resolve();
  let stopped = false;
  const workers = new Set<() => void>();
  const stopWork = () => { transport.abort(); for (const stop of workers) { try { stop(); } catch { /* teardown cannot retain credentials */ } } workers.clear(); };
  const serialize = <T>(work: () => Promise<T>): Promise<T> => {
    const result = pending.then(work); pending = result.then(() => {}, () => {}); return result;
  };
  const publish = async (connection: CloudConnection | null, secretRef: string | null, nextGeneration: number) => {
    await writePrivateFile(configPath, JSON.stringify({ version: 1, generation: nextGeneration, connection, secretRef }));
    generation = nextGeneration;
    publishedRef = secretRef;
  };
  const cancelled = () => new CloudError('cancelled', 'Cloud connection change was cancelled.', 409);
  try {
    const bytes = await readPrivateFile(configPath);
    if (bytes) {
      const saved = configSchema.parse(JSON.parse(bytes.toString('utf8')));
      generation = saved.generation;
      publishedRef = saved.secretRef;
      if (saved.connection) {
        if (!saved.secretRef || saved.connection.generation !== generation || normalizeBackendOrigin(saved.connection.backendOrigin) !== saved.connection.backendOrigin) throw new Error();
        const value = await options.secrets.get(saved.secretRef); if (!value) throw new Error();
        const secret = secretSchema.parse(JSON.parse(value));
        if (secret.secretRef !== saved.secretRef || JSON.stringify(secret.connection) !== JSON.stringify(saved.connection)) throw new Error();
        active = { connection: saved.connection, secretRef: saved.secretRef, token: secret.token };
        // Restored credentials have not yet been checked with the backend. No automatic network request.
        state = 'offline';
      } else if (saved.secretRef !== null) throw new Error();
    }
  } catch (error) {
    active = null; state = 'disconnected';
    lastError = error instanceof CloudError ? error.message : 'Saved cloud credential binding is invalid. Reconnect this device.';
  }
  const client = createCloudClient({
    active: () => {
      if (transitionEpoch !== null) throw new CloudError('connection_changing', 'Cloud connection is changing. Try again when pairing completes.', 409);
      return stopped ? null : active;
    },
    revision: () => epoch, transport, outcome(snapshot, error) {
    if (active !== snapshot || stopped) return;
    if (!error || isReachableCloudError(error)) { state = 'connected'; lastError = null; }
    else if (error.code !== 'invalid_path') { state = error.code === 'revoked' ? 'revoked' : 'offline'; lastError = error.message; if (error.code === 'revoked') stopWork(); }
  } });
  const connector: CloudConnector = {
    client,
    status() { return { connection: active ? { ...active.connection } : null, state: transitionEpoch !== null && active ? 'offline' : state, lastError }; },
    async connectCloud(input) {
      const parsed = z.object({ backendUrl: z.string().max(2048), pairingCode: z.string().regex(/^[A-Za-z0-9_-]{22}$/), deviceName: nameSchema }).strict().safeParse(input);
      if (!parsed.success) throw new CloudError('invalid_input', 'Provide a valid backend URL, pairing code and device name.', 400);
      const origin = normalizeBackendOrigin(parsed.data.backendUrl);
      if (stopped) throw cancelled();
      const currentEpoch = ++epoch;
      transitionEpoch = currentEpoch;
      stopWork();
      let newRef: string | null = null;
      let installed = false;
      try {
        // Refuse unavailable Electron encryption before consuming a pairing code.
        await options.secrets.get('availability-check');
        if (currentEpoch !== epoch || stopped) throw cancelled();
        const data = await transport.send<unknown>(origin, 'POST', '/v1/devices/pair', { code: parsed.data.pairingCode, name: parsed.data.deviceName });
        const paired = pairSchema.safeParse(data);
        if (!paired.success) throw new CloudError('invalid_response', 'Cloud returned an invalid pairing response.');
        return await serialize(async () => {
          if (currentEpoch !== epoch || stopped) throw cancelled();
          const previousRef = active?.secretRef ?? publishedRef;
          const connection: CloudConnection = { backendOrigin: origin, accountId: paired.data.ownerId, deviceId: paired.data.deviceId, deviceName: parsed.data.deviceName, generation: generation + 1 };
          newRef = randomUUID();
          await options.secrets.set(newRef, JSON.stringify({ version: 1, secretRef: newRef, connection, token: paired.data.token }));
          if (currentEpoch !== epoch || stopped) throw cancelled();
          stopWork();
          await publish(connection, newRef, connection.generation);
          if (currentEpoch !== epoch || stopped) throw cancelled();
          stopWork();
          active = { connection, secretRef: newRef, token: paired.data.token };
          installed = true; state = 'connected'; lastError = null;
          // A stale isolated secret is unusable without its matching published ref.
          if (previousRef) await options.secrets.remove(previousRef).catch(() => {});
          return { ...connection };
        });
      } catch (error) {
        if (newRef && !installed) await options.secrets.remove(newRef).catch(() => {});
        const safe = safeError(error);
        if (currentEpoch === epoch && !stopped) { lastError = safe.message; if (!active) state = 'disconnected'; }
        throw safe;
      } finally {
        if (transitionEpoch === currentEpoch) transitionEpoch = null;
      }
    },
    async recheckCloud() {
      const snapshot = active;
      if (!snapshot || stopped) throw new CloudError('disconnected', 'Cloud is disconnected.', 409);
      const revision = epoch;
      const result = await client.request<unknown>('GET', '/v1/health');
      if (active !== snapshot || revision !== epoch || stopped) throw cancelled();
      const health = healthSchema.safeParse(result);
      if (!health.success || health.data.ownerId !== snapshot.connection.accountId || health.data.deviceId !== snapshot.connection.deviceId) {
        const error = new CloudError('invalid_response', 'Cloud health identity does not match the saved connection.');
        if (active === snapshot && !stopped) { state = 'offline'; lastError = error.message; }
        throw error;
      }
      return connector.status();
    },
    async disconnectCloud() {
      ++epoch; transitionEpoch = null; stopWork();
      const previousRef = active?.secretRef ?? publishedRef; active = null; state = 'disconnected'; lastError = null;
      try {
        await serialize(async () => {
          try { await publish(null, null, generation + 1); }
          finally { if (previousRef) await options.secrets.remove(previousRef); }
        });
      } catch (error) { const safe = safeError(error); lastError = safe.message; throw safe; }
    },
    async revokeDevice() {
      const snapshot = active;
      if (!snapshot || stopped) throw new CloudError('disconnected', 'Cloud is disconnected.', 409);
      const result = await client.request<{ revoked: boolean }>('DELETE', `/v1/devices/${snapshot.connection.deviceId}`);
      if (result?.revoked !== true) throw new CloudError('invalid_response', 'Cloud did not confirm device revocation.');
      if (active === snapshot) { stopWork(); state = 'revoked'; lastError = 'This device was revoked. Reconnect to use cloud services.'; }
    },
    async stop() { stopped = true; ++epoch; stopWork(); await pending; },
    onStop(worker) { workers.add(worker); return () => workers.delete(worker); },
  };
  return connector;
}
