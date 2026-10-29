import type { Request } from 'express';
import type { z } from 'zod';
import { NotesStatusSchema } from '../../src/types/skillNotesSync.js';
import { CloudError, type CloudConnector } from './types.js';
/** The (backend, account, generation) a browser reviewed; any change invalidates its action. */
export const CloudBindingSchema = NotesStatusSchema.shape.connection.unwrap();
export type CloudBinding = z.infer<typeof CloudBindingSchema>;
/** One account on one backend, across connection generations (job and project ownership). */
export function accountKey(binding: CloudBinding): string {
  return JSON.stringify([binding.backendOrigin, binding.accountId]);
}
export function assertCloudBinding(cloud: CloudConnector, input: CloudBinding): CloudBinding {
  const parsed = CloudBindingSchema.safeParse(input),
    current = cloud.status().connection;
  if (
    !parsed.success ||
    !current ||
    current.backendOrigin !== parsed.data.backendOrigin ||
    current.accountId !== parsed.data.accountId ||
    current.generation !== parsed.data.generation
  )
    throw new CloudError(
      'connection_changed',
      'The cloud connection changed. Refresh and review this action again.',
      409,
    );
  return parsed.data;
}
export function bindingFromHeaders(req: Request): CloudBinding {
  const generation = req.get('x-aasc-cloud-generation');
  if (!generation || !/^(0|[1-9][0-9]{0,15})$/.test(generation))
    throw new CloudError(
      'connection_changed',
      'A current cloud connection review is required.',
      409,
    );
  const parsed = CloudBindingSchema.safeParse({
    backendOrigin: req.get('x-aasc-cloud-backend'),
    accountId: req.get('x-aasc-cloud-account'),
    generation: Number(generation),
  });
  if (!parsed.success)
    throw new CloudError(
      'connection_changed',
      'A current cloud connection review is required.',
      409,
    );
  return parsed.data;
}
/**
 * A read that also answers with no connection (Projects lists this Mac's folders, Oct 29 2026):
 * no binding header at all is `null`; any one of them and all are checked as above.
 */
export function optionalBindingFromHeaders(req: Request): CloudBinding | null {
  const named = ['x-aasc-cloud-backend', 'x-aasc-cloud-account', 'x-aasc-cloud-generation'].some(
    (h) => req.get(h) !== undefined,
  );
  return named ? bindingFromHeaders(req) : null;
}
export const abortCheck = (signal: AbortSignal) => {
  if (signal.aborted) throw new CloudError('cancelled', 'Cloud job cancelled.', 409);
};
export type RetryDelay = (ms: number, signal: AbortSignal) => Promise<void>;
const delay: RetryDelay = (ms, signal) =>
  new Promise((resolve, reject) => {
    abortCheck(signal);
    const stop = () => {
      clearTimeout(timer);
      reject(new CloudError('cancelled', 'Cloud job cancelled.', 409));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', stop);
      resolve();
    }, ms);
    signal.addEventListener('abort', stop, { once: true });
  });
/** Stable caller-owned mutation/upload IDs; only a validated 429 can repeat an operation. */
export async function retryRateLimit<T>(
  operation: () => Promise<T>,
  check: () => void,
  signal: AbortSignal,
  wait: RetryDelay = delay,
): Promise<T> {
  let elapsed = 0;
  for (let attempt = 0; ; attempt++) {
    abortCheck(signal);
    check();
    try {
      const value = await operation();
      check();
      abortCheck(signal);
      return value;
    } catch (error) {
      if (!(error instanceof CloudError) || error.code !== 'rate_limited' || attempt >= 5)
        throw error;
      const ms = error.retryAfterMs ?? 1000;
      if (ms < 1 || ms > 120000 || elapsed + ms > 300000) throw error;
      elapsed += ms;
      check();
      await wait(ms, signal);
    }
  }
}
