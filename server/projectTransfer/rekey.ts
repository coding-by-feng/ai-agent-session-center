/**
 * Re-keying a project's agent memory to its new folder. Claude Code and Codex record the folder a
 * session ran in as `cwd` on transcript lines (Claude: top level; Codex: `payload.cwd` on
 * `session_meta` and `turn_context` lines). A copied transcript must name the new folder, or
 * `--resume` and AASC's history look for the old one.
 */

/** `from` itself or a path inside it, moved under `to`; anything else is returned as it is. */
export function movePath(value: string, from: string, to: string): string {
  if (value === from) return to;
  if (value.startsWith(from + '/')) return to + value.slice(from.length);
  return value;
}

function rewriteObject(obj: Record<string, unknown>, from: string, to: string): boolean {
  let changed = false;
  if (typeof obj.cwd === 'string') {
    const next = movePath(obj.cwd, from, to);
    if (next !== obj.cwd) {
      obj.cwd = next;
      changed = true;
    }
  }
  const payload = obj.payload;
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const p = payload as Record<string, unknown>;
    if (typeof p.cwd === 'string') {
      const next = movePath(p.cwd, from, to);
      if (next !== p.cwd) {
        p.cwd = next;
        changed = true;
      }
    }
  }
  return changed;
}

/**
 * One JSONL text with every `cwd` (and `payload.cwd`) under `from` moved under `to`. A line that
 * isn't a JSON object, or names no such folder, is kept byte for byte.
 */
export function rewriteJsonlCwd(text: string, from: string, to: string): { text: string; changed: number } {
  if (from === to) return { text, changed: 0 };
  let changed = 0;
  const lines = text.split('\n').map((line) => {
    if (!line.includes('"cwd"')) return line;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return line;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return line;
    if (!rewriteObject(parsed as Record<string, unknown>, from, to)) return line;
    changed++;
    return JSON.stringify(parsed);
  });
  return { text: lines.join('\n'), changed };
}

/** The `cwd` a Codex rollout's first line (`session_meta`) records, or null. */
export function codexRolloutCwd(firstLine: string): string | null {
  try {
    const parsed = JSON.parse(firstLine) as { type?: unknown; payload?: { cwd?: unknown } };
    if (parsed?.type !== 'session_meta') return null;
    return typeof parsed.payload?.cwd === 'string' ? parsed.payload.cwd : null;
  } catch {
    return null;
  }
}
