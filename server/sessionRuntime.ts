/**
 * @module sessionRuntime
 * The model and effort a Claude session is running with RIGHT NOW, as Claude Code
 * itself reports them — not what the dashboard launched it with.
 *
 * Two reports, merged per field, newest first:
 *
 * - **Status line** (`hooks/dashboard-statusline.sh` → `<queue>/runtime/<sid>.json`):
 *   `model` and `effort.level`, the live values — including the level Claude restores
 *   for a model after a switch. But the status line only re-runs on a reply, `/compact`
 *   and a few other triggers; `/model` and `/effort` are not among them.
 * - **Transcript**: `/model` and `/effort` write a `system`/`local_command` line the
 *   moment they run ("Set model to `Opus 5.5` …", "Set effort level to max …"), and
 *   every reply carries the ID of the model that answered it.
 *
 * Effort is saved per model, so a model switch makes the last effort reading wrong:
 * a switch with no effort of its own clears it until the status line says what it is.
 *
 * The status line also carries how full the context window is (`context`): status-line
 * only, newest wins, and `null` (no reply yet, or just after `/clear`) clears it.
 *
 * Codex has no status-line tap; its rollout file writes a `turn_context` line (model +
 * effort) at the start of every turn, and the same fold reads it. Its `token_count`
 * events carry the context window too (`last_token_usage` of `model_context_window`).
 *
 * The values also become the session's launch flags ({@link launchFlagsFromRuntime}),
 * so every resume relaunches with the model and effort the session last ran on.
 */
import type { SessionContextParts, SessionContextUsage, SessionRuntime } from '../src/types/session.js';
import { modelFlagFromLabel, modelLabelKey } from '../src/lib/modelLabel.js';

/** One source's view. `effort: null` = known to be unknown (cleared at `effortAt`). */
export interface RuntimeReading {
  model?: string;
  modelAt?: number;
  /** A model the user chose, as a valid `--model` value (see {@link SessionRuntime}). */
  launchModel?: string;
  launchModelAt?: number;
  effort?: string | null;
  effortAt?: number;
  /** `effort` came from an explicit `/effort`. */
  effortSet?: boolean;
  /** `null` = known to be unknown (no usage reported at `contextAt`). */
  context?: SessionContextUsage | null;
  contextAt?: number;
}

/** A label from a file or a payload is bounded before it reaches every browser. */
const MAX_LABEL_CHARS = 80;
const EFFORT_RE = /^[a-z]{2,16}$/;
const SET_MODEL_RE = /Set model to `([^`]{1,200})`/;
const SET_EFFORT_RE = /Set effort level to ([a-z]{2,16})\b/;

const clip = (s: string): string => s.slice(0, MAX_LABEL_CHARS);

interface TranscriptLine {
  type?: unknown;
  subtype?: unknown;
  isSidechain?: unknown;
  timestamp?: unknown;
  content?: unknown;
  commandRun?: { command?: unknown; args?: unknown } | null;
  message?: { model?: unknown } | null;
  /** Codex rollouts: `{ type: 'turn_context', payload: { model, effort } }`, and
   *  `{ type: 'event_msg', payload: { type: 'token_count', info } }`. */
  payload?: { model?: unknown; effort?: unknown; type?: unknown; info?: unknown } | null;
}

function parseLine(line: string): TranscriptLine | null {
  if (!line || line.charCodeAt(0) !== 123 /* { */) return null;
  try {
    const value: unknown = JSON.parse(line);
    return value && typeof value === 'object' ? (value as TranscriptLine) : null;
  } catch {
    return null;
  }
}

/** Fold a transcript tail (oldest line first) into one reading. */
export function readingFromTranscript(lines: readonly string[]): RuntimeReading {
  let model: string | undefined;
  let modelAt: number | undefined;
  let effort: string | null | undefined;
  let effortAt: number | undefined;
  let effortSet = false;
  let launchModel: string | undefined;
  let launchModelAt: number | undefined;
  let context: SessionContextUsage | undefined;
  let contextAt: number | undefined;
  // A `/model` menu pick prints only a display name; the next reply names the model.
  let awaitingPickedModel = false;

  const setLaunchModel = (next: string | undefined, when: number): void => {
    if (next === undefined) return;
    launchModel = next;
    launchModelAt = when;
  };

  const setModel = (next: string, when: number): void => {
    // A different model than the one on record: its own saved effort applies now.
    if (model !== undefined && modelLabelKey(model) !== modelLabelKey(next) && (effortAt ?? 0) <= when) {
      effort = null;
      effortAt = when;
      effortSet = false;
    }
    model = clip(next);
    modelAt = when;
  };

  for (const line of lines) {
    const entry = parseLine(line);
    if (!entry || entry.isSidechain === true) continue;
    const when = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
    if (!Number.isFinite(when)) continue;

    if (entry.type === 'system' && entry.subtype === 'local_command' && typeof entry.content === 'string') {
      const command = entry.commandRun?.command;
      if (command === 'model') {
        const m = SET_MODEL_RE.exec(entry.content);
        if (m) {
          // With no earlier model on record we cannot tell a switch from a no-op, and a
          // stale effort is worse than none: treat it as a switch.
          if (model === undefined) {
            effort = null;
            effortAt = when;
            effortSet = false;
          }
          setModel(m[1], when);
          // `/model opusplan` launches as `opusplan`, whatever model then answers.
          const args = typeof entry.commandRun?.args === 'string' ? modelFlagFromLabel(entry.commandRun.args) : undefined;
          setLaunchModel(args ?? modelFlagFromLabel(m[1]), when);
          awaitingPickedModel = args === undefined;
        }
      } else if (command === 'effort') {
        const m = SET_EFFORT_RE.exec(entry.content);
        if (m) {
          effort = m[1];
          effortAt = when;
          effortSet = true;
        }
      }
      continue;
    }

    if (entry.type === 'event_msg' && entry.payload?.type === 'token_count') {
      // Codex: one per reply. The first of a session has no usage yet and says nothing.
      const usage = contextFromCodexInfo(entry.payload.info);
      if (usage) {
        context = usage;
        contextAt = when;
      }
      continue;
    }

    if (entry.type === 'turn_context') {
      const id = entry.payload?.model;
      if (typeof id === 'string' && id.trim()) {
        setModel(id.trim(), when);
        // Codex's turn context IS the configured model (`/model` there applies per turn).
        setLaunchModel(modelFlagFromLabel(id), when);
      }
      const level = entry.payload?.effort;
      effort = typeof level === 'string' && EFFORT_RE.test(level) ? level : null;
      effortAt = when;
      effortSet = false;
      continue;
    }

    if (entry.type === 'assistant') {
      const id = entry.message?.model;
      if (typeof id === 'string' && id && !id.startsWith('<')) {
        setModel(id, when);
        // Any other reply is NOT a launch model: `opusplan` answers from Sonnet outside
        // plan mode, and a fallback model answers when the chosen one is overloaded.
        if (awaitingPickedModel) {
          setLaunchModel(modelFlagFromLabel(id), when);
          awaitingPickedModel = false;
        }
      }
    }
  }

  const reading: RuntimeReading = {};
  if (model !== undefined) {
    reading.model = model;
    reading.modelAt = modelAt;
  }
  if (launchModel !== undefined) {
    reading.launchModel = launchModel;
    reading.launchModelAt = launchModelAt;
  }
  if (effortAt !== undefined) {
    reading.effort = effort ?? null;
    reading.effortAt = effortAt;
    reading.effortSet = effortSet;
  }
  if (contextAt !== undefined) {
    reading.context = context;
    reading.contextAt = contextAt;
  }
  return reading;
}

const countOf = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined;

/**
 * A Codex `token_count` event's `info` → the context window: the last reply's tokens
 * (reasoning tokens are not kept in the context) of `model_context_window`. Codex's own
 * "% context left" also discounts a fixed start-up share, so it can read a point or two
 * apart. Undefined when the event carries no usage.
 */
function contextFromCodexInfo(raw: unknown): SessionContextUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const info = raw as { last_token_usage?: unknown; model_context_window?: unknown };
  const size = countOf(info.model_context_window);
  const last = info.last_token_usage as {
    total_tokens?: unknown; reasoning_output_tokens?: unknown; input_tokens?: unknown;
    cached_input_tokens?: unknown; cache_write_input_tokens?: unknown; output_tokens?: unknown;
  } | null | undefined;
  const total = countOf(last?.total_tokens);
  if (!size || total === undefined) return undefined;
  const tokens = Math.max(0, total - (countOf(last?.reasoning_output_tokens) ?? 0));
  // Codex counts cached input INSIDE input_tokens: new input is the rest.
  const input = countOf(last?.input_tokens);
  const cacheRead = countOf(last?.cached_input_tokens);
  const parts = partsOf({
    cacheRead,
    cacheWrite: last?.cache_write_input_tokens,
    input: input !== undefined && cacheRead !== undefined ? Math.max(0, input - cacheRead) : input,
    output: last?.output_tokens,
  });
  return { pct: Math.min(100, Math.round((tokens / size) * 100)), size, tokens, ...(parts ? { parts } : {}) };
}

/** The last reply's counts by kind (`{ input, cacheWrite, cacheRead, output }`), each kept only when it is a count. */
function partsOf(raw: unknown): SessionContextParts | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const parts: SessionContextParts = {};
  for (const key of ['input', 'cacheWrite', 'cacheRead', 'output'] as const) {
    const n = countOf(r[key]);
    if (n !== undefined) parts[key] = n;
  }
  return Object.keys(parts).length > 0 ? parts : undefined;
}

/**
 * The tap's `context` object (`{ used_percentage, size, tokens }`). Claude Code computes
 * `used_percentage` itself; an older CLI without it gets tokens ÷ size. No usage at all
 * is `null`: unknown, so the header shows nothing rather than a false 0%.
 */
function contextFromSnapshot(raw: unknown): SessionContextUsage | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as { used_percentage?: unknown; size?: unknown; tokens?: unknown; parts?: unknown };
  const size = countOf(c.size);
  const tokens = countOf(c.tokens);
  const reported = countOf(c.used_percentage);
  const pct = reported ?? (tokens !== undefined && size ? Math.round((tokens / size) * 100) : undefined);
  if (pct === undefined) return null;
  const parts = partsOf(c.parts);
  return {
    pct: Math.min(100, pct),
    ...(size ? { size } : {}),
    ...(tokens !== undefined ? { tokens } : {}),
    ...(parts ? { parts } : {}),
  };
}

/** What `hooks/dashboard-statusline.sh` writes to `<queue>/runtime/<sid>.json`. */
export function readingFromStatusLine(snapshot: unknown): RuntimeReading | null {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const s = snapshot as { ts?: unknown; model?: unknown; effort?: unknown; context?: unknown };
  if (typeof s.ts !== 'number' || !Number.isFinite(s.ts) || s.ts <= 0) return null;
  const m = s.model && typeof s.model === 'object' ? (s.model as { id?: unknown; display_name?: unknown }) : null;
  const name = typeof m?.display_name === 'string' && m.display_name.trim()
    ? m.display_name.trim()
    : typeof m?.id === 'string' && m.id.trim() ? m.id.trim() : null;
  if (!name) return null;
  const level = s.effort && typeof s.effort === 'object' ? (s.effort as { level?: unknown }).level : undefined;
  return {
    model: clip(name),
    modelAt: s.ts,
    // Absent = the model does not take the effort parameter: there is no effort.
    effort: typeof level === 'string' && EFFORT_RE.test(level) ? level : null,
    effortAt: s.ts,
    effortSet: false,
    // A snapshot from a tap older than the context field says nothing about it.
    ...('context' in s ? { context: contextFromSnapshot(s.context), contextAt: s.ts } : {}),
  };
}

/**
 * Apply one reading. Returns the new value, or `null` when the reading changed
 * nothing at all (timestamps included). Never mutates. Whether a browser needs to
 * hear about it is {@link runtimeVisiblyChanged}.
 */
export function mergeRuntime(prev: SessionRuntime | undefined, r: RuntimeReading): SessionRuntime | null {
  let next: SessionRuntime = { ...(prev ?? {}) };

  if (r.model !== undefined && r.modelAt !== undefined && r.modelAt >= (prev?.modelAt ?? 0)) {
    const switched = prev?.model !== undefined && modelLabelKey(prev.model) !== modelLabelKey(r.model);
    next = { ...next, model: r.model, modelAt: r.modelAt };
    if (switched && r.effortAt === undefined && (prev?.effortAt ?? 0) < r.modelAt) {
      const { effort: _dropped, effortSet: _set, ...rest } = next;
      next = { ...rest, effortAt: r.modelAt };
    }
  }

  if (r.launchModel !== undefined && r.launchModelAt !== undefined && r.launchModelAt >= (next.launchModelAt ?? 0)) {
    next = { ...next, launchModel: r.launchModel, launchModelAt: r.launchModelAt };
  }

  if (r.effortAt !== undefined && r.effortAt >= (next.effortAt ?? 0)) {
    const { effort: _dropped, effortSet: _set, ...rest } = next;
    next = r.effort
      ? { ...rest, effort: r.effort, effortAt: r.effortAt, ...(r.effortSet ? { effortSet: true } : {}) }
      : { ...rest, effortAt: r.effortAt };
  }

  if (r.contextAt !== undefined && r.contextAt >= (next.contextAt ?? 0)) {
    const { context: _dropped, ...rest } = next;
    next = r.context ? { ...rest, context: r.context, contextAt: r.contextAt } : { ...rest, contextAt: r.contextAt };
  }

  const same = prev !== undefined
    && prev.model === next.model && prev.modelAt === next.modelAt
    && prev.launchModel === next.launchModel && prev.launchModelAt === next.launchModelAt
    && prev.effort === next.effort && prev.effortAt === next.effortAt && prev.effortSet === next.effortSet
    && sameContext(prev.context, next.context) && prev.contextAt === next.contextAt;
  return same ? null : next;
}

/**
 * The same runtime minus the context-window share: for a card re-keyed onto a new
 * conversation (`/clear`, a resume), whose old share no longer describes it. The new
 * id's first snapshot may have landed before the re-key and been dropped, so waiting
 * for a `null` reading is not enough. Never mutates.
 */
export function withoutContext(runtime: SessionRuntime | undefined): SessionRuntime | undefined {
  if (!runtime || (runtime.context === undefined && runtime.contextAt === undefined)) return runtime;
  const { context: _context, contextAt: _at, ...rest } = runtime;
  return rest;
}

function sameContext(a: SessionContextUsage | undefined, b: SessionContextUsage | undefined): boolean {
  const p = a?.parts;
  const q = b?.parts;
  return a?.pct === b?.pct && a?.size === b?.size && a?.tokens === b?.tokens
    && p?.input === q?.input && p?.cacheWrite === q?.cacheWrite && p?.cacheRead === q?.cacheRead && p?.output === q?.output;
}

/**
 * Would the chip a browser draws (or its tooltip) look different? Timestamps alone do
 * not count. Context tokens do — they only move with a reply, when the % mostly moves
 * too, and a tooltip that lags the % by up to 1% of a 1M window (10k tokens) is wrong.
 */
export function runtimeVisiblyChanged(prev: SessionRuntime | undefined, next: SessionRuntime): boolean {
  if (!prev) return next.model !== undefined || next.effort !== undefined || next.context !== undefined;
  const prevModel = prev.model === undefined ? undefined : modelLabelKey(prev.model);
  const nextModel = next.model === undefined ? undefined : modelLabelKey(next.model);
  return prevModel !== nextModel || prev.effort !== next.effort || !sameContext(prev.context, next.context);
}

/**
 * The effort levels a session may be (re)launched with — mirrors the `effortLevel`
 * enum of the terminal-create schema in `apiRouter.ts`. `ultracode` launches as
 * `--effort xhigh` and is upgraded by a typed `/effort ultracode`.
 */
const LAUNCH_EFFORT_LEVELS: ReadonlySet<string> = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode']);

export interface LaunchFlags {
  model?: string;
  effortLevel?: string;
}

/**
 * What a resume should launch with. The model is the one the user last CHOSE
 * (`launchModel` — never merely the model a reply came from), else the current one.
 * Once the CLI has reported an effort, that is the effort: a valid level is used, and
 * an unknown one (cleared by a model switch, or a model without effort) gives none, so
 * the relaunch drops `--effort` and the model's own saved level applies. A reported
 * `xhigh` keeps `ultracode` (its launch base) unless `/effort xhigh` set it explicitly.
 */
export function launchFlagsFromRuntime(runtime: SessionRuntime | undefined, current: LaunchFlags): LaunchFlags {
  const model = modelFlagFromLabel(runtime?.launchModel) ?? current.model;
  if (runtime?.effortAt === undefined) return { model, effortLevel: current.effortLevel };
  const effort = runtime.effort;
  if (!effort || !LAUNCH_EFFORT_LEVELS.has(effort)) return { model, effortLevel: undefined };
  const keepsUltracode = current.effortLevel === 'ultracode' && effort === 'xhigh' && runtime.effortSet !== true;
  return { model, effortLevel: keepsUltracode ? 'ultracode' : effort };
}
