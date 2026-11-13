import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HostedConfig } from './hostedConfig.js';

export interface HostedIdentity {
  sub: string;
  ownerEpoch: number;
  accessMode: 'verify' | 'use' | 'admin';
  adminGrant?: string;
}
const positive = new Map<string, number>();
/** Opaque subject is private durable authority state, never sent to browser code. */
export function currentHostedOwner(config: HostedConfig): HostedIdentity | null {
  try {
    if (readFileSync(join(config.dataDir, 'hosted-launch', 'order'), 'utf8') !== config.orderId)
      return null;
    const value = JSON.parse(
      readFileSync(join(config.dataDir, 'hosted-launch', 'principal'), 'utf8'),
    );
    return value.orderId === config.orderId &&
      typeof value.subject === 'string' &&
      value.subject.length > 0 &&
      Number.isSafeInteger(value.epoch) &&
      value.epoch >= 0 &&
      (value.accessMode === 'verify' || value.accessMode === 'use')
      ? { sub: value.subject, ownerEpoch: value.epoch, accessMode: value.accessMode }
      : null;
  } catch {
    return null;
  }
}
/** Signed server-to-server authority check. No cookies/credentials from customer requests are forwarded. */
export async function authorizeHosted(
  config: HostedConfig,
  identity: HostedIdentity | null,
  fresh = false,
): Promise<boolean> {
  if (
    !identity ||
    !['verify', 'use', 'admin'].includes(identity.accessMode) ||
    (identity.accessMode === 'admin' && !/^[0-9a-f-]{36}$/.test(identity.adminGrant ?? ''))
  )
    return false;
  const key = `${config.dataDir}:${config.orderId}:${identity.sub}:${identity.ownerEpoch}:${identity.accessMode}:${identity.adminGrant ?? ''}`;
  if (!fresh && (positive.get(key) ?? 0) > Date.now()) return true;
  const checkedAt = Date.now();
  const now = Math.floor(checkedAt / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(
    JSON.stringify({
      iss: config.runtimeOrigin,
      aud: config.websiteOrigin,
      orderId: config.orderId,
      sub: identity.sub,
      ownerEpoch: identity.ownerEpoch,
      accessMode: identity.accessMode,
      ...(identity.accessMode === 'admin' ? { adminGrant: identity.adminGrant } : {}),
      purpose: 'authorize',
      iat: now,
      exp: now + 30,
    }),
  ).toString('base64url');
  const signature = createHmac('sha256', config.launchKey)
    .update(`${header}.${body}`)
    .digest('base64url');
  try {
    const response = await fetch(`${config.websiteOrigin}/api/runtime/authorize`, {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assertion: `${header}.${body}.${signature}` }),
      signal: AbortSignal.timeout(5000),
    });
    const result = await response.json();
    if (response.ok && result.authorized === true) {
      positive.set(key, checkedAt + 20_000);
      return true;
    }
  } catch {
    /* Network failure or malformed responses fail closed. */
  }
  positive.delete(key);
  return false;
}
