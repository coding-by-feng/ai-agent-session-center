/**
 * resourceMask — the ONLY way a config value, or any file text, leaves the server.
 *
 * Pure and import-free (a type-only import is erased at build time), so it can
 * be unit-tested exhaustively and reused by any route without dragging in fs.
 *
 * The rule is an **allowlist with deny-wins**:
 * - A string is shown only when its key path matches `ALLOWED_KEY_PATHS` AND no
 *   deny rule matches anywhere along the path. Everything else is `******`.
 *   An allowlist rather than a blocklist because config formats grow new keys
 *   every release — a blocklist leaks the first secret nobody anticipated,
 *   an allowlist merely hides the first harmless setting nobody listed.
 * - Numbers, booleans and null are shown — unless a deny rule matches. Deny
 *   wins for EVERY kind: `env.PORT = 8080` and `password = 1234` are still user
 *   data under a secret-shaped key. (Side effect, accepted: token COUNTS such as
 *   `lastTotalInputTokens` read as masked.)
 * - Every string that IS shown still goes through `redactSecretsInString`,
 *   because allowlisted fields are where secrets get pasted: `args` of an MCP
 *   server (`--token ghp_…`), a hook command (`curl -H "Authorization: Bearer …"`),
 *   a URL with `?token=`.
 * - Every TEXT that leaves as text — a detail body of any format, a package
 *   file, a compare patch, frontmatter — goes through `redactText` (or
 *   `redactPatch`): the same line rules without the 300-character cap, plus
 *   whole private-key blocks. Memory notes and hook scripts hold real keys too.
 */
import type { ResourceField, ResourceFieldKind } from '../src/types/resources.js';

export const MASK = '******';

const MAX_SHOWN_CHARS = 300;

/**
 * Key paths whose STRING values may be shown. `*` = one object key, `[]` = any
 * array index. Paths are matched on the raw keys, so a key that itself contains
 * dots (a project path under `projects`) is still one segment.
 */
export const ALLOWED_KEY_PATHS: readonly string[] = [
  // Claude settings.json / settings.local.json / ~/.claude.json
  'model',
  'effortLevel',
  'theme',
  'outputStyle',
  'permissions.defaultMode',
  'permissions.allow[]',
  'permissions.deny[]',
  'permissions.ask[]',
  'permissions.additionalDirectories[]',
  'enabledPlugins.*',
  'statusLine.*',
  // Hook groups — Claude settings and Codex config.toml share this shape
  'hooks.*[].matcher',
  'hooks.*[].hooks[].type',
  'hooks.*[].hooks[].command',
  'hooks.*[].hooks[].timeout',
  // Codex config.toml
  'model_reasoning_effort',
  'plan_mode_reasoning_effort',
  'approval_policy',
  'approvals_reviewer',
  'sandbox_mode',
  'service_tier',
  'notify[]',
  'projects.*.trust_level',
  'features.*',
  'plugins.*.enabled',
  'mcp_servers.*.command',
  'mcp_servers.*.args[]',
  'mcp_servers.*.url',
  'mcp_servers.*.type',
  'mcp_servers.*.enabled',
  // The same MCP fields inside ~/.claude.json's mcpServers table
  'mcpServers.*.command',
  'mcpServers.*.args[]',
  'mcpServers.*.url',
  'mcpServers.*.type',
  // One MCP server entry flattened on its own (.mcp.json / mcpServers.<n> / mcp_servers.<n>)
  'type',
  'url',
  'command',
  'args[]',
  // One plugin install record (installed_plugins.json entry; installPath pre-rendered as ~/…)
  'version',
  'scope',
  'installPath',
  'installedAt',
  'lastUpdated',
];

/** Key names that mark their whole subtree as secret. From the spec, verbatim. */
const DENY_KEY_RE =
  /(pass(word|wd)?|secret|token|api[-_]?key|apikey|credential|cookie|private[-_]?key|bearer|oauth|session[-_]?key|auth(orization)?$|^auth|signature|access[-_]?key|client[-_]?secret|passwordhash)/i;

/**
 * Segments whose values are arbitrary user data — environment variables and
 * HTTP headers. Wider than the spec's literal `env`/`headers` on purpose:
 * Codex spells them `http_headers` / `env_http_headers`, and its
 * `shell_environment_policy.set` table is an env map under another name.
 */
const DENY_SEGMENT_RE = /^(?:env|environment|.*headers|shell_environment_policy)$/i;

export function isDeniedKeyName(name: string): boolean {
  return DENY_KEY_RE.test(name) || DENY_SEGMENT_RE.test(name);
}

// ---------------------------------------------------------------------------
// Secret redaction inside shown strings and bodies
// ---------------------------------------------------------------------------

/**
 * Only 300 characters are ever shown, so only this much of an input is ever
 * scanned. Config files come from arbitrary repos (a project's
 * `.claude/settings.json`), and a regex over an unbounded string is an event
 * loop stall waiting for a hostile value.
 */
const REDACT_WINDOW = 1024;

/** A body line longer than this is cut before any pattern runs, so no one line can make a pass slow. */
export const REDACT_LINE_MAX = 8 * 1024;

/**
 * Every pattern starts with a lookbehind (or a literal prefix) rather than `\b`
 * wherever its token class contains `-` or `.`: with `\b`, every separator in a
 * long run is a new start that rescans the rest of the run (quadratic); the
 * lookbehind allows one start per run. No pattern crosses a newline — `[ \t]`,
 * never `\s`, between the parts — so a whole body can be scanned in one pass
 * and still behaves line by line.
 */
const URL_RE = /(?<![A-Za-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;

type Replacement = string | ((match: string, ...groups: string[]) => string);

/** Ordered: specific token shapes first, the generic catch-alls (in `scrub`) last. */
const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, Replacement]> = [
  [/(?<![A-Za-z0-9_-])(sk-(?:ant-)?)[A-Za-z0-9_-]{6,}/g, `$1${MASK}`],
  [/(?<![A-Za-z0-9_-])((?:sk|rk|pk)_(?:live|test)_)[A-Za-z0-9]{8,}/g, `$1${MASK}`],
  [/(?<![A-Za-z0-9_-])(gh[pousr]_)[A-Za-z0-9]{10,}/g, `$1${MASK}`],
  [/(?<![A-Za-z0-9_-])(github_pat_)[A-Za-z0-9_]{10,}/g, `$1${MASK}`],
  [/(?<![A-Za-z0-9_-])(glpat-)[A-Za-z0-9_-]{10,}/g, `$1${MASK}`],
  [/(?<![A-Za-z0-9_-])(xox[abprs]-)[A-Za-z0-9-]{6,}/g, `$1${MASK}`],
  [/(?<![A-Za-z0-9_-])(hf_|npm_|do[por]_v1_)[A-Za-z0-9]{20,}/g, `$1${MASK}`],
  [/(?<![A-Za-z0-9_-])(xai-)[A-Za-z0-9_-]{20,}/g, `$1${MASK}`],
  [/(?<![A-Za-z0-9_-])(AKIA|ASIA)[0-9A-Z]{16}(?![A-Za-z0-9_-])/g, `$1${MASK}`],
  [/(?<![A-Za-z0-9_-])SK[0-9a-fA-F]{32}(?![A-Za-z0-9_-])/g, `SK${MASK}`], // Twilio API key
  [/(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}/g, `AIza${MASK}`],
  [/(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, MASK],
  // Telegram bot token — often inside a URL path (`/bot<token>/`), so only a digit may not precede it.
  [/(?<!\d)\d{8,10}:[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/g, MASK],
  // Authorization headers keep their scheme word: "Authorization: Basic ******".
  [
    /\b((?:proxy-)?authorization[ \t]*:[ \t]*)(?:(bearer|basic|token|digest|negotiate)[ \t]+)?[^\s"',;]+/gi,
    (_match, head: string, scheme?: string) => `${head}${scheme ? `${scheme} ` : ''}${MASK}`,
  ],
  [/\b((?:x-)?(?:api[-_]?key|auth[-_]?token|access[-_]?token|private[-_]?token)[ \t]*:[ \t]*)[^\s"',;]+/gi, `$1${MASK}`],
  // A cookie header's value runs to the end of the quoted string: every pair in it is session state.
  [/\b((?:set-)?cookie[ \t]*:[ \t]*)[^"'\n]+/gi, `$1${MASK}`],
  [/\b(Bearer)[ \t]+[A-Za-z0-9._~+/=-]+/gi, `$1 ${MASK}`],
  // curl -u user:pass / --user user:pass
  [/([ \t]-u[ \t]+|[ \t]--user[= \t]+)[^\s"']+/g, `$1${MASK}`],
  // URL userinfo: //user:pass@host and //token@host
  [/(\/\/)[^\s/?#@]+@/g, `$1${MASK}@`],
];

/** NAME=value where NAME mentions a key/token/secret/password (env assignments, --flags). */
const NAME_VALUE_RE = /(?<![A-Za-z0-9_-])(-{0,2}[A-Za-z_][A-Za-z0-9_-]*)=("[^"\n]*"|'[^'\n]*'|[^\s&"']+)/g;
const SECRET_NAME_RE = /key|token|secret|pass/i;

/**
 * `name: value`, `"name": "value"`, `name = value` — JSON, YAML, TOML and
 * notes. Judged on the name's LAST word (`api_key`, `apiKey`, `DB_PASSWORD`),
 * so `keywords:` or `token_url:` stay readable. A quoted value is unbounded
 * and still linear: every scan for a closing quote ends at the next quote of
 * its kind, so the scans of all starts on a line add up to the line.
 */
const ASSIGN_RE = /(?<![A-Za-z0-9_.-])(["']?)([A-Za-z_][A-Za-z0-9_.-]{0,63})\1([ \t]*:[ \t]*|[ \t]+=[ \t]*|[ \t]*=[ \t]+)("[^"\n]*"|'[^'\n]*'|[^\s"',;]+)/g;
const SECRET_WORDS: ReadonlySet<string> = new Set([
  'key', 'apikey', 'token', 'secret', 'password', 'passwd', 'pass', 'pwd', 'passphrase', 'credential', 'credentials',
]);

function isSecretName(name: string): boolean {
  const words = name.split(/[-_.]+|(?<=[a-z0-9])(?=[A-Z])/).filter(Boolean).map((w) => w.toLowerCase());
  return SECRET_WORDS.has(words[words.length - 1] ?? '') || words.some((w) => w === 'secret' || w === 'password');
}

/** `--token abc`: a secret-named flag and its value as separate words of ONE string (hook commands). */
const FLAG_VALUE_RE = /(?<![A-Za-z0-9_.-])(--?[A-Za-z][A-Za-z0-9_.-]{0,63})([ \t]+)("[^"\n]*"|'[^'\n]*'|[^\s"'-][^\s"']*)/g;

const LONG_RUN_RE = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{40,}/g;
/** Maximal runs of the base64/base62 alphabet — judged whole by `looksLikeSecret`. */
const TOKEN_RUN_RE = /(?<![A-Za-z0-9+/=_-])[A-Za-z0-9+/=_-]{20,}/g;

/**
 * A generated secret rather than a word or a path: mixed case plus a digit,
 * and at most two `/` (so `/Users/me/Documents/x` survives). Two exceptions
 * catch base64 that happens to hold more `/`: exactly 40 characters (an AWS
 * secret access key), or 64+ characters with at most one `/` per 16 — base64
 * averages one per 64, a path one every ten or so.
 */
function looksLikeSecret(run: string): boolean {
  if (!/\d/.test(run) || !/[A-Z]/.test(run) || !/[a-z]/.test(run)) return false;
  const slashes = run.length - run.replace(/\//g, '').length;
  if (slashes <= 2) return true;
  if (run.length >= 64 && slashes * 16 <= run.length) return true;
  return run.length === 40 && /^[A-Za-z0-9/+]+$/.test(run) && !run.startsWith('/') && !run.includes('//');
}

/** A URL path segment that looks generated rather than named (a webhook secret). */
function looksGenerated(segment: string): boolean {
  const classes = [/[a-z]/, /[A-Z]/, /\d/].filter((re) => re.test(segment)).length;
  return classes >= 2;
}

function maskUrls(input: string): string {
  return input.replace(URL_RE, (url) => url
    // `?` is excluded from the name too: otherwise every `?` of `a????…` rescans to the end (quadratic).
    .replace(/([?&][^=&#?\s]+=)[^&#\s]*/g, `$1${MASK}`)
    .replace(/(?<=\/)[A-Za-z0-9_-]{20,}(?=[/?#]|$)/g, (segment) => (looksGenerated(segment) ? MASK : segment)));
}

function isSpace(ch: string | undefined): boolean {
  return ch !== undefined && /\s/.test(ch);
}

/** The first `max` characters, minus a token the cut went through — a secret is never shown in part. */
function cutAt(text: string, max: number): string {
  let end = max;
  while (end > 0 && !isSpace(text[end - 1])) end -= 1;
  return text.slice(0, end);
}

/** Every line rule, over text of any length (each pattern is linear and newline-bounded). */
function scrub(text: string): string {
  let out = maskUrls(text);
  for (const [re, replacement] of SECRET_PATTERNS) {
    // Two identical-looking branches: String#replace has no overload for the union, each narrows it.
    out = typeof replacement === 'string' ? out.replace(re, replacement) : out.replace(re, replacement);
  }
  return out
    .replace(NAME_VALUE_RE, (match, name: string) => (SECRET_NAME_RE.test(name) ? `${name}=${MASK}` : match))
    .replace(ASSIGN_RE, (match, q: string, name: string, sep: string, value: string) => {
      if (!isSecretName(name)) return match;
      const vq = /^["']/.test(value) ? value[0] : '';
      return `${q}${name}${q}${sep}${vq}${MASK}${vq}`;
    })
    .replace(FLAG_VALUE_RE, (match, flag: string, gap: string) => (isSecretFlag(flag) ? `${flag}${gap}${MASK}` : match))
    // Whole base64 runs first: the long-run rule's class has no `/` or `+`, so
    // running it first would mask pieces of a blob and strand the rest.
    .replace(TOKEN_RUN_RE, (run) => (looksLikeSecret(run) ? MASK : run))
    .replace(LONG_RUN_RE, MASK);
}

/**
 * Mask token-shaped substrings and cap the result at 300 characters. A token
 * cut by the scan window is dropped whole, never shown in part.
 */
export function redactSecretsInString(input: string): string {
  const clipped = input.length > REDACT_WINDOW;
  const out = scrub(clipped ? cutAt(input, REDACT_WINDOW) : input);
  if (out.length > MAX_SHOWN_CHARS) return `${out.slice(0, MAX_SHOWN_CHARS - 1)}…`;
  return clipped ? `${out}…` : out;
}

const PEM_BEGIN_RE = /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY[A-Z ]{0,20}-----/g;
const PEM_END_RE = /-----END [A-Z0-9 ]{0,60}-----/g;

/** From the first to the last non-space character → MASK; indentation and a trailing `\r` survive. */
function maskSpan(s: string): string {
  const start = s.search(/\S/);
  if (start < 0) return s;
  let end = s.length;
  while (end > start && isSpace(s[end - 1])) end -= 1;
  return `${s.slice(0, start)}${MASK}${s.slice(end)}`;
}

/** One line of the private-key state machine: markers kept, everything between them masked. */
function maskPemLine(line: string, inBlock: boolean): { line: string; inBlock: boolean } {
  const parts: string[] = [];
  let block = inBlock;
  let at = 0;
  for (;;) {
    const re = block ? PEM_END_RE : PEM_BEGIN_RE;
    re.lastIndex = at;
    const m = re.exec(line);
    if (!m) break;
    const head = line.slice(at, m.index);
    parts.push(block ? maskSpan(head) : head, m[0]);
    at = m.index + m[0].length;
    block = !block;
  }
  const tail = line.slice(at);
  parts.push(block ? maskSpan(tail) : tail);
  return { line: parts.join(''), inBlock: block };
}

/**
 * Private-key blocks, masked whole — no line rule can see them, the body lines
 * are bare base64. Markers are kept so the reader sees what was there; a block
 * that never closes is masked to the end. Also catches the one-line form a
 * service-account JSON carries (`\n` escapes between the markers).
 */
export function redactPemBlocks(text: string): string {
  if (!text.includes('-----BEGIN ')) return text;
  let inBlock = false;
  return text.split('\n').map((line) => {
    const out = maskPemLine(line, inBlock);
    inBlock = out.inBlock;
    return out.line;
  }).join('\n');
}

/** Line rules only (no private-key pass). */
function redactLines(text: string): string {
  const capped = text.length <= REDACT_LINE_MAX ? text : text.split('\n')
    .map((line) => (line.length > REDACT_LINE_MAX ? `${cutAt(line, REDACT_LINE_MAX)}…` : line))
    .join('\n');
  return scrub(capped);
}

/**
 * Redact a whole body — a detail body, a package file, a note — before it
 * leaves the server. Line-oriented and linear: a line over `REDACT_LINE_MAX` is
 * cut first (never a token in part), private-key blocks go whole, and every
 * line rule of `redactSecretsInString` applies — without its 300-character cap.
 */
export function redactText(text: string): string {
  return redactLines(redactPemBlocks(text));
}

/**
 * A unified diff whose inputs already went through `redactPemBlocks`: line
 * rules only, each hunk line judged by its text — never by its one-character
 * `+`/`-`/space marker (`-Key <x>` is a removed line, not a `-Key` flag).
 * No rule matches across or inserts a newline, so the lines stay aligned.
 */
export function redactPatch(patch: string): string {
  const lines = patch.split('\n');
  const firstHunk = lines.findIndex((l) => l.startsWith('@@'));
  const marks = lines.map((l, i) => (firstHunk >= 0 && i > firstHunk && /^[-+ ]/.test(l) ? l[0] : ''));
  const texts = redactLines(lines.map((l, i) => l.slice(marks[i].length)).join('\n')).split('\n');
  return texts.map((t, i) => marks[i] + t).join('\n');
}

/** Every string inside a parsed value (frontmatter) — keys as well as values — redacted. */
export function redactStrings(value: unknown): unknown {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(redactStrings);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => [redactSecretsInString(k), redactStrings(v)]));
  }
  return value;
}

// ---------------------------------------------------------------------------
// Flattening
// ---------------------------------------------------------------------------

export interface FlattenOptions {
  /** Path segments expanded before an object/array is summarised as `{…}`/`[…]`. */
  maxDepth?: number;
  /** Total fields returned, including the trailing "N more fields" marker. */
  maxFields?: number;
  maxArrayItems?: number;
  /** Rendered as `~` in keys and shown values (pass home and its realpath). */
  homeDirs?: readonly string[];
}

type PathSegment = string | number;
type Token = string; // a literal key, '*', or '[]'

interface Settings {
  maxDepth: number;
  maxFields: number;
  maxArrayItems: number;
  homeRes: RegExp[];
}

interface WalkState {
  fields: ResourceField[];
  total: number;
}

function parsePattern(pattern: string): Token[] {
  return pattern.match(/\[\]|[^.[\]]+/g) ?? [];
}

const ALLOWED_PATTERNS: ReadonlyArray<readonly Token[]> = ALLOWED_KEY_PATHS.map(parsePattern);

function isAllowedPath(path: readonly PathSegment[]): boolean {
  return ALLOWED_PATTERNS.some(
    (pattern) =>
      pattern.length === path.length &&
      pattern.every((token, i) => {
        const seg = path[i];
        if (token === '[]') return typeof seg === 'number';
        if (typeof seg === 'number') return false;
        return token === '*' || token === seg;
      }),
  );
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function homeRegExps(homeDirs: readonly string[] | undefined): RegExp[] {
  return [...(homeDirs ?? [])]
    .filter((h) => h.length > 1)
    .sort((a, b) => b.length - a.length) // /private/var/h before /var/h
    // An optional extra leading `/` covers the `//Users/me/**` absolute form of permission rules.
    .map((h) => new RegExp(`(?<![A-Za-z0-9._/-])/?${escapeRegExp(h)}(?![A-Za-z0-9._-])`, 'g'));
}

function substituteHome(s: string, homeRes: RegExp[]): string {
  return homeRes.reduce((acc, re) => acc.replace(re, '~'), s);
}

const SAFE_SEGMENT_RE = /^[A-Za-z0-9_@:+-]+$/;

/** Stands in for an account, org or cache-entry id used as an object key. */
const ID = '<id>';
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * `~/.claude.json` keys some maps by UUIDs and opaque ids
 * (`s1mAccessCache.<uuid>`) — identifiers of the account, not settings. A
 * UUID anywhere in a segment, a hex run of 16+ or an id-shaped segment (16+
 * alphanumerics after an optional `org_`-style prefix, with 4+ digits or mixed
 * case and a digit) renders as `<id>`; `tengu_sonnet_4_5_launch` stays a name.
 */
function idSegment(seg: string): string {
  const s = seg.replace(UUID_RE, ID);
  if (/^[0-9a-f]{16,}$/i.test(s)) return ID;
  const core = s.replace(/^[a-z]{1,10}[_-]/, '');
  if (core.length < 16 || !/^[A-Za-z0-9]+$/.test(core)) return s;
  const digits = core.length - core.replace(/\d/g, '').length;
  return digits >= 4 || (digits > 0 && /[A-Z]/.test(core) && /[a-z]/.test(core)) ? ID : s;
}

function renderKey(path: readonly PathSegment[], homeRes: RegExp[]): string {
  if (path.length === 0) return '(root)';
  const key = path
    .map((seg, i) => {
      if (typeof seg === 'number') return `[${seg}]`;
      const s = idSegment(substituteHome(seg, homeRes));
      if (s !== ID && !SAFE_SEGMENT_RE.test(s)) return `[${JSON.stringify(s)}]`;
      return i === 0 ? s : `.${s}`;
    })
    .join('');
  return redactSecretsInString(key);
}

function kindOf(value: unknown): ResourceFieldKind {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number' || typeof value === 'bigint') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  return 'string';
}

/**
 * Count a field, and build it only while there is room: rendering a key runs
 * the redaction patterns, and a multi-MB ~/.claude.json has far more leaves
 * than the 500 that are ever returned.
 */
function push(state: WalkState, s: Settings, build: () => ResourceField): void {
  state.total += 1;
  if (state.fields.length < s.maxFields) state.fields.push(build());
}

function leafField(value: unknown, path: PathSegment[], denied: boolean, s: Settings): ResourceField {
  const kind = kindOf(value);
  const key = renderKey(path, s.homeRes);
  if (denied) return { key, value: MASK, masked: true, kind };
  if (kind !== 'string') return { key, value: String(value), masked: false, kind };
  if (!isAllowedPath(path)) return { key, value: MASK, masked: true, kind };
  const text = value instanceof Date ? value.toISOString() : String(value);
  return { key, value: redactSecretsInString(substituteHome(text, s.homeRes)), masked: false, kind };
}

/** `--api-key <value>`: the value is its own argv element, so the FLAG decides. */
const SECRET_FLAG_RE = /^-{1,2}[A-Za-z0-9_.-]*(?:key|token|secret|pass|auth|bearer|credential|cookie)[A-Za-z0-9_.-]*$/i;

function isSecretFlag(item: unknown): boolean {
  return typeof item === 'string' && item.length <= 64 && SECRET_FLAG_RE.test(item);
}

function walk(value: unknown, path: PathSegment[], denied: boolean, state: WalkState, s: Settings): void {
  if (value === null || typeof value !== 'object' || value instanceof Date) {
    push(state, s, () => leafField(value, path, denied, s));
    return;
  }
  const isArray = Array.isArray(value);
  const kind: ResourceFieldKind = isArray ? 'array' : 'object';
  const size = isArray ? value.length : Object.keys(value).length;
  if (size === 0 || path.length >= s.maxDepth) {
    const summary = size === 0 ? (isArray ? '[]' : '{}') : isArray ? '[…]' : '{…}';
    push(state, s, () => ({ key: renderKey(path, s.homeRes), value: summary, masked: false, kind }));
    return;
  }
  if (isArray) {
    value.slice(0, s.maxArrayItems).forEach((item, i) => {
      walk(item, [...path, i], denied || (i > 0 && isSecretFlag(value[i - 1])), state, s);
    });
    if (value.length > s.maxArrayItems) {
      const more = `…${value.length - s.maxArrayItems} more`;
      push(state, s, () => ({ key: `${renderKey(path, s.homeRes)}[…]`, value: more, masked: false, kind: 'array' }));
    }
    return;
  }
  const record = value as Record<string, unknown>;
  for (const k of Object.keys(record)) {
    walk(record[k], [...path, k], denied || isDeniedKeyName(k), state, s);
  }
}

/**
 * Flatten a parsed config value into dotted `ResourceField`s (`a.b[0].c`),
 * masked per the module rules. Never throws on odd input (Dates, bigints,
 * empty containers) — it runs on whatever a user's config file contained.
 */
export function flattenMasked(value: unknown, opts: FlattenOptions = {}): ResourceField[] {
  const s: Settings = {
    maxDepth: opts.maxDepth ?? 6,
    maxFields: opts.maxFields ?? 500,
    maxArrayItems: opts.maxArrayItems ?? 50,
    homeRes: homeRegExps(opts.homeDirs),
  };
  const state: WalkState = { fields: [], total: 0 };
  walk(value, [], false, state, s);
  if (state.total <= s.maxFields) return state.fields;
  const kept = state.fields.slice(0, s.maxFields - 1);
  const omitted = state.total - kept.length;
  return [...kept, { key: '…', value: `${omitted} more fields`, masked: false, kind: 'null' }];
}
