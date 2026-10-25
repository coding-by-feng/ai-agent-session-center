// apiBody.ts — reading what an /api route answered, for the code that calls routes through the internal client
// (projectIndex.ts, routeScore.ts, router.ts) and must not trust the shape of what comes back. A route answers
// `{ success, data }`, `{ ok, data }` or a bare value (client.ts hands the body over whole); a row that is not what the
// route promises is dropped, never the whole answer.

import type { z } from 'zod';
import type { InternalResponse } from './client.js';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The body of a 2xx answer with its `{ success, data }` / `{ ok, data }` envelope taken off; null for a failed call. */
export function bodyOf(response: InternalResponse<unknown>): unknown {
  if (!response.ok) return null;
  const body = response.data;
  return isRecord(body) && 'data' in body ? body.data : body;
}

/** The rows of `list` that match `schema`, in order. Anything that is not a list has no rows. */
export function rowsOf<S extends z.ZodType>(list: unknown, schema: S): Array<z.output<S>> {
  if (!Array.isArray(list)) return [];
  return list.flatMap((row) => {
    const parsed = schema.safeParse(row);
    return parsed.success ? [parsed.data] : [];
  });
}
