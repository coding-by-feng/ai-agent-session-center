import { isAbsolute } from 'node:path';

export interface HostedConfig {
  orderId: string;
  websiteOrigin: string;
  runtimeOrigin: string;
  launchKey: string;
  dataDir: string;
}
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEYS = [
  'AASC_HOSTED_ORDER_ID',
  'AASC_HOSTED_WEBSITE_ORIGIN',
  'AASC_HOSTED_RUNTIME_ORIGIN',
  'AASC_HOSTED_LAUNCH_KEY',
] as const;
function httpsOrigin(raw: string | undefined): string {
  if (!raw) throw new Error('Hosted origins must be exact HTTPS origins');
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.origin !== raw || url.username || url.password)
    throw new Error('Hosted origins must be exact HTTPS origins');
  return raw;
}
/** No implicit hosted mode or shared data directory. Partial configuration is fatal. */
export function loadHostedConfig(env: NodeJS.ProcessEnv): HostedConfig | null {
  if (!KEYS.some((key) => env[key] !== undefined)) return null;
  if (KEYS.some((key) => !env[key])) throw new Error('Incomplete hosted configuration');
  if (!UUID.test(env.AASC_HOSTED_ORDER_ID!) || !/^[0-9a-f]{64}$/.test(env.AASC_HOSTED_LAUNCH_KEY!))
    throw new Error('Invalid hosted order/key');
  if (!env.APP_USER_DATA || !isAbsolute(env.APP_USER_DATA))
    throw new Error('Hosted mode requires an absolute, isolated APP_USER_DATA directory');
  const websiteOrigin = httpsOrigin(env.AASC_HOSTED_WEBSITE_ORIGIN);
  const runtimeOrigin = httpsOrigin(env.AASC_HOSTED_RUNTIME_ORIGIN);
  if (websiteOrigin !== 'https://xclaude.dev' || runtimeOrigin === websiteOrigin)
    throw new Error('Invalid hosted issuer/runtime origins');
  return {
    orderId: env.AASC_HOSTED_ORDER_ID!,
    websiteOrigin,
    runtimeOrigin,
    launchKey: env.AASC_HOSTED_LAUNCH_KEY!,
    dataDir: env.APP_USER_DATA,
  };
}
export function getHostedConfig(): HostedConfig | null {
  return loadHostedConfig(process.env);
}
