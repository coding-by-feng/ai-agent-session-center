/** Project Sync errors: a SyncError's message is meant for the user; anything else is logged. */
import { redactSecretsInString } from '../resourceMask.js';

export class SyncError extends Error {
  constructor(
    message: string,
    readonly status = 409,
    readonly code?: string,
  ) {
    super(message);
  }
}

/** An error's message, safe to keep on a run or show: secrets redacted, length capped. */
export const clean = (e: unknown) =>
  redactSecretsInString(e instanceof Error ? e.message : 'Project sync failed.').slice(0, 500);
