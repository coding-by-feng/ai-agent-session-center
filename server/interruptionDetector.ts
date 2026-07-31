/**
 * @module interruptionDetector
 * Recognises a *transient* failure banner in a terminal's PTY output — the
 * `API Error: 529 Overloaded`, rate-limit, and connection-error messages the AI
 * CLIs print when a turn dies for reasons that have nothing to do with the task.
 *
 * **Why this has to read the bytes at all.** The hook stream carries no error
 * payload: a turn that 529s still ends with `Stop`, so the session lands in
 * `waiting` — byte-for-byte the same state a *successful* turn produces. The
 * error exists only in the PTY output, which is why detection lives here and
 * not in the hook processor.
 *
 * **Edge-triggered on purpose.** The banner sits in scrollback for as long as
 * the screen holds it, so a level-triggered check (`tail contains /529/`) keeps
 * re-reporting the same dead turn forever — the exact trap `isAgentBusyOutput`
 * documents for the busy spinner. Two guards make this edge-triggered:
 *   1. only the INCOMING chunk (plus a small carry for split banners) is
 *      scanned, and the carry is dropped the moment a fault is reported;
 *   2. an identical banner within `DEDUPE_MS` is suppressed, so a full-screen
 *      TUI redraw cannot re-fire a fault that was already reported.
 */
import { stripAnsi } from '../src/lib/ansi.js';

export type FaultKind = 'api_error' | 'rate_limit' | 'network';

export interface FaultMatch {
  kind: FaultKind;
  /** The matched line, trimmed — surfaced verbatim in the UI badge. */
  line: string;
}

/**
 * Longest line still considered a status banner. The CLIs render these into a
 * 120-column PTY, so a real banner wraps well below this; anything longer is
 * prose (a file being catted, the agent quoting a log) and is skipped.
 */
const MAX_FAULT_LINE = 200;

/** Bytes carried between chunks so a banner split across a read still matches. */
const CARRY_BYTES = 512;

/** Never regex more than this per chunk — a `cat` of a huge file is not a banner. */
const MAX_SCAN_BYTES = 8192;

/** An identical banner inside this window is a redraw, not a second fault. */
const DEDUPE_MS = 60_000;

/**
 * Ordered most-specific first: `rate_limit` is checked before `api_error` so a
 * 429 that also says "API Error" is classified by its cause, not its shape.
 */
const FAULT_PATTERNS: ReadonlyArray<{ kind: FaultKind; re: RegExp }> = [
  {
    kind: 'rate_limit',
    re: /\b(?:rate[ _-]?limit(?:ed|ing)?|too many requests|API Error:?\s*429|usage limit reached)\b/i,
  },
  {
    kind: 'api_error',
    re: /\bAPI Error:?\s*5\d\d\b|\boverloaded\b|\binternal server error\b|\bservice unavailable\b/i,
  },
  {
    kind: 'network',
    re: /\b(?:connection error|connection reset|connection refused|fetch failed|socket hang up|network error|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN)\b/i,
  },
];

/**
 * Scan `text` for a fault banner and return the LAST (most recent) match.
 * Pure — the whole classification surface is testable without a PTY.
 */
export function matchFault(text: string | null | undefined): FaultMatch | null {
  if (!text) return null;
  const scanned = text.length > MAX_SCAN_BYTES ? text.slice(-MAX_SCAN_BYTES) : text;
  const lines = stripAnsi(scanned).split(/\r?\n/);
  // Walk backwards: the newest banner wins when a chunk holds several.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line || line.length > MAX_FAULT_LINE) continue;
    for (const { kind, re } of FAULT_PATTERNS) {
      if (re.test(line)) return { kind, line };
    }
  }
  return null;
}

interface DetectorState {
  /** Tail of the previous chunk, so a banner split across reads still matches. */
  carry: string;
  /** `kind:line` of the last REPORTED fault — the redraw dedupe key. */
  lastSig: string;
  lastAt: number;
}

/** terminalId -> per-terminal scan state */
const states = new Map<string, DetectorState>();

/**
 * Feed one PTY chunk through the detector. Returns a `FaultMatch` only on the
 * *edge* — the tick a new banner appears — and `null` on every other chunk,
 * including re-renders of a banner already reported.
 *
 * Cheap by construction: a handful of regexes over at most `MAX_SCAN_BYTES`,
 * no I/O and no process probing, so it is safe to call from the `onData` hot
 * path (cf. the "never call a process probe synchronously" invariant).
 */
export function scanChunk(
  terminalId: string,
  chunk: string,
  now: number = Date.now(),
): FaultMatch | null {
  if (!chunk) return null;
  const prev = states.get(terminalId);
  const carry = prev?.carry ?? '';
  const text = carry + chunk;

  const match = matchFault(text);
  if (!match) {
    states.set(terminalId, {
      carry: text.slice(-CARRY_BYTES),
      lastSig: prev?.lastSig ?? '',
      lastAt: prev?.lastAt ?? 0,
    });
    return null;
  }

  const sig = `${match.kind}:${match.line}`;
  if (prev && sig === prev.lastSig && now - prev.lastAt < DEDUPE_MS) {
    // Same banner still on screen (or redrawn) — not a new fault.
    states.set(terminalId, { carry: text.slice(-CARRY_BYTES), lastSig: sig, lastAt: prev.lastAt });
    return null;
  }

  // Drop the carry on report: otherwise this same banner is re-scanned on the
  // next chunk and re-fires the moment the dedupe window lapses.
  states.set(terminalId, { carry: '', lastSig: sig, lastAt: now });
  return match;
}

/** Forget a terminal's scan state. Call on terminal close. */
export function clearFaultState(terminalId: string): void {
  states.delete(terminalId);
}

/** Test-only: wipe all detector state between cases. */
export function resetFaultStates(): void {
  states.clear();
}
