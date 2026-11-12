/**
 * Typing probe: where does a keystroke's round trip spend its time?
 *
 * Off unless `localStorage['aasc.typingProbe'] === '1'`. One key at a time is
 * sampled (the next is taken only once the last one's echo was painted or gave
 * up), so a burst of typing never stacks samples on the wrong echo.
 *
 *   t0 key sent ──▶ server got it ──▶ first PTY output ──▶ t4 client got it ──▶ t5 painted
 *                   └──── serverMs (the server's own clock) ────┘
 *
 * Every `REPORT_EVERY` samples it prints p50/p95 per step with console.info.
 * Nothing changes how input or output is handled.
 */

export const TYPING_PROBE_KEY = 'aasc.typingProbe';
export const REPORT_EVERY = 20;
/** A sampled key whose echo never came (a password, a key the CLI ignored). */
export const PROBE_GIVE_UP_MS = 2000;
const MAX_SAMPLES = 200;

export function isTypingProbeEnabled(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(TYPING_PROBE_KEY) === '1';
  } catch {
    return false;
  }
}

export interface ProbeSample {
  /** key sent → first output received */
  roundTripMs: number;
  /** server: input received → first PTY output sent (PTY write + the CLI's redraw) */
  serverMs: number | null;
  /** first output received → painted */
  paintMs: number;
}

export interface StepStats {
  p50: number;
  p95: number;
}

export interface ProbeSummary {
  count: number;
  total: StepStats;
  roundTrip: StepStats;
  server: StepStats | null;
  /** round trip minus the server's share: the WebSocket both ways */
  wire: StepStats | null;
  paint: StepStats;
}

export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function stats(values: readonly number[]): StepStats {
  return { p50: round(percentile(values, 50)), p95: round(percentile(values, 95)) };
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

export function summarize(samples: readonly ProbeSample[]): ProbeSummary {
  const withServer = samples.filter((s) => s.serverMs !== null);
  return {
    count: samples.length,
    total: stats(samples.map((s) => s.roundTripMs + s.paintMs)),
    roundTrip: stats(samples.map((s) => s.roundTripMs)),
    server: withServer.length ? stats(withServer.map((s) => s.serverMs as number)) : null,
    wire: withServer.length
      ? stats(withServer.map((s) => Math.max(0, s.roundTripMs - (s.serverMs as number))))
      : null,
    paint: stats(samples.map((s) => s.paintMs)),
  };
}

export function formatSummary(label: string, s: ProbeSummary): string {
  const step = (name: string, v: StepStats | null) => (v ? `${name} ${v.p50}/${v.p95}` : `${name} n/a`);
  return [
    `[typing-probe] ${label} · ${s.count} keys · ms p50/p95`,
    step('total', s.total),
    step('round trip', s.roundTrip),
    step('server+CLI', s.server),
    step('wire', s.wire),
    step('paint', s.paint),
  ].join(' · ');
}

interface Pending {
  id: number;
  sentAt: number;
  serverMs: number | null;
  receivedAt: number | null;
}

export interface TypingProbe {
  /** A key is about to be sent. Returns the probe id to send with it, or null when not sampled. */
  noteKey(now: number): number | null;
  /** The server's measurement for probe `id`. */
  noteServer(id: number, serverMs: number): void;
  /** Output arrived. True when it is the sampled key's first echo (the caller then reports the paint). */
  noteOutput(now: number): boolean;
  /** The echo noted by `noteOutput` was painted. */
  notePainted(now: number): void;
  samples(): readonly ProbeSample[];
}

export function createTypingProbe(
  label: string,
  report: (line: string) => void = (line) => console.info(line),
): TypingProbe {
  let nextId = 1;
  let pending: Pending | null = null;
  const done: ProbeSample[] = [];

  return {
    noteKey(now) {
      if (pending && now - pending.sentAt < PROBE_GIVE_UP_MS) return null;
      pending = { id: nextId++, sentAt: now, serverMs: null, receivedAt: null };
      return pending.id;
    },
    noteServer(id, serverMs) {
      if (pending && pending.id === id) pending = { ...pending, serverMs };
    },
    noteOutput(now) {
      if (!pending || pending.receivedAt !== null) return false;
      if (now - pending.sentAt >= PROBE_GIVE_UP_MS) {
        pending = null;
        return false;
      }
      pending = { ...pending, receivedAt: now };
      return true;
    },
    notePainted(now) {
      if (!pending || pending.receivedAt === null) return;
      done.push({
        roundTripMs: pending.receivedAt - pending.sentAt,
        serverMs: pending.serverMs,
        paintMs: now - pending.receivedAt,
      });
      if (done.length > MAX_SAMPLES) done.shift();
      pending = null;
      if (done.length % REPORT_EVERY === 0) report(formatSummary(label, summarize(done)));
    },
    samples: () => done,
  };
}
