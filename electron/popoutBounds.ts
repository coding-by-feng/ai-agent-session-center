/**
 * Pure logic behind per-kind popout window bounds persistence.
 *
 * Four structurally different popout kinds — 'terminal' (a floating
 * Explain/Translate/custom AI popup, or the main/commands terminal detached:
 * a small utility window), 'project' (file tree + editor), 'session' (the
 * WHOLE DetailPanel — every tab), and 'internal' (any other in-app route
 * opened as a native window) — used to share ONE bounds slot. Resizing or
 * maximizing a content-heavy PROJECT or SESSION window permanently poisoned
 * the size of every later TERMINAL popout, even a one-line Explain prompt: a
 * fresh session would open at whatever huge size the user last left a project
 * browser at, mostly empty.
 *
 * Kept import-free and side-effect-free so this can be unit-tested without
 * booting Electron — same reasoning as `internalUrl.ts` (`electron/` cannot
 * import from `server/`, same tsconfig-roots constraint as `ptyRing.ts`).
 * `electron/main.ts` owns all the Electron-dependent glue (`readFileSync`,
 * `screen.getAllDisplays()`, …) and calls into these pure functions for the
 * actual shape/migration logic.
 */

export type PopoutKind = 'terminal' | 'project' | 'session' | 'internal';

export const POPOUT_KINDS: readonly PopoutKind[] = ['terminal', 'project', 'session', 'internal'];

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type PopoutBoundsFile = Partial<Record<PopoutKind, WindowBounds>>;

export const POPOUT_DEFAULT_SIZES: Record<PopoutKind, { width: number; height: number }> = {
  // Utility popup — a hovered/selected line's worth of conversation.
  terminal: { width: 820, height: 560 },
  // Full workspace surfaces — mirrors the main window's own default (1400×900)
  // rather than the terminal's utility size, which is what they used to
  // inherit by accident whenever the shared slot happened to hold it.
  project: { width: 1400, height: 900 },
  session: { width: 1400, height: 900 },
  internal: { width: 1100, height: 720 },
};

export function isWindowBounds(v: unknown): v is WindowBounds {
  if (!v || typeof v !== 'object') return false;
  const b = v as Partial<WindowBounds>;
  return typeof b.x === 'number' && typeof b.y === 'number'
    && typeof b.width === 'number' && typeof b.height === 'number';
}

/**
 * Parse the on-disk bounds file into a per-kind map.
 *
 * A file from BEFORE this change is a bare `{x,y,width,height}` — the single
 * shared bounds every kind used to read. It is deliberately NOT migrated by
 * seeding all four kinds from it: that value most likely belongs to whichever
 * content-heavy window the user resized last, and copying it forward would
 * hand TERMINAL that same oversized bounds it already has today —
 * reproducing the exact bug this change fixes, just once more before
 * self-correcting. No special-casing is needed to discard it, either: the
 * extraction below reads only the four KIND-named keys (`terminal`,
 * `project`, `session`, `internal`), and a flat legacy file's own keys (`x`,
 * `y`, `width`, `height`) don't collide with any of them — so it naturally
 * contributes nothing, by construction rather than by an explicit check.
 * (Verified, not assumed: a version of this function with an added
 * `if (isWindowBounds(parsed)) return {}` early-return behaved identically —
 * that branch was dead code, proving the loop alone is what does the work.)
 * Returning `{}` means every kind falls through to its own default/
 * auto-placement on first read post-upgrade, and the file is rewritten in the
 * new per-kind shape the next time any window moves or resizes.
 *
 * `raw` is `null` for "file doesn't exist" (the caller's `readFileSync` threw)
 * — same outcome as malformed JSON: every kind falls back to auto-placement.
 */
export function parsePopoutBoundsFile(raw: string | null): PopoutBoundsFile {
  if (raw === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object') return {};

  // Extract ONLY the recognized kind keys — never spread `parsed` wholesale.
  // Spreading would let an unrelated top-level key (a stray `x`/`width` from
  // a legacy file, or anything else) leak into the result; seeing only kind
  // names is what makes the legacy-discard behaviour above hold.
  const out: PopoutBoundsFile = {};
  for (const kind of POPOUT_KINDS) {
    const v = (parsed as Record<string, unknown>)[kind];
    if (isWindowBounds(v)) out[kind] = v;
  }
  return out;
}

/** Pure merge: an existing per-kind map plus one kind's freshly-saved bounds,
 *  ready to serialize. Never mutates `existing`. */
export function mergePopoutBounds(
  existing: PopoutBoundsFile,
  kind: PopoutKind,
  bounds: WindowBounds,
): PopoutBoundsFile {
  return { ...existing, [kind]: bounds };
}
