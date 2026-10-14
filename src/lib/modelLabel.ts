/**
 * Short, human labels for Claude model names, shared by the server (to tell a real
 * model switch from the same model under another name) and the session header chip.
 *
 * Import-free on purpose: `server/sessionRuntime.ts` imports it.
 *
 * Claude Code names one model three ways — an ID (`claude-opus-5-5`), a tier alias
 * (`opus`) and a display name (`Opus 5.5`, what `/model` prints) — and the session's
 * transcript and status line use different ones. All of them format to one label.
 */

const CURRENT_ID_RE = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/;
const LEGACY_ID_RE = /^claude-(\d+)(?:-(\d{1,2}))?-([a-z]+)(?:-\d{8})?$/;
const ONE_M_RE = /\[1m\]$/i;

const capitalise = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);

/** `claude-opus-5-5` → `Opus 5.5`; `sonnet[1m]` → `Sonnet 1M`; unknown names unchanged. */
export function formatModelLabel(model: string): string {
  const raw = model.trim();
  if (!raw) return '';
  const oneM = ONE_M_RE.test(raw);
  const base = raw.replace(ONE_M_RE, '');
  const suffix = oneM ? ' 1M' : '';

  const current = CURRENT_ID_RE.exec(base);
  if (current) {
    const [, family, major, minor] = current;
    return `${capitalise(family)} ${minor ? `${major}.${minor}` : major}${suffix}`;
  }
  const legacy = LEGACY_ID_RE.exec(base);
  if (legacy) {
    const [, major, minor, family] = legacy;
    return `${capitalise(family)} ${minor ? `${major}.${minor}` : major}${suffix}`;
  }
  if (/^[a-z]+$/.test(base)) return `${capitalise(base)}${suffix}`;
  return `${base}${suffix}`;
}

/** Comparison key: equal for an ID and the display name Claude Code prints for it. */
export function modelLabelKey(model: string): string {
  return formatModelLabel(model).toLowerCase();
}

/** What `--model` accepts unquoted: an ID or a tier alias (no spaces, no `[1m]`). */
const MODEL_FLAG_RE = /^[a-zA-Z0-9._-]{1,128}$/;
/**
 * A display name `/model` prints for a current-format ID: `Opus 5.5`. The minor
 * version is required and the major must be 4+: `Sonnet 4` is `claude-sonnet-4-0`
 * (or a dated ID) and `Sonnet 3.7` is `claude-3-7-sonnet`, so neither can be rebuilt.
 */
const DISPLAY_NAME_RE = /^([A-Za-z]+) (\d+)\.(\d{1,2})$/;
const MIN_REBUILDABLE_MAJOR = 4;

/**
 * The `--model` value a model name stands for, or `undefined` when it cannot be one.
 * An ID or alias is returned as is; a display name (`Opus 5.5`) is turned back into
 * its ID, and kept only if that ID formats to the same label. Everything else (the
 * 1M variants, picker text) gives `undefined`: guessing a model is worse than none.
 */
export function modelFlagFromLabel(model: string | null | undefined): string | undefined {
  const raw = (model ?? '').trim();
  if (!raw) return undefined;
  if (MODEL_FLAG_RE.test(raw)) return raw;
  const m = DISPLAY_NAME_RE.exec(raw);
  if (!m) return undefined;
  const [, family, major, minor] = m;
  if (Number(major) < MIN_REBUILDABLE_MAJOR) return undefined;
  const id = `claude-${family.toLowerCase()}-${major}-${minor}`;
  return modelLabelKey(id) === modelLabelKey(raw) ? id : undefined;
}
