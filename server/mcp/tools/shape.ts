// tools/shape.ts — what the Task 9 read tools (queue, rooms, resources, skill notes, saved prompts, history,
// notes, agenda, cloud) share beyond define.ts: reading what a route answered when its shape is only promised,
// cutting a body and fencing it in one step, the offset paging the lists use, and telling a route this build of
// AASC lacks from one that exists.

import { z } from 'zod';
import type { InternalQuery, InternalResponse } from '../client.js';
import { clipText, fence, isRecord, plain } from './define.js';

// ---------------------------------------------------------------------------
// Reading an answer whose shape is only promised
// ---------------------------------------------------------------------------

/** A finite number, else null. */
export const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Text, else null. */
export const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** A count: a finite number rounded to a whole one, never below zero; 0 for anything else. */
export const whole = (v: unknown): number => Math.max(0, Math.round(num(v) ?? 0));

/** The elements of an array, else none. */
export const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** The plain objects among an array's elements. */
export const records = (v: unknown): Array<Record<string, unknown>> => list(v).filter(isRecord);

/** The texts among an array's elements. */
export const strings = (v: unknown): string[] => list(v).filter((x): x is string => typeof x === 'string');

/**
 * An ISO 8601 date or time: `2026-10-01`, `2026-10-24T12:00`, `2026-10-24T12:00:00.5Z`, with an offset or without.
 * `Date.parse` alone is no check: V8 reads any text with a number in it as a date.
 */
export const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * A date a route gave, as it was written when it is an ISO date or time that exists, else null. A field that stays
 * plain in `data` (it is not fenced) may hold nothing but a date, so a hostile text cannot ride in it.
 */
export function isoOrNull(v: unknown): string | null {
  return typeof v === 'string' && ISO_DATE.test(v) && !Number.isNaN(Date.parse(v)) ? v : null;
}

/** An epoch time as an ISO string, or `unknown time` for one a date cannot hold. */
export function isoTime(ms: number | null): string {
  if (ms === null) return 'unknown time';
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? 'unknown time' : date.toISOString();
}

/** A route's query without the parameters nobody gave; undefined when none is left, so a call with none sends none. */
export function queryOf(params: Record<string, string | number | boolean | undefined>): InternalQuery | undefined {
  const given = Object.entries(params).filter(([, value]) => value !== undefined);
  return given.length === 0 ? undefined : Object.fromEntries(given);
}

// ---------------------------------------------------------------------------
// A body another party wrote
// ---------------------------------------------------------------------------

export interface FencedBody {
  /** The text cut to the cap and fenced as untrusted. */
  value: string;
  /** It was longer than the cap. */
  truncated: boolean;
  /** How many characters it had before the cut. */
  length: number;
}

/** `body` cut to `max` characters, then fenced: what `data` carries for free text. */
export function fenced(source: string, kind: string, body: string, max: number): FencedBody {
  const clipped = clipText(body, max);
  return { value: fence(source, kind, clipped.text), truncated: clipped.truncated, length: clipped.length };
}

// ---------------------------------------------------------------------------
// Offset paging
// ---------------------------------------------------------------------------

/** The `cursor` input of a paged list: the `nextCursor` of the page before. */
export const CURSOR_INPUT = z
  .string()
  .regex(/^\d{1,6}$/)
  .optional()
  .describe('The nextCursor of the page before: where this page starts.');

/** A `limit` input: a whole number from 1 to `max`. */
export const limitInput = (max: number, byDefault: number) =>
  z
    .number()
    .int()
    .min(1)
    .max(max)
    .optional()
    .describe(`How many to list, 1 to ${max} (default ${byDefault}).`);

export interface Page {
  start: number;
  end: number;
  /** Where the next page starts, null on the last. */
  next: string | null;
}

/** The slice of a list of `total` that a cursor and a limit ask for. A cursor past the end is an empty page. */
export function pageOf(total: number, cursor: string | undefined, limit: number): Page {
  const start = cursor === undefined ? 0 : Number(cursor);
  const end = Math.min(total, Math.max(start, start + limit));
  return { start, end: Math.max(start, end), next: end < total ? String(end) : null };
}

export interface PageWords {
  /** ` of 12`: how many there were before a filter cut the list; empty when nothing was cut. */
  of: string;
  /** `; showing 101 to 200`; empty when the one page is the whole list. */
  range: string;
  /** ` More: pass cursor="200".`; empty on the last page. */
  more: string;
}

/**
 * The words that follow a paged list's count, the same in every list tool. `found` is what the filters left and `all`
 * the list before them (leave it out when no filter applies). The cursor is a number this server made.
 */
export function pageWords(page: Page, found: number, all: number = found): PageWords {
  return {
    of: found === all ? '' : ` of ${all}`,
    range: page.next === null && page.start === 0 ? '' : `; showing ${page.start + 1} to ${page.end}`,
    more: page.next === null ? '' : ` More: pass cursor="${page.next}".`,
  };
}

/**
 * ` More: pass cursor="…".` for a cursor the cloud (not this server) gave: it is a word in AASC's own sentence, so it
 * is cut and made plain, and whatever it held reaches the central only as characters of an id.
 */
export const cursorHint = (cursor: string | null): string => (cursor === null ? '' : ` More: pass cursor="${plain(cursor, 60)}".`);

// ---------------------------------------------------------------------------
// A route this build does not have
// ---------------------------------------------------------------------------

/**
 * A route that is not in this build of AASC. An unknown `/api` GET does not answer 404: it falls through to the
 * app's own page, a 200 with no JSON (the client reads it as null data); under `/api/resources/cloud` it meets the
 * cloud router's content-type check first (415); a router of its own may answer 404. A tool that wraps a route only
 * some builds have asks this before it reads the answer, and says so instead of reporting a broken AASC.
 */
export function routeMissing(r: InternalResponse<unknown>): boolean {
  if (r.ok) return r.data === null || r.data === undefined;
  return r.status === 404 || r.status === 415;
}
